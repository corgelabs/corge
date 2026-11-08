import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import {
  getPlanDefinition, getProductDefinition, type CustomLineItem, type EnvScopedString, type NormalizedPaymentWebhook,
  type PaymentProvider, type PaymentTransactionType, type PlanDefinition, type PlanQuotaSpec, type SubscriptionStatus
} from './schema'

export const resolveEnvScopedValue = (val: EnvScopedString | undefined, isDev: boolean): string | undefined =>
  typeof val === 'string' ? val : val ? (isDev ? val.dev : val.prod) : undefined

export const currentPeriodKey = (periodStartIso?: string): string =>
  periodStartIso && /^\d{4}-\d{2}/.test(periodStartIso) ? periodStartIso.slice(0, 7) : new Date().toISOString().slice(0, 7)

export const paymentUsageDocId = (userId: string, periodKey: string): string => `${userId}_${periodKey}`

export const paymentTxDocId = (provider: PaymentProvider, externalId: string): string =>
  `tx_${createHash('sha256').update(`${provider}:${externalId}`).digest('hex').slice(0, 40)}`

export const idempotencyPaymentKey = (prefix: string, rawKey?: string): string | undefined =>
  rawKey ? `${prefix}_${createHash('sha256').update(rawKey.trim()).digest('hex').slice(0, 32)}` : undefined

export const defaultFallbackPlan = (defaultPlanId: string, defaultCurrency: string): PlanDefinition & { id: string; quota: PlanQuotaSpec } => ({
  id: defaultPlanId,
  name: defaultPlanId === 'free' ? 'Free Plan' : defaultPlanId,
  interval: 'free',
  amount: 0,
  currency: defaultCurrency.toLowerCase() as Lowercase<string>,
  quota: { overage: { enabled: false } }
})

export const encodeStripeForm = (data: Record<string, unknown>, prefix = '', out = new URLSearchParams()): URLSearchParams => {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue
    const formKey = prefix ? `${prefix}[${key}]` : key
    if (Array.isArray(value)) {
      value.forEach((item, idx) => {
        if (item !== null && typeof item === 'object') encodeStripeForm(item as Record<string, unknown>, `${formKey}[${idx}]`, out)
        else if (item !== undefined) out.append(`${formKey}[${idx}]`, String(item))
      })
    } else if (typeof value === 'object') {
      encodeStripeForm(value as Record<string, unknown>, formKey, out)
    } else {
      out.append(formKey, String(value))
    }
  }
  return out
}

const executePaymentFetch = async <T>(label: string, url: string, method: string, headers: Record<string, string>, body?: string): Promise<T> => {
  const res = await fetch(url, { method, headers, ...(body ? { body } : {}), signal: AbortSignal.timeout(15_000) })
  if (!res.ok) {
    const err = new Error(`${label} HTTP ${res.status}: ${await res.text().catch(() => '')}`)
    ;(err as { status?: number }).status = res.status
    throw err
  }
  return (await res.json().catch(() => ({}))) as T
}

export const requestStripeApi = async <T = Record<string, any>>(
  baseUrl: string,
  apiKey: string,
  apiVersion: string,
  method: string,
  path: string,
  formParams?: Record<string, unknown>,
  idempotencyKey?: string
): Promise<T> => {
  const url = `${baseUrl.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`
  const isGet = method.toUpperCase() === 'GET'
  const encoded = formParams ? encodeStripeForm(formParams).toString() : ''
  return executePaymentFetch<T>(
    'Stripe',
    isGet && encoded ? `${url}?${encoded}` : url,
    method.toUpperCase(),
    {
      Authorization: `Bearer ${apiKey}`,
      'Stripe-Version': apiVersion,
      ...(!isGet ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})
    },
    !isGet && encoded ? encoded : undefined
  )
}

export const requestDodoApi = async <T = Record<string, any>>(
  baseUrl: string,
  apiKey: string,
  method: string,
  path: string,
  body?: unknown,
  idempotencyKey?: string
): Promise<T> => {
  const url = `${baseUrl.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`
  const isGet = method.toUpperCase() === 'GET'
  return executePaymentFetch<T>(
    'Dodo',
    url,
    method.toUpperCase(),
    { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
    !isGet && body !== undefined ? JSON.stringify(body) : undefined
  )
}

const constantTimeEqual = (a: string, b: string): boolean => {
  if (!a || !b) return false
  const bufA = createHash('sha256').update(a).digest()
  const bufB = createHash('sha256').update(b).digest()
  return timingSafeEqual(bufA, bufB)
}

const getHeader = (headers: Record<string, string | undefined>, name: string): string | undefined => {
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower && v) return v.trim()
  }
  return undefined
}

export const verifyStripeWebhookHmac = (
  rawBody: string,
  headers: Record<string, string | undefined>,
  secret: string,
  toleranceSeconds: number
): Record<string, any> => {
  const sigHeader = getHeader(headers, 'stripe-signature')
  if (!sigHeader || !secret) {
    throw new Error('Missing Stripe-Signature header or webhook secret')
  }
  const parts = sigHeader.split(',').map((p) => p.trim())
  const tsPart = parts.find((p) => p.startsWith('t='))?.slice(2)
  const v1Sigs = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3))
  if (!tsPart || v1Sigs.length === 0) {
    throw new Error('Malformed Stripe-Signature header')
  }
  const tsSeconds = Number(tsPart)
  const nowSeconds = Math.floor(Date.now() / 1000)
  if (!Number.isFinite(tsSeconds) || Math.abs(nowSeconds - tsSeconds) > toleranceSeconds) {
    throw new Error('Stripe webhook timestamp outside tolerance window')
  }
  const expectedHex = createHmac('sha256', secret).update(`${tsPart}.${rawBody}`, 'utf8').digest('hex')
  if (!v1Sigs.some((sig) => constantTimeEqual(sig, expectedHex))) {
    throw new Error('Invalid Stripe webhook HMAC signature')
  }
  return JSON.parse(rawBody) as Record<string, any>
}

export const verifyDodoWebhookHmac = (
  rawBody: string,
  headers: Record<string, string | undefined>,
  secret: string,
  toleranceSeconds: number
): Record<string, any> => {
  const msgId = getHeader(headers, 'webhook-id') ?? getHeader(headers, 'svix-id')
  const msgTimestamp = getHeader(headers, 'webhook-timestamp') ?? getHeader(headers, 'svix-timestamp')
  const msgSignature = getHeader(headers, 'webhook-signature') ?? getHeader(headers, 'svix-signature')
  if (!msgId || !msgTimestamp || !msgSignature || !secret) {
    throw new Error('Missing Dodo Standard Webhooks signature headers or secret')
  }
  const tsSeconds = Number(msgTimestamp)
  const nowSeconds = Math.floor(Date.now() / 1000)
  if (!Number.isFinite(tsSeconds) || Math.abs(nowSeconds - tsSeconds) > toleranceSeconds) {
    throw new Error('Dodo webhook timestamp outside tolerance window')
  }
  const signedContent = `${msgId}.${msgTimestamp}.${rawBody}`
  const rawSecret = secret.startsWith('whsec_') ? secret.slice(6) : secret
  const expectedDecoded = createHmac('sha256', Buffer.from(rawSecret, 'base64'))
    .update(signedContent, 'utf8')
    .digest('base64')
  const expectedUtf8 = createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(signedContent, 'utf8')
    .digest('base64')
  const candidates = msgSignature
    .split(/\s+/)
    .map((part) => (part.startsWith('v1,') ? part.slice(3) : part.trim()))
    .filter(Boolean)
  if (!candidates.some((sig) => constantTimeEqual(sig, expectedDecoded) || constantTimeEqual(sig, expectedUtf8))) {
    throw new Error('Invalid Dodo webhook HMAC signature')
  }
  const parsed = JSON.parse(rawBody) as Record<string, any>
  return { ...parsed, _webhookId: msgId }
}

const STRIPE_EVENT_TX_MAP: Record<string, PaymentTransactionType> = {
  'checkout.session.completed': 'checkout.completed',
  'payment_intent.succeeded': 'payment.succeeded',
  'payment_intent.payment_failed': 'payment.failed',
  'invoice.created': 'invoice.created',
  'invoice.paid': 'invoice.paid',
  'invoice.payment_failed': 'subscription.past_due',
  'customer.subscription.created': 'subscription.active',
  'customer.subscription.updated': 'subscription.tier_changed',
  'customer.subscription.deleted': 'subscription.cancelled'
}

const DODO_EVENT_TX_MAP: Record<string, PaymentTransactionType> = {
  'payment.succeeded': 'payment.succeeded',
  'payment.failed': 'payment.failed',
  'subscription.active': 'subscription.active',
  'subscription.renewed': 'subscription.renewed',
  'subscription.plan_changed': 'subscription.tier_changed',
  'subscription.on_hold': 'subscription.past_due',
  'subscription.cancelled': 'subscription.cancelled',
  'subscription.expired': 'subscription.cancelled'
}

const mapSubStatus = (rawStatus?: string): SubscriptionStatus | undefined => {
  if (!rawStatus) return undefined
  const s = rawStatus.toLowerCase()
  if (s === 'active') return 'active'
  if (s === 'trialing') return 'trialing'
  if (s === 'past_due' || s === 'unpaid') return 'past_due'
  if (s === 'on_hold' || s === 'paused') return 'on_hold'
  if (s === 'canceled' || s === 'cancelled') return 'cancelled'
  if (s === 'expired' || s === 'incomplete_expired') return 'expired'
  return undefined
}

const toIsoIfEpochOrString = (val: unknown): string | undefined => {
  if (typeof val === 'number' && Number.isFinite(val)) {
    return new Date(val > 1e11 ? val : val * 1000).toISOString()
  }
  if (typeof val === 'string' && val.trim()) {
    const d = new Date(val)
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
  }
  return undefined
}

export const normalizePaymentWebhook = (
  provider: PaymentProvider,
  rawBody: string,
  headers: Record<string, string | undefined>,
  secret: string,
  toleranceSeconds: number
): NormalizedPaymentWebhook => {
  const raw =
    provider === 'stripe'
      ? verifyStripeWebhookHmac(rawBody, headers, secret, toleranceSeconds)
      : verifyDodoWebhookHmac(rawBody, headers, secret, toleranceSeconds)

  const rawEventType = String(raw.type ?? raw.event_type ?? '')
  const obj = (raw.data?.object ?? raw.data ?? raw) as Record<string, any>
  const meta = (obj.metadata ?? raw.metadata ?? {}) as Record<string, string | undefined>
  const eventId = String(raw.id ?? raw.event_id ?? raw._webhookId ?? obj.id ?? `evt_${Date.now()}`)
  const txType =
    (provider === 'stripe' ? STRIPE_EVENT_TX_MAP[rawEventType] : DODO_EVENT_TX_MAP[rawEventType]) ?? null
  const paymentId =
    typeof obj.payment_intent === 'string'
      ? obj.payment_intent
      : typeof obj.payment_id === 'string'
        ? obj.payment_id
        : txType === 'payment.succeeded' && typeof obj.id === 'string'
          ? obj.id
          : undefined

  const customerId =
    typeof obj.customer === 'string'
      ? obj.customer
      : typeof obj.customer?.customer_id === 'string'
        ? obj.customer.customer_id
        : typeof obj.customer_id === 'string'
          ? obj.customer_id
          : undefined

  const subscriptionId =
    typeof obj.subscription === 'string'
      ? obj.subscription
      : typeof obj.subscription_id === 'string'
        ? obj.subscription_id
        : rawEventType.includes('subscription') && typeof obj.id === 'string'
          ? obj.id
          : undefined

  const subStatus =
    mapSubStatus(obj.status) ??
    (txType === 'subscription.active' || txType === 'subscription.renewed'
      ? 'active'
      : txType === 'subscription.cancelled'
        ? 'cancelled'
        : txType === 'subscription.past_due'
          ? 'past_due'
          : undefined)

  const amountRaw = obj.amount_total ?? obj.amount_paid ?? obj.amount ?? obj.total_amount
  const amount = typeof amountRaw === 'number' ? Math.round(amountRaw) : undefined
  const currency = typeof obj.currency === 'string' ? obj.currency.toLowerCase() : undefined
  const currentPeriodStart = toIsoIfEpochOrString(obj.current_period_start ?? obj.previous_billing_date)
  const currentPeriodEnd = toIsoIfEpochOrString(obj.current_period_end ?? obj.next_billing_date)
  const cancelAtPeriodEnd =
    typeof obj.cancel_at_period_end === 'boolean'
      ? obj.cancel_at_period_end
      : typeof obj.cancel_at_next_billing_date === 'boolean'
        ? obj.cancel_at_next_billing_date
        : undefined

  return {
    eventId,
    ...(paymentId ? { paymentId } : {}),
    rawEventType,
    txType,
    ...(meta.userId ? { userId: meta.userId } : {}),
    ...(customerId ? { customerId } : {}),
    ...(subscriptionId ? { subscriptionId } : {}),
    ...(subStatus ? { subscriptionStatus: subStatus } : {}),
    ...(meta.planId ? { planId: meta.planId } : {}),
    ...(meta.productId ? { productId: meta.productId } : {}),
    ...(amount !== undefined ? { amount } : {}),
    ...(currency ? { currency } : {}),
    ...(currentPeriodStart ? { currentPeriodStart } : {}),
    ...(currentPeriodEnd ? { currentPeriodEnd } : {}),
    ...(cancelAtPeriodEnd !== undefined ? { cancelAtPeriodEnd } : {}),
    resetPeriodUsage: txType === 'subscription.renewed' || rawEventType === 'invoice.paid'
  }
}

export interface ResolvedPurchaseItem {
  kind: 'product' | 'plan' | 'custom'
  id?: string
  name: string
  description?: string
  amount: number
  currency: string
  quantity: number
  interval?: 'month' | 'year' | 'free'
  stripePriceId?: string
  dodoProductId?: string
  metadata: Record<string, string>
}

export const resolvePurchaseItem = (
  input: {
    product?: string
    plan?: string
    custom?: CustomLineItem
    quantity?: number
    amount?: number
    currency?: string
    description?: string
    metadata?: Record<string, string>
  },
  userId: string,
  isDev: boolean,
  defaultCurrency: string
): ResolvedPurchaseItem | { error: string } => {
  const quantity = input.quantity ?? input.custom?.quantity ?? 1
  if (input.product) {
    const prod = getProductDefinition(input.product)
    if (!prod) return { error: `Unknown product alias: ${input.product}` }
    const stripePriceId = resolveEnvScopedValue(prod.providers?.stripe?.priceId, isDev)
    const dodoProductId = resolveEnvScopedValue(prod.providers?.dodo?.productId, isDev)
    return {
      kind: 'product',
      id: prod.id,
      name: prod.name,
      ...(prod.description ? { description: prod.description } : {}),
      amount: prod.amount,
      currency: (prod.currency ?? defaultCurrency).toLowerCase(),
      quantity,
      ...(stripePriceId ? { stripePriceId } : {}),
      ...(dodoProductId ? { dodoProductId } : {}),
      metadata: { ...prod.metadata, ...input.metadata, userId, productId: prod.id }
    }
  }
  if (input.plan) {
    const plan = getPlanDefinition(input.plan)
    if (!plan) return { error: `Unknown plan alias: ${input.plan}` }
    const stripePriceId = resolveEnvScopedValue(plan.providers?.stripe?.priceId, isDev)
    const dodoProductId = resolveEnvScopedValue(plan.providers?.dodo?.productId, isDev)
    return {
      kind: 'plan',
      id: plan.id,
      name: plan.name,
      ...(plan.description ? { description: plan.description } : {}),
      amount: plan.amount,
      currency: (plan.currency ?? defaultCurrency).toLowerCase(),
      quantity,
      interval: plan.interval,
      ...(stripePriceId ? { stripePriceId } : {}),
      ...(dodoProductId ? { dodoProductId } : {}),
      metadata: { ...plan.metadata, ...input.metadata, userId, planId: plan.id }
    }
  }
  const c = input.custom
  const amount = c?.amount ?? input.amount ?? 0
  const name = c?.name ?? input.description ?? 'Custom Purchase'
  const description = c?.description ?? input.description
  return {
    kind: 'custom',
    name,
    ...(description ? { description } : {}),
    amount,
    currency: (c?.currency ?? input.currency ?? defaultCurrency).toLowerCase(),
    quantity,
    metadata: { ...input.metadata, userId }
  }
}

export const buildStripeLineItem = (item: ResolvedPurchaseItem): Record<string, unknown> =>
  item.stripePriceId
    ? { price: item.stripePriceId, quantity: item.quantity }
    : {
        quantity: item.quantity,
        price_data: {
          currency: item.currency,
          unit_amount: item.amount,
          product_data: {
            name: item.name,
            ...(item.description ? { description: item.description } : {})
          },
          ...(item.kind === 'plan' && item.interval && item.interval !== 'free'
            ? { recurring: { interval: item.interval } }
            : {})
        }
      }

export const buildDodoCartOrCustom = (item: ResolvedPurchaseItem): Record<string, unknown> =>
  item.dodoProductId
    ? { product_cart: [{ product_id: item.dodoProductId, quantity: item.quantity }] }
    : {
        billing_currency: item.currency,
        custom_item: {
          name: item.name,
          ...(item.description ? { description: item.description } : {}),
          amount: item.amount * item.quantity,
          currency: item.currency,
          quantity: item.quantity
        }
      }

export const computeUsageDelta = (
  usageData: Record<string, unknown>,
  custData: Record<string, unknown>,
  plan: PlanDefinition & { quota: PlanQuotaSpec },
  parsed: { metric: string; amount: number; inputTokens?: number; outputTokens?: number },
  skipMutation = false
) => {
  let aiTokensUsed = Number(usageData.aiTokensUsed ?? 0)
  let aiInputTokens = Number(usageData.aiInputTokens ?? 0)
  let aiOutputTokens = Number(usageData.aiOutputTokens ?? 0)
  let overageTokensReported = Number(usageData.overageTokensReported ?? 0)
  let bonusAiTokens = Number(custData.bonusAiTokens ?? 0)
  const metricsUsed: Record<string, number> = { ...(usageData.metricsUsed as Record<string, number> | undefined) }
  const bonusMetrics: Record<string, number> = { ...(custData.bonusMetrics as Record<string, number> | undefined) }
  let overageDelta = 0
  if (skipMutation) return { aiTokensUsed, aiInputTokens, aiOutputTokens, overageTokensReported, bonusAiTokens, metricsUsed, bonusMetrics, overageDelta }

  if (parsed.metric === 'ai_tokens') {
    const limit = plan.quota.aiTokens
    const prevUncovered = typeof limit === 'number' ? Math.max(0, aiTokensUsed - limit) : 0
    aiTokensUsed += Math.round(parsed.amount)
    aiInputTokens += parsed.inputTokens ?? 0
    aiOutputTokens += parsed.outputTokens ?? 0
    const nextUncovered = typeof limit === 'number' ? Math.max(0, aiTokensUsed - limit) : 0
    const uncoveredIncrease = Math.max(0, nextUncovered - prevUncovered)
    const bonusDeducted = Math.min(bonusAiTokens, uncoveredIncrease)
    bonusAiTokens -= bonusDeducted
    overageDelta = uncoveredIncrease - bonusDeducted
    if (overageDelta > 0 && plan.quota.overage?.enabled) overageTokensReported += overageDelta
  } else {
    const limit = plan.quota.metrics?.[parsed.metric]
    const prev = metricsUsed[parsed.metric] ?? 0
    const prevUncovered = typeof limit === 'number' ? Math.max(0, prev - limit) : 0
    const next = prev + parsed.amount
    metricsUsed[parsed.metric] = next
    const nextUncovered = typeof limit === 'number' ? Math.max(0, next - limit) : 0
    const uncoveredIncrease = Math.max(0, nextUncovered - prevUncovered)
    const availBonus = bonusMetrics[parsed.metric] ?? 0
    const bonusDeducted = Math.min(availBonus, uncoveredIncrease)
    if (bonusDeducted > 0) bonusMetrics[parsed.metric] = availBonus - bonusDeducted
  }
  return { aiTokensUsed, aiInputTokens, aiOutputTokens, overageTokensReported, bonusAiTokens, metricsUsed, bonusMetrics, overageDelta }
}

