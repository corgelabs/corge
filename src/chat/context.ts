import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ModelMessage } from 'ai'
import { FieldValue, type Query } from 'firebase-admin/firestore'
import type { JevQuestion } from '../ai'
import { CORGE_CONFIG, type DbRole } from '../config'
import { fileScan, fileScanError, type EntryId, type FileRef } from '../db'
import { Corge } from '../index'
import type {
  AgentConfig,
  ChatMessagePublic,
  ChatMessageRole,
  ContextEntry,
  ContextItemSpec,
  GetContextOptions,
  HybridRetrievalOptions,
  HybridRetrievalResult,
  RecalledMemorySnippet,
  UserContext,
  VectorValue
} from './schema'
import {
  formatAttachmentLine,
  isContextItemVisible,
  isUserContextShape,
  mapFirestoreMessageDoc,
  PUBLIC_MESSAGE_FIELDS,
  RECALL_MESSAGE_FIELDS,
  toModelMessageFromDoc
} from './utils'

let contextCatalog: readonly ContextItemSpec[] = []
const markdownCache = new Map<string, string>()

export class ChatContextEngine {
  readonly #corge: Corge

  constructor(corgeClient: Corge) {
    this.#corge = corgeClient
  }

  registerContextCatalog = (items: readonly ContextItemSpec[] = [], reset = false): void => {
    if (reset) {
      contextCatalog = []
      markdownCache.clear()
    }
    contextCatalog = [...items]
  }

  #readContextMarkdown = async (relPath: string): Promise<string | undefined> => {
    if (!relPath.endsWith('.md')) return undefined
    const cached = markdownCache.get(relPath)
    if (cached !== undefined) return cached

    const roots = [
      path.resolve(process.cwd(), CORGE_CONFIG.context.dir),
      path.resolve(process.cwd(), 'dist/context')
    ]

    for (const contextRoot of roots) {
      const resolved = path.resolve(contextRoot, relPath)
      if (!resolved.startsWith(contextRoot + path.sep)) continue
      try {
        const content = await readFile(resolved, 'utf8')
        markdownCache.set(relPath, content)
        return content
      } catch {}
    }

    return undefined
  }

  getContext = async (
    prompt: string,
    catalog: readonly ContextItemSpec[] = contextCatalog,
    options?: GetContextOptions
  ): Promise<ContextEntry[]> => {
    const trimmed = prompt.trim()
    if (!trimmed || catalog.length === 0) return []

    const validItems = catalog.filter(
      (item) =>
        item.path?.endsWith('.md') &&
        !item.path.includes('..') &&
        !path.isAbsolute(item.path) &&
        isContextItemVisible(item, options?.audiences)
    )
    if (validItems.length === 0) return []

    const maxSources = options?.maxSources ?? CORGE_CONFIG.context.maxSources
    const userState = options?.userState
    const recentConversation = options?.recentConversation?.trim()
    const stateHint =
      (userState ? ' Use the provided userState when judging relevance.' : '') +
      (recentConversation ? ' Consider recentConversation for follow-up topic continuity.' : '')
    const questions: Record<string, JevQuestion> = {}
    validItems.forEach((item, idx) => {
      questions[`doc_${idx}`] = {
        type: 'noul',
        instructions: `Is documentation file "${item.path}" (${item.description}) directly relevant to answering the user prompt?${stateHint}`,
        criteria: {
          true: `The user prompt requires or benefits from documentation in ${item.path} (${item.description})`,
          false: 'The user prompt is unrelated to this documentation file'
        }
      }
    })

    try {
      const decision = await this.#corge.ai.decide(
        {
          prompt: trimmed,
          ...(recentConversation ? { recentConversation } : {}),
          ...(userState ? { userState } : {})
        },
        questions
      )
      const scored = validItems
        .map((item, idx) => {
          const ans = decision.answers[`doc_${idx}`]
          return { item, score: ans?.type === 'noul' ? ans.noul : 0 }
        })
        .filter((x) => x.score >= 0.5)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxSources)

      if (scored.length === 0) return []

      const loaded = await Promise.all(
        scored.map(async ({ item }): Promise<ContextEntry | undefined> => {
          const markdown = await this.#readContextMarkdown(item.path)
          return markdown ? { path: item.path, description: item.description, markdown } : undefined
        })
      )
      return loaded.filter((entry): entry is ContextEntry => Boolean(entry))
    } catch {
      return []
    }
  }

  #resolveTurnUserContext = async (opts: {
    userId: EntryId
    role?: DbRole
    agent?: Pick<AgentConfig, 'resolveUserContext'>
    abortSignal?: AbortSignal
  }): Promise<UserContext | undefined> => {
    const resolver = opts.agent?.resolveUserContext
    const role = opts.role ?? this.#corge.internals.auth.resolveUserRole(opts.userId)
    if (!resolver || !opts.userId || role === 'anon') return undefined
    const timeout = AbortSignal.timeout(CORGE_CONFIG.context.userContextTimeoutMs)
    const signal = opts.abortSignal ? AbortSignal.any([opts.abortSignal, timeout]) : timeout
    let onAbort: (() => void) | undefined
    try {
      const state = { env: this.#corge.env, userId: opts.userId, role }
      const turnCore = new Corge(state)
      const aborted = new Promise<undefined>((resolve) => {
        onAbort = () => resolve(undefined)
        if (signal.aborted) return resolve(undefined)
        signal.addEventListener('abort', onAbort, { once: true })
      })
      const result = await Promise.race([
        this.#corge.internals.context.run(state, () =>
          Promise.resolve(resolver({ userId: opts.userId, corge: turnCore, signal }))
        ),
        aborted
      ])
      return isUserContextShape(result) ? result : undefined
    } catch {
      return undefined
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }

  #queryNearestMessages = async (
    baseQuery: Query,
    vectorValue: VectorValue,
    limit: number,
    scope: 'in_chat' | 'cross_chat',
    fallbackChatId = ''
  ): Promise<RecalledMemorySnippet[]> => {
    try {
      await this.#corge.internals.resilience.acquireLimit('firestore')
      const snap = await baseQuery
        .select(...RECALL_MESSAGE_FIELDS)
        .findNearest({
          vectorField: 'embedding',
          queryVector: vectorValue,
          limit,
          distanceMeasure: 'COSINE',
          distanceThreshold: 0.35
        })
        .get()
      return snap.docs
        .map((d) => {
          const data = d.data()
          const content = typeof data.content === 'string' ? data.content.trim() : ''
          const attachments = Array.isArray(data.attachments) ? (data.attachments as FileRef[]) : undefined
          if (!content && !attachments?.length) return undefined
          return {
            id: d.id,
            chatId: typeof data.chatId === 'string' ? data.chatId : fallbackChatId,
            role: (data.role === 'assistant' ? 'assistant' : 'user') as ChatMessageRole,
            content,
            ...(attachments?.length ? { attachments } : {}),
            scope
          }
        })
        .filter((x): x is RecalledMemorySnippet => Boolean(x))
    } catch {
      return []
    }
  }

  #vectorRecall = async (
    prompt: string,
    userId: EntryId,
    chatId: string | undefined,
    messageCount: number,
    slidingWindowSize: number
  ): Promise<RecalledMemorySnippet[]> => {
    const queryVector = await this.#corge.ai.embed(prompt)
    if (!queryVector) return []
    const vectorValue = FieldValue.vector(queryVector)
    const db = this.#corge.db.firestore()

    const inChatPromise =
      chatId && messageCount > slidingWindowSize
        ? this.#queryNearestMessages(
            db.collection('chat').doc(chatId).collection('messages'),
            vectorValue,
            5,
            'in_chat',
            chatId
          )
        : Promise.resolve([] as RecalledMemorySnippet[])

    const crossChatPromise = userId
      ? this.#queryNearestMessages(
          db.collectionGroup('messages').where('userId', '==', userId),
          vectorValue,
          3,
          'cross_chat'
        )
      : Promise.resolve([] as RecalledMemorySnippet[])

    const [inChat, crossChat] = await Promise.all([inChatPromise, crossChatPromise])
    return [...inChat, ...crossChat]
  }

  #hydrateAttachmentSummaries = async (refs: readonly string[]): Promise<Map<string, string>> => {
    const unique = [...new Set(refs.filter(Boolean))].slice(-CORGE_CONFIG.limits.maxChatAttachments)
    const out = new Map<string, string>()
    if (unique.length === 0) return out
    try {
      await this.#corge.internals.resilience.acquireLimit('firestore')
      const db = this.#corge.db.firestore()
      const snaps = await db.getAll(...unique.map((r) => db.collection('file').doc(r)))
      for (const snap of snaps) {
        if (!snap.exists) continue
        const raw = snap.data() ?? {}
        const filename = typeof raw.fileName === 'string' && raw.fileName ? raw.fileName : snap.id
        const parsedScan = raw.scan ? fileScan.safeParse(raw.scan) : undefined
        if (parsedScan?.success) {
          out.set(snap.id, formatAttachmentLine(filename, { ref: snap.id, scan: parsedScan.data }).trim())
          continue
        }
        const parsedErr = raw.scanError ? fileScanError.safeParse(raw.scanError) : undefined
        if (parsedErr?.success) {
          out.set(snap.id, formatAttachmentLine(filename, { ref: snap.id, error: parsedErr.data.agentHint }).trim())
        }
      }
    } catch {}
    return out
  }

  retrieveContext = async (opts: HybridRetrievalOptions): Promise<HybridRetrievalResult> => {
    const {
      userId = this.#corge.userId,
      chatId,
      messageCount = 0,
      chatAttachmentRefs,
      prompt,
      useContext = true,
      slidingWindowSize = CORGE_CONFIG.limits.chatMessagesLimit,
      agent,
      role,
      abortSignal
    } = opts
    const db = this.#corge.db.firestore()

    const userContextPromise = this.#resolveTurnUserContext({ userId, role, agent, abortSignal })

    const slidingWindowPromise = (async (): Promise<ChatMessagePublic[]> => {
      if (!chatId) return []
      try {
        await this.#corge.internals.resilience.acquireLimit('firestore')
        const snap = await db
          .collection('chat')
          .doc(chatId)
          .collection('messages')
          .select(...PUBLIC_MESSAGE_FIELDS)
          .orderBy('createdAt', 'desc')
          .limit(slidingWindowSize)
          .get()
        return snap.docs.map((d) => mapFirestoreMessageDoc(d.id, d.data() ?? {})).reverse()
      } catch {
        return []
      }
    })()

    const vectorRecallPromise = this.#vectorRecall(prompt, userId, chatId, messageCount, slidingWindowSize)

    const infobasePromise =
      useContext !== false && prompt.trim()
        ? Promise.all([userContextPromise, slidingWindowPromise]).then(([userContext, windowDocs]) => {
            const recentConversation = windowDocs
              .slice(-4)
              .map((m) => `${m.role}: ${m.content.slice(0, 350)}`)
              .join('\n')
              .slice(0, 1_500)
            return this.getContext(prompt, undefined, {
              ...(agent?.contextAudiences ? { audiences: agent.contextAudiences } : {}),
              ...(userContext ? { userState: userContext.state } : {}),
              ...(recentConversation ? { recentConversation } : {})
            })
          })
        : Promise.resolve([] as ContextEntry[])

    const [slidingWindowDocs, rawRecalled, infobaseContextEntries, userContext] = await Promise.all([
      slidingWindowPromise,
      vectorRecallPromise,
      infobasePromise,
      userContextPromise
    ])

    const windowIds = new Set(slidingWindowDocs.map((m) => m.id))
    const seenRecallIds = new Set<string>()
    const recalledMemories: RecalledMemorySnippet[] = []
    for (const mem of rawRecalled) {
      if (windowIds.has(mem.id) || seenRecallIds.has(mem.id)) continue
      seenRecallIds.add(mem.id)
      recalledMemories.push(mem)
    }

    const windowRefs = slidingWindowDocs.flatMap((d) => d.attachments ?? [])
    const recallRefs = recalledMemories.flatMap((m) => m.attachments ?? [])
    const threadRefs = chatAttachmentRefs ?? []
    const attachmentMap = await this.#hydrateAttachmentSummaries([...threadRefs, ...windowRefs, ...recallRefs])

    const inlinedRefs = new Set<string>()
    for (const r of windowRefs) if (attachmentMap.has(r)) inlinedRefs.add(r)
    for (const mem of recalledMemories) {
      const attLines = (mem.attachments ?? [])
        .map((r) => {
          const line = attachmentMap.get(r)
          if (line) inlinedRefs.add(r)
          return line
        })
        .filter((s): s is string => Boolean(s))
      if (attLines.length > 0) mem.content = [mem.content, ...attLines].filter(Boolean).join('\n\n')
    }

    const historicalAttachmentSummaries = threadRefs
      .filter((r) => !inlinedRefs.has(r) && attachmentMap.has(r))
      .map((r) => attachmentMap.get(r)!)

    const slidingWindowMessages = slidingWindowDocs
      .map((d) => toModelMessageFromDoc(d, attachmentMap))
      .filter((m): m is ModelMessage => Boolean(m))

    return {
      slidingWindowDocs,
      slidingWindowMessages,
      recalledMemories,
      infobaseContextEntries,
      ...(historicalAttachmentSummaries.length > 0 ? { historicalAttachmentSummaries } : {}),
      ...(userContext ? { userContext } : {})
    }
  }
}
