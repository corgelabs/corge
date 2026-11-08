import { FieldValue, Timestamp, type DocumentReference, type Firestore } from 'firebase-admin/firestore'
import { createUIMessageStreamResponse, toUIMessageStream, type LanguageModelUsage, type ModelMessage, type streamText } from 'ai'
import { z } from 'zod'
import type { ProcessedAttachment } from '../attachments'
import type { EntryId } from '../db'
import type { FileRef } from '../files'
import type {
  ChatMessagePublic,
  ChatMessageRole,
  ContextEntry,
  ContextItemSpec,
  DynamicContextBlockInput,
  RawAttachmentPart,
  UserContext,
  streamChatBody
} from './schema'

export const FORBIDDEN_TOOL_SCHEMA_KEYS = new Set([
  'userId',
  'chatId',
  'role',
  'userRole',
  'token',
  'idToken',
  'apiKey',
  'session'
])

export const sanitizeToolInputSchema = (schema: z.ZodType<any>): z.ZodType<any> => {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodType<any>>
    const keysToOmit: Record<string, true> = {}
    let hasForbidden = false
    for (const key of Object.keys(shape)) {
      if (FORBIDDEN_TOOL_SCHEMA_KEYS.has(key)) {
        keysToOmit[key] = true
        hasForbidden = true
      }
    }
    if (hasForbidden) {
      return schema.omit(keysToOmit)
    }
  }
  return schema
}

export const isUserContextShape = (value: unknown): value is UserContext =>
  Boolean(value) &&
  typeof value === 'object' &&
  typeof (value as UserContext).state === 'object' &&
  (value as UserContext).state !== null

export const formatAttachmentLine = (filename: string, item: ProcessedAttachment): string =>
  'error' in item
    ? `[attached ${filename} (ref: ${item.ref}) (error: ${item.error})]\n`
    : `[attached ${filename} (ref: ${item.ref}) (type: ${item.scan.type}) (fields: ${JSON.stringify(item.scan.fields ?? {})}) (markdown: ${item.scan.markdown ?? ''})]\n`

export const isSafePublicUrl = (raw?: string): boolean => {
  if (!raw) return false
  try {
    const u = new URL(raw)
    const host = u.hostname.toLowerCase()
    return (
      (u.protocol === 'https:' || u.protocol === 'http:') &&
      !/^(\d+|0x[0-9a-f]+)$/i.test(host) &&
      !/^(localhost|127\.|10\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|metadata\.|\[(::1?|fc|fd|fe80:|::ffff:))/i.test(
        host
      ) &&
      !/(\.internal|\.local|\.nip\.io|\.sslip\.io)\.?$/i.test(host)
    )
  } catch {
    return false
  }
}

export const extractPart = (p: Record<string, unknown>): RawAttachmentPart | undefined => {
  if (!p || typeof p !== 'object' || (p.type !== 'file' && !('url' in p))) return undefined
  const url = String(p.url ?? '')
  const dataUrl = url.startsWith('data:') ? url : undefined
  const ref = url.match(/^\/api\/files\/([A-Za-z0-9_-]+_[a-f0-9]{24})$/)?.[1]
  return dataUrl || ref ? { dataUrl, ref, filename: typeof p.filename === 'string' ? p.filename : 'file' } : undefined
}

export const extractTurnAttachmentParts = (msg: z.infer<typeof streamChatBody>['message']): RawAttachmentPart[] => {
  const fromParts = (msg.parts ?? [])
    .map((p) => extractPart(p))
    .filter((p): p is RawAttachmentPart => Boolean(p))
  const seenRefs = new Set(fromParts.map((p) => p.ref).filter(Boolean))
  const fromRefs: RawAttachmentPart[] = (msg.attachments ?? [])
    .filter((ref) => !seenRefs.has(ref))
    .map((ref) => ({ ref, filename: ref }))
  return [...fromParts, ...fromRefs]
}

export const extractMessageText = (msg: { content?: unknown; parts?: readonly unknown[] }): string => {
  if (typeof msg.content === 'string' && msg.content.trim()) return msg.content.trim()
  const items = (Array.isArray(msg.content) ? msg.content : Array.isArray(msg.parts) ? msg.parts : []) as Record<
    string,
    unknown
  >[]
  return items
    .filter((p) => p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string')
    .map((p) => (p.text as string).trim())
    .filter(Boolean)
    .join('\n')
}

export const deriveTitle = (
  msgOrList: { content?: unknown; parts?: readonly unknown[]; role?: string } | readonly Record<string, unknown>[]
): string => {
  const list = Array.isArray(msgOrList) ? msgOrList : [msgOrList]
  for (const m of list) {
    if (m.role && m.role !== 'user') continue
    const text = extractMessageText(m as { content?: unknown; parts?: readonly unknown[] })
    if (text) return text.slice(0, 80)
  }
  return 'New Chat'
}

export const extractLatestUserPrompt = (messages: readonly (Record<string, unknown> | ModelMessage)[]): string => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown>
    if (m?.role !== 'user') continue
    const text = extractMessageText(m as { content?: unknown; parts?: readonly unknown[] })
    if (text) return text
  }
  return ''
}

export const formatUsage = (usage: LanguageModelUsage | null) => ({
  prompt_tokens: usage?.inputTokens ?? 0,
  completion_tokens: usage?.outputTokens ?? 0,
  total_tokens: usage?.totalTokens ?? (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
})

export const isContextItemVisible = (item: ContextItemSpec, audiences?: readonly string[]): boolean =>
  !audiences || !item.audiences || item.audiences.some((a) => audiences.includes(a))

export const formatContextBlock = (entries: readonly ContextEntry[]): string => {
  if (entries.length === 0) return ''
  const sources = entries
    .map(
      (entry) =>
        `<source path=${JSON.stringify(entry.path)} description=${JSON.stringify(entry.description)}>\n${entry.markdown.trim()}\n</source>`
    )
    .join('\n')
  return `<infobase_context>\n${sources}\n</infobase_context>`
}

export const buildDynamicContextBlock = (input: DynamicContextBlockInput): string => {
  const sections: string[] = [`Current UTC Date: ${input.currentTimeIso ?? new Date().toISOString()}`]

  if (input.userContext) {
    sections.push(`<user_state>\n${JSON.stringify(input.userContext.state)}\n</user_state>`)
    if (input.userContext.details && Object.keys(input.userContext.details).length > 0) {
      sections.push(`<user_records>\n${JSON.stringify(input.userContext.details)}\n</user_records>`)
    }
  }

  if (input.recalledMemories && input.recalledMemories.length > 0) {
    const items = input.recalledMemories
      .map(
        (m) =>
          `<memory scope=${JSON.stringify(m.scope)} chatId=${JSON.stringify(m.chatId)} role=${JSON.stringify(m.role)}>\n${m.content.trim()}\n</memory>`
      )
      .join('\n')
    sections.push(`<recalled_memory>\n${items}\n</recalled_memory>`)
  }

  if (input.infobaseContextEntries && input.infobaseContextEntries.length > 0) {
    const block = formatContextBlock(input.infobaseContextEntries)
    if (block) sections.push(block)
  }

  if (input.stagedAttachmentSummaries && input.stagedAttachmentSummaries.length > 0) {
    sections.push(`<staged_attachments>\n${input.stagedAttachmentSummaries.join('\n').trim()}\n</staged_attachments>`)
  }

  return sections.join('\n\n')
}

export const PUBLIC_MESSAGE_FIELDS = [
  'id',
  'chatId',
  'userId',
  'role',
  'content',
  'parts',
  'toolInvocations',
  'attachments',
  'tokenCount',
  'cancelled',
  'createdAt'
] as const

export const RECALL_MESSAGE_FIELDS = ['id', 'chatId', 'role', 'content'] as const

export const mapFirestoreMessageDoc = (
  id: string,
  raw: Record<string, unknown>
): ChatMessagePublic => {
  const createdRaw = raw.createdAt
  const createdAt =
    createdRaw instanceof Timestamp
      ? createdRaw.toDate()
      : createdRaw instanceof Date
        ? createdRaw
        : typeof createdRaw === 'string' || typeof createdRaw === 'number'
          ? new Date(createdRaw)
          : new Date()

  const role: ChatMessageRole =
    raw.role === 'assistant' || raw.role === 'system' || raw.role === 'tool' ? raw.role : 'user'
  const content = typeof raw.content === 'string' ? raw.content : ''
  const parts = Array.isArray(raw.parts) ? raw.parts : content ? [{ type: 'text', text: content }] : []

  return {
    id,
    chatId: typeof raw.chatId === 'string' ? raw.chatId : '',
    userId: typeof raw.userId === 'string' ? raw.userId : '',
    role,
    content,
    parts,
    ...(Array.isArray(raw.toolInvocations) ? { toolInvocations: raw.toolInvocations } : {}),
    ...(Array.isArray(raw.attachments) ? { attachments: raw.attachments as string[] } : {}),
    ...(typeof raw.tokenCount === 'number' ? { tokenCount: raw.tokenCount } : {}),
    ...(typeof raw.cancelled === 'boolean' ? { cancelled: raw.cancelled } : {}),
    createdAt
  }
}

export const toModelMessageFromDoc = (doc: ChatMessagePublic): ModelMessage | undefined => {
  const text = doc.content.trim()
  if (!text) return undefined
  if (doc.role === 'assistant') {
    return { role: 'assistant', content: [{ type: 'text', text }] }
  }
  if (doc.role === 'user') {
    return { role: 'user', content: [{ type: 'text', text }] }
  }
  return undefined
}

export const extractToolInvocations = (messages: readonly { content: unknown }[]): unknown[] => {
  const toolInvocations: unknown[] = []
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const part of m.content) {
      if (part && typeof part === 'object' && 'type' in part && (part.type === 'tool-call' || part.type === 'tool-result')) {
        toolInvocations.push(part)
      }
    }
  }
  return toolInvocations
}

export const buildUIMessageResponse = (
  turn: ReturnType<typeof streamText>,
  chatId: string,
  generationId: string,
  completionPromise: Promise<void>,
  onDelta: (delta: string) => void
): Response => {
  const baseRes = createUIMessageStreamResponse({ stream: toUIMessageStream({ stream: turn.stream }) })
  const headers = new Headers(baseRes.headers)
  headers.set('x-chat-id', chatId)
  headers.set('x-generation-id', generationId)

  const decoder = new TextDecoder()
  const [clientBranch, monitorBranch] = baseRes.body!.tee()

  void (async () => {
    const reader = monitorBranch.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        for (const line of decoder.decode(value, { stream: true }).split('\n')) {
          if (!line.startsWith('data: ')) continue
          try {
            const payload = JSON.parse(line.slice(6)) as { type?: string; delta?: string; textDelta?: string }
            if (payload.type === 'text-delta') onDelta(payload.delta ?? payload.textDelta ?? '')
          } catch {}
        }
      }
    } catch {
    } finally {
      reader.releaseLock()
    }
  })()

  const syncedClientStream = clientBranch.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      async flush() {
        await completionPromise.catch(() => {})
      }
    })
  )

  return new Response(syncedClientStream, { status: baseRes.status, headers })
}

export const buildCompletedTurnWriteBatch = (
  db: Firestore,
  opts: {
    chatDocRef: DocumentReference
    chatId: string
    userId: EntryId
    resolvedAgentId: string
    title: string
    selectedModel: string
    userMsgId: string
    assistantMsgId: string
    userCreatedAtMs: number
    finalUserText: string
    userPartsForStorage: unknown[]
    stagedRefs: FileRef[]
    finalAssistantText: string
    toolInvocations: unknown[]
    totalTokens?: number
    cancelled: boolean
    userVector: number[] | null
    assistantVector: number[] | null
  }
) => {
  const messagesCol = opts.chatDocRef.collection('messages')
  const batch = db.batch()
  batch.set(messagesCol.doc(opts.userMsgId), {
    id: opts.userMsgId,
    chatId: opts.chatId,
    userId: opts.userId,
    role: 'user',
    content: opts.finalUserText,
    parts: opts.userPartsForStorage,
    ...(opts.stagedRefs.length > 0 ? { attachments: opts.stagedRefs } : {}),
    createdAt: Timestamp.fromMillis(opts.userCreatedAtMs),
    ...(opts.userVector ? { embedding: FieldValue.vector(opts.userVector) } : {})
  })

  batch.set(messagesCol.doc(opts.assistantMsgId), {
    id: opts.assistantMsgId,
    chatId: opts.chatId,
    userId: opts.userId,
    role: 'assistant',
    content: opts.finalAssistantText,
    parts: opts.finalAssistantText ? [{ type: 'text', text: opts.finalAssistantText }] : [],
    ...(opts.toolInvocations.length > 0 ? { toolInvocations: opts.toolInvocations } : {}),
    ...(opts.totalTokens !== undefined ? { tokenCount: opts.totalTokens } : {}),
    cancelled: opts.cancelled,
    createdAt: Timestamp.fromMillis(Math.max(opts.userCreatedAtMs + 1, Date.now())),
    ...(opts.assistantVector ? { embedding: FieldValue.vector(opts.assistantVector) } : {})
  })

  batch.set(
    opts.chatDocRef,
    {
      id: opts.chatId,
      userId: opts.userId,
      agentId: opts.resolvedAgentId,
      title: opts.title,
      model: opts.selectedModel,
      deleted: false,
      activeGenerationId: null,
      messageCount: FieldValue.increment(2),
      updatedAt: FieldValue.serverTimestamp()
    },
    { merge: true }
  )
  return batch
}
