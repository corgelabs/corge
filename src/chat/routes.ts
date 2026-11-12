import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import type { ModelMessage, streamText } from 'ai'
import type { Context } from 'hono'
import type { z } from 'zod'
import { CORGE_CONFIG, type AppEnv } from '../config'
import type { EntryId } from '../db'
import { corge } from '../index'
import {
  listChatMessagesQuery,
  openaiCompletionsBody,
  saveChatBody,
  streamChatBody,
  type RawAttachmentPart,
  type WorkflowToolSpec
} from './schema'
import { extractLatestUserPrompt, formatUsage, sanitizeToolInputSchema } from './utils'

const listOpenaiModelsService = async () => {
  const agents = corge.internals.registry.getRegisteredAgents()
  return {
    object: 'list',
    data: Object.keys(agents).map((id) => ({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: CORGE_CONFIG.appName
    }))
  }
}

const parseOpenaiMessages = (
  messages: z.infer<typeof openaiCompletionsBody>['messages']
): { parts: RawAttachmentPart[]; modelMessages: ModelMessage[] } => {
  const parts: RawAttachmentPart[] = []
  const modelMessages: ModelMessage[] = []
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text =
      typeof message.content === 'string'
        ? message.content
        : (message.content ?? [])
            .filter((p) => p.type === 'text')
            .map((p) => p.text ?? '')
            .join('\n\n')
    if (message.role === 'assistant' && text.trim()) {
      modelMessages.push({ role: 'assistant', content: [{ type: 'text', text }] })
    }
    if (message.role !== 'user') continue
    for (const p of Array.isArray(message.content) ? message.content : []) {
      const dataUrl = p.image_url?.url ?? p.file?.file_data
      if (dataUrl?.startsWith('data:')) parts.push({ dataUrl, filename: p.file?.filename ?? 'file' })
    }
    if (text.trim()) modelMessages.push({ role: 'user', content: [{ type: 'text', text }] })
  }
  return { parts, modelMessages }
}

const createOpenaiSseResponse = (
  turn: ReturnType<typeof streamText>,
  id: string,
  created: number,
  model: string,
  includeUsage: boolean
): Response => {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
      const sendChunk = (choices: unknown[], extra?: Record<string, unknown>) =>
        send({ id, object: 'chat.completion.chunk', created, model, choices, ...extra })

      sendChunk([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }])
      try {
        for await (const delta of turn.textStream) {
          if (delta) sendChunk([{ index: 0, delta: { content: delta }, finish_reason: null }])
        }
        sendChunk([{ index: 0, delta: {}, finish_reason: 'stop' }])
        if (includeUsage) sendChunk([], { usage: formatUsage(await turn.usage) })
      } catch (error) {
        console.error('[openai] stream failed:', error)
        send({ error: { message: 'The agent failed to produce a reply. Please retry.' } })
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    }
  })
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' }
  })
}

const openaiCompletionsService = async ({
  c,
  userId,
  input
}: {
  c: Context<AppEnv>
  userId: EntryId
  input?: z.infer<typeof openaiCompletionsBody>
}) => {
  const body = input ?? openaiCompletionsBody.parse(await c.req.json().catch(() => ({})))
  const agents = corge.internals.registry.getRegisteredAgents()
  const entries = Object.entries(agents)
  if (entries.length === 0) return corge.errors.httpError(404, 'No registered agents', 'NOT_FOUND')
  const [defaultModel, defaultAgent] = entries[0]!
  const modelKey = body.model && body.model in agents ? body.model : defaultModel
  const agent = agents[modelKey] ?? defaultAgent
  const model = agent.name ?? modelKey

  await corge.internals.context.enforceAgentAccess(c, agent, 'openai.completions')

  const { parts, modelMessages } = parseOpenaiMessages(body.messages)
  if (modelMessages.length === 0 && parts.length === 0) {
    return corge.errors.httpError(400, 'No supported messages', 'VALIDATION_ERROR')
  }

  const latestPrompt = extractLatestUserPrompt(modelMessages)
  const role = corge.internals.auth.resolveUserRole(userId, c.get('userRole'))
  const { turn, userCreatedAtMs } = await corge.internals.context.startChatStreamTurn({
    userId,
    role,
    agent,
    attachmentParts: parts,
    rawUserText: latestPrompt,
    signal: c.req.raw.signal,
    priorMessages: modelMessages
  })
  const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`
  const created = Math.floor(userCreatedAtMs / 1000)

  if (!body.stream) {
    const [text, usage] = await Promise.all([turn.text, turn.usage])
    return {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: formatUsage(usage)
    }
  }

  return createOpenaiSseResponse(turn, id, created, model, Boolean(body.stream_options?.include_usage))
}

export const mcpRoute = async (
  request: Request,
  userId: EntryId,
  mcpTools: Map<string, WorkflowToolSpec>
): Promise<Response> => {
  const role = corge.internals.auth.resolveUserRole(userId)
  const server = new McpServer({ name: CORGE_CONFIG.appName, version: '1.0.0' })
  for (const [name, toolSpec] of mcpTools) {
    if (toolSpec.mcp !== true) continue
    server.registerTool(
      name,
      {
        description: (toolSpec.description || name).slice(0, 1024),
        inputSchema: sanitizeToolInputSchema(toolSpec.input)
      },
      async (input) => {
        try {
          const step = corge.internals.workflows.createStepRunner('workflow')
          const result = await corge.internals.context.run({ env: corge.env, userId, role, step }, () =>
            toolSpec.execute(input, userId)
          )
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(corge.errors.buildErrorBody(msg, 502, 'WORKFLOW_ERROR'))
              }
            ],
            isError: true
          }
        }
      }
    )
  }
  return createMcpHandler(() => server).fetch(request)
}

export const coreChatRoutes = {
  'chat.list': {
    handler: async ({ c, userId }: { c: Context<AppEnv>; userId: EntryId }) =>
      corge.db.list(
        'chat',
        {
          userId,
          ...(c?.req.query('full') === 'true'
            ? {}
            : {
                select: [
                  'id',
                  'userId',
                  'agentId',
                  'title',
                  'model',
                  'messageCount',
                  'summary',
                  'activeGenerationId',
                  'deleted',
                  'createdAt',
                  'updatedAt'
                ]
              })
        },
        { bypassRbac: true }
      )
  },
  'chat.get': {
    handler: async ({ c }: { c: Context<AppEnv> }) => {
      const chat = await corge.db.read('chat', c.req.param('chatId') ?? '', false)
      return chat ?? corge.errors.httpError(404, 'Chat not found', 'NOT_FOUND')
    }
  },
  'chat.messages': {
    handler: async ({ c }: { c: Context<AppEnv> }) => {
      const chatId = c.req.param('chatId') ?? ''
      const parsedQuery = listChatMessagesQuery.parse(c.req.query())
      return corge.chat.messages(chatId, { limit: parsedQuery.limit, before: parsedQuery.before })
    }
  },
  'chat.save': {
    input: saveChatBody,
    handler: ({ userId, input }: { userId: EntryId; input: z.infer<typeof saveChatBody> }) =>
      corge.internals.context.saveChat({ userId, input })
  },
  'chat.delete': {
    handler: async ({ c }: { c: Context<AppEnv> }) => {
      const chatId = c.req.param('chatId') ?? ''
      await corge.db.delete('chat', chatId)
      return { id: chatId, deleted: true }
    }
  },
  'chat.stream': {
    input: streamChatBody,
    handler: ({
      c,
      userId,
      input
    }: {
      c: Context<AppEnv>
      userId: EntryId
      input?: z.infer<typeof streamChatBody>
    }) => corge.internals.context.streamChatSse({ c, userId, input })
  },
  'chat.cancel': {
    handler: ({ c }: { c: Context<AppEnv> }) => {
      const chatId = c.req.param('chatId') ?? ''
      return corge.chat.cancel(chatId)
    }
  },
  'openai.models': {
    handler: listOpenaiModelsService
  },
  'openai.completions': {
    input: openaiCompletionsBody,
    handler: openaiCompletionsService
  }
}
