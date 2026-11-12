import { type ModelMessage, type streamText } from 'ai'
import { type DocumentReference } from 'firebase-admin/firestore'
import type { Context } from 'hono'
import type { z } from 'zod'
import type { AttachmentTypesMap, ProcessedAttachment } from '../attachments'
import { CORGE_CONFIG, type AppEnv, type DbRole } from '../config'
import { entryId, type EntryId, type SelectModel } from '../db'
import type { FileRef, FileType } from '../files'
import { Corge } from '../index'
import {
  saveChatBody,
  streamChatBody,
  type AgentConfig,
  type ChatMessagePublic,
  type ListChatMessagesOptions,
  type PersistTurnCompletionOpts,
  type RawAttachmentPart
} from './schema'
import {
  buildCompletedTurnWriteBatch,
  buildUIMessageResponse,
  deriveTitle,
  extractMessageText,
  extractToolInvocations,
  extractTurnAttachmentParts,
  formatAttachmentLine,
  mapFirestoreMessageDoc,
  PUBLIC_MESSAGE_FIELDS
} from './utils'

interface ActiveGenerationEntry {
  generationId: string
  controller: AbortController
  partialText: () => string
  completionPromise?: Promise<void>
}

const activeGenerations = new Map<string, ActiveGenerationEntry>()
const genKey = (isDev: boolean, chatId: string): string => `${isDev ? 'dev' : 'prod'}:${chatId}`

export class ChatStreamEngine {
  readonly #corge: Corge
  readonly #agentRegistry: Map<string, AgentConfig>

  constructor(corgeClient: Corge, agentRegistry: Map<string, AgentConfig>) {
    this.#corge = corgeClient
    this.#agentRegistry = agentRegistry
  }

  #assertChatAccess = async (chatId: EntryId): Promise<void> => {
    const caller = this.#corge.caller
    if (caller.role !== 'admin' && caller.userId !== CORGE_CONFIG.auth.adminUserId) {
      const chatDoc = await this.#corge.db.read('chat', chatId, false, {
        userId: caller.userId,
        userRole: caller.role
      })
      if (!chatDoc) this.#corge.errors.httpError(404, `Chat not found: ${chatId}`, 'NOT_FOUND')
    }
  }

  enforceAgentAccess = async (c: Context<AppEnv>, agent: AgentConfig, scopeKey: string): Promise<void> => {
    if (agent.auth) {
      await this.#corge.internals.context.authenticateRequest(c, agent.auth)
    }
    if (agent.rateLimit !== undefined) {
      this.#corge.internals.context.applyRateLimit(c, agent.rateLimit, `${scopeKey}:${agent.name ?? 'agent'}`)
    }
  }

  stageAndScanAttachments = async (
    userId: EntryId,
    parts: RawAttachmentPart[],
    types?: AttachmentTypesMap
  ): Promise<{ staged: { ref: FileRef; filename: string }[]; attachments: ProcessedAttachment[] }> => {
    if (parts.length === 0) return { staged: [], attachments: [] }
    if (parts.length > CORGE_CONFIG.limits.maxChatAttachments) {
      this.#corge.errors.httpError(
        400,
        `Too many attachments (max ${CORGE_CONFIG.limits.maxChatAttachments})`,
        'TOO_MANY_ATTACHMENTS'
      )
    }
    const staged = await Promise.all(
      parts.map(async (part) => {
        if (part.ref) {
          if (!this.#corge.files.canAccess(part.ref, userId)) {
            this.#corge.errors.httpError(403, 'Forbidden', 'FORBIDDEN')
          }
          return { ref: part.ref, filename: part.filename }
        }
        if ((part.dataUrl?.length ?? 0) > 28 * 1024 * 1024) {
          this.#corge.errors.httpError(413, 'Attachment exceeds 20MiB limit', 'PAYLOAD_TOO_LARGE')
        }
        const match = /^data:([^;,]+);base64,(.+)$/.exec(part.dataUrl ?? '')
        if (!match?.[1] || !match[2]) {
          return this.#corge.errors.httpError(400, 'Invalid base64 data URL for attachment', 'INVALID_FILE')
        }
        const contentType = match[1] as FileType
        const bytes = new Uint8Array(Buffer.from(match[2], 'base64'))
        const { ref } = await this.#corge.files.upload({ type: contentType, name: part.filename, bytes }, userId)
        return { ref, filename: part.filename }
      })
    )
    const { attachments } = await this.#corge.attachments.process({ refs: staged.map((s) => s.ref) }, { types })
    return { staged, attachments }
  }

  saveChat = async ({
    userId = this.#corge.userId,
    input
  }: {
    userId?: EntryId
    input: z.infer<typeof saveChatBody>
  }): Promise<SelectModel<'chat'>> => {
    const targetId = input.id ?? input.chatId
    const existing = targetId ? await this.#corge.db.read('chat', targetId, true, { bypassRbac: true }) : undefined
    if (existing && userId !== CORGE_CONFIG.auth.adminUserId && existing.userId !== userId) {
      return this.#corge.errors.httpError(403, 'Forbidden', 'FORBIDDEN')
    }
    const defaultAgentId = this.#agentRegistry.keys().next().value ?? 'chat'
    if (existing && input.agentId && input.agentId !== existing.agentId) {
      return this.#corge.errors.httpError(400, 'Cannot switch agentId on an existing chat', 'AGENT_IMMUTABLE')
    }
    const title = input.title ?? existing?.title ?? 'New Chat'
    const agentId = existing ? existing.agentId : (input.agentId ?? defaultAgentId)
    if (!this.#agentRegistry.has(agentId)) {
      return this.#corge.errors.httpError(404, `Unknown agent: ${agentId}`, 'NOT_FOUND')
    }
    const model = input.model ?? existing?.model ?? CORGE_CONFIG.models.vertex

    if (existing && targetId) {
      const patch = { title, model, ...(input.summary !== undefined ? { summary: input.summary } : {}), deleted: false }
      await this.#corge.db.update('chat', targetId, patch, { bypassRbac: true })
      return { ...existing, ...patch, updatedAt: new Date() }
    }

    return this.#corge.db.create(
      'chat',
      {
        ...(targetId ? { id: targetId } : {}),
        userId,
        agentId,
        title,
        model,
        messageCount: 0,
        summary: input.summary ?? null,
        activeGenerationId: null
      },
      { bypassRbac: true }
    )
  }

  messages = async (chatId: EntryId, opts?: ListChatMessagesOptions): Promise<ChatMessagePublic[]> => {
    await this.#assertChatAccess(chatId)
    const limit = Math.min(
      Math.max(opts?.limit ?? CORGE_CONFIG.limits.chatMessagesLimit, 1),
      CORGE_CONFIG.limits.defaultListLimit
    )
    const db = this.#corge.db.firestore()
    const messagesCol = db.collection('chat').doc(chatId).collection('messages')

    await this.#corge.internals.resilience.acquireLimit('firestore')
    let query = messagesCol.select(...PUBLIC_MESSAGE_FIELDS).orderBy('createdAt', 'desc').limit(limit)
    if (opts?.before) {
      const beforeSnap = await messagesCol.doc(opts.before).get()
      if (beforeSnap.exists) query = query.startAfter(beforeSnap)
    }
    const snap = await query.get()
    return snap.docs.map((d) => mapFirestoreMessageDoc(d.id, d.data() ?? {})).reverse()
  }

  cancel = async (chatId: EntryId): Promise<{ chatId: string; cancelled: true }> => {
    await this.#assertChatAccess(chatId)
    const key = genKey(Boolean(this.#corge.env.isDev), chatId)
    const localGen = activeGenerations.get(key)

    await this.#corge.db.update('chat', chatId, { activeGenerationId: null }, { bypassRbac: true }).catch(() => {})

    if (localGen) {
      localGen.controller.abort(new Error('Cancelled by user'))
      if (localGen.completionPromise) {
        await Promise.race([localGen.completionPromise, new Promise((r) => setTimeout(r, 2_500))])
      }
    }

    return { chatId, cancelled: true }
  }

  #resolveStreamTurnTarget = async (c: Context<AppEnv>, userId: EntryId, body: z.infer<typeof streamChatBody>) => {
    const paramValue = c.req.param('chatId')
    const paramIsAgent = Boolean(
      paramValue && this.#agentRegistry.has(paramValue) && !body.agentId && !body.chatId && !body.id
    )
    const defaultAgentId = this.#agentRegistry.keys().next().value ?? 'chat'
    const db = this.#corge.db.firestore()
    const candidateChatId = !paramIsAgent ? (paramValue ?? body.chatId ?? body.id) : (body.chatId ?? body.id)
    const chatId =
      candidateChatId && entryId.safeParse(candidateChatId).success
        ? candidateChatId
        : db.collection('chat').doc().id

    const existing = await this.#corge.db.read('chat', chatId, true, { bypassRbac: true })
    if (existing && userId !== CORGE_CONFIG.auth.adminUserId && existing.userId !== userId) {
      this.#corge.errors.httpError(403, 'Forbidden', 'FORBIDDEN')
    }

    const requestedAgentId = body.agentId ?? (paramIsAgent ? paramValue : undefined)
    if (existing && requestedAgentId && requestedAgentId !== existing.agentId) {
      this.#corge.errors.httpError(400, 'Cannot switch agentId on an existing chat', 'AGENT_IMMUTABLE')
    }
    const resolvedAgentId = existing ? existing.agentId : (requestedAgentId ?? defaultAgentId)
    const agent = this.#agentRegistry.get(resolvedAgentId)
    if (!agent) return this.#corge.errors.httpError(404, `Unknown agent: ${resolvedAgentId}`, 'NOT_FOUND')
    await this.enforceAgentAccess(c, agent, 'chat.stream')

    const attachmentParts = extractTurnAttachmentParts(body.message)
    const rawUserText = extractMessageText(body.message)
    if (!rawUserText && attachmentParts.length === 0) {
      this.#corge.errors.httpError(400, 'message must contain non-empty text or attachments', 'VALIDATION_ERROR')
    }

    const key = genKey(Boolean(this.#corge.env.isDev), chatId)
    const activeTimeoutMs = CORGE_CONFIG.cloudRun.http.timeoutSeconds * 1000
    const hasFreshRemoteLock =
      Boolean(existing?.activeGenerationId) &&
      Date.now() - (existing?.updatedAt instanceof Date ? existing.updatedAt.getTime() : 0) < activeTimeoutMs

    if (activeGenerations.has(key) || hasFreshRemoteLock) {
      this.#corge.errors.httpError(409, 'A generation is already in progress for this chat', 'GENERATION_IN_PROGRESS')
    }

    return { chatId, existing, resolvedAgentId, agent, attachmentParts, rawUserText, key }
  }

  #persistTurnCompletion = async (opts: PersistTurnCompletionOpts): Promise<void> => {
    let assistantText = ''
    let totalTokens: number | undefined
    const toolInvocations: unknown[] = []
    try {
      try {
        const [text, response, usage] = await Promise.all([opts.turn.text, opts.turn.response, opts.turn.usage])
        assistantText = text || opts.getAccumulatedText()
        totalTokens = usage?.totalTokens ?? ((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) || undefined)
        toolInvocations.push(...extractToolInvocations(response.messages))
      } catch {
        assistantText = opts.getAccumulatedText()
      }

      const finalAssistantText = assistantText.trim()
      const [userVector, assistantVector] = await Promise.all([
        opts.userVecPromise,
        this.#corge.ai.embed(finalAssistantText).catch(() => null)
      ])

      const batch = buildCompletedTurnWriteBatch(this.#corge.db.firestore(), {
        ...opts,
        finalAssistantText,
        toolInvocations,
        ...(totalTokens !== undefined ? { totalTokens } : {}),
        cancelled: opts.signal.aborted,
        userVector,
        assistantVector
      })

      await this.#corge.internals.resilience.acquireLimit('firestore')
      await batch.commit().catch((err) => console.error('[chat] failed to commit turn batch:', err))
    } finally {
      try {
        opts.unsubCancelWatch?.()
      } catch {}
      activeGenerations.delete(opts.key)
    }
  }

  #upsertChatTurnLock = async (
    existing: SelectModel<'chat'> | undefined,
    chatDocRef: DocumentReference,
    chatId: string,
    userId: EntryId,
    resolvedAgentId: string,
    title: string,
    selectedModel: string,
    generationId: string,
    generationController: AbortController
  ): Promise<() => void> => {
    if (existing) {
      await this.#corge.db.update(
        'chat',
        chatId,
        { title, agentId: resolvedAgentId, model: selectedModel, activeGenerationId: generationId, deleted: false },
        { bypassRbac: true }
      )
    } else {
      await this.#corge.db.create(
        'chat',
        {
          id: chatId,
          userId,
          agentId: resolvedAgentId,
          title,
          model: selectedModel,
          messageCount: 0,
          summary: null,
          activeGenerationId: generationId
        },
        { bypassRbac: true }
      )
    }

    return chatDocRef.onSnapshot(
      (snap) => {
        if (snap.data()?.activeGenerationId !== generationId && !generationController.signal.aborted) {
          generationController.abort(new Error('Generation cancelled via Firestore state'))
        }
      },
      () => {}
    )
  }

  startChatStreamTurn = async (opts: {
    userId: EntryId
    role: DbRole
    agent: AgentConfig
    attachmentParts: RawAttachmentPart[]
    rawUserText: string
    signal: AbortSignal
    chatId?: string
    messageCount?: number
    selectedModel?: string
    priorMessages?: ModelMessage[]
  }) => {
    const { userId, role, agent, attachmentParts, rawUserText, signal, chatId, messageCount, selectedModel, priorMessages } =
      opts
    const [{ staged, attachments }, hybrid] = await Promise.all([
      this.stageAndScanAttachments(userId, attachmentParts, agent.attachmentTypes ?? {}),
      this.#corge.chat.retrieveContext({
        userId,
        ...(chatId ? { chatId } : {}),
        ...(messageCount !== undefined ? { messageCount } : {}),
        prompt: rawUserText,
        useContext: agent.useContext !== false,
        agent,
        role,
        abortSignal: signal
      })
    ])

    const stagedAttachmentSummaries = attachments.map((item, idx) =>
      formatAttachmentLine(staged[idx]?.filename ?? 'file', item).trim()
    )
    const userCreatedAtMs = Date.now()
    const messagesForTurn = priorMessages
      ? [
          ...priorMessages,
          ...(stagedAttachmentSummaries.length > 0
            ? [{ role: 'user' as const, content: [{ type: 'text' as const, text: stagedAttachmentSummaries.join('\n\n') }] }]
            : [])
        ].slice(-CORGE_CONFIG.limits.chatMessagesLimit)
      : [
          ...hybrid.slidingWindowMessages,
          {
            role: 'user' as const,
            content: [{ type: 'text' as const, text: [rawUserText, ...stagedAttachmentSummaries].filter(Boolean).join('\n\n') || 'Attached files.' }]
          }
        ]

    const turn = await this.#corge.chat.stream(agent, messagesForTurn, userId, {
      ...(selectedModel ? { modelOverride: selectedModel } : {}),
      ...(chatId ? { chatId } : {}),
      abortSignal: signal,
      corge: new Corge({ env: this.#corge.env, userId, role }),
      dynamicContext: {
        currentTimeIso: new Date(userCreatedAtMs).toISOString(),
        recalledMemories: hybrid.recalledMemories,
        infobaseContextEntries: hybrid.infobaseContextEntries,
        stagedAttachmentSummaries,
        userContext: hybrid.userContext
      }
    })
    return { turn, stagedRefs: staged.map((s) => s.ref), stagedAttachmentSummaries, userCreatedAtMs }
  }

  streamChatSse = async ({
    c,
    userId = this.#corge.userId,
    input
  }: {
    c: Context<AppEnv>
    userId?: EntryId
    input?: z.infer<typeof streamChatBody>
  }): Promise<Response> => {
    const parsedBody = streamChatBody.safeParse(input ?? (await c.req.json().catch(() => ({}))))
    if (!parsedBody.success) {
      return this.#corge.errors.httpError(
        400,
        parsedBody.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '),
        'VALIDATION_ERROR'
      )
    }
    const body = parsedBody.data
    const { chatId, existing, resolvedAgentId, agent, attachmentParts, rawUserText, key } =
      await this.#resolveStreamTurnTarget(c, userId, body)

    const generationId = `gen_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
    const generationController = new AbortController()
    let accumulatedText = ''
    const activeEntry: ActiveGenerationEntry = {
      generationId,
      controller: generationController,
      partialText: () => accumulatedText
    }
    activeGenerations.set(key, activeEntry)

    const title = body.title ?? existing?.title ?? deriveTitle(body.message)
    const selectedModel = body.model ?? existing?.model ?? agent.model ?? CORGE_CONFIG.models.vertex
    const chatDocRef = this.#corge.db.firestore().collection('chat').doc(chatId)
    let unsubCancelWatch: (() => void) | undefined

    try {
      unsubCancelWatch = await this.#upsertChatTurnLock(
        existing,
        chatDocRef,
        chatId,
        userId,
        resolvedAgentId,
        title,
        selectedModel,
        generationId,
        generationController
      )
      const role = this.#corge.internals.auth.resolveUserRole(userId, c.get('userRole'))
      const { turn, stagedRefs, stagedAttachmentSummaries, userCreatedAtMs } = await this.startChatStreamTurn({
        userId,
        role,
        chatId,
        messageCount: existing?.messageCount ?? 0,
        agent,
        selectedModel,
        attachmentParts,
        rawUserText,
        signal: generationController.signal
      })

      const finalUserText = rawUserText || stagedAttachmentSummaries.join('\n')
      const msgCol = chatDocRef.collection('messages')
      const userMsgId = body.message.id && entryId.safeParse(body.message.id).success ? body.message.id : msgCol.doc().id
      const userPartsForStorage = body.message.parts?.length ? body.message.parts : [{ type: 'text', text: rawUserText }]
      const completionPromise = this.#persistTurnCompletion({
        turn,
        getAccumulatedText: () => accumulatedText,
        signal: generationController.signal,
        userVecPromise: this.#corge.ai.embed(finalUserText).catch(() => null),
        chatDocRef,
        chatId,
        userId,
        resolvedAgentId,
        title,
        selectedModel,
        userMsgId,
        assistantMsgId: msgCol.doc().id,
        userCreatedAtMs,
        finalUserText,
        userPartsForStorage,
        stagedRefs,
        unsubCancelWatch,
        key
      })
      activeEntry.completionPromise = completionPromise
      return buildUIMessageResponse(turn, chatId, generationId, completionPromise, (d) => {
        accumulatedText += d
      })
    } catch (err) {
      try {
        unsubCancelWatch?.()
      } catch {}
      activeGenerations.delete(key)
      await this.#corge.db.update('chat', chatId, { activeGenerationId: null }, { bypassRbac: true }).catch(() => {})
      throw err
    }
  }
}
