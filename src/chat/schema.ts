import type { FieldValue, Timestamp } from 'firebase-admin/firestore'
import type { ModelMessage, streamText } from 'ai'
import { z } from 'zod'
import type { AttachmentTypesMap } from '../attachments'
import type { AppBindings, DbRole, RateLimitConfig } from '../config'
import { entryId, fileRef, type EntryId, type FileRef } from '../db'
import type { Core } from '../index'
import type { AuthLevel } from '../router'

export type VectorValue = ReturnType<typeof FieldValue.vector>

export type SystemPromptBuilder = (ctx: {
  today: string
  userId: EntryId
  env: AppBindings
}) => string | Promise<string>

export interface AgentToolPresets {
  discovery?: string[]
  workflow?: string[]
}

/** Per-user data injected into a chat turn by `AgentConfig.resolveUserContext`. */
export interface UserContext {
  /** Compact flags (≤ ~1 KB). Sent to the InfoBase classifier and to the agent. */
  state: Record<string, unknown>
  /** Capped records (≤ ~8 KB). Sent to the agent only, never to the classifier. */
  details?: Record<string, unknown>
}

export type UserContextResolver = (ctx: {
  userId: EntryId
  core: Core
  signal: AbortSignal
}) => Promise<UserContext | undefined>

export interface AgentConfig {
  name?: string
  description?: string
  model?: string
  systemPrompt: string | SystemPromptBuilder
  tools?: string[]
  toolPresets?: AgentToolPresets
  maxSteps?: number
  useContext?: boolean
  /** Restricts InfoBase items to those tagged with any of these audiences. Omit for no filtering. */
  contextAudiences?: readonly string[]
  /** Loads the caller's own data for each turn. Must honour `signal`; failures degrade to no user context. */
  resolveUserContext?: UserContextResolver
  attachmentTypes?: AttachmentTypesMap
  auth?: AuthLevel
  rateLimit?: RateLimitConfig
  mcp?: boolean
}

export const defineAgent = <C extends AgentConfig>(config: C): C => config
export const defineAgents = <T extends Record<string, AgentConfig>>(agents: T): T => agents

export interface ChatMetadataDoc {
  id: string
  userId: string
  agentId: string
  title: string
  model: string
  messageCount: number
  summary?: string | null
  activeGenerationId?: string | null
  deleted: boolean
  createdAt: Timestamp | Date
  updatedAt: Timestamp | Date
}

export type ChatMessageRole = 'user' | 'assistant' | 'system' | 'tool'

export interface ChatMessageDoc {
  id: string
  chatId: string
  userId: string
  role: ChatMessageRole
  content: string
  parts: unknown[]
  toolInvocations?: unknown[]
  attachments?: string[]
  tokenCount?: number
  cancelled?: boolean
  createdAt: Timestamp | Date
  embedding?: VectorValue
}

export type ChatMessagePublic = Omit<ChatMessageDoc, 'embedding' | 'createdAt'> & {
  createdAt: Date
}

export interface RecalledMemorySnippet {
  id: string
  chatId: string
  role: ChatMessageRole
  content: string
  scope: 'in_chat' | 'cross_chat'
}

export interface ContextItemSpec {
  path: string
  description: string
  /** Audiences allowed to receive this item (matched against `AgentConfig.contextAudiences`). Omit to expose to every agent. */
  audiences?: readonly string[]
}

export const defineContext = <const T extends readonly ContextItemSpec[]>(items: T): T => items

export interface ContextEntry {
  path: string
  description: string
  markdown: string
}

export interface GetContextOptions {
  maxSources?: number
  /** Only items tagged with any of these audiences (or untagged items) are considered. */
  audiences?: readonly string[]
  /** Compact caller state forwarded to the classifier to judge relevance. */
  userState?: Record<string, unknown>
}

export interface DynamicContextBlockInput {
  currentTimeIso?: string
  recalledMemories?: readonly RecalledMemorySnippet[]
  infobaseContextEntries?: readonly ContextEntry[]
  stagedAttachmentSummaries?: readonly string[]
  userContext?: UserContext
}

export interface HybridRetrievalOptions {
  userId?: EntryId
  chatId?: string
  messageCount?: number
  prompt: string
  useContext?: boolean
  slidingWindowSize?: number
  /** Agent whose `contextAudiences` and `resolveUserContext` scope this turn. */
  agent?: Pick<AgentConfig, 'contextAudiences' | 'resolveUserContext'>
  /** Verified caller role (defaults to `resolveUserRole(userId)`). */
  role?: DbRole
  abortSignal?: AbortSignal
}

export interface HybridRetrievalResult {
  slidingWindowDocs: ChatMessagePublic[]
  slidingWindowMessages: ModelMessage[]
  recalledMemories: RecalledMemorySnippet[]
  infobaseContextEntries: ContextEntry[]
  userContext?: UserContext
}

export interface ListChatMessagesOptions {
  limit?: number
  before?: EntryId
}

export interface WorkflowToolSpec {
  description: string
  input: z.ZodType<any>
  mcp?: boolean
  tool?: boolean
  execute: (input: any, userId: EntryId) => Promise<unknown>
}

export interface VerifiedAgentToolContext {
  core: Core
  chatId?: string
  abortSignal?: AbortSignal
}

export interface RunAgentOptions {
  modelOverride?: string
  chatId?: string
  abortSignal?: AbortSignal
  dynamicContext?: DynamicContextBlockInput
  core?: Core
  onFinish?: Parameters<typeof streamText>[0]['onFinish']
}

export interface AskAgentOptions {
  userId?: EntryId
  includeContext?: boolean
  abortSignal?: AbortSignal
}

export const ReasoningExpertInputDto = z.object({
  problemStatement: z.string().describe('Self-contained specification of the complex reasoning task.'),
  constraintsAndContext: z.string().describe('Compact summary of relevant data, constraints, or document fields.')
})

export const ReasoningExpertOutputDto = z.object({
  analysisSummary: z.string(),
  recommendedSolution: z.string(),
  edgeCasesToWatch: z.array(z.string())
})

export interface RawAttachmentPart {
  dataUrl?: string
  ref?: FileRef
  filename: string
}

export interface PersistTurnCompletionOpts {
  turn: ReturnType<typeof import('ai').streamText>
  getAccumulatedText: () => string
  signal: AbortSignal
  userVecPromise: Promise<number[] | null>
  chatDocRef: import('firebase-admin/firestore').DocumentReference
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
  unsubCancelWatch: (() => void) | undefined
  key: string
}

export const chatIdParam = z.object({ chatId: entryId })

export const listChatMessagesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: entryId.optional()
})

export const saveChatBody = z
  .object({
    id: entryId.optional(),
    chatId: entryId.optional(),
    title: z.string().min(1).max(256).optional(),
    agentId: z.string().min(1).max(128).optional(),
    model: z.string().min(1).max(128).optional(),
    summary: z.string().max(4000).nullable().optional()
  })
  .strict()

export const streamChatMessageInput = z.object({
  id: entryId.optional(),
  role: z.literal('user').default('user'),
  content: z.string().optional(),
  parts: z.array(z.record(z.string(), z.unknown())).optional(),
  attachments: z.array(fileRef).max(20).optional()
})

export type StreamChatMessageInput = z.infer<typeof streamChatMessageInput>

export const streamChatBody = z
  .object({
    id: entryId.optional(),
    chatId: entryId.optional(),
    agentId: z.string().min(1).max(128).optional(),
    title: z.string().max(256).optional(),
    model: z.string().max(128).optional(),
    message: streamChatMessageInput
  })
  .strict()

export const openaiMessagePartSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    image_url: z.object({ url: z.string().optional() }).optional(),
    file: z.object({ file_data: z.string().optional(), filename: z.string().optional() }).optional()
  })
  .passthrough()

export const openaiMessageSchema = z
  .object({
    role: z.string(),
    content: z.union([z.string(), z.array(openaiMessagePartSchema), z.null()]).optional()
  })
  .passthrough()

export const openaiCompletionsBody = z
  .object({
    model: z.string(),
    messages: z.array(openaiMessageSchema).min(1).max(500),
    stream: z.boolean().optional(),
    stream_options: z.object({ include_usage: z.boolean().optional() }).optional()
  })
  .extend({ model: z.string().optional() })
  .passthrough()

export const webSearchInput = z.object({
  query: z.string().min(1).optional(),
  url: z.string().optional().describe('Full URL to open and read — wins over query')
})
