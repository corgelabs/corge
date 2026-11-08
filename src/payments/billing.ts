import type { EntryId, SelectModel } from '../db'
import type { Core } from '../index'
import {
  cancelSubscriptionInput, changeTierInput, createCheckoutInput, createInvoiceInput, createPaymentLinkInput, directChargeInput,
  getPlanDefinition, getProductDefinition, subscribeInput, type CancelSubscriptionInput, type ChangeTierInput, type ChargeResult,
  type CheckoutSessionResult, type CreateCheckoutInput, type CreateInvoiceInput, type CreatePaymentLinkInput, type DirectChargeInput,
  type InvoiceResult, type PaymentCallOptions, type PaymentLinkResult, type PaymentProvider, type SubscribeInput, type SubscribeResult, type SubscriptionRecord
} from './schema'
import {
  buildDodoCartOrCustom, buildStripeLineItem, currentPeriodKey, idempotencyPaymentKey, paymentUsageDocId,
  requestDodoApi, requestStripeApi, resolveEnvScopedValue, resolvePurchaseItem, type ResolvedPurchaseItem
} from './utils'

export class PaymentsBillingEngine {
  readonly #core: Core

  constructor(coreClient: Core) {
    this.#core = coreClient
  }

  resolveProvider = (override?: PaymentProvider): PaymentProvider => {
    if (override) return override
    const preferred = this.#core.config.payments.provider
    const isDev = Boolean(this.#core.env.isDev)
    const env = this.#core.env
    const hasStripe = Boolean((isDev ? env.STRIPE_SANDBOX_API_KEY : env.STRIPE_API_KEY) || env.STRIPE_API_KEY || env.STRIPE_SANDBOX_API_KEY)
    const hasDodo = Boolean((isDev ? env.DODO_SANDBOX_API_KEY : env.DODO_API_KEY) || env.DODO_API_KEY || env.DODO_SANDBOX_API_KEY)
    if (preferred === 'dodo' && !hasDodo && hasStripe) return 'stripe'
    if (preferred === 'stripe' && !hasStripe && hasDodo) return 'dodo'
    return preferred
  }

  getCreds = (provider: PaymentProvider) => {
    const isDev = Boolean(this.#core.env.isDev)
    const cfg = this.#core.config.payments
    const env = this.#core.env
    if (provider === 'stripe') {
      const apiKey = (isDev && env.STRIPE_SANDBOX_API_KEY ? env.STRIPE_SANDBOX_API_KEY : env.STRIPE_API_KEY || env.STRIPE_SANDBOX_API_KEY).trim()
      const webhookSecret = (isDev && env.STRIPE_SANDBOX_WEBHOOK_SECRET ? env.STRIPE_SANDBOX_WEBHOOK_SECRET : env.STRIPE_WEBHOOK_SECRET || env.STRIPE_SANDBOX_WEBHOOK_SECRET).trim()
      return { apiKey, webhookSecret, baseUrl: cfg.stripe.baseUrl, isSyntheticDev: isDev && !apiKey }
    }
    const apiKey = (isDev && env.DODO_SANDBOX_API_KEY ? env.DODO_SANDBOX_API_KEY : env.DODO_API_KEY || env.DODO_SANDBOX_API_KEY).trim()
    const webhookSecret = (isDev && env.DODO_SANDBOX_WEBHOOK_SECRET ? env.DODO_SANDBOX_WEBHOOK_SECRET : env.DODO_WEBHOOK_SECRET || env.DODO_SANDBOX_WEBHOOK_SECRET).trim()
    return { apiKey, webhookSecret, baseUrl: isDev ? cfg.dodo.testBaseUrl : cfg.dodo.liveBaseUrl, isSyntheticDev: isDev && !apiKey }
  }

  #withBreaker = async <T>(cost: number, fn: () => Promise<T>): Promise<T> => {
    await this.#core.internals.resilience.acquireLimit('payments', cost)
    return this.#core.internals.resilience.circuitBreaker('payments', fn, undefined, { isDev: this.#core.env.isDev })
  }

  stripeCall = <T = Record<string, any>>(method: string, path: string, form?: Record<string, unknown>, idempotencyKey?: string): Promise<T> => {
    const { baseUrl, apiKey } = this.getCreds('stripe')
    return this.#withBreaker(1, () => requestStripeApi<T>(baseUrl, apiKey, this.#core.config.payments.stripe.apiVersion, method, path, form, idempotencyKey))
  }

  dodoCall = <T = Record<string, any>>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> => {
    const { baseUrl, apiKey } = this.getCreds('dodo')
    return this.#withBreaker(1, () => requestDodoApi<T>(baseUrl, apiKey, method, path, body, idempotencyKey))
  }

  #resolveItem = (rawInput: Parameters<typeof resolvePurchaseItem>[0], userId: string): ResolvedPurchaseItem => {
    const res = resolvePurchaseItem(rawInput, userId, Boolean(this.#core.env.isDev), this.#core.config.payments.defaultCurrency)
    if ('error' in res) return this.#core.errors.httpError(400, res.error, 'INVALID_PAYMENT_ITEM')
    return res
  }

  ensureCustomer = async (userId: EntryId, provider: PaymentProvider): Promise<{ doc: SelectModel<'payment_customer'>; providerCustomerId: string }> =>
    this.#core.internals.resilience.singleflight(
      `pay_cust:${provider}:${userId}`,
      async () => {
        const defaultPlanId = this.#core.config.payments.defaultPlanId
        let doc = await this.#core.db.read('payment_customer', userId, false, { bypassRbac: true })
        if (!doc) {
          doc = await this.#core.db.create(
            'payment_customer',
            { id: userId, userId, planId: defaultPlanId, subscriptionStatus: 'none', cancelAtPeriodEnd: false, bonusAiTokens: 0, credits: 0, bonusMetrics: {} },
            { bypassRbac: true }
          )
        }
        const existingCusId = provider === 'stripe' ? doc.stripeCustomerId : doc.dodoCustomerId
        if (existingCusId) return { doc, providerCustomerId: existingCusId }

        let providerCustomerId = `cus_dev_${provider}_${userId}`
        if (!this.getCreds(provider).isSyntheticDev) {
          const custIdemKey = `cust_${provider}_${userId}`
          const created =
            provider === 'stripe'
              ? await this.stripeCall('POST', '/customers', { ...(doc.email ? { email: doc.email } : {}), ...(doc.name ? { name: doc.name } : {}), metadata: { userId } }, custIdemKey)
              : await this.dodoCall('POST', '/customers', { email: doc.email ?? `${userId}@customer.local`, name: doc.name ?? userId, metadata: { userId } }, custIdemKey)
          providerCustomerId = String(created.id ?? created.customer_id ?? providerCustomerId)
        }
        const patch = provider === 'stripe' ? { stripeCustomerId: providerCustomerId, activeProvider: provider } : { dodoCustomerId: providerCustomerId, activeProvider: provider }
        await this.#core.db.update('payment_customer', userId, patch, { bypassRbac: true })
        return { doc: { ...doc, ...patch }, providerCustomerId }
      },
      { scope: 'global' }
    )

  applyProductGrants = async (userId: EntryId, productId?: string, grantKey?: string): Promise<void> => {
    const prod = productId ? getProductDefinition(productId) : undefined
    if (!prod?.grants) return
    const db = this.#core.db.firestore()
    const custRef = db.collection('payment_customer').doc(userId)
    const grantRef = grantKey ? db.collection('_idempotency').doc(`pay_grant_${userId}_${grantKey.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96)}`) : undefined
    await this.#core.internals.resilience.acquireLimit('firestore')
    await db.runTransaction(async (tx) => {
      const [custSnap, grantSnap] = await Promise.all([tx.get(custRef), grantRef ? tx.get(grantRef) : Promise.resolve(undefined)])
      if (grantSnap?.exists) return
      const data = custSnap.data() ?? {}
      const bonusMetrics: Record<string, number> = { ...(data.bonusMetrics ?? {}) }
      for (const [m, delta] of Object.entries(prod.grants?.metrics ?? {})) bonusMetrics[m] = (bonusMetrics[m] ?? 0) + delta
      const now = new Date()
      if (grantRef) tx.set(grantRef, { key: grantRef.id, userId, productId, createdAt: now, expiresAt: new Date(now.getTime() + 86_400_000) })
      tx.set(
        custRef,
        {
          id: userId,
          userId,
          planId: data.planId ?? this.#core.config.payments.defaultPlanId,
          subscriptionStatus: data.subscriptionStatus ?? 'none',
          cancelAtPeriodEnd: Boolean(data.cancelAtPeriodEnd),
          bonusAiTokens: Number(data.bonusAiTokens ?? 0) + (prod.grants?.aiTokens ?? 0),
          credits: Number(data.credits ?? 0) + (prod.grants?.credits ?? 0),
          bonusMetrics,
          deleted: false,
          createdAt: data.createdAt ?? now,
          updatedAt: now
        },
        { merge: true }
      )
    })
  }

  createCheckout = async (rawInput: CreateCheckoutInput, opts?: PaymentCallOptions): Promise<CheckoutSessionResult> => {
    const parsed = createCheckoutInput.parse(rawInput)
    const userId = opts?.userId ?? this.#core.userId
    const provider = this.resolveProvider(opts?.provider)
    const isDev = Boolean(this.#core.env.isDev)
    const item = this.#resolveItem(parsed, userId)
    const { providerCustomerId } = await this.ensureCustomer(userId, provider)
    const cfgUrls = this.#core.config.payments.urls
    const successUrl = parsed.successUrl ?? resolveEnvScopedValue(cfgUrls.successUrl, isDev) ?? 'https://localhost/success'
    const cancelUrl = parsed.cancelUrl ?? resolveEnvScopedValue(cfgUrls.cancelUrl, isDev) ?? 'https://localhost/cancel'
    const idemKey = idempotencyPaymentKey('chk', parsed.idempotencyKey ?? opts?.idempotencyKey)

    if (this.getCreds(provider).isSyntheticDev) {
      const checkoutId = `chk_dev_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
      return { checkoutId, url: `${successUrl}?session_id=${checkoutId}`, provider }
    }
    if (provider === 'stripe') {
      const res = await this.stripeCall(
        'POST',
        '/checkout/sessions',
        {
          mode: item.kind === 'plan' ? 'subscription' : 'payment',
          customer: providerCustomerId,
          success_url: successUrl,
          cancel_url: cancelUrl,
          line_items: [buildStripeLineItem(item)],
          metadata: item.metadata
        },
        idemKey
      )
      return {
        checkoutId: String(res.id ?? `cs_${Date.now()}`),
        url: String(res.url ?? `${successUrl}?session_id=${res.id}`),
        provider: 'stripe',
        ...(typeof res.expires_at === 'number' ? { expiresAt: new Date(res.expires_at * 1000).toISOString() } : {})
      }
    }
    const res = await this.dodoCall(
      'POST',
      '/checkouts',
      { customer: { customer_id: providerCustomerId }, return_url: successUrl, ...buildDodoCartOrCustom(item), metadata: item.metadata },
      idemKey
    )
    const checkoutId = String(res.checkout_id ?? res.session_id ?? res.id ?? `chk_${Date.now()}`)
    return { checkoutId, url: String(res.checkout_url ?? res.payment_link ?? res.url ?? `${successUrl}?session_id=${checkoutId}`), provider: 'dodo' }
  }

  createPaymentLink = async (rawInput: CreatePaymentLinkInput, opts?: PaymentCallOptions): Promise<PaymentLinkResult> => {
    const parsed = createPaymentLinkInput.parse(rawInput)
    const userId = opts?.userId ?? this.#core.userId
    const provider = this.resolveProvider(opts?.provider)
    const isDev = Boolean(this.#core.env.isDev)
    const item = this.#resolveItem(parsed, userId)
    const { providerCustomerId } = await this.ensureCustomer(userId, provider)
    const returnUrl = parsed.returnUrl ?? resolveEnvScopedValue(this.#core.config.payments.urls.returnUrl, isDev) ?? 'https://localhost/billing'
    const idemKey = idempotencyPaymentKey('pl', parsed.idempotencyKey ?? opts?.idempotencyKey)

    if (this.getCreds(provider).isSyntheticDev) {
      const paymentLinkId = `pl_dev_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
      return { paymentLinkId, url: `${returnUrl}?payment_link=${paymentLinkId}`, provider }
    }
    if (provider === 'stripe') {
      const res = await this.stripeCall(
        'POST',
        '/payment_links',
        { line_items: [buildStripeLineItem(item)], after_completion: { type: 'redirect', redirect: { url: returnUrl } }, metadata: item.metadata },
        idemKey
      )
      return { paymentLinkId: String(res.id ?? `plink_${Date.now()}`), url: String(res.url ?? `${returnUrl}?payment_link=${res.id}`), provider: 'stripe' }
    }
    const res = await this.dodoCall(
      'POST',
      '/payments',
      { payment_link: true, customer: { customer_id: providerCustomerId }, return_url: returnUrl, ...buildDodoCartOrCustom(item), metadata: item.metadata },
      idemKey
    )
    const paymentLinkId = String(res.payment_id ?? res.id ?? `plink_${Date.now()}`)
    return { paymentLinkId, url: String(res.payment_link ?? res.url ?? `${returnUrl}?payment_link=${paymentLinkId}`), provider: 'dodo' }
  }

  createInvoice = async (rawInput: CreateInvoiceInput, opts?: PaymentCallOptions): Promise<InvoiceResult> => {
    const parsed = createInvoiceInput.parse(rawInput)
    const userId = opts?.userId ?? this.#core.userId
    const provider = this.resolveProvider(opts?.provider)
    const item = this.#resolveItem(parsed, userId)
    const totalAmount = item.amount * item.quantity
    const { providerCustomerId } = await this.ensureCustomer(userId, provider)
    const idemKey = idempotencyPaymentKey('inv', parsed.idempotencyKey ?? opts?.idempotencyKey)

    if (this.getCreds(provider).isSyntheticDev) {
      const invoiceId = `inv_dev_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
      return {
        invoiceId,
        status: 'open',
        amount: totalAmount,
        currency: item.currency,
        hostedInvoiceUrl: `https://localhost/invoices/${invoiceId}`,
        pdfUrl: `https://localhost/invoices/${invoiceId}.pdf`,
        provider
      }
    }
    if (provider === 'stripe') {
      await this.stripeCall('POST', '/invoiceitems', { customer: providerCustomerId, amount: totalAmount, currency: item.currency, description: item.name })
      const draft = await this.stripeCall(
        'POST',
        '/invoices',
        { customer: providerCustomerId, collection_method: 'send_invoice', days_until_due: parsed.daysUntilDue, metadata: item.metadata },
        idemKey
      )
      const invId = String(draft.id ?? `in_${Date.now()}`)
      const finalized = await this.stripeCall('POST', `/invoices/${invId}/finalize`)
      return {
        invoiceId: invId,
        status: 'open',
        amount: totalAmount,
        currency: item.currency,
        hostedInvoiceUrl: String(finalized.hosted_invoice_url ?? `https://invoice.stripe.com/i/${invId}`),
        ...(finalized.invoice_pdf ? { pdfUrl: String(finalized.invoice_pdf) } : {}),
        provider: 'stripe'
      }
    }
    const { baseUrl } = this.getCreds('dodo')
    const res = await this.dodoCall(
      'POST',
      '/payments',
      {
        payment_link: true,
        generate_invoice: true,
        customer: { customer_id: providerCustomerId },
        billing: { amount: totalAmount, currency: item.currency, name: item.name, ...(item.description ? { description: item.description } : {}) },
        metadata: item.metadata
      },
      idemKey
    )
    const invoiceId = String(res.payment_id ?? res.invoice_id ?? res.id ?? `inv_${Date.now()}`)
    return {
      invoiceId,
      status: 'open',
      amount: totalAmount,
      currency: item.currency,
      hostedInvoiceUrl: String(res.payment_link ?? res.hosted_invoice_url ?? `${baseUrl}/invoices/${invoiceId}`),
      pdfUrl: String(res.pdf_url ?? `${baseUrl.replace(/\/+$/, '')}/invoices/payments/${invoiceId}`),
      provider: 'dodo'
    }
  }

  charge = async (rawInput: DirectChargeInput, opts?: PaymentCallOptions): Promise<ChargeResult> => {
    const parsed = directChargeInput.parse(rawInput)
    const userId = opts?.userId ?? this.#core.userId
    const provider = this.resolveProvider(opts?.provider)
    const item = this.#resolveItem(parsed, userId)
    const totalAmount = item.amount * item.quantity
    const { providerCustomerId } = await this.ensureCustomer(userId, provider)
    const idemKey = idempotencyPaymentKey('chg', parsed.idempotencyKey ?? opts?.idempotencyKey)

    if (this.getCreds(provider).isSyntheticDev) {
      const chargeId = idemKey ? `chg_dev_${idemKey.slice(4, 20)}` : `chg_dev_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
      if (item.kind === 'product') await this.applyProductGrants(userId, item.id, chargeId)
      return { chargeId, status: 'succeeded', amount: totalAmount, currency: item.currency, provider }
    }
    if (provider === 'stripe') {
      const res = await this.stripeCall(
        'POST',
        '/payment_intents',
        {
          customer: providerCustomerId,
          amount: totalAmount,
          currency: item.currency,
          description: item.name,
          ...(parsed.paymentMethodId ? { payment_method: parsed.paymentMethodId, confirm: true, off_session: true } : {}),
          metadata: item.metadata
        },
        idemKey
      )
      const chargeId = String(res.id ?? `pi_${Date.now()}`)
      const status = res.status === 'succeeded' ? 'succeeded' : res.status === 'canceled' ? 'failed' : 'requires_action'
      if (status === 'succeeded' && item.kind === 'product') await this.applyProductGrants(userId, item.id, chargeId)
      return {
        chargeId,
        status,
        amount: totalAmount,
        currency: item.currency,
        provider: 'stripe',
        ...(res.next_action?.redirect_to_url?.url ? { checkoutUrl: String(res.next_action.redirect_to_url.url) } : {}),
        ...(res.client_secret ? { clientSecret: String(res.client_secret) } : {})
      }
    }
    const res = await this.dodoCall(
      'POST',
      '/payments',
      {
        customer: { customer_id: providerCustomerId },
        payment_link: !parsed.paymentMethodId,
        ...(parsed.paymentMethodId ? { payment_method_id: parsed.paymentMethodId } : {}),
        ...buildDodoCartOrCustom(item),
        metadata: item.metadata
      },
      idemKey
    )
    const chargeId = String(res.payment_id ?? res.id ?? `pay_${Date.now()}`)
    const status = res.status === 'succeeded' ? 'succeeded' : res.status === 'failed' ? 'failed' : 'requires_action'
    if (status === 'succeeded' && item.kind === 'product') await this.applyProductGrants(userId, item.id, chargeId)
    return {
      chargeId,
      status,
      amount: totalAmount,
      currency: item.currency,
      provider: 'dodo',
      ...(res.payment_link ? { checkoutUrl: String(res.payment_link) } : {})
    }
  }

  subscribe = async (rawInput: SubscribeInput, opts?: PaymentCallOptions): Promise<SubscribeResult> => {
    const parsed = subscribeInput.parse(rawInput)
    const userId = opts?.userId ?? this.#core.userId
    const provider = this.resolveProvider(opts?.provider)
    const isDev = Boolean(this.#core.env.isDev)
    const plan = getPlanDefinition(parsed.plan)
    if (!plan) return this.#core.errors.httpError(400, `Unknown plan alias: ${parsed.plan}`, 'INVALID_PLAN')

    const { providerCustomerId } = await this.ensureCustomer(userId, provider)
    const returnUrl = parsed.returnUrl ?? resolveEnvScopedValue(this.#core.config.payments.urls.returnUrl, isDev) ?? 'https://localhost/billing'
    const idemKey = idempotencyPaymentKey('sub', parsed.idempotencyKey ?? opts?.idempotencyKey)

    if (plan.interval === 'free' || plan.amount === 0 || this.getCreds(provider).isSyntheticDev) {
      const subscriptionId = `sub_dev_${plan.id}_${userId}`
      await this.#core.db.update(
        'payment_customer',
        userId,
        { planId: plan.id, subscriptionId, subscriptionStatus: 'active', activeProvider: provider, cancelAtPeriodEnd: false },
        { bypassRbac: true }
      )
      return { subscriptionId, planId: plan.id, status: 'active', provider }
    }
    const item = this.#resolveItem({ plan: plan.id, metadata: parsed.metadata }, userId)
    const res =
      provider === 'stripe'
        ? await this.stripeCall(
            'POST',
            '/subscriptions',
            {
              customer: providerCustomerId,
              items: [{ ...(item.stripePriceId ? { price: item.stripePriceId } : buildStripeLineItem(item)) }],
              payment_behavior: 'default_incomplete',
              metadata: item.metadata
            },
            idemKey
          )
        : await this.dodoCall(
            'POST',
            '/subscriptions',
            { customer: { customer_id: providerCustomerId }, product_id: item.dodoProductId ?? plan.id, quantity: 1, payment_link: true, return_url: returnUrl, metadata: item.metadata },
            idemKey
          )
    const subscriptionId = String(res.subscription_id ?? res.id ?? `sub_${Date.now()}`)
    const status = res.status === 'active' ? 'active' : res.status === 'trialing' ? 'trialing' : 'requires_action'
    const checkoutUrl = res.payment_link ?? res.checkout_url
    await this.#core.db.update(
      'payment_customer',
      userId,
      { planId: plan.id, subscriptionId, subscriptionStatus: status === 'requires_action' ? 'none' : status, activeProvider: provider },
      { bypassRbac: true }
    )
    return { subscriptionId, planId: plan.id, status, provider, ...(checkoutUrl ? { checkoutUrl: String(checkoutUrl) } : {}) }
  }

  changeSubscriptionTier = async (rawInput: ChangeTierInput, opts?: PaymentCallOptions): Promise<SubscriptionRecord> => {
    const parsed = changeTierInput.parse(rawInput)
    const userId = opts?.userId ?? this.#core.userId
    const plan = getPlanDefinition(parsed.plan)
    if (!plan) return this.#core.errors.httpError(400, `Unknown plan alias: ${parsed.plan}`, 'INVALID_PLAN')

    const cust = await this.#core.db.read('payment_customer', userId, false, { bypassRbac: true })
    if (!cust?.subscriptionId) return this.#core.errors.httpError(400, 'No active subscription to change tier', 'NO_ACTIVE_SUBSCRIPTION')
    const provider = this.resolveProvider(opts?.provider ?? cust.activeProvider)
    const isDev = Boolean(this.#core.env.isDev)
    const idemKey = idempotencyPaymentKey('tier', parsed.idempotencyKey ?? opts?.idempotencyKey)

    if (!this.getCreds(provider).isSyntheticDev) {
      if (provider === 'stripe') {
        const sub = await this.stripeCall('GET', `/subscriptions/${cust.subscriptionId}`)
        const itemId = sub.items?.data?.[0]?.id
        const priceId = resolveEnvScopedValue(plan.providers?.stripe?.priceId, isDev) ?? plan.id
        const prorationBehavior = parsed.proration === 'prorated_immediately' ? 'always_invoice' : parsed.proration === 'next_cycle' ? 'create_prorations' : 'none'
        await this.stripeCall(
          'POST',
          `/subscriptions/${cust.subscriptionId}`,
          { items: [{ ...(itemId ? { id: itemId } : {}), price: priceId }], proration_behavior: prorationBehavior, metadata: { userId, planId: plan.id } },
          idemKey
        )
      } else {
        const productId = resolveEnvScopedValue(plan.providers?.dodo?.productId, isDev) ?? plan.id
        await this.dodoCall(
          'POST',
          `/subscriptions/${cust.subscriptionId}/change-plan`,
          { product_id: productId, proration_billing_mode: parsed.proration, quantity: 1 },
          idemKey
        )
      }
    }

    await this.#core.db.update('payment_customer', userId, { planId: plan.id, subscriptionStatus: 'active', cancelAtPeriodEnd: false }, { bypassRbac: true })
    const usageId = paymentUsageDocId(userId, currentPeriodKey(cust.currentPeriodStart))
    const usageDoc = await this.#core.db.read('payment_usage', usageId, false, { bypassRbac: true })
    if (usageDoc) await this.#core.db.update('payment_usage', usageId, { planId: plan.id }, { bypassRbac: true })

    return {
      subscriptionId: cust.subscriptionId,
      planId: plan.id,
      status: 'active',
      provider,
      cancelAtPeriodEnd: false,
      ...(cust.currentPeriodStart ? { currentPeriodStart: cust.currentPeriodStart } : {}),
      ...(cust.currentPeriodEnd ? { currentPeriodEnd: cust.currentPeriodEnd } : {})
    }
  }

  cancelSubscription = async (rawInput: CancelSubscriptionInput = {}, opts?: PaymentCallOptions): Promise<SubscriptionRecord> => {
    const parsed = cancelSubscriptionInput.parse(rawInput)
    const userId = opts?.userId ?? this.#core.userId
    const cust = await this.#core.db.read('payment_customer', userId, false, { bypassRbac: true })
    if (!cust?.subscriptionId) return this.#core.errors.httpError(400, 'No active subscription to cancel', 'NO_ACTIVE_SUBSCRIPTION')
    const provider = this.resolveProvider(opts?.provider ?? cust.activeProvider)
    const idemKey = idempotencyPaymentKey('can', parsed.idempotencyKey ?? opts?.idempotencyKey)

    if (!this.getCreds(provider).isSyntheticDev) {
      if (provider === 'stripe') {
        await (parsed.immediately
          ? this.stripeCall('DELETE', `/subscriptions/${cust.subscriptionId}`, undefined, idemKey)
          : this.stripeCall('POST', `/subscriptions/${cust.subscriptionId}`, { cancel_at_period_end: true }, idemKey))
      } else {
        await this.dodoCall(
          'PATCH',
          `/subscriptions/${cust.subscriptionId}`,
          parsed.immediately ? { status: 'cancelled' } : { cancel_at_next_billing_date: true },
          idemKey
        )
      }
    }

    const newStatus = parsed.immediately ? 'cancelled' : cust.subscriptionStatus === 'none' ? 'active' : cust.subscriptionStatus
    const newPlanId = parsed.immediately ? this.#core.config.payments.defaultPlanId : cust.planId
    await this.#core.db.update('payment_customer', userId, { planId: newPlanId, subscriptionStatus: newStatus, cancelAtPeriodEnd: !parsed.immediately }, { bypassRbac: true })
    return {
      subscriptionId: cust.subscriptionId,
      planId: newPlanId,
      status: newStatus,
      provider,
      cancelAtPeriodEnd: !parsed.immediately,
      ...(cust.currentPeriodStart ? { currentPeriodStart: cust.currentPeriodStart } : {}),
      ...(cust.currentPeriodEnd ? { currentPeriodEnd: cust.currentPeriodEnd } : {})
    }
  }
}
