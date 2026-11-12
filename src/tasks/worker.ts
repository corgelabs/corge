import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { Timestamp, type DocumentReference, type Firestore } from 'firebase-admin/firestore'
import { CORGE_CONFIG, type DbRole } from '../config'
import type { EntryId } from '../db'
import type { Corge } from '../index'
import type { RouteMode } from '../router'
import type { Duration } from '../utils'
import {
  StaleWorkerEpochError,
  type ActiveTaskExecution,
  type ActiveWorkflowStore,
  type DispatchWorkflowOptions,
  type ExecuteWorkflowTaskOptions,
  type StepRunner,
  type TaskRecord,
  type TaskYieldSignal,
  type WorkflowContext,
  type WorkflowRuntimeEntry,
  type WorkflowTaskPayload
} from './schema'
import type { TaskStepsEngine } from './steps'
import {
  claimTaskEpochTx,
  commitTaskCompensatingTx,
  commitTaskCompletionTx,
  commitTaskYieldTx,
  isTaskYieldSignal,
  resolveTaskDeadline,
  setTaskDoc,
  startTaskHeartbeatTimer
} from './utils'
import type { TaskWatcherEngine } from './watcher'

const activeTaskExecutions = new Map<string, ActiveTaskExecution>()
const workflowStorage = new AsyncLocalStorage<ActiveWorkflowStore>()
let activeRegistry: Record<string, WorkflowRuntimeEntry> = {}

export class TaskWorkerEngine {
  readonly #corge: Corge
  #steps!: TaskStepsEngine
  #watcher!: TaskWatcherEngine

  constructor(corgeClient: Corge) {
    this.#corge = corgeClient
  }

  bindEngines = (steps: TaskStepsEngine, watcher: TaskWatcherEngine): void => {
    this.#steps = steps
    this.#watcher = watcher
  }

  getActiveWorkflowStore = (): ActiveWorkflowStore | undefined => workflowStorage.getStore()

  getContext = (): WorkflowContext => {
    const store = workflowStorage.getStore()
    if (store) return store.workflow
    const now = Date.now()
    return {
      taskId: 'inline',
      workflowName: 'inline',
      attempt: 1,
      startedAt: now,
      deadlineMs: now + CORGE_CONFIG.tasks.defaultDeadlineSeconds * 1000,
      signal: new AbortController().signal
    }
  }

  runWithWorkflowContext = <T>(store: ActiveWorkflowStore, fn: () => Promise<T>): Promise<T> =>
    workflowStorage.run(store, fn)

  registerActiveTaskExecution = (exec: ActiveTaskExecution): void => {
    activeTaskExecutions.set(exec.taskId, exec)
  }

  unregisterActiveTaskExecution = (taskId: string, step?: StepRunner): void => {
    const existing = activeTaskExecutions.get(taskId)
    if (existing && (!step || existing.step === step)) activeTaskExecutions.delete(taskId)
  }

  getActiveTaskExecution = (taskId: string): ActiveTaskExecution | undefined => activeTaskExecutions.get(taskId)

  registerRuntime = (registry: Record<string, WorkflowRuntimeEntry>): void => {
    activeRegistry = registry
  }

  getRuntime = (): { registry: Record<string, WorkflowRuntimeEntry> } => ({ registry: activeRegistry })

  invokeChildWorkflow = async (
    targetName: string,
    input: unknown,
    options?: { timeout?: Duration; dedupeKey?: string; wait?: boolean }
  ): Promise<any> => {
    const wf = activeRegistry[targetName]
    if (!wf) throw new Error(`Unknown child workflow: ${targetName}`)
    const timeout: Duration | undefined =
      options?.timeout ?? (wf.deadlineSeconds !== undefined ? `${wf.deadlineSeconds}s` : undefined)
    return this.dispatch(targetName, wf.runTask as any, input, {
      mode: wf.mode,
      ...(timeout !== undefined ? { timeout } : {}),
      ...(options?.dedupeKey ? { dedupeKey: options.dedupeKey } : {}),
      wait: options?.wait !== false,
      userId: this.#corge.userId,
      userRole: this.#corge.role
    })
  }

  #unwrapTaskRecord = <O>(res: TaskRecord<O>): O => {
    if (res.status === 'completed') return res.response
    if (res.status === 'cancelled') {
      return this.#corge.errors.httpError(409, res.error ?? 'Workflow task cancelled', 'TASK_CANCELLED')
    }
    if (res.nonRetryable) {
      return this.#corge.errors.httpError(400, res.error, res.errorCode ?? 'NON_RETRYABLE_ERROR')
    }
    return this.#corge.errors.httpError(502, res.error, 'WORKFLOW_ERROR')
  }

  #dispatchInline = async <I, O>(
    workflowName: string,
    mode: RouteMode,
    deadline: number,
    userId: EntryId,
    userRole: DbRole,
    fn: (input: I, step: StepRunner) => Promise<O>,
    params: I
  ): Promise<O> => {
    const env = this.#corge.env
    const now = Date.now()
    const wfCtx: WorkflowContext = {
      taskId: 'inline',
      workflowName,
      attempt: 1,
      startedAt: now,
      deadlineMs: now + deadline * 1000,
      signal: new AbortController().signal
    }
    const step = this.#steps.createStepRunner(mode, undefined, {}, undefined, {
      isDev: env.isDev,
      workflowContext: wfCtx,
      canYield: false
    })
    try {
      return await this.runWithWorkflowContext({ workflow: wfCtx, step, env }, () =>
        this.#corge.internals.context.run({ env, userId, role: userRole, step }, () => fn(params, step))
      )
    } catch (err) {
      await step.compensate()
      if (err instanceof this.#corge.errors.NonRetryableError) {
        return this.#corge.errors.httpError(400, err.message, err.code ?? 'NON_RETRYABLE_ERROR')
      }
      const msg = err instanceof Error ? err.message : String(err)
      return this.#corge.errors.httpError(502, msg, 'WORKFLOW_ERROR')
    }
  }

  #initOrReuseTaskDoc = async <O>(
    db: Firestore,
    docRef: DocumentReference,
    deterministicId: string | undefined,
    workflowName: string,
    params: unknown,
    userId: EntryId,
    userRole: DbRole
  ): Promise<{ settled: true; response: O } | { settled: false; shouldDispatch: boolean }> => {
    const nowMs = Date.now()
    const nowIso = new Date(nowMs).toISOString()
    const initialTaskDoc = {
      taskId: docRef.id,
      workflowName,
      status: 'running',
      epoch: 0,
      activeRunId: null,
      compensatedSteps: {},
      params: (params ?? {}) as Record<string, unknown>,
      steps: {},
      userId,
      userRole,
      keepAlive: true,
      lastHeartbeatAt: nowMs,
      createdAt: nowIso,
      updatedAt: nowIso,
      expiresAt: Timestamp.fromMillis(nowMs + CORGE_CONFIG.tasks.ttlMs)
    }

    if (!deterministicId) {
      await docRef.set(initialTaskDoc)
      return { settled: false, shouldDispatch: true }
    }

    let shouldDispatch = true
    const existingOutcome = await db.runTransaction(async (tx) => {
      const data = (await tx.get(docRef)).data()
      if (data?.status === 'completed') return { settled: true as const, response: data.response as O }
      if (['running', 'sleeping', 'waiting_signal', 'compensating'].includes(String(data?.status))) {
        shouldDispatch = false
        return { settled: false as const }
      }
      tx.set(docRef, initialTaskDoc)
      return { settled: false as const }
    })
    return existingOutcome.settled ? existingOutcome : { settled: false, shouldDispatch }
  }

  dispatch = async <I, O>(
    workflowName: string,
    fn: (input: I, step: StepRunner) => Promise<O>,
    params: I,
    opts?: DispatchWorkflowOptions
  ): Promise<O> => {
    const env = this.#corge.env
    const mode = opts?.mode ?? 'workflow'
    const explicitDeadline = opts?.timeout
      ? Math.max(
          15,
          Math.ceil(this.#corge.errors.parseDuration(opts.timeout, CORGE_CONFIG.tasks.defaultDeadlineSeconds * 1000) / 1000)
        )
      : undefined
    const deadline = resolveTaskDeadline(workflowName, explicitDeadline)
    const useQueue = mode !== 'rest' && CORGE_CONFIG.tasks.useCloudTasks
    const userId = opts?.userId ?? this.#corge.userId ?? CORGE_CONFIG.auth.adminUserId
    const userRole = this.#corge.internals.auth.resolveUserRole(userId, opts?.userRole ?? this.#corge.role)

    const db = this.#corge.db.firestore(env.isDev)
    const deterministicId = opts?.dedupeKey
      ? `dedupe_${createHash('sha256').update(`${workflowName}:${opts.dedupeKey}`).digest('hex').slice(0, 24)}`
      : undefined

    if (!useQueue && opts?.wait !== false && !deterministicId && opts?.maxWaitMs === undefined) {
      return this.#dispatchInline(workflowName, mode, deadline, userId, userRole, fn, params)
    }

    const docRef = deterministicId ? db.collection('_tasks').doc(deterministicId) : db.collection('_tasks').doc()
    const taskId = docRef.id
    const keepAlive = Boolean(deterministicId || opts?.wait === false || opts?.maxWaitMs !== undefined)
    const initRes = await this.#initOrReuseTaskDoc<O>(db, docRef, deterministicId, workflowName, params, userId, userRole)
    if (initRes.settled) {
      return opts?.wait === false
        ? ({ taskId } as unknown as O)
        : await this.#steps.maybeHydrateStepValue<O>(initRes.response, Boolean(env.isDev))
    }

    const payload: WorkflowTaskPayload = {
      taskId,
      workflowName,
      params: (params ?? {}) as Record<string, unknown>,
      isDev: Boolean(env.isDev),
      expectedEpoch: 0
    }
    const dispatchFn = () =>
      useQueue
        ? this.#watcher.enqueueBatched(payload, deadline)
        : this.execute(payload, {
            ...activeRegistry,
            [workflowName]: { mode, deadlineSeconds: deadline, runTask: fn as any }
          })

    if (opts?.wait === false) {
      if (initRes.shouldDispatch) void dispatchFn().catch(() => {})
      return { taskId } as unknown as O
    }

    const record = await this.#watcher.watchTask<O>(taskId, {
      isDev: Boolean(env.isDev),
      docRef,
      workflowName,
      hedgeable: workflowName === 'scan-attachment',
      keepAlive,
      timeoutMs: CORGE_CONFIG.tasks.timeoutMs,
      ...(opts?.maxWaitMs !== undefined ? { maxWaitMs: opts.maxWaitMs } : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
      ...(initRes.shouldDispatch ? { dispatch: dispatchFn } : {})
    })
    return this.#unwrapTaskRecord(record)
  }

  #commitCompletion = async (opts: {
    db: Firestore
    docRef: DocumentReference
    baseMeta: Record<string, unknown>
    taskId: string
    claimedEpoch: number
    response: unknown
    steps: Record<string, unknown>
    expiresAt: Timestamp
    isDev: boolean
  }): Promise<void> => {
    const stored = await this.#steps.maybeOffloadStepValue(opts.docRef, '__response', opts.response, opts.isDev)
    await commitTaskCompletionTx(opts.db, opts.docRef, opts.baseMeta, opts.taskId, opts.claimedEpoch, stored, opts.steps, opts.expiresAt)
  }

  #commitYieldAndEnqueue = async (opts: {
    db: Firestore
    docRef: DocumentReference
    baseMeta: Record<string, unknown>
    taskId: string
    workflowName: string
    claimedEpoch: number
    err: TaskYieldSignal
    effectiveParams: Record<string, unknown>
    steps: Record<string, unknown>
    expiresAt: Timestamp
    isDev: boolean
    useQueue: boolean
    deadlineSeconds: number
  }): Promise<void> => {
    const nextEpoch = opts.claimedEpoch + 1
    const nextParams =
      opts.err.reason === 'continue_as_new'
        ? ((opts.err.meta.newInput ?? {}) as Record<string, unknown>)
        : opts.effectiveParams
    const nextSteps = opts.err.reason === 'continue_as_new' ? {} : opts.steps
    const nextStatus =
      opts.err.reason === 'sleeping' ? 'sleeping' : opts.err.reason === 'waiting_signal' ? 'waiting_signal' : 'running'
    await commitTaskYieldTx(opts.db, opts.docRef, opts.baseMeta, opts.taskId, opts.claimedEpoch, opts.err, nextEpoch, nextParams, nextSteps, nextStatus, opts.expiresAt)
    if (!opts.useQueue) return
    const nextPayload: WorkflowTaskPayload = {
      taskId: opts.taskId,
      workflowName: opts.workflowName,
      params: nextParams,
      isDev: opts.isDev,
      expectedEpoch: nextEpoch
    }
    if (opts.err.reason === 'continue_as_new' || opts.err.reason === 'yield') {
      await this.#watcher.enqueueBatched(nextPayload, opts.deadlineSeconds)
    } else if (opts.err.reason === 'sleeping') {
      await this.#watcher.enqueueBatched(nextPayload, opts.deadlineSeconds, opts.err.meta.delaySeconds ?? 1)
    } else if (opts.err.reason === 'waiting_signal' && opts.err.meta.timeoutMs && opts.err.meta.timeoutMs > 0) {
      await this.#watcher.enqueueBatched(nextPayload, opts.deadlineSeconds, Math.ceil(opts.err.meta.timeoutMs / 1000))
    }
  }

  #commitErrorAndCompensate = async (opts: {
    db: Firestore
    docRef: DocumentReference
    baseMeta: Record<string, unknown>
    taskId: string
    claimedEpoch: number
    err: unknown
    step: StepRunner
    steps: Record<string, unknown>
    expiresAt: Timestamp
  }): Promise<void> => {
    const error = opts.err instanceof Error ? opts.err.message : String(opts.err)
    const nonRetryable = opts.err instanceof this.#corge.errors.NonRetryableError
    const errorCode =
      opts.err instanceof this.#corge.errors.NonRetryableError ? (opts.err.code ?? 'NON_RETRYABLE_ERROR') : undefined

    await commitTaskCompensatingTx(opts.db, opts.docRef, opts.taskId, opts.claimedEpoch, opts.expiresAt)
    await opts.step.compensate()
    await setTaskDoc(opts.docRef, {
      ...opts.baseMeta,
      status: 'errored',
      activeRunId: null,
      error,
      ...(nonRetryable ? { nonRetryable: true, errorCode } : {}),
      steps: opts.steps,
      updatedAt: new Date().toISOString(),
      expiresAt: opts.expiresAt
    })
  }

  #runSingleAttempt = async (
    db: Firestore,
    docRef: DocumentReference,
    payload: WorkflowTaskPayload,
    wf: WorkflowRuntimeEntry,
    attempt: number,
    deadlineSeconds: number,
    useQueue: boolean,
    canYield: boolean
  ): Promise<boolean> => {
    const { taskId, workflowName, isDev: rawIsDev } = payload
    const isDev = Boolean(rawIsDev)
    const claim = await claimTaskEpochTx(db, docRef, payload, attempt, this.#corge.internals.auth.resolveUserRole)
    if (claim.aborted) return true

    const { claimedEpoch, startedAt, expiresAt, effectiveParams, userId, userRole, steps, signals, compensatedSteps } =
      claim
    const baseMeta = { taskId, workflowName, userId, userRole }
    const env = { ...this.#corge.env, isDev }
    const controller = new AbortController()
    const wfCtx: WorkflowContext = {
      taskId,
      workflowName,
      attempt: attempt + 1,
      startedAt,
      deadlineMs: startedAt + deadlineSeconds * 1000,
      signal: controller.signal
    }
    const step = this.#steps.createStepRunner(wf.mode, docRef, steps, expiresAt, {
      isDev,
      signals,
      workflowContext: wfCtx,
      canYield,
      claimedEpoch,
      abortController: controller,
      compensatedSteps
    })

    this.registerActiveTaskExecution({ taskId, step, controller, claimedEpoch })
    const hbTimer = startTaskHeartbeatTimer(db, docRef, taskId, claimedEpoch, expiresAt, controller)

    try {
      const response = await this.runWithWorkflowContext({ workflow: wfCtx, step, env }, () =>
        this.#corge.internals.context.run({ env, userId, role: userRole, step }, () => wf.runTask(effectiveParams, step))
      )
      await step.flush()
      await this.#commitCompletion({ db, docRef, baseMeta, taskId, claimedEpoch, response, steps, expiresAt, isDev })
      return true
    } catch (err) {
      if (this.#corge.errors.isStaleWorkerEpochError(err)) throw err
      if (isTaskYieldSignal(err)) {
        await step.flush()
        await this.#commitYieldAndEnqueue({ db, docRef, baseMeta, taskId, workflowName, claimedEpoch, err, effectiveParams, steps, expiresAt, isDev, useQueue, deadlineSeconds })
        return true
      }
      if (this.#corge.errors.isNonRetryableError(err) || attempt >= CORGE_CONFIG.tasks.maxAttempts - 1) {
        await this.#commitErrorAndCompensate({ db, docRef, baseMeta, taskId, claimedEpoch, err, step, steps, expiresAt })
        return true
      }
      await step.flush()
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
      return false
    } finally {
      clearInterval(hbTimer)
      this.unregisterActiveTaskExecution(taskId, step)
    }
  }

  execute = async (
    payload: WorkflowTaskPayload,
    workflowRegistry: Record<string, WorkflowRuntimeEntry> = activeRegistry,
    execOpts?: ExecuteWorkflowTaskOptions
  ): Promise<void> => {
    const { taskId, workflowName, isDev } = payload
    const db = this.#corge.db.firestore(Boolean(isDev))
    const docRef = db.collection('_tasks').doc(taskId)
    const wf = workflowRegistry[workflowName]

    if (!wf) {
      await setTaskDoc(docRef, {
        taskId,
        workflowName,
        status: 'errored',
        error: `Unknown workflow: ${workflowName}`,
        expiresAt: Timestamp.fromMillis(Date.now() + CORGE_CONFIG.tasks.ttlMs)
      })
      return
    }

    const deadlineSeconds = resolveTaskDeadline(workflowName, wf.deadlineSeconds)
    const useQueue = CORGE_CONFIG.tasks.useCloudTasks
    const canYield = execOpts?.canYield ?? useQueue

    for (let attempt = 0; attempt < CORGE_CONFIG.tasks.maxAttempts; attempt++) {
      const done = await this.#runSingleAttempt(db, docRef, payload, wf, attempt, deadlineSeconds, useQueue, canYield)
      if (done) return
    }
  }
}
