import { Timestamp, type DocumentReference, type Firestore } from 'firebase-admin/firestore'
import { z } from 'zod'
import { CORGE_CONFIG, type DbRole } from '../config'
import type { EntryId } from '../db'
import type { RouteMode } from '../router'
import type { Duration } from '../utils'
import {
  StaleWorkerEpochError,
  TaskWaitDetachedSignal,
  TaskYieldSignal,
  type ClaimCheckPointer,
  type StepContext,
  type StepRetryPolicy,
  type TaskRecord,
  type WorkflowContext,
  type WorkflowTargetRef,
  type WorkflowTaskPayload
} from './schema'

export interface StepRunnerState {
  mode: RouteMode
  docRef?: DocumentReference
  steps: Record<string, unknown>
  expiresAt?: Timestamp
  isDev: boolean
  signals: Record<string, unknown>
  wfCtx?: WorkflowContext
  canYield: boolean
  compensatedSteps: Record<string, boolean>
  replayOnly: boolean
  claimedEpoch?: number
  fencedError: Error | null
  activePersistPromise: Promise<void> | null
  pendingPersist: boolean
  writes: Promise<unknown>[]
  rollbacks: { name: string; run: () => Promise<unknown> }[]
  callCounts: Map<string, number>
  abortController?: AbortController
}

export const isTaskYieldSignal = (err: unknown): err is TaskYieldSignal =>
  err instanceof TaskYieldSignal || Boolean(err && typeof err === 'object' && (err as any).isTaskYield === true)

export const isClaimCheckPointer = (val: unknown): val is ClaimCheckPointer =>
  Boolean(val && typeof val === 'object' && typeof (val as any).__claimCheck === 'string')

export const isTaskWaitDetachedSignal = (err: unknown): err is TaskWaitDetachedSignal =>
  err instanceof TaskWaitDetachedSignal ||
  Boolean(err && typeof err === 'object' && (err as { isTaskWaitDetached?: unknown }).isTaskWaitDetached === true)

export const zodToJsonSchemaSafe = (schema?: z.ZodType<any>): Record<string, unknown> | null => {
  if (!schema) return null
  try {
    const raw = z.toJSONSchema(schema, { unrepresentable: 'any' }) as Record<string, unknown>
    const { $schema: _$schema, ...rest } = raw
    return rest
  } catch {
    return null
  }
}

export const resolveTaskDeadline = (workflowName: string, deadlineSeconds?: number): number =>
  deadlineSeconds ??
  (workflowName === 'scan-attachment'
    ? CORGE_CONFIG.tasks.scanDeadlineSeconds
    : CORGE_CONFIG.tasks.defaultDeadlineSeconds)

export const getQueueLoc = (): string => `projects/${CORGE_CONFIG.gcpProject}/locations/${CORGE_CONFIG.region}`

export const getQueueBase = (isDev = false): string =>
  `${getQueueLoc()}/queues/${isDev ? CORGE_CONFIG.queueBaseNames.dev : CORGE_CONFIG.queueBaseNames.prod}`

export const getQueueParent = (idx: number, isDev = false): string => {
  const base = getQueueBase(isDev)
  return idx === 0 ? base : `${base}-${String(idx).padStart(2, '0')}`
}

export const getWorkerUri = (isDev = false): string =>
  isDev ? CORGE_CONFIG.workerUris.dev : CORGE_CONFIG.workerUris.prod

export const isTerminalRecord = (d: TaskRecord<unknown> | undefined): d is TaskRecord<unknown> =>
  Boolean(d && (d.status === 'completed' || d.status === 'errored' || d.status === 'cancelled'))

export const setTaskDoc = (docRef: DocumentReference, patch: Record<string, unknown>): Promise<void> =>
  docRef
    .set(patch, { mergeFields: Object.keys(patch).filter((k) => patch[k] !== undefined) })
    .then(() => {})
    .catch(() => {})

export const resolveTargetName = (target: string | WorkflowTargetRef<any, any>): string => {
  if (typeof target === 'string') return target
  if (target.workflowName) return target.workflowName
  throw new Error('Workflow target must specify a workflowName or route key')
}

export const isFencedOut = (
  claimedEpoch: number | undefined,
  docEpoch: number | undefined,
  docStatus: string | undefined,
  requireRunning = false
): boolean => {
  if (claimedEpoch !== undefined && docEpoch !== undefined && docEpoch !== claimedEpoch) return true
  if (requireRunning) return docStatus !== 'running'
  return (
    docStatus === 'compensating' ||
    docStatus === 'cancelled' ||
    docStatus === 'completed' ||
    docStatus === 'errored'
  )
}

export const createStaleEpochError = (
  taskId: string | undefined,
  claimedEpoch: number | undefined,
  actualEpoch: number | undefined,
  status?: string
): StaleWorkerEpochError =>
  new StaleWorkerEpochError(
    `Worker epoch ${claimedEpoch ?? 'unknown'} superseded by epoch ${actualEpoch ?? 'unknown'} (status=${status ?? 'unknown'})`,
    {
      ...(taskId ? { taskId } : {}),
      ...(claimedEpoch !== undefined ? { claimedEpoch } : {}),
      ...(actualEpoch !== undefined ? { actualEpoch } : {})
    }
  )

const compensationLocks = new Map<string, Promise<void>>()

export const runSerializedCompensation = async (taskId: string, fn: () => Promise<void>): Promise<void> => {
  const prev = compensationLocks.get(taskId) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  compensationLocks.set(taskId, next)
  try {
    await next
  } finally {
    if (compensationLocks.get(taskId) === next) compensationLocks.delete(taskId)
  }
}

export const executeCompensateState = async (s: StepRunnerState): Promise<void> => {
  await Promise.allSettled(s.writes)
  if (!s.rollbacks.length) return
  if (s.docRef) {
    const snap = await s.docRef.get().catch(() => null)
    const remoteComp = snap?.data()?.compensatedSteps as Record<string, boolean> | undefined
    if (remoteComp && typeof remoteComp === 'object') Object.assign(s.compensatedSteps, remoteComp)
  }
  for (const item of [...s.rollbacks].reverse()) {
    if (s.compensatedSteps[item.name]) {
      delete s.steps[item.name]
      continue
    }
    await item.run()
    s.compensatedSteps[item.name] = true
    delete s.steps[item.name]
    if (s.docRef) {
      const patch: Record<string, unknown> = {
        compensatedSteps: { ...s.compensatedSteps },
        steps: { ...s.steps },
        updatedAt: new Date().toISOString(),
        ...(s.expiresAt ? { expiresAt: s.expiresAt } : {})
      }
      await s.docRef.set(patch, { mergeFields: Object.keys(patch) })
    }
  }
}

export const runStepWithRetry = async <T>(
  fn: (ctx: StepContext) => Promise<T>,
  retryOrCount: number | StepRetryPolicy = 2,
  delayMs = 1000,
  stepId = 'step',
  timeout: Duration | undefined,
  parentSignal: AbortSignal | undefined,
  parseDuration: (d: Duration | undefined, fallbackMs: number) => number,
  isNonRetryableError: (err: unknown) => boolean
): Promise<T> => {
  const policy: StepRetryPolicy =
    typeof retryOrCount === 'number'
      ? { maxAttempts: retryOrCount + 1, initialInterval: delayMs, backoffCoefficient: 1.5 }
      : retryOrCount
  const maxAttempts = Math.max(1, policy.maxAttempts ?? 3)
  const initialMs = parseDuration(policy.initialInterval, delayMs)
  const backoff = policy.backoffCoefficient ?? 1.5
  const maxIntervalMs = policy.maxInterval ? parseDuration(policy.maxInterval, 30_000) : 30_000
  const useJitter = policy.jitter !== false
  const timeoutMs = timeout ? parseDuration(timeout, 0) : 0

  let lastErr: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController()
    const onParentAbort = () => controller.abort(parentSignal?.reason)
    if (parentSignal) {
      if (parentSignal.aborted) controller.abort(parentSignal.reason)
      else parentSignal.addEventListener('abort', onParentAbort, { once: true })
    }
    const timer =
      timeoutMs > 0
        ? setTimeout(() => controller.abort(new Error(`Step "${stepId}" timed out after ${timeoutMs}ms`)), timeoutMs)
        : undefined
    try {
      const result = await fn({ signal: controller.signal, attempt, stepId })
      if (timer) clearTimeout(timer)
      if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort)
      return result
    } catch (err) {
      if (timer) clearTimeout(timer)
      if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort)
      if (isTaskYieldSignal(err)) throw err
      lastErr = err
      const errName = err instanceof Error ? err.name : ''
      if (isNonRetryableError(err) || (errName && policy.nonRetryableErrorTypes?.includes(errName))) throw err
      if (attempt < maxAttempts) {
        const rawWait = Math.min(maxIntervalMs, initialMs * Math.pow(backoff, attempt - 1))
        const waitMs = useJitter ? Math.round(rawWait * (0.75 + Math.random() * 0.5)) : Math.round(rawWait)
        await new Promise((r) => setTimeout(r, waitMs))
      }
    }
  }
  throw lastErr
}

export const claimTaskEpochTx = (
  db: Firestore,
  docRef: DocumentReference,
  payload: WorkflowTaskPayload,
  attempt: number,
  resolveRole: (userId?: EntryId, explicitRole?: DbRole) => DbRole
) =>
  db.runTransaction(async (tx) => {
    const data = (await tx.get(docRef)).data()
    const currentStatus = data?.status as string | undefined
    if (['completed', 'errored', 'cancelled', 'compensating'].includes(String(currentStatus))) {
      return { aborted: true as const }
    }
    const currentEpoch = typeof data?.epoch === 'number' ? data.epoch : 0
    if (attempt === 0 && payload.expectedEpoch !== undefined && currentEpoch !== payload.expectedEpoch) {
      return { aborted: true as const }
    }
    const claimedEpoch = currentEpoch + 1
    const activeRunId = crypto.randomUUID()
    const startedAt = Date.now()
    const expiresAt = Timestamp.fromMillis(startedAt + CORGE_CONFIG.tasks.ttlMs)
    const effectiveParams = (data?.params as Record<string, unknown> | undefined) ?? payload.params
    const userId: EntryId = typeof data?.userId === 'string' ? data.userId : CORGE_CONFIG.auth.adminUserId
    const userRole = resolveRole(userId, data?.userRole as DbRole | undefined)
    const steps: Record<string, unknown> = { ...((data?.steps as Record<string, unknown> | undefined) ?? {}) }
    const signals: Record<string, unknown> = { ...((data?.signals as Record<string, unknown> | undefined) ?? {}) }
    const compensatedSteps: Record<string, boolean> = {
      ...((data?.compensatedSteps as Record<string, boolean> | undefined) ?? {})
    }
    tx.set(
      docRef,
      {
        taskId: payload.taskId,
        workflowName: payload.workflowName,
        userId,
        userRole,
        status: 'running',
        epoch: claimedEpoch,
        activeRunId,
        lastHeartbeatAt: startedAt,
        params: effectiveParams,
        steps,
        compensatedSteps,
        updatedAt: new Date(startedAt).toISOString(),
        expiresAt
      },
      { merge: true }
    )
    return {
      aborted: false as const,
      claimedEpoch,
      startedAt,
      expiresAt,
      effectiveParams,
      userId,
      userRole,
      steps,
      signals,
      compensatedSteps
    }
  })

export const startTaskHeartbeatTimer = (
  db: Firestore,
  docRef: DocumentReference,
  taskId: string,
  claimedEpoch: number,
  expiresAt: Timestamp,
  controller: AbortController
): ReturnType<typeof setInterval> => {
  const timer = setInterval(() => {
    void db
      .runTransaction(async (tx) => {
        const data = (await tx.get(docRef)).data()
        if (data?.epoch !== claimedEpoch || data?.status !== 'running') {
          controller.abort(
            new StaleWorkerEpochError(`Heartbeat detected stale epoch on ${taskId}`, {
              taskId,
              claimedEpoch,
              actualEpoch: typeof data?.epoch === 'number' ? data.epoch : undefined
            })
          )
          return
        }
        tx.set(docRef, { lastHeartbeatAt: Date.now(), updatedAt: new Date().toISOString(), expiresAt }, { merge: true })
      })
      .catch(() => {})
  }, CORGE_CONFIG.tasks.heartbeatIntervalMs)
  timer.unref?.()
  return timer
}

export const commitTaskCompletionTx = (
  db: Firestore,
  docRef: DocumentReference,
  baseMeta: Record<string, unknown>,
  taskId: string,
  claimedEpoch: number,
  storedResponse: unknown,
  steps: Record<string, unknown>,
  expiresAt: Timestamp
): Promise<void> =>
  db.runTransaction(async (tx) => {
    const data = (await tx.get(docRef)).data()
    const docEpoch = typeof data?.epoch === 'number' ? data.epoch : undefined
    if (docEpoch !== claimedEpoch || data?.status !== 'running') {
      throw new StaleWorkerEpochError(`Completion fenced on ${taskId}`, {
        taskId,
        claimedEpoch,
        actualEpoch: docEpoch
      })
    }
    tx.set(
      docRef,
      {
        ...baseMeta,
        status: 'completed',
        epoch: claimedEpoch,
        activeRunId: null,
        response: storedResponse,
        steps,
        lastHeartbeatAt: Date.now(),
        updatedAt: new Date().toISOString(),
        expiresAt
      },
      { merge: true }
    )
  })

export const commitTaskYieldTx = async (
  db: Firestore,
  docRef: DocumentReference,
  baseMeta: Record<string, unknown>,
  taskId: string,
  claimedEpoch: number,
  err: TaskYieldSignal,
  nextEpoch: number,
  nextParams: Record<string, unknown>,
  nextSteps: Record<string, unknown>,
  nextStatus: string,
  expiresAt: Timestamp
): Promise<void> => {
  const yieldCommitted = await db.runTransaction(async (tx) => {
    const data = (await tx.get(docRef)).data()
    const docEpoch = typeof data?.epoch === 'number' ? data.epoch : undefined
    if (docEpoch !== claimedEpoch || data?.status !== 'running') {
      return { fenced: true as const, docEpoch }
    }
    tx.set(
      docRef,
      {
        ...baseMeta,
        status: nextStatus,
        epoch: nextEpoch,
        activeRunId: null,
        params: nextParams,
        steps: nextSteps,
        ...(err.reason === 'waiting_signal' ? { waitingSignal: err.meta.signalName ?? null } : {}),
        updatedAt: new Date().toISOString(),
        expiresAt
      },
      {
        mergeFields: [
          'taskId',
          'workflowName',
          'userId',
          'userRole',
          'status',
          'epoch',
          'activeRunId',
          'params',
          'steps',
          ...(err.reason === 'waiting_signal' ? ['waitingSignal'] : []),
          'updatedAt',
          'expiresAt'
        ]
      }
    )
    return { fenced: false as const }
  })
  if (yieldCommitted.fenced) {
    throw new StaleWorkerEpochError(`Yield fenced on ${taskId}`, {
      taskId,
      claimedEpoch,
      actualEpoch: yieldCommitted.docEpoch
    })
  }
}

export const commitTaskCompensatingTx = async (
  db: Firestore,
  docRef: DocumentReference,
  taskId: string,
  claimedEpoch: number,
  expiresAt: Timestamp
): Promise<void> => {
  const compTransition = await db.runTransaction(async (tx) => {
    const data = (await tx.get(docRef)).data()
    const docEpoch = typeof data?.epoch === 'number' ? data.epoch : undefined
    if (docEpoch !== claimedEpoch || data?.status !== 'running') {
      return { fenced: true as const, docEpoch }
    }
    tx.set(
      docRef,
      {
        status: 'compensating',
        epoch: claimedEpoch + 1,
        activeRunId: null,
        updatedAt: new Date().toISOString(),
        expiresAt
      },
      { merge: true }
    )
    return { fenced: false as const }
  })
  if (compTransition.fenced) {
    throw new StaleWorkerEpochError(`Error compensation fenced on ${taskId}`, {
      taskId,
      claimedEpoch,
      actualEpoch: compTransition.docEpoch
    })
  }
}
