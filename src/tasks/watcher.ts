import type { DocumentReference, DocumentSnapshot } from 'firebase-admin/firestore'
import { CORGE_CONFIG } from '../config'
import type { Corge } from '../index'
import { TaskWaitDetachedSignal, type TaskRecord, type WatchTaskOptions, type WorkflowTaskPayload } from './schema'
import type { TaskStepsEngine } from './steps'
import { getQueueBase, getQueueLoc, getQueueParent, getWorkerUri, isTerminalRecord } from './utils'

type BatchItem = {
  payload: WorkflowTaskPayload
  deadline: number
  scheduleDelaySeconds?: number
  resolve: () => void
  reject: (e: Error) => void
}

type WatchCleanup = {
  unsubscribeSnapshot?: () => void
  pollTimer?: ReturnType<typeof setInterval>
  hedgeTimer?: ReturnType<typeof setTimeout>
  deadlineTimer?: ReturnType<typeof setTimeout>
  detachTimer?: ReturnType<typeof setTimeout>
  onAbort?: () => void
}

const batchQueue: BatchItem[] = []
let flushScheduled = false
let nextShard = 0
let activeWatcherCount = 0

export class TaskWatcherEngine {
  readonly #corge: Corge
  readonly #steps: TaskStepsEngine

  constructor(corgeClient: Corge, steps: TaskStepsEngine) {
    this.#corge = corgeClient
    this.#steps = steps
  }

  getActiveWatcherCount = (): number => activeWatcherCount

  #sendBatch = async (queueParent: string, chunk: BatchItem[]): Promise<void> => {
    await this.#corge.internals.resilience.acquireLimit('workflows', chunk.length)
    const accessToken = await this.#corge.internals.registry.getGcpAccessToken()
    const isDev = Boolean(chunk[0]?.payload.isDev)
    const queueBase = getQueueBase(isDev)
    const shardsCount = Math.max(1, CORGE_CONFIG.tasks.defaultShardsCount)
    const headers = {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'x-goog-user-project': CORGE_CONFIG.gcpProject
    }
    const buildRequests = (parent: string) =>
      chunk.map((i) => {
        const workerUri = getWorkerUri(i.payload.isDev)
        return {
          parent,
          task: {
            dispatchDeadline: `${i.deadline}s`,
            ...(i.scheduleDelaySeconds && i.scheduleDelaySeconds > 0
              ? { scheduleTime: new Date(Date.now() + Math.round(i.scheduleDelaySeconds * 1000)).toISOString() }
              : {}),
            httpRequest: {
              url: workerUri,
              httpMethod: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: Buffer.from(JSON.stringify({ data: i.payload })).toString('base64'),
              oidcToken: { serviceAccountEmail: CORGE_CONFIG.serviceAccount, audience: workerUri }
            }
          }
        }
      })

    let targetParent = queueParent
    let lastErr: Error | null = null
    for (let a = 0; a < 3; a++) {
      try {
        const res = await fetch(`https://cloudtasks.googleapis.com/v2/${targetParent}/tasks:batchCreate`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ requests: buildRequests(targetParent) })
        })
        if (res.status === 404 && targetParent !== queueBase) {
          const createRes = await fetch(`https://cloudtasks.googleapis.com/v2/${getQueueLoc()}/queues`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              name: targetParent,
              rateLimits: { maxDispatchesPerSecond: 500, maxConcurrentDispatches: 1000 }
            })
          }).catch(() => null)
          if (!createRes?.ok) targetParent = getQueueParent(nextShard++ % shardsCount, isDev)
          continue
        }
        if (!res.ok) throw new Error(`Cloud Tasks batchCreate (${res.status}): ${await res.text()}`)
        return chunk.forEach((i) => i.resolve())
      } catch (e) {
        lastErr = e instanceof Error ? e : new Error(String(e))
        if (a < 2) await new Promise((r) => setTimeout(r, 300 * (a + 1)))
      }
    }
    chunk.forEach((i) => i.reject(lastErr!))
  }

  enqueueBatched = (
    payload: WorkflowTaskPayload,
    deadline: number,
    scheduleDelaySeconds?: number
  ): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      batchQueue.push({
        payload,
        deadline,
        ...(scheduleDelaySeconds && scheduleDelaySeconds > 0 ? { scheduleDelaySeconds } : {}),
        resolve,
        reject
      })
      if (!flushScheduled) {
        flushScheduled = true
        queueMicrotask(() => {
          flushScheduled = false
          const shardsCount = Math.max(1, CORGE_CONFIG.tasks.defaultShardsCount)
          const batchSize = Math.max(1, CORGE_CONFIG.tasks.batchCreateSize)
          const byShard = new Map<string, BatchItem[]>()
          for (const item of batchQueue.splice(0)) {
            const parent = getQueueParent(nextShard++ % shardsCount, item.payload.isDev)
            let list = byShard.get(parent)
            if (!list) {
              list = []
              byShard.set(parent, list)
            }
            list.push(item)
          }
          for (const [parent, items] of byShard) {
            while (items.length) void this.#sendBatch(parent, items.splice(0, batchSize))
          }
        })
      }
    })

  #delRefs = (refs: DocumentReference[], isDev: boolean): void => {
    if (!refs.length) return
    const batch = this.#corge.db.firestore(isDev).batch()
    const bucket = this.#corge.db.bucket(isDev)
    refs.forEach((r) => {
      batch.delete(r)
      void bucket.deleteFiles({ prefix: `_tasks/${r.id}/` }).catch(() => {})
    })
    void batch.commit().catch(() => {})
  }

  hydrateTerminalSnap = async <O = unknown>(
    snap: DocumentSnapshot,
    isDev: boolean
  ): Promise<TaskRecord<O> | null> => {
    const d = snap.exists ? (snap.data() as TaskRecord<O> | undefined) : undefined
    if (!isTerminalRecord(d)) return null
    if (d.status === 'completed') {
      return { status: 'completed', response: await this.#steps.maybeHydrateStepValue<O>(d.response, isDev) }
    }
    return d
  }

  #startHedgeTimer = <O>(opts: {
    docRef: DocumentReference
    isDev: boolean
    createdAt: number
    hedgeAfterMs: number
    dispatch: () => Promise<void>
    isDone: () => boolean
    finishResolve: (rec: TaskRecord<O>, isTerminalFromDb: boolean) => void
  }): ReturnType<typeof setTimeout> => {
    let hedged = false
    const timer = setTimeout(async () => {
      if (opts.isDone() || hedged) return
      try {
        const snap = await opts.docRef.get()
        if (opts.isDone()) return
        const record = await this.hydrateTerminalSnap<O>(snap, opts.isDev)
        if (record) {
          opts.finishResolve(record, true)
          return
        }
        const rawData = snap.data() as { lastHeartbeatAt?: number } | undefined
        const lastHb = typeof rawData?.lastHeartbeatAt === 'number' ? rawData.lastHeartbeatAt : opts.createdAt
        if (Date.now() - lastHb > CORGE_CONFIG.tasks.heartbeatStaleMs) {
          hedged = true
          opts.dispatch().catch(() => {})
        }
      } catch {}
    }, opts.hedgeAfterMs)
    timer.unref?.()
    return timer
  }

  #awaitTaskSettlement = <O>(
    taskId: string,
    docRef: DocumentReference,
    isDev: boolean,
    workflowName: string,
    hedgeable: boolean,
    timeoutMs: number,
    hedgeAfterMs: number,
    pollIntervalMs: number,
    createdAt: number,
    watchOpts: WatchTaskOptions | undefined,
    cleanup: WatchCleanup
  ): Promise<{ record: TaskRecord<O>; settledTerminal: boolean }> =>
    new Promise((resolve, reject) => {
      let done = false
      let polling = false
      const finishResolve = (record: TaskRecord<O>, settledTerminal = false) => {
        if (done) return
        done = true
        resolve({ record, settledTerminal })
      }
      const finishReject = (err: unknown) => {
        if (done) return
        done = true
        reject(err)
      }

      if (watchOpts?.signal) {
        if (watchOpts.signal.aborted) return finishReject(watchOpts.signal.reason ?? new Error(`Task watch aborted: ${taskId}`))
        cleanup.onAbort = () => finishReject(watchOpts.signal!.reason ?? new Error(`Task watch aborted: ${taskId}`))
        watchOpts.signal.addEventListener('abort', cleanup.onAbort, { once: true })
      }

      const checkSnapshot = async (snap: DocumentSnapshot) => {
        if (done) return
        try {
          const record = await this.hydrateTerminalSnap<O>(snap, isDev)
          if (record) finishResolve(record, true)
        } catch (err) {
          finishReject(err)
        }
      }

      cleanup.unsubscribeSnapshot = docRef.onSnapshot((snap) => void checkSnapshot(snap), () => {})
      cleanup.pollTimer = setInterval(async () => {
        if (done || polling) return
        polling = true
        try {
          await checkSnapshot(await docRef.get())
        } catch {
        } finally {
          polling = false
        }
      }, pollIntervalMs)
      cleanup.pollTimer.unref?.()

      if (hedgeable && watchOpts?.dispatch) {
        cleanup.hedgeTimer = this.#startHedgeTimer({ docRef, isDev, createdAt, hedgeAfterMs, dispatch: watchOpts.dispatch, isDone: () => done, finishResolve })
      }
      cleanup.deadlineTimer = setTimeout(() => finishResolve({ status: 'errored', error: `Workflow task timed out: ${workflowName}/${taskId}` }, false), timeoutMs)
      cleanup.deadlineTimer.unref?.()
      if (watchOpts?.maxWaitMs !== undefined && watchOpts.maxWaitMs > 0) {
        cleanup.detachTimer = setTimeout(() => finishReject(new TaskWaitDetachedSignal(taskId)), watchOpts.maxWaitMs)
        cleanup.detachTimer.unref?.()
      }
      if (watchOpts?.dispatch) {
        watchOpts.dispatch().catch((err) => finishResolve({ status: 'errored', error: err instanceof Error ? err.message : String(err) }, false))
      }
    })

  watchTask = async <O = unknown>(taskId: string, opts?: WatchTaskOptions): Promise<TaskRecord<O>> => {
    const isDev = Boolean(opts?.isDev ?? this.#corge.env.isDev)
    const docRef = opts?.docRef ?? this.#corge.db.firestore(isDev).collection('_tasks').doc(taskId)
    const workflowName = opts?.workflowName ?? 'workflow'
    const hedgeable = Boolean(opts?.hedgeable ?? workflowName === 'scan-attachment')
    const keepAlive = opts?.keepAlive ?? true
    const timeoutMs = opts?.timeoutMs ?? CORGE_CONFIG.tasks.timeoutMs
    const hedgeAfterMs = opts?.hedgeAfterMs ?? CORGE_CONFIG.tasks.hedgeAfterMs
    const pollIntervalMs = opts?.pollIntervalMs ?? 5_000
    const createdAt = Date.now()

    activeWatcherCount += 1
    const cleanup: WatchCleanup = {}

    try {
      const { record, settledTerminal } = await this.#awaitTaskSettlement<O>(
        taskId,
        docRef,
        isDev,
        workflowName,
        hedgeable,
        timeoutMs,
        hedgeAfterMs,
        pollIntervalMs,
        createdAt,
        opts,
        cleanup
      )
      if (settledTerminal && !keepAlive) this.#delRefs([docRef], isDev)
      return record
    } finally {
      try {
        cleanup.unsubscribeSnapshot?.()
      } catch {}
      if (cleanup.pollTimer !== undefined) clearInterval(cleanup.pollTimer)
      if (cleanup.hedgeTimer !== undefined) clearTimeout(cleanup.hedgeTimer)
      if (cleanup.deadlineTimer !== undefined) clearTimeout(cleanup.deadlineTimer)
      if (cleanup.detachTimer !== undefined) clearTimeout(cleanup.detachTimer)
      if (cleanup.onAbort && opts?.signal) opts.signal.removeEventListener('abort', cleanup.onAbort)
      activeWatcherCount = Math.max(0, activeWatcherCount - 1)
    }
  }
}
