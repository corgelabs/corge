import type { EntryId } from '../db'
import type { Corge } from '../index'
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
  type PlanDefinition,
  type PlanQuotaSpec,
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
  paymentUsageDocId,
  resolveEnvScopedValue
} from './utils'

export class PaymentsService {
  readonly #corge: Corge
  readonly #billing: PaymentsBillingEngine

  constructor(corgeClient: Corge) {
    this.#corge = corgeClient
    this.#billing = new PaymentsBillingEngine(corgeClient)
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

  getSubscription = async (userId: EntryId = this.#corge.userId): Promise<CustomerBillingSummary> => {
    const cfg = this.#corge.config.payments
    const cust = await this.#corge.db.read('payment_customer', userId, false, { bypassRbac: true })
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

  getUsage = async (userId: EntryId = this.#corge.userId): Promise<UsageStatusResult> => {
    const cfg = this.#corge.config.payments
    const cust = await this.#corge.db.read('payment_customer', userId, false, { bypassRbac: true })
    const planId = cust?.planId ?? cfg.defaultPlanId
    const plan = getPlanDefinition(planId) ?? defaultFallbackPlan(planId, cfg.defaultCurrency)
    const periodKey = currentPeriodKey(cust?.currentPeriodStart)
    const usage = await this.#corge.db.read('payment_usage', paymentUsageDocId(userId, periodKey), false, {
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
    userId: EntryId = this.#corge.userId,
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
      return this.#corge.errors.httpError(
        402,
        `Payment Required: ${metric} quota exceeded for plan "${usage.planId}"`,
        'QUOTA_EXCEEDED'
      )
    }
    return { allowed, metric, used, limit, bonusRemaining, overageEnabled, remaining }
  }

  #ingestMeterEvent = async (params: {
    provider: PaymentProvider
    providerCustomerId: string
    subscriptionId?: string
    plan: PlanDefinition & { id: string; quota: PlanQuotaSpec }
    eventName: string
    overageDelta: number
    overageUnits: number
    idempotencyKey: string
    metadata?: Record<string, string>
  }): Promise<void> => {
    const { provider, providerCustomerId, subscriptionId, plan, eventName, overageDelta, overageUnits, idempotencyKey, metadata } =
      params
    if (this.#billing.getCreds(provider).isSyntheticDev || overageDelta <= 0) return

    if (provider === 'stripe') {
      await this.#billing.stripeCall(
        'POST',
        '/billing/meter_events',
        {
          event_name: eventName,
          identifier: idempotencyKey,
          payload: { stripe_customer_id: providerCustomerId, value: String(Math.round(overageDelta)) }
        },
        idempotencyKey
      )
      return
    }

    if (provider === 'dodo') {
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
              metadata: { ...metadata, value: String(Math.round(overageDelta)) }
            }
          ]
        },
        idempotencyKey
      )
      return
    }

    if (!subscriptionId || subscriptionId.startsWith('sub_dev_') || overageUnits <= 0) return
    const isDev = Boolean(this.#corge.env.isDev)
    const cfg = this.#corge.config.payments
    const overagePriceId = resolveEnvScopedValue(plan.providers?.paddle?.overagePriceId, isDev)
    const paddleProductId = resolveEnvScopedValue(plan.providers?.paddle?.productId, isDev)
    const unitTokens = plan.quota.overage?.unitTokens ?? 1_000_000
    const rateCents = plan.quota.overage?.rateCents ?? 100
    const currency = (plan.currency ?? cfg.defaultCurrency).toUpperCase()

    await this.#billing.paddleCall(
      'POST',
      `/subscriptions/${subscriptionId}/charge`,
      {
        effective_from: 'next_billing_period',
        items: [
          overagePriceId
            ? { price_id: overagePriceId, quantity: overageUnits }
            : {
                quantity: overageUnits,
                price: {
                  name: `AI Token Overage (${unitTokens.toLocaleString()} tokens/unit)`,
                  description: `Metered AI token overage for plan ${plan.name}`,
                  billing_cycle: null,
                  unit_price: {
                    amount: String(rateCents),
                    currency_code: currency
                  },
                  ...(paddleProductId
                    ? { product_id: paddleProductId }
                    : {
                        product: {
                          name: `${plan.name} AI Token Overage`,
                          tax_category: cfg.paddle.taxCategory
                        }
                      })
                }
              }
        ]
      },
      idempotencyKey
    )
  }

  recordUsage = async (rawInput: RecordUsageInput, opts?: PaymentCallOptions): Promise<UsageStatusResult> => {
    const parsed = recordUsageInput.parse(rawInput)
    const userId = opts?.userId ?? this.#corge.userId
    const cfg = this.#corge.config.payments
    const db = this.#corge.db.firestore()
    const custRef = db.collection('payment_customer').doc(userId)
    const rawIdemKey = parsed.idempotencyKey

    await this.#corge.internals.resilience.acquireLimit('firestore')
    const txOut = await db.runTransaction(async (tx) => {
      const idemRef = rawIdemKey
        ? db.collection('_idempotency').doc(`pay_usage_${userId}_${rawIdemKey.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96)}`)
        : undefined
      const custSnap = await tx.get(custRef)
      const custData = custSnap.data() ?? {}
      const planId = String(custData.planId ?? cfg.defaultPlanId)
      const plan = getPlanDefinition(planId) ?? defaultFallbackPlan(planId, cfg.defaultCurrency)
      const activeProv = this.#billing.resolveProvider(
        opts?.provider ?? (custData.activeProvider as PaymentProvider | undefined)
      )
      const stepTokens = activeProv === 'paddle' ? (plan.quota.overage?.unitTokens ?? 1_000_000) : 1
      const periodKey = currentPeriodKey(custData.currentPeriodStart as string | undefined)
      const usageId = paymentUsageDocId(userId, periodKey)
      const usageRef = db.collection('payment_usage').doc(usageId)
      const [usageSnap, idemSnap] = await Promise.all([
        tx.get(usageRef),
        idemRef ? tx.get(idemRef) : Promise.resolve(undefined)
      ])
      const usageData = usageSnap.data() ?? {}
      const delta = computeUsageDelta(usageData, custData, plan, parsed, Boolean(idemSnap?.exists), stepTokens)

      if (!idemSnap?.exists) {
        const now = new Date()
        if (idemRef) {
          tx.set(idemRef, { key: idemRef.id, userId, createdAt: now, expiresAt: new Date(now.getTime() + 86_400_000) })
        }
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
            overageCarryTokens: delta.overageCarryTokens,
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
              ...(custSnap.exists
                ? {}
                : { createdAt: now, deleted: false, subscriptionStatus: 'none', cancelAtPeriodEnd: false, credits: 0 })
            },
            { merge: true }
          )
        }
      }
      return {
        plan,
        custData,
        activeProv,
        overageDelta: delta.overageDelta,
        overageUnits: delta.overageUnits,
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
      const provider = txOut.activeProv
      const { providerCustomerId } = await this.#billing.ensureCustomer(userId, provider)
      const meterName =
        (provider === 'stripe'
          ? txOut.plan.providers?.stripe?.meterEventName
          : provider === 'dodo'
            ? txOut.plan.providers?.dodo?.meterEventName
            : undefined) ?? cfg.aiTokenMeterName
      const idemKey = parsed.idempotencyKey ?? `mtr_${userId}_${Date.now()}_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`
      const subscriptionId = typeof txOut.custData.subscriptionId === 'string' ? txOut.custData.subscriptionId : undefined
      await this.#ingestMeterEvent({
        provider,
        providerCustomerId,
        ...(subscriptionId ? { subscriptionId } : {}),
        plan: txOut.plan,
        eventName: meterName,
        overageDelta: txOut.overageDelta,
        overageUnits: txOut.overageUnits,
        idempotencyKey: idemKey,
        metadata: {
          ...parsed.metadata,
          ...(parsed.model ? { model: parsed.model } : {})
        }
      })
    }
    return txOut.result
  }

  #applyWebhookStateUpdate = async (
    provider: PaymentProvider,
    ev: NormalizedPaymentWebhook
  ): Promise<{ handled: boolean; deduplicated?: boolean }> => {
    const db = this.#corge.db.firestore()
    let userId = ev.userId
    if (!userId && ev.customerId) {
      const field =
        provider === 'stripe' ? 'stripeCustomerId' : provider === 'dodo' ? 'dodoCustomerId' : 'paddleCustomerId'
      const snap = await db
        .collection('payment_customer')
        .where(field, '==', ev.customerId)
        .where('deleted', '==', false)
        .limit(1)
        .get()
      userId = snap.docs[0]?.id
    }
    if (!userId || !ev.txType) return { handled: false }

    const txId = paymentTxDocId(provider, ev.eventId)
    const txRef = db.collection('payment_transaction').doc(txId)
    const custRef = db.collection('payment_customer').doc(userId)
    const prod = ev.productId ? getProductDefinition(ev.productId) : undefined
    const grantKey = prod?.grants ? (ev.paymentId ?? ev.eventId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96) : undefined
    const grantRef = grantKey ? db.collection('_idempotency').doc(`pay_grant_${userId}_${grantKey}`) : undefined
    await this.#corge.internals.resilience.acquireLimit('firestore')

    const { deduplicated } = await db.runTransaction(async (tx) => {
      const [txSnap, custSnap, grantSnap] = await Promise.all([
        tx.get(txRef),
        tx.get(custRef),
        grantRef ? tx.get(grantRef) : Promise.resolve(undefined)
      ])
      if (txSnap.exists) return { deduplicated: true }
      const custData = custSnap.data() ?? {}
      const now = new Date()
      const applyGrants = Boolean(prod?.grants && !grantSnap?.exists)
      if (applyGrants && grantRef) {
        tx.set(grantRef, {
          key: grantRef.id,
          userId,
          productId: ev.productId,
          createdAt: now,
          expiresAt: new Date(now.getTime() + 86_400_000)
        })
      }
      const bonusMetrics: Record<string, number> = { ...(custData.bonusMetrics ?? {}) }
      if (applyGrants) {
        for (const [m, delta] of Object.entries(prod?.grants?.metrics ?? {})) bonusMetrics[m] = (bonusMetrics[m] ?? 0) + delta
      }
      const defaultPlanId = this.#corge.config.payments.defaultPlanId
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

      const customerIdPatch = ev.customerId
        ? provider === 'stripe'
          ? { stripeCustomerId: ev.customerId }
          : provider === 'dodo'
            ? { dodoCustomerId: ev.customerId }
            : { paddleCustomerId: ev.customerId }
        : {}

      tx.set(
        custRef,
        {
          id: userId,
          userId,
          activeProvider: provider,
          ...customerIdPatch,
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
      const planId = ev.planId ?? this.#corge.config.payments.defaultPlanId
      await db.collection('payment_usage').doc(usageId).set(
        {
          id: usageId,
          userId,
          periodKey,
          planId,
          aiTokensUsed: 0,
          aiInputTokens: 0,
          aiOutputTokens: 0,
          overageTokensReported: 0,
          overageCarryTokens: 0,
          metricsUsed: {},
          lastUpdatedAt: now.toISOString(),
          deleted: false,
          createdAt: now,
          updatedAt: now
        },
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
      normalized = normalizePaymentWebhook(
        provider,
        rawBody,
        headers,
        webhookSecret,
        this.#corge.config.payments.webhookToleranceSeconds
      )
    } catch (err) {
      return this.#corge.errors.httpError(
        401,
        err instanceof Error ? err.message : `Invalid ${provider} webhook signature`,
        'INVALID_WEBHOOK_SIGNATURE'
      )
    }
    const { handled, deduplicated } = await this.#applyWebhookStateUpdate(provider, normalized)
    return { received: true, eventId: normalized.eventId, handled, ...(deduplicated ? { deduplicated: true } : {}) }
  }

  #enforceAiQuota = async (userId: EntryId = this.#corge.userId, estimatedTokens = 1): Promise<void> => {
    const cfg = this.#corge.config.payments
    if (!cfg.enabled || !cfg.autoTrackAiTokens || !userId || this.#corge.role === 'admin' || userId === this.#corge.config.auth.adminUserId) return
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
    const cfg = this.#corge.config.payments
    const userId = params.userId ?? this.#corge.userId
    if (!cfg.enabled || !cfg.autoTrackAiTokens || !userId || this.#corge.role === 'admin' || userId === this.#corge.config.auth.adminUserId) return
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
