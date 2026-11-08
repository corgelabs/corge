import type { EntryId } from '../db'
import type { Core } from '../index'
import { PaymentsBillingEngine } from './billing'
import {
  getPlanDefinition,
  getProductDefinition,
  recordUsageInput,
  type CancelSubscriptionInput,
  type ChangeTierInput,
  type ChargeResult,
  type CheckoutSessionResult,
  type CreateCheckoutInput,
  type CreateInvoiceInput,
  type CreatePaymentLinkInput,
  type CustomerBillingSummary,
  type DirectChargeInput,
  type InvoiceResult,
  type NormalizedPaymentWebhook,
  type PaymentCallOptions,
  type PaymentLinkResult,
  type PaymentProvider,
  type PaymentWebhookResult,
  type QuotaCheckResult,
  type RecordUsageInput,
  type SubscribeInput,
  type SubscribeResult,
  type SubscriptionRecord,
  type UsageStatusResult
} from './schema'
import {
  computeUsageDelta,
  currentPeriodKey,
  defaultFallbackPlan,
  normalizePaymentWebhook,
  paymentTxDocId,
  paymentUsageDocId
} from './utils'

export class PaymentsService {
  readonly #core: Core
  readonly #billing: PaymentsBillingEngine

  constructor(coreClient: Core) {
    this.#core = coreClient
    this.#billing = new PaymentsBillingEngine(coreClient)
  }

  createCheckout = (input: CreateCheckoutInput, opts?: PaymentCallOptions): Promise<CheckoutSessionResult> =>
    this.#billing.createCheckout(input, opts)

  createPaymentLink = (input: CreatePaymentLinkInput, opts?: PaymentCallOptions): Promise<PaymentLinkResult> =>
    this.#billing.createPaymentLink(input, opts)

  createInvoice = (input: CreateInvoiceInput, opts?: PaymentCallOptions): Promise<InvoiceResult> =>
    this.#billing.createInvoice(input, opts)

  charge = (input: DirectChargeInput, opts?: PaymentCallOptions): Promise<ChargeResult> =>
    this.#billing.charge(input, opts)

  subscribe = (input: SubscribeInput, opts?: PaymentCallOptions): Promise<SubscribeResult> =>
    this.#billing.subscribe(input, opts)

  changeSubscriptionTier = (input: ChangeTierInput, opts?: PaymentCallOptions): Promise<SubscriptionRecord> =>
    this.#billing.changeSubscriptionTier(input, opts)

  cancelSubscription = (input?: CancelSubscriptionInput, opts?: PaymentCallOptions): Promise<SubscriptionRecord> =>
    this.#billing.cancelSubscription(input, opts)

  getSubscription = async (userId: EntryId = this.#core.userId): Promise<CustomerBillingSummary> => {
    const cfg = this.#core.config.payments
    const cust = await this.#core.db.read('payment_customer', userId, false, { bypassRbac: true })
    const planId = cust?.planId ?? cfg.defaultPlanId
    const plan = getPlanDefinition(planId) ?? defaultFallbackPlan(planId, cfg.defaultCurrency)
    return {
      userId,
      planId,
      plan: {
        id: plan.id,
        name: plan.name,
        interval: plan.interval,
        amount: plan.amount,
        currency: (plan.currency ?? cfg.defaultCurrency).toLowerCase()
      },
      status: cust?.subscriptionStatus ?? 'none',
      ...(cust?.subscriptionId ? { subscriptionId: cust.subscriptionId } : {}),
      ...(cust?.activeProvider ? { activeProvider: cust.activeProvider } : {}),
      ...(cust?.currentPeriodStart ? { currentPeriodStart: cust.currentPeriodStart } : {}),
      ...(cust?.currentPeriodEnd ? { currentPeriodEnd: cust.currentPeriodEnd } : {}),
      cancelAtPeriodEnd: Boolean(cust?.cancelAtPeriodEnd),
      bonusAiTokens: cust?.bonusAiTokens ?? 0,
      credits: cust?.credits ?? 0,
      bonusMetrics: cust?.bonusMetrics ?? {}
    }
  }

  getUsage = async (userId: EntryId = this.#core.userId): Promise<UsageStatusResult> => {
    const cfg = this.#core.config.payments
    const cust = await this.#core.db.read('payment_customer', userId, false, { bypassRbac: true })
    const planId = cust?.planId ?? cfg.defaultPlanId
    const plan = getPlanDefinition(planId) ?? defaultFallbackPlan(planId, cfg.defaultCurrency)
    const periodKey = currentPeriodKey(cust?.currentPeriodStart)
    const usage = await this.#core.db.read('payment_usage', paymentUsageDocId(userId, periodKey), false, {
      bypassRbac: true
    })
    return {
      userId,
      periodKey,
      planId,
      aiTokensUsed: usage?.aiTokensUsed ?? 0,
      aiTokensLimit: plan.quota.aiTokens ?? null,
      bonusAiTokens: cust?.bonusAiTokens ?? 0,
      overageTokensReported: usage?.overageTokensReported ?? 0,
      overageEnabled: Boolean(plan.quota.overage?.enabled),
      ...(plan.quota.overage?.maxOverageTokens !== undefined ? { maxOverageTokens: plan.quota.overage.maxOverageTokens } : {}),
      metricsUsed: usage?.metricsUsed ?? {},
      metricsLimits: plan.quota.metrics ?? {},
      bonusMetrics: cust?.bonusMetrics ?? {}
    }
  }

  checkQuota = async (
    metric = 'ai_tokens',
    requiredAmount = 1,
    userId: EntryId = this.#core.userId,
    throwOnExceeded = true
  ): Promise<QuotaCheckResult> => {
    const usage = await this.getUsage(userId)
    const isAi = metric === 'ai_tokens'
    const used = isAi ? usage.aiTokensUsed : (usage.metricsUsed[metric] ?? 0)
    const limit = isAi ? usage.aiTokensLimit : (usage.metricsLimits[metric] ?? null)
    const bonusRemaining = isAi ? usage.bonusAiTokens : (usage.bonusMetrics[metric] ?? 0)
    const overageEnabled = isAi ? usage.overageEnabled : false
    const maxOverage = isAi ? usage.maxOverageTokens : undefined

    if (limit === null) {
      return { allowed: true, metric, used, limit: null, bonusRemaining, overageEnabled, remaining: null }
    }
    const baseAndBonusCap = limit + bonusRemaining
    const hardCap = overageEnabled
      ? maxOverage !== undefined
        ? baseAndBonusCap + maxOverage
        : Number.POSITIVE_INFINITY
      : baseAndBonusCap
    const allowed = used + requiredAmount <= hardCap
    const remaining = Number.isFinite(hardCap) ? Math.max(0, hardCap - used) : null

    if (!allowed && throwOnExceeded) {
      return this.#core.errors.httpError(
        402,
        `Payment Required: ${metric} quota exceeded for plan "${usage.planId}"`,
        'QUOTA_EXCEEDED'
      )
    }
    return { allowed, metric, used, limit, bonusRemaining, overageEnabled, remaining }
  }

  #ingestMeterEvent = async (
    provider: PaymentProvider,
    providerCustomerId: string,
    eventName: string,
    value: number,
    idempotencyKey: string,
    metadata?: Record<string, string>
  ): Promise<void> => {
    if (this.#billing.getCreds(provider).isSyntheticDev || value <= 0) return
    if (provider === 'stripe') {
      await this.#billing.stripeCall(
        'POST',
        '/billing/meter_events',
        {
          event_name: eventName,
          identifier: idempotencyKey,
          payload: { stripe_customer_id: providerCustomerId, value: String(Math.round(value)) }
        },
        idempotencyKey
      )
      return
    }
    await this.#billing.dodoCall(
      'POST',
      '/events/ingest',
      {
        events: [
          {
            event_id: idempotencyKey,
            customer_id: providerCustomerId,
            event_name: eventName,
            timestamp: new Date().toISOString(),
            metadata: { ...metadata, value: String(Math.round(value)) }
          }
        ]
      },
      idempotencyKey
    )
  }

  recordUsage = async (rawInput: RecordUsageInput, opts?: PaymentCallOptions): Promise<UsageStatusResult> => {
    const parsed = recordUsageInput.parse(rawInput)
    const userId = opts?.userId ?? this.#core.userId
    const cfg = this.#core.config.payments
    const db = this.#core.db.firestore()
    const custRef = db.collection('payment_customer').doc(userId)
    const rawIdemKey = parsed.idempotencyKey ?? opts?.idempotencyKey

    await this.#core.internals.resilience.acquireLimit('firestore')
    const txOut = await db.runTransaction(async (tx) => {
      const idemRef = rawIdemKey
        ? db.collection('_idempotency').doc(`pay_usage_${userId}_${rawIdemKey.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96)}`)
        : undefined
      const custSnap = await tx.get(custRef)
      const custData = custSnap.data() ?? {}
      const planId = String(custData.planId ?? cfg.defaultPlanId)
      const plan = getPlanDefinition(planId) ?? defaultFallbackPlan(planId, cfg.defaultCurrency)
      const periodKey = currentPeriodKey(custData.currentPeriodStart as string | undefined)
      const usageId = paymentUsageDocId(userId, periodKey)
      const usageRef = db.collection('payment_usage').doc(usageId)
      const [usageSnap, idemSnap] = await Promise.all([tx.get(usageRef), idemRef ? tx.get(idemRef) : Promise.resolve(undefined)])
      const usageData = usageSnap.data() ?? {}
      const delta = computeUsageDelta(usageData, custData, plan, parsed, Boolean(idemSnap?.exists))

      if (!idemSnap?.exists) {
        const now = new Date()
        if (idemRef) tx.set(idemRef, { key: idemRef.id, userId, createdAt: now, expiresAt: new Date(now.getTime() + 86_400_000) })
        tx.set(
          usageRef,
          {
            id: usageId,
            userId,
            periodKey,
            planId,
            aiTokensUsed: delta.aiTokensUsed,
            aiInputTokens: delta.aiInputTokens,
            aiOutputTokens: delta.aiOutputTokens,
            overageTokensReported: delta.overageTokensReported,
            metricsUsed: delta.metricsUsed,
            lastUpdatedAt: now.toISOString(),
            deleted: false,
            createdAt: usageData.createdAt ?? now,
            updatedAt: now
          },
          { merge: true }
        )
        if (custSnap.exists || delta.bonusAiTokens !== Number(custData.bonusAiTokens ?? 0)) {
          tx.set(
            custRef,
            {
              id: userId,
              userId,
              planId,
              bonusAiTokens: delta.bonusAiTokens,
              bonusMetrics: delta.bonusMetrics,
              updatedAt: now,
              ...(custSnap.exists ? {} : { createdAt: now, deleted: false, subscriptionStatus: 'none', cancelAtPeriodEnd: false, credits: 0 })
            },
            { merge: true }
          )
        }
      }
      return {
        plan,
        custData,
        overageDelta: delta.overageDelta,
        result: {
          userId,
          periodKey,
          planId,
          aiTokensUsed: delta.aiTokensUsed,
          aiTokensLimit: plan.quota.aiTokens ?? null,
          bonusAiTokens: delta.bonusAiTokens,
          overageTokensReported: delta.overageTokensReported,
          overageEnabled: Boolean(plan.quota.overage?.enabled),
          ...(plan.quota.overage?.maxOverageTokens !== undefined ? { maxOverageTokens: plan.quota.overage.maxOverageTokens } : {}),
          metricsUsed: delta.metricsUsed,
          metricsLimits: plan.quota.metrics ?? {},
          bonusMetrics: delta.bonusMetrics
        } satisfies UsageStatusResult
      }
    })

    if (txOut.overageDelta > 0 && txOut.plan.quota.overage?.enabled) {
      const provider = this.#billing.resolveProvider(opts?.provider ?? (txOut.custData.activeProvider as PaymentProvider | undefined))
      const { providerCustomerId } = await this.#billing.ensureCustomer(userId, provider)
      const meterName =
        (provider === 'stripe' ? txOut.plan.providers?.stripe?.meterEventName : txOut.plan.providers?.dodo?.meterEventName) ??
        cfg.aiTokenMeterName
      const idemKey = parsed.idempotencyKey ?? `mtr_${userId}_${Date.now()}_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`
      await this.#ingestMeterEvent(provider, providerCustomerId, meterName, txOut.overageDelta, idemKey, {
        ...parsed.metadata,
        ...(parsed.model ? { model: parsed.model } : {})
      })
    }
    return txOut.result
  }

  #applyWebhookStateUpdate = async (
    provider: PaymentProvider,
    ev: NormalizedPaymentWebhook
  ): Promise<{ handled: boolean; deduplicated?: boolean }> => {
    const db = this.#core.db.firestore()
    let userId = ev.userId
    if (!userId && ev.customerId) {
      const field = provider === 'stripe' ? 'stripeCustomerId' : 'dodoCustomerId'
      const snap = await db.collection('payment_customer').where(field, '==', ev.customerId).where('deleted', '==', false).limit(1).get()
      userId = snap.docs[0]?.id
    }
    if (!userId || !ev.txType) return { handled: false }

    const txId = paymentTxDocId(provider, ev.eventId)
    const txRef = db.collection('payment_transaction').doc(txId)
    const custRef = db.collection('payment_customer').doc(userId)
    const prod = ev.productId ? getProductDefinition(ev.productId) : undefined
    const grantKey = prod?.grants ? (ev.paymentId ?? ev.eventId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96) : undefined
    const grantRef = grantKey ? db.collection('_idempotency').doc(`pay_grant_${userId}_${grantKey}`) : undefined
    await this.#core.internals.resilience.acquireLimit('firestore')

    const { deduplicated } = await db.runTransaction(async (tx) => {
      const [txSnap, custSnap, grantSnap] = await Promise.all([tx.get(txRef), tx.get(custRef), grantRef ? tx.get(grantRef) : Promise.resolve(undefined)])
      if (txSnap.exists) return { deduplicated: true }
      const custData = custSnap.data() ?? {}
      const now = new Date()
      const applyGrants = Boolean(prod?.grants && !grantSnap?.exists)
      if (applyGrants && grantRef) {
        tx.set(grantRef, { key: grantRef.id, userId, productId: ev.productId, createdAt: now, expiresAt: new Date(now.getTime() + 86_400_000) })
      }
      const bonusMetrics: Record<string, number> = { ...(custData.bonusMetrics ?? {}) }
      if (applyGrants) {
        for (const [m, delta] of Object.entries(prod?.grants?.metrics ?? {})) bonusMetrics[m] = (bonusMetrics[m] ?? 0) + delta
      }
      const defaultPlanId = this.#core.config.payments.defaultPlanId
      const nextPlanId = ev.txType === 'subscription.cancelled' ? defaultPlanId : (ev.planId ?? custData.planId ?? defaultPlanId)

      tx.set(txRef, {
        id: txId,
        userId,
        provider,
        externalId: ev.eventId,
        type: ev.txType,
        ...(ev.amount !== undefined ? { amount: ev.amount } : {}),
        ...(ev.currency ? { currency: ev.currency } : {}),
        ...(ev.productId || ev.planId ? { productOrPlanId: ev.productId ?? ev.planId } : {}),
        rawEventType: ev.rawEventType,
        processedAt: now.toISOString(),
        deleted: false,
        createdAt: now,
        updatedAt: now
      })

      tx.set(
        custRef,
        {
          id: userId,
          userId,
          activeProvider: provider,
          ...(ev.customerId ? (provider === 'stripe' ? { stripeCustomerId: ev.customerId } : { dodoCustomerId: ev.customerId }) : {}),
          planId: nextPlanId,
          ...(ev.subscriptionId ? { subscriptionId: ev.subscriptionId } : {}),
          ...(ev.subscriptionStatus ? { subscriptionStatus: ev.subscriptionStatus } : {}),
          ...(ev.currentPeriodStart ? { currentPeriodStart: ev.currentPeriodStart } : {}),
          ...(ev.currentPeriodEnd ? { currentPeriodEnd: ev.currentPeriodEnd } : {}),
          ...(ev.cancelAtPeriodEnd !== undefined ? { cancelAtPeriodEnd: ev.cancelAtPeriodEnd } : {}),
          bonusAiTokens: Number(custData.bonusAiTokens ?? 0) + (applyGrants ? (prod?.grants?.aiTokens ?? 0) : 0),
          credits: Number(custData.credits ?? 0) + (applyGrants ? (prod?.grants?.credits ?? 0) : 0),
          bonusMetrics,
          deleted: false,
          createdAt: custData.createdAt ?? now,
          updatedAt: now
        },
        { merge: true }
      )
      return { deduplicated: false }
    })

    if (!deduplicated && ev.resetPeriodUsage) {
      const periodKey = currentPeriodKey(ev.currentPeriodStart)
      const usageId = paymentUsageDocId(userId, periodKey)
      const now = new Date()
      const planId = ev.planId ?? this.#core.config.payments.defaultPlanId
      await db.collection('payment_usage').doc(usageId).set(
        { id: usageId, userId, periodKey, planId, aiTokensUsed: 0, aiInputTokens: 0, aiOutputTokens: 0, overageTokensReported: 0, metricsUsed: {}, lastUpdatedAt: now.toISOString(), deleted: false, createdAt: now, updatedAt: now },
        { merge: true }
      )
    }
    return { handled: true, ...(deduplicated ? { deduplicated: true } : {}) }
  }

  #verifyAndProcessWebhook = async (
    provider: PaymentProvider,
    rawBody: string,
    headers: Record<string, string | undefined>
  ): Promise<PaymentWebhookResult> => {
    const { webhookSecret } = this.#billing.getCreds(provider)
    let normalized: NormalizedPaymentWebhook
    try {
      normalized = normalizePaymentWebhook(provider, rawBody, headers, webhookSecret, this.#core.config.payments.webhookToleranceSeconds)
    } catch (err) {
      return this.#core.errors.httpError(
        401,
        err instanceof Error ? err.message : `Invalid ${provider} webhook signature`,
        'INVALID_WEBHOOK_SIGNATURE'
      )
    }
    const { handled, deduplicated } = await this.#applyWebhookStateUpdate(provider, normalized)
    return { received: true, eventId: normalized.eventId, handled, ...(deduplicated ? { deduplicated: true } : {}) }
  }

  #enforceAiQuota = async (userId: EntryId = this.#core.userId, estimatedTokens = 1): Promise<void> => {
    const cfg = this.#core.config.payments
    if (!cfg.enabled || !cfg.autoTrackAiTokens || !userId || this.#core.role === 'admin' || userId === this.#core.config.auth.adminUserId) return
    await this.checkQuota('ai_tokens', estimatedTokens, userId, true)
  }

  #trackAiUsage = async (params: {
    userId?: EntryId
    model: string
    inputTokens: number
    outputTokens: number
    totalTokens?: number
    source: 'generate' | 'vision' | 'decide' | 'chat'
  }): Promise<void> => {
    const cfg = this.#core.config.payments
    const userId = params.userId ?? this.#core.userId
    if (!cfg.enabled || !cfg.autoTrackAiTokens || !userId || this.#core.role === 'admin' || userId === this.#core.config.auth.adminUserId) return
    const total = params.totalTokens ?? params.inputTokens + params.outputTokens
    if (total <= 0) return
    await this.recordUsage(
      {
        metric: 'ai_tokens',
        amount: total,
        inputTokens: params.inputTokens,
        outputTokens: params.outputTokens,
        model: params.model,
        metadata: { source: params.source }
      },
      { userId }
    )
  }

  get internals() {
    return {
      enforceAiQuota: this.#enforceAiQuota,
      trackAiUsage: this.#trackAiUsage,
      verifyAndProcessWebhook: this.#verifyAndProcessWebhook
    }
  }
}
