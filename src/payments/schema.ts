import { z } from 'zod'
import { CORE_CONFIG, type EnvScopedString, type PaymentProvider, type PaymentsConfig } from '../config'
import { entryId, type EntryId } from '../db'

export type { EnvScopedString, PaymentProvider, PaymentsConfig }

export interface ProviderPlanMapping {
  stripe?: {
    priceId: EnvScopedString
    meterEventName?: string
  }
  dodo?: {
    productId: EnvScopedString
    meterEventName?: string
  }
}

export interface PlanQuotaSpec {
  aiTokens?: number | null
  metrics?: Record<string, number>
  overage?: {
    enabled: boolean
    maxOverageTokens?: number
    unitTokens?: number
    rateCents?: number
  }
}

export interface PlanDefinition {
  id?: string
  name: string
  description?: string
  interval: 'month' | 'year' | 'free'
  amount: number
  currency?: Lowercase<string>
  providers?: ProviderPlanMapping
  quota?: PlanQuotaSpec
  quotas?: PlanQuotaSpec
  metadata?: Record<string, string>
}

export type PlansMap = Record<string, PlanDefinition>

export interface ProductDefinition {
  id?: string
  name: string
  description?: string
  amount: number
  currency?: Lowercase<string>
  providers?: {
    stripe?: {
      priceId?: EnvScopedString
      productId?: EnvScopedString
    }
    dodo?: {
      productId: EnvScopedString
    }
  }
  grants?: {
    aiTokens?: number
    credits?: number
    metrics?: Record<string, number>
  }
  metadata?: Record<string, string>
}

export type ProductsMap = Record<string, ProductDefinition>

const registeredPlans: Record<string, PlanDefinition & { id: string; quota: PlanQuotaSpec }> = {}
const registeredProducts: Record<string, ProductDefinition & { id: string }> = {}

export const registerPlans = (plans?: PlansMap, reset = false): void => {
  if (reset) {
    for (const k of Object.keys(registeredPlans)) delete registeredPlans[k]
  }
  if (!plans) return
  const entries = Object.entries(plans)
  for (const [k, def] of entries) {
    const quota = def.quota ?? def.quotas ?? {}
    registeredPlans[k] = { ...def, id: def.id ?? k, quota, quotas: quota }
  }
  if (entries.length > 0) CORE_CONFIG.payments.enabled = true
}

export const registerProducts = (products?: ProductsMap, reset = false): void => {
  if (reset) {
    for (const k of Object.keys(registeredProducts)) delete registeredProducts[k]
  }
  if (!products) return
  const entries = Object.entries(products)
  for (const [k, def] of entries) {
    registeredProducts[k] = { ...def, id: def.id ?? k }
  }
  if (entries.length > 0) CORE_CONFIG.payments.enabled = true
}

export const clearPaymentDefinitions = (): void => {
  for (const k of Object.keys(registeredPlans)) delete registeredPlans[k]
  for (const k of Object.keys(registeredProducts)) delete registeredProducts[k]
  CORE_CONFIG.payments.enabled = false
}

export const definePlans = <T extends PlansMap>(plans: T): T => {
  const normalized = Object.fromEntries(
    Object.entries(plans).map(([k, def]) => [k, { ...def, id: def.id ?? k }])
  ) as T
  registerPlans(normalized, false)
  return normalized
}

export const defineProducts = <T extends ProductsMap>(products: T): T => {
  const normalized = Object.fromEntries(
    Object.entries(products).map(([k, def]) => [k, { ...def, id: def.id ?? k }])
  ) as T
  registerProducts(normalized, false)
  return normalized
}

export const getPlanDefinition = (id: string): (PlanDefinition & { id: string; quota: PlanQuotaSpec }) | undefined =>
  registeredPlans[id]

export const getProductDefinition = (id: string): (ProductDefinition & { id: string }) | undefined =>
  registeredProducts[id]

export const getRegisteredPlans = (): Record<string, PlanDefinition & { id: string; quota: PlanQuotaSpec }> => registeredPlans

export const getRegisteredProducts = (): Record<string, ProductDefinition & { id: string }> => registeredProducts

export const subscriptionStatusSchema = z.enum([
  'none',
  'active',
  'trialing',
  'past_due',
  'on_hold',
  'cancelled',
  'expired'
])
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>

export const paymentTransactionTypeSchema = z.enum([
  'checkout.completed',
  'payment.succeeded',
  'payment.failed',
  'invoice.created',
  'invoice.paid',
  'subscription.active',
  'subscription.renewed',
  'subscription.tier_changed',
  'subscription.cancelled',
  'subscription.past_due'
])
export type PaymentTransactionType = z.infer<typeof paymentTransactionTypeSchema>

export const customLineItemSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  amount: z.number().int().positive(),
  currency: z.string().length(3).toLowerCase().optional(),
  quantity: z.number().int().positive().default(1)
})
export type CustomLineItem = z.input<typeof customLineItemSchema>

export const createCheckoutInput = z
  .object({
    product: z.string().optional(),
    plan: z.string().optional(),
    custom: customLineItemSchema.optional(),
    quantity: z.number().int().positive().default(1),
    successUrl: z.string().url().optional(),
    cancelUrl: z.string().url().optional(),
    idempotencyKey: z.string().max(200).optional(),
    metadata: z.record(z.string(), z.string()).optional()
  })
  .refine((v) => Number(Boolean(v.product)) + Number(Boolean(v.plan)) + Number(Boolean(v.custom)) === 1, {
    message: 'Provide exactly one of: product, plan, or custom'
  })
export type CreateCheckoutInput = z.input<typeof createCheckoutInput>

export const checkoutSessionResultSchema = z.object({
  checkoutId: z.string(),
  url: z.string().url(),
  provider: z.enum(['stripe', 'dodo']),
  expiresAt: z.string().datetime().optional()
})
export type CheckoutSessionResult = z.infer<typeof checkoutSessionResultSchema>

export const createPaymentLinkInput = z
  .object({
    product: z.string().optional(),
    plan: z.string().optional(),
    custom: customLineItemSchema.optional(),
    quantity: z.number().int().positive().default(1),
    returnUrl: z.string().url().optional(),
    idempotencyKey: z.string().max(200).optional(),
    metadata: z.record(z.string(), z.string()).optional()
  })
  .refine((v) => Number(Boolean(v.product)) + Number(Boolean(v.plan)) + Number(Boolean(v.custom)) === 1, {
    message: 'Provide exactly one of: product, plan, or custom'
  })
export type CreatePaymentLinkInput = z.input<typeof createPaymentLinkInput>

export const paymentLinkResultSchema = z.object({
  paymentLinkId: z.string(),
  url: z.string().url(),
  provider: z.enum(['stripe', 'dodo'])
})
export type PaymentLinkResult = z.infer<typeof paymentLinkResultSchema>

export const createInvoiceInput = z
  .object({
    product: z.string().optional(),
    custom: customLineItemSchema.optional(),
    quantity: z.number().int().positive().default(1),
    daysUntilDue: z.number().int().positive().max(365).default(30),
    idempotencyKey: z.string().max(200).optional(),
    metadata: z.record(z.string(), z.string()).optional()
  })
  .refine((v) => Number(Boolean(v.product)) + Number(Boolean(v.custom)) === 1, {
    message: 'Provide exactly one of: product or custom'
  })
export type CreateInvoiceInput = z.input<typeof createInvoiceInput>

export const invoiceResultSchema = z.object({
  invoiceId: z.string(),
  status: z.enum(['open', 'paid', 'draft', 'void']),
  amount: z.number().int().nonnegative(),
  currency: z.string(),
  hostedInvoiceUrl: z.string().url(),
  pdfUrl: z.string().url().optional(),
  provider: z.enum(['stripe', 'dodo'])
})
export type InvoiceResult = z.infer<typeof invoiceResultSchema>

export const directChargeInput = z
  .object({
    product: z.string().optional(),
    custom: customLineItemSchema.optional(),
    amount: z.number().int().positive().optional(),
    currency: z.string().length(3).toLowerCase().optional(),
    description: z.string().max(1000).optional(),
    paymentMethodId: z.string().optional(),
    idempotencyKey: z.string().max(200).optional(),
    metadata: z.record(z.string(), z.string()).optional()
  })
  .refine((v) => Boolean(v.product || v.custom || v.amount), {
    message: 'Provide product, custom, or amount'
  })
export type DirectChargeInput = z.input<typeof directChargeInput>

export const chargeResultSchema = z.object({
  chargeId: z.string(),
  status: z.enum(['succeeded', 'requires_action', 'failed']),
  amount: z.number().int().nonnegative(),
  currency: z.string(),
  provider: z.enum(['stripe', 'dodo']),
  checkoutUrl: z.string().url().optional(),
  clientSecret: z.string().optional()
})
export type ChargeResult = z.infer<typeof chargeResultSchema>

export const subscribeInput = z.object({
  plan: z.string().min(1),
  returnUrl: z.string().url().optional(),
  idempotencyKey: z.string().max(200).optional(),
  metadata: z.record(z.string(), z.string()).optional()
})
export type SubscribeInput = z.input<typeof subscribeInput>

export const subscribeResultSchema = z.object({
  subscriptionId: z.string(),
  planId: z.string(),
  status: z.enum(['active', 'trialing', 'requires_action']),
  provider: z.enum(['stripe', 'dodo']),
  checkoutUrl: z.string().url().optional()
})
export type SubscribeResult = z.infer<typeof subscribeResultSchema>

export const changeTierInput = z.object({
  plan: z.string().min(1),
  proration: z.enum(['prorated_immediately', 'next_cycle', 'none']).default('prorated_immediately'),
  idempotencyKey: z.string().max(200).optional()
})
export type ChangeTierInput = z.input<typeof changeTierInput>

export const cancelSubscriptionInput = z.object({
  immediately: z.boolean().default(false),
  reason: z.string().max(500).optional(),
  idempotencyKey: z.string().max(200).optional()
})
export type CancelSubscriptionInput = z.input<typeof cancelSubscriptionInput>

export const subscriptionRecordSchema = z.object({
  subscriptionId: z.string(),
  planId: z.string(),
  status: subscriptionStatusSchema,
  provider: z.enum(['stripe', 'dodo']),
  cancelAtPeriodEnd: z.boolean(),
  currentPeriodStart: z.string().datetime().optional(),
  currentPeriodEnd: z.string().datetime().optional()
})
export type SubscriptionRecord = z.infer<typeof subscriptionRecordSchema>

export const recordUsageInput = z.object({
  metric: z.string().default('ai_tokens'),
  amount: z.number().positive(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  model: z.string().optional(),
  idempotencyKey: z.string().max(200).optional(),
  metadata: z.record(z.string(), z.string()).optional()
})
export type RecordUsageInput = z.input<typeof recordUsageInput>

export const usageStatusResultSchema = z.object({
  userId: entryId,
  periodKey: z.string(),
  planId: z.string(),
  aiTokensUsed: z.number().int().nonnegative(),
  aiTokensLimit: z.number().int().nonnegative().nullable(),
  bonusAiTokens: z.number().int().nonnegative(),
  overageTokensReported: z.number().int().nonnegative(),
  overageEnabled: z.boolean(),
  maxOverageTokens: z.number().int().positive().optional(),
  metricsUsed: z.record(z.string(), z.number()),
  metricsLimits: z.record(z.string(), z.number()),
  bonusMetrics: z.record(z.string(), z.number())
})
export type UsageStatusResult = z.infer<typeof usageStatusResultSchema>
export const usageSummarySchema = usageStatusResultSchema
export type UsageSummary = UsageStatusResult

export const quotaCheckResultSchema = z.object({
  allowed: z.boolean(),
  metric: z.string(),
  used: z.number().nonnegative(),
  limit: z.number().nonnegative().nullable(),
  bonusRemaining: z.number().nonnegative(),
  overageEnabled: z.boolean(),
  remaining: z.number().nullable()
})
export type QuotaCheckResult = z.infer<typeof quotaCheckResultSchema>

export const customerBillingSummarySchema = z.object({
  userId: entryId,
  planId: z.string(),
  plan: z.object({
    id: z.string(),
    name: z.string(),
    interval: z.enum(['month', 'year', 'free']),
    amount: z.number(),
    currency: z.string()
  }),
  status: subscriptionStatusSchema,
  subscriptionId: z.string().optional(),
  activeProvider: z.enum(['stripe', 'dodo']).optional(),
  currentPeriodStart: z.string().datetime().optional(),
  currentPeriodEnd: z.string().datetime().optional(),
  cancelAtPeriodEnd: z.boolean(),
  bonusAiTokens: z.number().int().nonnegative(),
  credits: z.number().nonnegative(),
  bonusMetrics: z.record(z.string(), z.number())
})
export type CustomerBillingSummary = z.infer<typeof customerBillingSummarySchema>

export const paymentWebhookParamsSchema = z.object({
  provider: z.enum(['stripe', 'dodo'])
})
export type PaymentWebhookParams = z.infer<typeof paymentWebhookParamsSchema>

export const paymentWebhookResultSchema = z.object({
  received: z.literal(true),
  eventId: z.string(),
  handled: z.boolean(),
  deduplicated: z.boolean().optional()
})
export type PaymentWebhookResult = z.infer<typeof paymentWebhookResultSchema>

export interface PaymentCallOptions {
  provider?: PaymentProvider
  userId?: EntryId
  idempotencyKey?: string
}

export interface NormalizedPaymentWebhook {
  eventId: string
  paymentId?: string
  rawEventType: string
  txType: PaymentTransactionType | null
  userId?: string
  customerId?: string
  subscriptionId?: string
  subscriptionStatus?: SubscriptionStatus
  planId?: string
  productId?: string
  amount?: number
  currency?: string
  currentPeriodStart?: string
  currentPeriodEnd?: string
  cancelAtPeriodEnd?: boolean
  resetPeriodUsage?: boolean
}
