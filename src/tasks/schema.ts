import type { DocumentReference } from 'firebase-admin/firestore'
import { z } from 'zod'
import type { AppBindings, DbRole } from '../config'
import type { EntryId } from '../db'
import type { AuthLevel, BaseRouteConfig, RouteMode } from '../router'
import { StaleWorkerEpochError, type Duration } from '../utils'

export { StaleWorkerEpochError }

export type TaskStatus =
  | 'running'
  | 'sleeping'
  | 'waiting_signal'
  | 'compensating'
  | 'completed'
  | 'errored'
  | 'cancelled'

export interface TaskExecutionFence {
  /** Monotonically increasing integer incremented on every worker claim, yield, hedge, or cancel transition */
  epoch: number
  /** Unique UUID for the currently owning worker execution attempt */
  activeRunId: string | null
  /** Timestamp of the latest worker heartbeat */
  lastHeartbeatAt: number
}

export interface TaskProgressUpdate {
  percent?: number
  stage?: string
  message?: string
  data?: Record<string, unknown>
}

export interface TaskStatusRecord<O = unknown> {
  taskId: string
  workflowName: string
  status: TaskStatus
  userId?: EntryId
  epoch?: number
  activeRunId?: string | null
  lastHeartbeatAt?: number
  compensatedSteps?: Record<string, boolean>
  progress?: TaskProgressUpdate
  response?: O
  error?: string
  createdAt?: string
  updatedAt?: string
}

export interface WorkflowContext {
  taskId: string
  workflowName: string
  attempt: number
  startedAt: number
  deadlineMs: number
  signal: AbortSignal
}

export interface StepRetryPolicy {
  maxAttempts?: number
  initialInterval?: Duration
  backoffCoefficient?: number
  maxInterval?: Duration
  jitter?: boolean
  nonRetryableErrorTypes?: string[]
}

export interface StepContext {
  signal: AbortSignal
  attempt: number
  stepId: string
}

export interface StepOptions<T = unknown> {
  retry?: number | StepRetryPolicy
  timeout?: Duration
  rollback?: (result: T) => Promise<unknown>
}

export interface StepMapOptions<T, R> extends StepOptions<R> {
  concurrency?: number
  shortCircuit?: (item: T, index: number) => Promise<R | undefined> | R | undefined
}

export type StepSpec<T> =
  | ((ctx: StepContext) => Promise<T>)
  | {
      fn: (ctx: StepContext) => Promise<T>
      rollback?: (result: T) => Promise<unknown>
      retry?: number | StepRetryPolicy
      timeout?: Duration
    }

export type StepFn = <T>(name: string, fnOrSpec: StepSpec<T>, options?: StepOptions<T>) => Promise<T>

export interface WorkflowTargetRef<I = any, O = any> {
  workflowName?: string
  timeout?: Duration
  handler?: (ctx: any) => Promise<O>
  __input?: I
}

export interface StepRunner extends StepFn {
  run: StepFn
  map: <T, R>(
    name: string,
    items: readonly T[],
    fn: (item: T, index: number, ctx: StepContext) => Promise<R>,
    options?: StepMapOptions<T, R>
  ) => Promise<R[]>
  invoke: <I = unknown, O = unknown>(
    name: string,
    target: string | WorkflowTargetRef<I, O>,
    input: I,
    options?: { timeout?: Duration; dedupeKey?: string }
  ) => Promise<O>
  spawn: <I = unknown>(
    name: string,
    target: string | WorkflowTargetRef<I, unknown>,
    input: I,
    options?: { dedupeKey?: string; timeout?: Duration }
  ) => Promise<{ taskId: string }>
  sleep: (name: string, duration: Duration) => Promise<void>
  waitForSignal: <T = unknown>(
    name: string,
    signalName: string,
    options?: { timeout?: Duration }
  ) => Promise<T>
  continueAsNew: <I = unknown>(newInput: I) => Promise<never>
  progress: (update: TaskProgressUpdate) => Promise<void>
  flush: () => Promise<PromiseSettledResult<unknown>[]>
  compensate: () => Promise<void>
  onError: () => Promise<void>
}

export interface RollbackLeg<T> {
  fn: () => Promise<T>
  rollback?: (result: T) => Promise<unknown>
}

export interface WorkflowTaskPayload {
  taskId: string
  workflowName: string
  params: Record<string, unknown>
  isDev: boolean
  expectedEpoch?: number
}

export interface WorkflowRuntimeEntry {
  mode: RouteMode
  deadlineSeconds?: number
  runTask: (params: any, step: StepRunner) => Promise<unknown>
}

export class TaskYieldSignal extends Error {
  readonly isTaskYield = true
  constructor(
    public readonly reason: 'sleeping' | 'waiting_signal' | 'continue_as_new' | 'yield',
    public readonly meta: {
      delaySeconds?: number
      signalName?: string
      timeoutMs?: number
      newInput?: unknown
    } = {}
  ) {
    super(`TaskYield:${reason}`)
    this.name = 'TaskYieldSignal'
  }
}

export interface ClaimCheckPointer {
  __claimCheck: string
}

export class ReplayCompleteSignal extends Error {
  readonly isReplayComplete = true as const
  constructor() {
    super('ReplayComplete')
    this.name = 'ReplayCompleteSignal'
  }
}

export interface ActiveTaskExecution {
  taskId: string
  step: StepRunner
  controller: AbortController
  claimedEpoch?: number
}

export interface ActiveWorkflowStore {
  workflow: WorkflowContext
  step: StepRunner
  env?: AppBindings
}

export interface CreateStepRunnerOptions {
  isDev?: boolean
  signals?: Record<string, unknown>
  workflowContext?: WorkflowContext
  canYield?: boolean
  claimedEpoch?: number
  abortController?: AbortController
  compensatedSteps?: Record<string, boolean>
  replayOnly?: boolean
}

export interface DispatchWorkflowOptions {
  mode?: RouteMode
  timeout?: Duration
  dedupeKey?: string
  wait?: boolean
  maxWaitMs?: number
  signal?: AbortSignal
  userId?: EntryId
  userRole?: DbRole
}

export interface ExecuteWorkflowTaskOptions {
  canYield?: boolean
}

export type TaskRecord<O = unknown> =
  | { status: 'completed'; response: O }
  | { status: 'errored'; error: string; errorCode?: string; nonRetryable?: boolean }
  | { status: 'cancelled'; error?: string }

export class TaskWaitDetachedSignal extends Error {
  readonly isTaskWaitDetached = true as const
  constructor(public readonly taskId: string) {
    super(`TaskWaitDetached:${taskId}`)
    this.name = 'TaskWaitDetachedSignal'
  }
}

export interface PendingEntry {
  taskId: string
  workflowName: string
  docRef: DocumentReference
  createdAt: number
  hedged: boolean
  hedgeable?: boolean
  keepAlive?: boolean
  unsub?: () => void
  dispatch: () => Promise<void>
  finish: (res: TaskRecord<any>) => void
}

export interface WatchTaskOptions {
  isDev?: boolean
  docRef?: DocumentReference
  workflowName?: string
  hedgeable?: boolean
  keepAlive?: boolean
  timeoutMs?: number
  maxWaitMs?: number
  hedgeAfterMs?: number
  pollIntervalMs?: number
  signal?: AbortSignal
  dispatch?: () => Promise<void>
}

export interface RouteRegistryItem {
  id: string
  mode: RouteMode
  method: string
  path: string
  workflowName?: string
  auth?: AuthLevel
  description: string
  mcp?: boolean
  tool?: boolean
  input?: z.ZodType<any>
  output?: z.ZodType<any>
  guard?: BaseRouteConfig['guard']
}

export interface RouteIntrospectionItem {
  id: string
  method: string
  path: string
  mode: 'rest' | 'workflow'
  workflowName?: string
  auth: string | false
  description: string
  mcp: boolean
  tool: boolean
  guards: string[]
  inputSchema: Record<string, unknown> | null
  outputSchema: Record<string, unknown> | null
}

export interface RoutesIntrospectionResponse {
  appName: string
  generatedAt: string
  routes: RouteIntrospectionItem[]
  collections?: Record<
    string,
    {
      relationType: string
      rbac?: Record<string, unknown>
      schema: Record<string, unknown> | null
    }
  >
}

export const signalTaskBody = z.object({
  signal: z.string().min(1),
  payload: z.unknown().optional()
})
