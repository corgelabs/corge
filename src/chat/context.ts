import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ModelMessage } from 'ai'
import { FieldValue, type Query } from 'firebase-admin/firestore'
import type { JevQuestion } from '../ai'
import { CORE_CONFIG, type DbRole } from '../config'
import type { EntryId } from '../db'
import { Core } from '../index'
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
  readonly #core: Core

  constructor(coreClient: Core) {
    this.#core = coreClient
  }

  registerContextCatalog = (items: readonly ContextItemSpec[] = [], reset = false): void => {
    if (reset) {
      contextCatalog = []
      markdownCache.clear()
    }
    contextCatalog = [...items]
  }

  #readContextMarkdown = async (relPath: string): Promise<string | undefined> => {
    const cached = markdownCache.get(relPath)
    if (cached !== undefined) return cached

    const contextRoot = path.resolve(process.cwd(), CORE_CONFIG.context.dir)
    const resolved = path.resolve(contextRoot, relPath)
    if (!resolved.startsWith(contextRoot + path.sep) || !relPath.endsWith('.md')) {
      return undefined
    }

    try {
      const content = await readFile(resolved, 'utf8')
      markdownCache.set(relPath, content)
      return content
    } catch {
      return undefined
    }
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

    const maxSources = options?.maxSources ?? CORE_CONFIG.context.maxSources
    const userState = options?.userState
    const stateHint = userState ? ' Use the provided userState when judging relevance.' : ''
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
      const decision = await this.#core.ai.decide(
        { prompt: trimmed, ...(userState ? { userState } : {}) },
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
    const role = opts.role ?? this.#core.internals.auth.resolveUserRole(opts.userId)
    if (!resolver || !opts.userId || role === 'anon') return undefined
    const timeout = AbortSignal.timeout(CORE_CONFIG.context.userContextTimeoutMs)
    const signal = opts.abortSignal ? AbortSignal.any([opts.abortSignal, timeout]) : timeout
    let onAbort: (() => void) | undefined
    try {
      const state = { env: this.#core.env, userId: opts.userId, role }
      const turnCore = new Core(state)
      const aborted = new Promise<undefined>((resolve) => {
        onAbort = () => resolve(undefined)
        if (signal.aborted) return resolve(undefined)
        signal.addEventListener('abort', onAbort, { once: true })
      })
      const result = await Promise.race([
        this.#core.internals.context.run(state, () =>
          Promise.resolve(resolver({ userId: opts.userId, core: turnCore, signal }))
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
      await this.#core.internals.resilience.acquireLimit('firestore')
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
          if (!content) return undefined
          return {
            id: d.id,
            chatId: typeof data.chatId === 'string' ? data.chatId : fallbackChatId,
            role: (data.role === 'assistant' ? 'assistant' : 'user') as ChatMessageRole,
            content,
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
    const queryVector = await this.#core.ai.embed(prompt)
    if (!queryVector) return []
    const vectorValue = FieldValue.vector(queryVector)
    const db = this.#core.db.firestore()

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

  retrieveContext = async (opts: HybridRetrievalOptions): Promise<HybridRetrievalResult> => {
    const {
      userId = this.#core.userId,
      chatId,
      messageCount = 0,
      prompt,
      useContext = true,
      slidingWindowSize = CORE_CONFIG.limits.chatMessagesLimit,
      agent,
      role,
      abortSignal
    } = opts
    const db = this.#core.db.firestore()

    const userContextPromise = this.#resolveTurnUserContext({ userId, role, agent, abortSignal })

    const slidingWindowPromise = (async (): Promise<ChatMessagePublic[]> => {
      if (!chatId) return []
      try {
        await this.#core.internals.resilience.acquireLimit('firestore')
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
        ? userContextPromise.then((userContext) =>
            this.getContext(prompt, undefined, {
              ...(agent?.contextAudiences ? { audiences: agent.contextAudiences } : {}),
              ...(userContext ? { userState: userContext.state } : {})
            })
          )
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

    const slidingWindowMessages = slidingWindowDocs
      .map(toModelMessageFromDoc)
      .filter((m): m is ModelMessage => Boolean(m))

    return {
      slidingWindowDocs,
      slidingWindowMessages,
      recalledMemories,
      infobaseContextEntries,
      ...(userContext ? { userContext } : {})
    }
  }
}
