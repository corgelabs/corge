import { z } from 'zod'
import { CORE_CONFIG } from '../config'

export type Duration = number | `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`

export const errorBodySchema = z.object({
  error: z.string(),
  code: z.string().optional(),
  status: z.number().int().optional(),
  retryAfterMs: z.number().int().optional()
})

export type ErrorBody = z.infer<typeof errorBodySchema>

export class NonRetryableError extends Error {
  readonly nonRetryable = true as const
  readonly code?: string
  constructor(message: string, code?: string) {
    super(message)
    this.name = 'NonRetryableError'
    this.code = code
  }
}

export class StaleWorkerEpochError extends NonRetryableError {
  readonly isStaleWorkerEpoch = true as const
  readonly taskId?: string
  readonly claimedEpoch?: number
  readonly actualEpoch?: number
  constructor(
    message = 'Worker execution epoch superseded by a newer run or cancellation',
    meta?: { taskId?: string; claimedEpoch?: number; actualEpoch?: number }
  ) {
    super(message, 'STALE_WORKER_EPOCH')
    this.name = 'StaleWorkerEpochError'
    this.taskId = meta?.taskId
    this.claimedEpoch = meta?.claimedEpoch
    this.actualEpoch = meta?.actualEpoch
  }
}

export class CircuitBreakerOpenError extends NonRetryableError {
  readonly isCircuitBreakerOpen = true as const
  readonly breakerKey: string
  constructor(breakerKey: string, message = `Circuit breaker "${breakerKey}" is OPEN`) {
    super(message, 'CIRCUIT_BREAKER_OPEN')
    this.name = 'CircuitBreakerOpenError'
    this.breakerKey = breakerKey
  }
}

export interface SingleflightOptions {
  scope?: 'tenant' | 'global'
}

export const LIMITS = CORE_CONFIG.limits.buckets
export type Bucket = keyof typeof LIMITS

/** Built-in provider breakers plus any app-defined key (`[a-z0-9-]` recommended; used in a Firestore doc ID). */
export type CircuitBreakerKey = 'mistral' | 'jev' | 'vertex' | 'emails' | 'payments' | (string & {})
export type CircuitBreakerStateName = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export interface CircuitBreakerRecord {
  state: CircuitBreakerStateName
  failureCount: number
  firstFailureAt: number
  openedAt: number
  updatedAt?: number
}
