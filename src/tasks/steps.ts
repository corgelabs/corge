import type { DocumentReference, Timestamp } from 'firebase-admin/firestore'
import { CORGE_CONFIG } from '../config'
import type { Corge } from '../index'
import type { RouteMode } from '../router'
import type { Duration } from '../utils'
import {
  ReplayCompleteSignal,
  TaskYieldSignal,
  type ClaimCheckPointer,
  type CreateStepRunnerOptions,
  type RollbackLeg,
  type StepContext,
  type StepFn,
  type StepMapOptions,
  type StepOptions,
  type StepRetryPolicy,
  type StepRunner,
  type StepSpec,
  type TaskProgressUpdate,
  type WorkflowContext,
  type WorkflowTargetRef
} from './schema'
import {
  createStaleEpochError,
  executeCompensateState,
  isClaimCheckPointer,
  isFencedOut,
  resolveTargetName,
  runSerializedCompensation,
  runStepWithRetry,
  type StepRunnerState
} from './utils'

const CUMULATIVE_STEPS_THRESHOLD_BYTES = 150 * 1024

export class TaskStepsEngine {
  readonly #corge: Corge
  readonly #invokeChildWorkflow: (
    targetName: string,
    input: unknown,
    options?: { timeout?: Duration; dedupeKey?: string; wait?: boolean }
  ) => Promise<any>

  constructor(
    corgeClient: Corge,
    invokeChildWorkflow: (
      targetName: string,
      input: unknown,
      options?: { timeout?: Duration; dedupeKey?: string; wait?: boolean }
    ) => Promise<any>
  ) {
    this.#corge = corgeClient
    this.#invokeChildWorkflow = invokeChildWorkflow
  }

  maybeOffloadStepValue = async (
    docRef: DocumentReference | undefined,
    stepId: string,
    val: unknown,
    isDev = false,
    forceOffload = false
  ): Promise<unknown> => {
    if (!docRef || val === undefined || val === null || isClaimCheckPointer(val)) return val
    try {
      const json = JSON.stringify(val)
      if (!json) return val
      if (!forceOffload && Buffer.byteLength(json, 'utf8') <= CORGE_CONFIG.tasks.claimCheckThresholdBytes) {
        return val
      }
      const gcsPath = `_tasks/${docRef.id}/steps/${encodeURIComponent(stepId)}.json`
      await this.#corge.db
        .bucket(isDev)
        .file(gcsPath)
        .save(Buffer.from(json, 'utf8'), {
          resumable: false,
          validation: false,
          contentType: 'application/json'
        })
      return { __claimCheck: gcsPath } satisfies ClaimCheckPointer
    } catch {
      return val
    }
  }

  maybeHydrateStepValue = async <T>(raw: unknown, isDev = false): Promise<T> => {
    if (!isClaimCheckPointer(raw)) return raw as T
    const [buf] = await this.#corge.db.bucket(isDev).file(raw.__claimCheck).download()
    return JSON.parse(buf.toString('utf8')) as T
  }

  allWithRollback = async <T extends readonly unknown[]>(
    legs: { [K in keyof T]: RollbackLeg<T[K]> }
  ): Promise<T> => {
    const settled = await Promise.allSettled(legs.map((l) => l.fn()))
    const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected')
    if (failed) {
      await Promise.allSettled(
        settled.map((s, i) => (s.status === 'fulfilled' && legs[i]?.rollback ? legs[i]!.rollback!(s.value) : undefined))
      )
      throw failed.reason
    }
    return settled.map((s) => (s as PromiseFulfilledResult<unknown>).value) as unknown as T
  }

  #assertNotFenced = (s: StepRunnerState): void => {
    if (s.fencedError) throw s.fencedError
    if (s.wfCtx?.signal?.aborted && this.#corge.errors.isStaleWorkerEpochError(s.wfCtx.signal.reason)) {
      s.fencedError = s.wfCtx.signal.reason
      throw s.fencedError
    }
  }

  #triggerFenceAbort = (s: StepRunnerState, actualEpoch?: number, status?: string): never => {
    if (!s.fencedError) {
      s.fencedError = createStaleEpochError(s.docRef?.id, s.claimedEpoch, actualEpoch, status)
    }
    s.abortController?.abort(s.fencedError)
    throw s.fencedError
  }

  #runFencedPersistOnce = async (s: StepRunnerState): Promise<void> => {
    if (!s.docRef) return
    this.#assertNotFenced(s)
    try {
      if (Buffer.byteLength(JSON.stringify(s.steps), 'utf8') > CUMULATIVE_STEPS_THRESHOLD_BYTES) {
        for (const [k, v] of Object.entries(s.steps)) {
          if (v !== undefined && v !== null && typeof v === 'object' && !isClaimCheckPointer(v)) {
            s.steps[k] = await this.maybeOffloadStepValue(s.docRef, k, v, s.isDev, true)
          }
        }
      }
    } catch {}

    const docRef = s.docRef
    await docRef.firestore.runTransaction(async (tx) => {
      const snap = await tx.get(docRef)
      const data = snap.data()
      const docEpoch = typeof data?.epoch === 'number' ? data.epoch : undefined
      const docStatus = typeof data?.status === 'string' ? data.status : undefined
      if (s.claimedEpoch === undefined && docEpoch !== undefined) s.claimedEpoch = docEpoch
      if (isFencedOut(s.claimedEpoch, docEpoch, docStatus)) {
        this.#triggerFenceAbort(s, docEpoch, docStatus)
      }
      const patch: Record<string, unknown> = {
        steps: { ...s.steps },
        lastHeartbeatAt: Date.now(),
        ...(s.expiresAt ? { expiresAt: s.expiresAt } : {})
      }
      tx.set(docRef, patch, { mergeFields: Object.keys(patch) })
    })
  }

  #persistSteps = (s: StepRunnerState): Promise<void> => {
    if (!s.docRef) return Promise.resolve()
    this.#assertNotFenced(s)
    if (s.activePersistPromise) {
      s.pendingPersist = true
      return s.activePersistPromise
    }
    const loop = (async () => {
      try {
        do {
          s.pendingPersist = false
          await this.#runFencedPersistOnce(s)
        } while (s.pendingPersist && !s.fencedError)
      } finally {
        s.activePersistPromise = null
      }
    })()
    s.activePersistPromise = loop
    s.writes.push(loop.catch(() => {}))
    return loop
  }

  #executeSingleStep = async <T>(
    s: StepRunnerState,
    flushFn: () => Promise<unknown>,
    stepId: string,
    fnOrSpec: StepSpec<T>,
    options?: StepOptions<T>
  ): Promise<T> => {
    this.#assertNotFenced(s)
    const fn = typeof fnOrSpec === 'function' ? fnOrSpec : fnOrSpec.fn
    const rollback = options?.rollback ?? (typeof fnOrSpec === 'function' ? undefined : fnOrSpec.rollback)
    const retry = options?.retry ?? (typeof fnOrSpec === 'function' ? undefined : fnOrSpec.retry)
    const timeout = options?.timeout ?? (typeof fnOrSpec === 'function' ? undefined : fnOrSpec.timeout)

    const registerRollback = (val: T) => {
      if (!rollback) return
      const idx = s.rollbacks.findIndex((r) => r.name === stepId)
      if (idx !== -1) s.rollbacks.splice(idx, 1)
      s.rollbacks.push({ name: stepId, run: () => rollback(val) })
    }

    if (stepId in s.steps) {
      const cached = await this.maybeHydrateStepValue<T>(s.steps[stepId], s.isDev)
      registerRollback(cached)
      return cached
    }
    if (s.replayOnly) throw new ReplayCompleteSignal()

    if (s.canYield && s.wfCtx) {
      const budgetMs = (s.wfCtx.deadlineMs - s.wfCtx.startedAt) * CORGE_CONFIG.tasks.yieldBudgetRatio
      if (budgetMs > 0 && Date.now() - s.wfCtx.startedAt > budgetMs) {
        await flushFn()
        throw new TaskYieldSignal('yield', { delaySeconds: 0 })
      }
    }
    this.#assertNotFenced(s)

    const val = await (s.mode !== 'rest' || retry !== undefined || timeout !== undefined
      ? runStepWithRetry(
          fn,
          retry ?? (s.mode !== 'rest' ? 2 : 0),
          1000,
          stepId,
          timeout,
          s.wfCtx?.signal,
          this.#corge.errors.parseDuration,
          this.#corge.errors.isNonRetryableError
        )
      : fn({ signal: s.wfCtx?.signal ?? new AbortController().signal, attempt: 1, stepId }))

    this.#assertNotFenced(s)
    s.steps[stepId] = await this.maybeOffloadStepValue(s.docRef, stepId, val, s.isDev)
    if (s.docRef) {
      try {
        await this.#persistSteps(s)
      } catch (err) {
        if (this.#corge.errors.isStaleWorkerEpochError(err)) {
          delete s.steps[stepId]
          throw err
        }
      }
    }
    registerRollback(val)
    return val
  }

  #mapStep = async <T, R>(
    s: StepRunnerState,
    flushFn: () => Promise<unknown>,
    stepId: string,
    items: readonly T[],
    fn: (item: T, index: number, ctx: StepContext) => Promise<R>,
    options?: StepMapOptions<T, R>
  ): Promise<R[]> => {
    if (items.length === 0) return []
    if (stepId in s.steps) return this.maybeHydrateStepValue<R[]>(s.steps[stepId], s.isDev)

    const results = new Array<R>(items.length)
    const pendingIndices: number[] = []

    if (options?.shortCircuit) {
      const checks = await Promise.all(items.map((item, idx) => options.shortCircuit!(item, idx)))
      for (let i = 0; i < items.length; i++) {
        if (checks[i] !== undefined) results[i] = checks[i]!
        else pendingIndices.push(i)
      }
    } else {
      for (let i = 0; i < items.length; i++) pendingIndices.push(i)
    }

    if (pendingIndices.length > 0) {
      const concurrency = Math.max(1, options?.concurrency ?? CORGE_CONFIG.tasks.defaultShardsCount)
      let cursor = 0
      const workers = Array.from({ length: Math.min(concurrency, pendingIndices.length) }, async () => {
        while (cursor < pendingIndices.length) {
          const idx = pendingIndices[cursor++]!
          results[idx] = await this.#executeSingleStep(
            s,
            flushFn,
            `${stepId}:${idx}`,
            (ctx) => fn(items[idx]!, idx, ctx),
            options
          )
        }
      })
      await Promise.all(workers)
    }

    for (const idx of pendingIndices) delete s.steps[`${stepId}:${idx}`]
    s.steps[stepId] = await this.maybeOffloadStepValue(s.docRef, stepId, results, s.isDev, items.length > 25)
    if (s.docRef) await this.#persistSteps(s)
    return results
  }

  #waitForSignalStep = async <T = unknown>(
    s: StepRunnerState,
    flushFn: () => Promise<unknown>,
    stepId: string,
    signalName: string,
    options?: { timeout?: Duration }
  ): Promise<T> => {
    this.#assertNotFenced(s)
    if (stepId in s.steps) return this.maybeHydrateStepValue<T>(s.steps[stepId], s.isDev)
    if (s.replayOnly) throw new ReplayCompleteSignal()
    if (signalName in s.signals) {
      const payload = s.signals[signalName] as T
      s.steps[stepId] = await this.maybeOffloadStepValue(s.docRef, stepId, payload, s.isDev)
      if (s.docRef) await this.#persistSteps(s)
      return payload
    }
    if (s.docRef) {
      const freshSnap = await s.docRef.get().catch(() => null)
      const freshSignals = (freshSnap?.data()?.signals as Record<string, unknown> | undefined) ?? {}
      if (signalName in freshSignals) {
        const payload = freshSignals[signalName] as T
        s.steps[stepId] = await this.maybeOffloadStepValue(s.docRef, stepId, payload, s.isDev)
        await this.#persistSteps(s)
        return payload
      }
      const timeoutKey = `__signal_deadline:${stepId}`
      const timeoutMs = options?.timeout ? this.#corge.errors.parseDuration(options.timeout, 0) : 0
      const now = Date.now()
      const existingDeadline = typeof s.steps[timeoutKey] === 'number' ? (s.steps[timeoutKey] as number) : undefined
      if (existingDeadline && now >= existingDeadline) {
        throw this.#corge.errors.nonRetryableError(`Timed out waiting for signal "${signalName}"`, 'SIGNAL_TIMEOUT')
      }
      if (!existingDeadline && timeoutMs > 0) {
        s.steps[timeoutKey] = now + timeoutMs
        await this.#persistSteps(s)
      }
      if (s.canYield) {
        await flushFn()
        throw new TaskYieldSignal('waiting_signal', {
          signalName,
          ...(timeoutMs > 0 ? { timeoutMs: existingDeadline ? Math.max(1000, existingDeadline - now) : timeoutMs } : {})
        })
      }
    }
    throw this.#corge.errors.nonRetryableError(`Signal "${signalName}" not received`, 'SIGNAL_TIMEOUT')
  }

  #invokeChildStep = <I, O>(
    s: StepRunnerState,
    flush: () => Promise<PromiseSettledResult<unknown>[]>,
    step: StepFn,
    stepId: string,
    target: string | WorkflowTargetRef<I, any>,
    input: I,
    options: { timeout?: Duration; dedupeKey?: string } | undefined,
    wait: boolean
  ): Promise<O> =>
    this.#executeSingleStep(s, flush, stepId, async () => {
      if (wait && typeof target === 'object' && target.handler && !target.workflowName) {
        return target.handler({ input, step })
      }
      const workflowName = resolveTargetName(target)
      const timeout = options?.timeout ?? (typeof target === 'object' ? target.timeout : undefined)
      return this.#invokeChildWorkflow(workflowName, input, {
        ...(timeout !== undefined ? { timeout } : {}),
        ...(options?.dedupeKey ? { dedupeKey: options.dedupeKey } : {}),
        wait
      }) as Promise<O>
    })

  #sleepStep = async (
    s: StepRunnerState,
    flush: () => Promise<PromiseSettledResult<unknown>[]>,
    stepId: string,
    duration: Duration
  ): Promise<void> => {
    this.#assertNotFenced(s)
    if (s.steps[stepId] === true) return
    if (s.replayOnly) throw new ReplayCompleteSignal()
    const ms = Math.max(0, this.#corge.errors.parseDuration(duration, 0))
    if (!s.canYield || ms <= 2_000) {
      if (ms > 0) await new Promise((r) => setTimeout(r, ms))
      s.steps[stepId] = true
      if (s.docRef) await this.#persistSteps(s)
      return
    }
    s.steps[stepId] = true
    await this.#persistSteps(s)
    await flush()
    throw new TaskYieldSignal('sleeping', { delaySeconds: Math.ceil(ms / 1000) })
  }

  #progressStep = async (s: StepRunnerState, update: TaskProgressUpdate): Promise<void> => {
    this.#assertNotFenced(s)
    if (!s.docRef || !s.expiresAt) return
    const ref = s.docRef
    const p = ref.firestore
      .runTransaction(async (tx) => {
        const data = (await tx.get(ref)).data()
        const docEpoch = typeof data?.epoch === 'number' ? data.epoch : undefined
        const docStatus = typeof data?.status === 'string' ? data.status : undefined
        if (isFencedOut(s.claimedEpoch, docEpoch, docStatus)) this.#triggerFenceAbort(s, docEpoch, docStatus)
        tx.set(ref, { progress: update, updatedAt: new Date().toISOString(), expiresAt: s.expiresAt }, { merge: true })
      })
      .catch((err) => {
        if (this.#corge.errors.isStaleWorkerEpochError(err)) throw err
      })
    s.writes.push(p)
    await p
  }

  #flushSteps = async (s: StepRunnerState): Promise<PromiseSettledResult<unknown>[]> => {
    this.#assertNotFenced(s)
    if (s.docRef && s.claimedEpoch !== undefined && s.writes.length === 0) await this.#persistSteps(s)
    const settled = await Promise.allSettled(s.writes)
    for (const item of settled) {
      if (item.status === 'rejected' && this.#corge.errors.isStaleWorkerEpochError(item.reason)) throw item.reason
    }
    this.#assertNotFenced(s)
    return settled
  }

  createStepRunner = (
    mode: RouteMode = 'workflow',
    docRef?: DocumentReference,
    steps: Record<string, unknown> = {},
    expiresAt?: Timestamp,
    runnerOpts?: CreateStepRunnerOptions
  ): StepRunner => {
    const s: StepRunnerState = {
      mode,
      docRef,
      steps,
      expiresAt,
      isDev: Boolean(runnerOpts?.isDev ?? this.#corge.env.isDev),
      signals: runnerOpts?.signals ?? {},
      wfCtx: runnerOpts?.workflowContext,
      canYield: Boolean(runnerOpts?.canYield && docRef && expiresAt && mode === 'workflow'),
      compensatedSteps: runnerOpts?.compensatedSteps ?? {},
      replayOnly: Boolean(runnerOpts?.replayOnly),
      claimedEpoch: runnerOpts?.claimedEpoch,
      fencedError: null,
      activePersistPromise: null,
      pendingPersist: false,
      writes: [],
      rollbacks: [],
      callCounts: new Map<string, number>(),
      abortController: runnerOpts?.abortController
    }

    const nextStepKey = (baseName: string): string => {
      const count = (s.callCounts.get(baseName) ?? 0) + 1
      s.callCounts.set(baseName, count)
      return count === 1 ? baseName : `${baseName}#${count}`
    }

    const flush = (): Promise<PromiseSettledResult<unknown>[]> => this.#flushSteps(s)
    const step: StepFn = <T>(name: string, fnOrSpec: StepSpec<T>, options?: StepOptions<T>): Promise<T> =>
      this.#executeSingleStep(s, flush, nextStepKey(name), fnOrSpec, options)
    const compensate = (): Promise<void> =>
      s.docRef ? runSerializedCompensation(s.docRef.id, () => executeCompensateState(s)) : executeCompensateState(s)

    return Object.assign(step, {
      run: step,
      map: <T, R>(name: string, items: readonly T[], fn: (item: T, index: number, ctx: StepContext) => Promise<R>, options?: StepMapOptions<T, R>): Promise<R[]> =>
        this.#mapStep(s, flush, nextStepKey(name), items, fn, options),
      invoke: <I = unknown, O = unknown>(name: string, target: string | WorkflowTargetRef<I, O>, input: I, options?: { timeout?: Duration; dedupeKey?: string }): Promise<O> =>
        this.#invokeChildStep(s, flush, step, nextStepKey(name), target, input, options, true),
      spawn: <I = unknown>(name: string, target: string | WorkflowTargetRef<I, unknown>, input: I, options?: { dedupeKey?: string; timeout?: Duration }): Promise<{ taskId: string }> =>
        this.#invokeChildStep<I, { taskId: string }>(s, flush, step, nextStepKey(name), target, input, options, false),
      sleep: (name: string, duration: Duration) => this.#sleepStep(s, flush, nextStepKey(name), duration),
      waitForSignal: <T = unknown>(name: string, signalName: string, options?: { timeout?: Duration }): Promise<T> =>
        this.#waitForSignalStep(s, flush, nextStepKey(name), signalName, options),
      continueAsNew: async <I = unknown>(newInput: I): Promise<never> => {
        this.#assertNotFenced(s)
        await flush()
        throw new TaskYieldSignal('continue_as_new', { newInput })
      },
      progress: (update: TaskProgressUpdate) => this.#progressStep(s, update),
      flush,
      compensate,
      onError: compensate
    })
  }
}
