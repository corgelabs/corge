import { Timestamp, type DocumentReference } from 'firebase-admin/firestore'
import { CORGE_CONFIG } from '../config'
import type { Corge } from '../index'
import {
  StaleWorkerEpochError,
  type StepRunner,
  type TaskStatusRecord,
  type WorkflowContext,
  type WorkflowRuntimeEntry
} from './schema'
import { TaskStepsEngine } from './steps'
import { resolveTaskDeadline } from './utils'
import { TaskWatcherEngine } from './watcher'
import { TaskWorkerEngine } from './worker'

export class TasksService {
  readonly #corge: Corge
  readonly #worker: TaskWorkerEngine
  readonly #steps: TaskStepsEngine
  readonly #watcher: TaskWatcherEngine

  constructor(corgeClient: Corge) {
    this.#corge = corgeClient
    this.#worker = new TaskWorkerEngine(corgeClient)
    this.#steps = new TaskStepsEngine(corgeClient, this.#worker.invokeChildWorkflow)
    this.#watcher = new TaskWatcherEngine(corgeClient, this.#steps)
    this.#worker.bindEngines(this.#steps, this.#watcher)
  }

  #useStep = (): StepRunner => {
    const store = this.#worker.getActiveWorkflowStore()
    return store?.step ?? this.#steps.createStepRunner('workflow')
  }

  #assertTaskOwnership = (data: Record<string, unknown> | undefined): void => {
    if (!data) throw this.#corge.errors.httpError(404, 'Task not found', 'NOT_FOUND')
    const caller = this.#corge.caller
    if (!caller || caller.role === 'admin' || caller.userId === CORGE_CONFIG.auth.adminUserId) return
    if (typeof data.userId === 'string' && data.userId !== caller.userId) {
      throw this.#corge.errors.httpError(403, 'Forbidden', 'FORBIDDEN')
    }
  }

  status = async <O = unknown>(taskId: string): Promise<TaskStatusRecord<O>> => {
    const isDev = Boolean(this.#corge.env.isDev)
    const snap = await this.#corge.db.firestore(isDev).collection('_tasks').doc(taskId).get()
    const data = snap.exists ? (snap.data() as Record<string, unknown>) : undefined
    this.#assertTaskOwnership(data)
    const response =
      'response' in data! ? await this.#steps.maybeHydrateStepValue<O>(data!.response, isDev) : undefined
    return {
      taskId,
      workflowName: String(data!.workflowName ?? ''),
      status: (data!.status as TaskStatusRecord['status']) ?? 'running',
      ...(typeof data!.userId === 'string' ? { userId: data!.userId } : {}),
      ...(typeof data!.epoch === 'number' ? { epoch: data!.epoch } : {}),
      ...('activeRunId' in data! ? { activeRunId: (data!.activeRunId as string | null) ?? null } : {}),
      ...(typeof data!.lastHeartbeatAt === 'number' ? { lastHeartbeatAt: data!.lastHeartbeatAt } : {}),
      ...(data!.compensatedSteps
        ? { compensatedSteps: data!.compensatedSteps as Record<string, boolean> }
        : {}),
      ...(data!.progress ? { progress: data!.progress as TaskStatusRecord['progress'] } : {}),
      ...('response' in data! ? { response: response as O } : {}),
      ...(typeof data!.error === 'string' ? { error: data!.error } : {}),
      ...(typeof data!.createdAt === 'string' ? { createdAt: data!.createdAt } : {}),
      ...(typeof data!.updatedAt === 'string' ? { updatedAt: data!.updatedAt } : {})
    }
  }

  signal = async (
    taskId: string,
    signalName: string,
    payload?: unknown
  ): Promise<{ taskId: string; signaled: true }> => {
    const isDev = Boolean(this.#corge.env.isDev)
    const db = this.#corge.db.firestore(isDev)
    const docRef = db.collection('_tasks').doc(taskId)

    const outcome = await db.runTransaction(async (tx) => {
      const snap = await tx.get(docRef)
      const data = snap.exists ? (snap.data() as Record<string, unknown>) : undefined
      this.#assertTaskOwnership(data)

      const workflowName = String(data!.workflowName ?? '')
      const params = (data!.params as Record<string, unknown> | undefined) ?? {}
      const signals = {
        ...((data!.signals as Record<string, unknown> | undefined) ?? {}),
        [signalName]: payload ?? true
      }
      const wasWaiting = data!.status === 'waiting_signal'
      const currentEpoch = typeof data!.epoch === 'number' ? data!.epoch : 0
      const nextEpoch = wasWaiting ? currentEpoch + 1 : currentEpoch

      tx.set(
        docRef,
        {
          signals,
          ...(wasWaiting ? { status: 'running', waitingSignal: null, epoch: nextEpoch, activeRunId: null } : {}),
          updatedAt: new Date().toISOString()
        },
        { merge: true }
      )
      return { workflowName, params, wasWaiting, nextEpoch }
    })

    if (outcome.wasWaiting) {
      const wf = this.#worker.getRuntime().registry[outcome.workflowName]
      const deadline = resolveTaskDeadline(outcome.workflowName, wf?.deadlineSeconds)
      if (CORGE_CONFIG.tasks.useCloudTasks) {
        await this.#watcher.enqueueBatched(
          {
            taskId,
            workflowName: outcome.workflowName,
            params: outcome.params,
            isDev,
            expectedEpoch: outcome.nextEpoch
          },
          deadline
        )
      } else if (wf) {
        void this.#worker
          .execute({
            taskId,
            workflowName: outcome.workflowName,
            params: outcome.params,
            isDev,
            expectedEpoch: outcome.nextEpoch
          })
          .catch(() => {})
      }
    }
    return { taskId, signaled: true }
  }

  #replayUncompensatedSteps = async (
    taskId: string,
    docRef: DocumentReference,
    freshData: Record<string, unknown>,
    isDev: boolean
  ): Promise<void> => {
    const stepsMap = { ...((freshData.steps as Record<string, unknown> | undefined) ?? {}) }
    const compMap = { ...((freshData.compensatedSteps as Record<string, boolean> | undefined) ?? {}) }
    const workflowName = String(freshData.workflowName ?? '')
    const wf: WorkflowRuntimeEntry | undefined = this.#worker.getRuntime().registry[workflowName]
    if (!wf || !Object.keys(stepsMap).some((k) => !compMap[k])) return

    const effectiveEnv = this.#corge.env
    const expiresAt = Timestamp.fromMillis(Date.now() + CORGE_CONFIG.tasks.ttlMs)
    const now = Date.now()
    const wfCtx: WorkflowContext = {
      taskId,
      workflowName,
      attempt: 1,
      startedAt: now,
      deadlineMs: now + 60_000,
      signal: new AbortController().signal
    }
    const replayStep = this.#steps.createStepRunner(wf.mode, docRef, stepsMap, expiresAt, {
      isDev,
      workflowContext: wfCtx,
      canYield: false,
      compensatedSteps: compMap,
      replayOnly: true
    })
    const params = (freshData.params as Record<string, unknown> | undefined) ?? {}
    try {
      await this.#worker.runWithWorkflowContext({ workflow: wfCtx, step: replayStep, env: effectiveEnv }, () =>
        this.#corge.internals.context.run(
          { env: effectiveEnv, userId: this.#corge.userId, role: this.#corge.role, step: replayStep },
          () => wf.runTask(params, replayStep)
        )
      )
    } catch {}
    await replayStep.compensate()
  }

  cancel = async (taskId: string): Promise<{ taskId: string; status: 'cancelled' }> => {
    const isDev = Boolean(this.#corge.env.isDev)
    const db = this.#corge.db.firestore(isDev)
    const docRef = db.collection('_tasks').doc(taskId)
    const preActiveExec = this.#worker.getActiveTaskExecution(taskId)

    const txResult = await db.runTransaction(async (tx) => {
      const snap = await tx.get(docRef)
      const data = snap.exists ? (snap.data() as Record<string, unknown>) : undefined
      this.#assertTaskOwnership(data)

      const currentStatus = data!.status as string | undefined
      if (currentStatus === 'completed' || currentStatus === 'errored' || currentStatus === 'cancelled') {
        return { alreadyTerminal: true as const, data: data! }
      }

      const currentEpoch = typeof data!.epoch === 'number' ? data!.epoch : 0
      const nextEpoch = currentEpoch + 1
      tx.set(
        docRef,
        {
          status: 'compensating',
          epoch: nextEpoch,
          activeRunId: null,
          updatedAt: new Date().toISOString()
        },
        { merge: true }
      )
      return { alreadyTerminal: false as const, nextEpoch, data: data! }
    })

    if (!txResult.alreadyTerminal) {
      const activeExec = preActiveExec ?? this.#worker.getActiveTaskExecution(taskId)
      if (activeExec) {
        activeExec.controller.abort(
          new StaleWorkerEpochError(`Task ${taskId} cancelled by caller`, {
            taskId,
            claimedEpoch: activeExec.claimedEpoch,
            actualEpoch: txResult.nextEpoch
          })
        )
        await activeExec.step.compensate()
      }

      const freshSnap = await docRef.get().catch(() => null)
      const freshData = (freshSnap?.data() as Record<string, unknown> | undefined) ?? txResult.data
      await this.#replayUncompensatedSteps(taskId, docRef, freshData, isDev)

      await docRef.set(
        {
          status: 'cancelled',
          activeRunId: null,
          error: 'Cancelled by caller',
          updatedAt: new Date().toISOString()
        },
        { merge: true }
      )
    }

    return { taskId, status: 'cancelled' }
  }

  get internals() {
    return {
      createStepRunner: this.#steps.createStepRunner,
      allWithRollback: this.#steps.allWithRollback,
      getContext: this.#worker.getContext,
      useStep: this.#useStep,
      getActiveWorkflowStore: this.#worker.getActiveWorkflowStore,
      dispatch: this.#worker.dispatch,
      execute: this.#worker.execute,
      registerRuntime: this.#worker.registerRuntime,
      getRuntime: this.#worker.getRuntime,
      watchTask: this.#watcher.watchTask,
      getActiveWatcherCount: this.#watcher.getActiveWatcherCount
    }
  }
}
