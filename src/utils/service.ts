import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { ZodError } from 'zod'
import { CORGE_CONFIG } from '../config'
import type { Corge } from '../index'
import {
  CircuitBreakerOpenError,
  errorBodySchema,
  NonRetryableError,
  StaleWorkerEpochError,
  type Bucket,
  type CircuitBreakerKey,
  type CircuitBreakerRecord,
  type CircuitBreakerStateName,
  type Duration,
  type ErrorBody,
  type SingleflightOptions
} from './schema'

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000
}

export class ErrorsService {
  readonly NonRetryableError = NonRetryableError
  readonly StaleWorkerEpochError = StaleWorkerEpochError
  readonly CircuitBreakerOpenError = CircuitBreakerOpenError

  parseDuration = (d?: Duration, fallbackMs = 0): number => {
    if (d === undefined || d === null) return fallbackMs
    if (typeof d === 'number') return Math.max(0, d)
    const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(d.trim())
    if (!m) throw new Error(`Invalid duration: ${d}`)
    return Math.round(Number(m[1]) * (DURATION_UNITS[m[2]!] ?? 1))
  }

  buildErrorBody = (error: string, status?: number, code?: string, retryAfterMs?: number): ErrorBody =>
    errorBodySchema.parse({
      error,
      ...(code ? { code } : {}),
      ...(status ? { status } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs: Math.ceil(retryAfterMs) } : {})
    })

  isStaleWorkerEpochError = (err: unknown): err is StaleWorkerEpochError =>
    err instanceof StaleWorkerEpochError ||
    Boolean(
      err &&
        typeof err === 'object' &&
        ((err as { isStaleWorkerEpoch?: unknown }).isStaleWorkerEpoch === true ||
          (err as { name?: unknown }).name === 'StaleWorkerEpochError')
    )

  nonRetryableError = (message: string, code?: string): never => {
    throw new NonRetryableError(message, code)
  }

  #jsonErr = (status: ContentfulStatusCode, error: string, code?: string, retryAfterMs?: number): HTTPException => {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (retryAfterMs !== undefined && retryAfterMs > 0) {
      headers['retry-after'] = String(Math.max(1, Math.ceil(retryAfterMs / 1000)))
    }
    return new HTTPException(status, {
      res: new Response(JSON.stringify(this.buildErrorBody(error, status, code, retryAfterMs)), { status, headers })
    })
  }

  httpError = (status: ContentfulStatusCode, message: string, code?: string, retryAfterMs?: number): never => {
    throw this.#jsonErr(status, message, code, retryAfterMs)
  }

  isNonRetryableError = (err: unknown): boolean => {
    if (err instanceof NonRetryableError || err instanceof ZodError) return true
    if (err instanceof HTTPException && err.status < 500) return true
    if (
      err &&
      typeof err === 'object' &&
      ('nonRetryable' in err || ('code' in err && (err.code === 'NOT_FOUND' || err.code === 5)))
    ) {
      return true
    }
    const msg = err instanceof Error ? err.message : String(err)
    return (
      msg.startsWith('File not found:') ||
      msg.startsWith('Not found:') ||
      msg.includes('NOT_FOUND') ||
      msg.includes('No document to update')
    )
  }

  toHttpError = (err: unknown): HTTPException => {
    if (err instanceof HTTPException) return err
    if (err instanceof ZodError) {
      return this.#jsonErr(
        400,
        err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '),
        'VALIDATION_ERROR'
      )
    }
    if (err instanceof NonRetryableError) {
      return this.#jsonErr(400, err.message, err.code ?? 'NON_RETRYABLE_ERROR')
    }
    const msg = err instanceof Error ? err.message : ''
    if (msg.startsWith('File not found:') || msg.startsWith('Not found:')) {
      return this.#jsonErr(404, msg, 'NOT_FOUND')
    }
    console.error('[http] unhandled error:', err)
    return this.#jsonErr(500, 'Internal server error', 'INTERNAL_SERVER_ERROR')
  }
}

class RateLimiter {
  #slots: number[] = []
  #maxOverride?: number
  #remoteRemaining?: number
  #remoteResetAt = 0
  readonly #bucket: Bucket
  readonly #getMaxWaitMs: () => number

  constructor(bucket: Bucket, getMaxWaitMs: () => number) {
    this.#bucket = bucket
    this.#getMaxWaitMs = getMaxWaitMs
  }

  #cfg(now = Date.now()) {
    const base = CORGE_CONFIG.limits.buckets[this.#bucket]
    const windowMs = this.#bucket === 'mistral' ? base.windowMs + 3000 : base.windowMs
    const max = this.#maxOverride ?? base.max
    const safeMax = this.#bucket === 'mistral' ? Math.max(1, max - 5) : max
    this.#slots = this.#slots.filter((at) => at > now - windowMs)
    if (now >= this.#remoteResetAt) this.#remoteRemaining = undefined
    return { now, windowMs, max, safeMax }
  }

  acquire(units = 1): number {
    const { now, windowMs, safeMax } = this.#cfg()
    const needed = Math.max(1, units)
    const next = [...this.#slots]
    let lastAt = now
    if (this.#remoteRemaining !== undefined && this.#remoteRemaining < needed) {
      lastAt = Math.max(lastAt, this.#remoteResetAt)
    }
    for (let i = 0; i < needed; i++) {
      const windowReady = next.length >= safeMax ? next[next.length - safeMax]! + windowMs : now
      lastAt = Math.max(lastAt, windowReady)
      next.push(lastAt)
    }
    const waitMs = Math.max(0, lastAt - now)
    if (waitMs <= this.#getMaxWaitMs()) {
      this.#slots = next
      if (this.#remoteRemaining !== undefined) {
        this.#remoteRemaining = Math.max(0, this.#remoteRemaining - needed)
      }
    }
    return waitMs
  }

  charge(units: number) {
    const now = Date.now()
    for (let i = 0; i < units; i++) this.#slots.push(now)
    if (this.#remoteRemaining !== undefined) {
      this.#remoteRemaining = Math.max(0, this.#remoteRemaining - units)
    }
  }

  sync(remaining?: number, limit?: number) {
    if (limit && limit > 0) this.#maxOverride = limit
    if (remaining === undefined || Number.isNaN(remaining)) return
    const now = Date.now()
    this.#remoteRemaining = Math.max(0, remaining)
    this.#remoteResetAt = now + (remaining === 0 ? 5_000 : 10_000)
  }
}

const inflight = new Map<string, Promise<unknown>>()
const limiters = new Map<string, RateLimiter>()
const httpCounters = new Map<string, { count: number; resetAt: number }>()
const breakerCache = new Map<string, { record: CircuitBreakerRecord; cachedAt: number }>()

const BREAKER_CACHE_TTL_MS = 3_000
const BREAKER_FAILURE_WINDOW_MS = 30_000
const BREAKER_TRIP_THRESHOLD = 3
const BREAKER_OPEN_DURATION_MS = 45_000

const breakerCacheKey = (key: CircuitBreakerKey, isDev: boolean): string => `${isDev ? 'dev' : 'prod'}:${key}`
const breakerDocPath = (key: CircuitBreakerKey): string => `_system/breaker_${key}`

export class ResilienceService {
  readonly #corge: Corge

  constructor(corgeClient: Corge) {
    this.#corge = corgeClient
  }

  #getLimiter = (b: Bucket): RateLimiter => {
    const key = `${this.#corge.env.isDev ? 'dev' : 'prod'}:${b}`
    return (
      limiters.get(key) ??
      (limiters.set(key, new RateLimiter(b, () => this.#corge.config.limits.maxWaitMs)), limiters.get(key)!)
    )
  }

  singleflight = <T>(key: string, fn: () => Promise<T>, opts?: SingleflightOptions): Promise<T> => {
    const scope = opts?.scope ?? 'tenant'
    const active = this.#corge.internals.context.getState()
    const activeUserId = scope === 'tenant' ? active?.userId : undefined
    const scopedKey = activeUserId ? `tenant:${activeUserId}:${key}` : `global:${key}`

    const existing = inflight.get(scopedKey) as Promise<T> | undefined
    if (existing) return existing

    const exec =
      scope === 'global' && active
        ? () =>
            this.#corge.internals.context.run(
              { env: active.env, userId: this.#corge.config.auth.adminUserId, role: 'admin' },
              fn
            )
        : fn
    const promise = exec().finally(() => {
      inflight.delete(scopedKey)
    })
    inflight.set(scopedKey, promise)
    return promise
  }

  acquireLimit = async (bucket: Bucket, cost = 1): Promise<void> => {
    const waitMs = this.#getLimiter(bucket).acquire(cost)
    if (waitMs > this.#corge.config.limits.maxWaitMs) {
      this.#corge.errors.httpError(429, `Rate limit exceeded for ${bucket}`, 'RATE_LIMITED', waitMs)
    }
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs))
  }

  chargeLimit = async (bucket: Bucket, extra: number): Promise<void> => {
    this.#getLimiter(bucket).charge(extra)
  }

  syncLimit = async (bucket: Bucket, remaining?: number, max?: number): Promise<void> => {
    this.#getLimiter(bucket).sync(remaining, max)
  }

  acquireHttpLimit = (key: string, max = 300, windowMs = 60_000): void => {
    const now = Date.now()
    const existing = httpCounters.get(key)
    if (!existing || now >= existing.resetAt) {
      if (!existing && httpCounters.size >= 5000) {
        httpCounters.delete(httpCounters.keys().next().value!)
      }
      httpCounters.set(key, { count: 1, resetAt: now + windowMs })
      return
    }
    if (existing.count >= max) {
      const retryAfterMs = Math.max(1000, existing.resetAt - now)
      this.#corge.errors.httpError(429, 'Rate limit exceeded', 'RATE_LIMITED', retryAfterMs)
    }
    existing.count += 1
  }

  #isUpstreamProviderError = (err: unknown): boolean => {
    if (!err) return false
    const rec = typeof err === 'object' ? (err as Record<string, unknown>) : {}
    const rawStatus =
      typeof rec.statusCode === 'number'
        ? rec.statusCode
        : typeof rec.status === 'number'
          ? rec.status
          : undefined
    const code = typeof rec.code === 'string' ? rec.code.toUpperCase() : ''
    const msg = err instanceof Error ? err.message : String(err)
    const lower = msg.toLowerCase()

    const parsedStatusMatch = /\b(?:status(?:\s+code)?|http)\s*[:=]?\s*(\d{3})\b/i.exec(msg)
    const status = rawStatus ?? (parsedStatusMatch?.[1] ? Number(parsedStatusMatch[1]) : undefined)

    if (status !== undefined) {
      if (status === 400 || status === 401 || status === 403 || status === 404 || status === 415 || status === 422) {
        return false
      }
      if (status === 502 || status === 503 || status === 504 || status === 408) {
        return true
      }
    }

    if (
      code === 'ETIMEDOUT' ||
      code === 'ECONNRESET' ||
      code === 'ECONNREFUSED' ||
      code === 'UND_ERR_CONNECT_TIMEOUT' ||
      lower.includes('etimedout') ||
      lower.includes('econnreset') ||
      lower.includes('econnrefused') ||
      lower.includes('socket hang up') ||
      lower.includes('bad gateway') ||
      lower.includes('service unavailable') ||
      lower.includes('gateway timeout') ||
      lower.includes('502') ||
      lower.includes('503') ||
      lower.includes('504')
    ) {
      return true
    }

    return false
  }

  getCircuitBreakerState = async (
    breakerKey: CircuitBreakerKey,
    isDev: boolean = this.#corge.env.isDev,
    forceRefresh = false
  ): Promise<CircuitBreakerRecord> => {
    const cKey = breakerCacheKey(breakerKey, isDev)
    const now = Date.now()
    const hit = breakerCache.get(cKey)
    if (!forceRefresh && hit && now - hit.cachedAt < BREAKER_CACHE_TTL_MS) {
      return hit.record
    }

    return this.singleflight(
      `breaker:read:${cKey}`,
      async () => {
        try {
          const snap = await this.#corge.db.firestore(isDev).doc(breakerDocPath(breakerKey)).get()
          const d = snap.data() as Partial<CircuitBreakerRecord> | undefined
          const record: CircuitBreakerRecord = {
            state: d?.state === 'OPEN' || d?.state === 'HALF_OPEN' ? d.state : 'CLOSED',
            failureCount: typeof d?.failureCount === 'number' ? d.failureCount : 0,
            firstFailureAt: typeof d?.firstFailureAt === 'number' ? d.firstFailureAt : 0,
            openedAt: typeof d?.openedAt === 'number' ? d.openedAt : 0
          }
          breakerCache.set(cKey, { record, cachedAt: Date.now() })
          return record
        } catch {
          const fallback: CircuitBreakerRecord = {
            state: 'CLOSED',
            failureCount: 0,
            firstFailureAt: 0,
            openedAt: 0
          }
          breakerCache.set(cKey, { record: fallback, cachedAt: Date.now() })
          return fallback
        }
      },
      { scope: 'global' }
    )
  }

  resetCircuitBreaker = async (breakerKey: CircuitBreakerKey, isDev: boolean = this.#corge.env.isDev): Promise<void> => {
    const cKey = breakerCacheKey(breakerKey, isDev)
    const record: CircuitBreakerRecord = {
      state: 'CLOSED',
      failureCount: 0,
      firstFailureAt: 0,
      openedAt: 0,
      updatedAt: Date.now()
    }
    breakerCache.set(cKey, { record, cachedAt: Date.now() })
    await this.#corge.db.firestore(isDev).doc(breakerDocPath(breakerKey)).set(record).catch(() => {})
  }

  #computeWindowFailureState = (prevFirst: number, prevCount: number, now: number): CircuitBreakerRecord => {
    const inWindow = prevFirst > 0 && now - prevFirst <= BREAKER_FAILURE_WINDOW_MS
    const failureCount = inWindow ? prevCount + 1 : 1
    const firstFailureAt = inWindow ? prevFirst : now
    const tripped = failureCount >= BREAKER_TRIP_THRESHOLD
    return {
      state: tripped ? 'OPEN' : 'CLOSED',
      failureCount,
      firstFailureAt,
      openedAt: tripped ? now : 0,
      updatedAt: now
    }
  }

  #recordBreakerFailure = async (breakerKey: CircuitBreakerKey, isDev: boolean): Promise<CircuitBreakerRecord> => {
    const cKey = breakerCacheKey(breakerKey, isDev)
    const db = this.#corge.db.firestore(isDev)
    const docRef = db.doc(breakerDocPath(breakerKey))
    const now = Date.now()

    try {
      const updated = await db.runTransaction(async (tx) => {
        const snap = await tx.get(docRef)
        const d = snap.data() as Partial<CircuitBreakerRecord> | undefined
        const prevState: CircuitBreakerStateName =
          d?.state === 'OPEN' || d?.state === 'HALF_OPEN' ? d.state : 'CLOSED'
        const prevFirst = typeof d?.firstFailureAt === 'number' ? d.firstFailureAt : 0
        const prevCount = typeof d?.failureCount === 'number' ? d.failureCount : 0

        const next: CircuitBreakerRecord =
          prevState === 'HALF_OPEN'
            ? {
                state: 'OPEN',
                failureCount: Math.max(BREAKER_TRIP_THRESHOLD, prevCount + 1),
                firstFailureAt: prevFirst || now,
                openedAt: now,
                updatedAt: now
              }
            : this.#computeWindowFailureState(prevFirst, prevCount, now)
        tx.set(docRef, next)
        return next
      })
      breakerCache.set(cKey, { record: updated, cachedAt: now })
      return updated
    } catch {
      const localPrev = breakerCache.get(cKey)?.record
      const next = this.#computeWindowFailureState(localPrev?.firstFailureAt ?? 0, localPrev?.failureCount ?? 0, now)
      breakerCache.set(cKey, { record: next, cachedAt: now })
      return next
    }
  }

  circuitBreaker = async <T>(
    breakerKey: CircuitBreakerKey,
    fn: () => Promise<T>,
    fallbackFn?: () => Promise<T>,
    opts?: { isDev?: boolean }
  ): Promise<T> => {
    const targetIsDev = opts?.isDev ?? this.#corge.env.isDev
    const cKey = breakerCacheKey(breakerKey, targetIsDev)
    let current = await this.getCircuitBreakerState(breakerKey, targetIsDev)
    const now = Date.now()

    if (current.state === 'OPEN') {
      if (now - current.openedAt >= BREAKER_OPEN_DURATION_MS) {
        current = { ...current, state: 'HALF_OPEN' }
        breakerCache.set(cKey, { record: current, cachedAt: now })
        void this.#corge.db
          .firestore(targetIsDev)
          .doc(breakerDocPath(breakerKey))
          .set({ state: 'HALF_OPEN', updatedAt: now }, { merge: true })
          .catch(() => {})
      } else {
        if (fallbackFn) {
          return fallbackFn()
        }
        throw new CircuitBreakerOpenError(breakerKey)
      }
    }

    try {
      const result = await fn()
      if (current.state === 'HALF_OPEN' || current.failureCount > 0) {
        await this.resetCircuitBreaker(breakerKey, targetIsDev)
      }
      return result
    } catch (err) {
      if (this.#isUpstreamProviderError(err)) {
        const updated = await this.#recordBreakerFailure(breakerKey, targetIsDev)
        if (updated.state === 'OPEN' && fallbackFn) {
          return fallbackFn()
        }
      }
      throw err
    }
  }
}
