import type { EntryId, SelectModel } from '../db'
import type { Corge } from '../index'
import {
  cancelSubscriptionInput,
  changeTierInput,
  createCheckoutInput,
  createInvoiceInput,
  createPaymentLinkInput,
  directChargeInput,
  getPlanDefinition,
  getProductDefinition,
  subscribeInput,
  type CancelSubscriptionInput,
  type ChangeTierInput,
  type ChargeResult,
  type CheckoutSessionResult,
  type CreateCheckoutInput,
  type CreateInvoiceInput,
  type CreatePaymentLinkInput,
  type DirectChargeInput,
  type InvoiceResult,
  type PaymentCallOptions,
  type PaymentLinkResult,
  type PaymentProvider,
  type SubscribeInput,
  type SubscribeResult,
  type SubscriptionRecord
} from './schema'
import {
  buildDodoCartOrCustom,
  buildPaddleItem,
  buildStripeLineItem,
  currentPeriodKey,
  idempotencyPaymentKey,
  isPaymentFailoverEligible,
  paymentUsageDocId,
  requestDodoApi,
  requestPaddleApi,
  requestStripeApi,
  resolveEnvScopedValue,
  resolvePurchaseItem,
  type ResolvedPurchaseItem
} from './utils'

export class PaymentsBillingEngine {
  readonly #corge: Corge

  constructor(corgeClient: Corge) {
    this.#corge = corgeClient
  }

  resolveProvider = (override?: PaymentProvider): PaymentProvider =>
    override ?? this.#corge.config.payments.provider

  getCreds = (provider: PaymentProvider) => {
    const isDev = Boolean(this.#corge.env.isDev)
    const cfg = this.#corge.config.payments
    const env = this.#corge.env
    if (provider === 'stripe') {
      const apiKey = (isDev ? env.STRIPE_SANDBOX_API_KEY : env.STRIPE_API_KEY).trim()
      const webhookSecret = (isDev ? env.STRIPE_SANDBOX_WEBHOOK_SECRET : env.STRIPE_WEBHOOK_SECRET).trim()
      return { apiKey, webhookSecret, baseUrl: cfg.stripe.baseUrl, isSyntheticDev: isDev && !apiKey }
    }
    if (provider === 'dodo') {
      const apiKey = (isDev ? env.DODO_SANDBOX_API_KEY : env.DODO_API_KEY).trim()
      const webhookSecret = (isDev ? env.DODO_SANDBOX_WEBHOOK_SECRET : env.DODO_WEBHOOK_SECRET).trim()
      return {
        apiKey,
        webhookSecret,
        baseUrl: isDev ? cfg.dodo.testBaseUrl : cfg.dodo.liveBaseUrl,
        isSyntheticDev: isDev && !apiKey
      }
    }
    const apiKey = (isDev ? env.PADDLE_SANDBOX_API_KEY : env.PADDLE_API_KEY).trim()
    const webhookSecret = (isDev ? env.PADDLE_SANDBOX_WEBHOOK_SECRET : env.PADDLE_WEBHOOK_SECRET).trim()
    return {
      apiKey,
      webhookSecret,
      baseUrl: isDev ? cfg.paddle.testBaseUrl : cfg.paddle.liveBaseUrl,
      isSyntheticDev: isDev && !apiKey
    }
  }

  resolveProviderChain = (override?: PaymentProvider): PaymentProvider[] => {
    if (override) return [override]
    const cfg = this.#corge.config.payments
    const ordered = [...new Set<PaymentProvider>([cfg.provider, ...(cfg.fallbackProviders ?? []).slice(0, 2)])]
    const ready = ordered.filter((p) => Boolean(this.getCreds(p).apiKey))
    return ready.length > 0 ? ready : [cfg.provider]
  }

  runWithFailover = async <T>(
    override: PaymentProvider | undefined,
    fn: (provider: PaymentProvider) => Promise<T>
  ): Promise<T> => {
    const chain = this.resolveProviderChain(override)
    let lastErr: unknown
    for (let i = 0; i < chain.length; i++) {
      const provider = chain[i]!
      try {
        return await fn(provider)
      } catch (err) {
        lastErr = err
        if (i === chain.length - 1 || !isPaymentFailoverEligible(err)) throw err
      }
    }
    throw lastErr
  }

  #withBreaker = async <T>(provider: PaymentProvider, cost: number, fn: () => Promise<T>): Promise<T> => {
    await this.#corge.internals.resilience.acquireLimit('payments', cost)
    return this.#corge.internals.resilience.circuitBreaker(`payments-${provider}`, fn, undefined, {
      isDev: this.#corge.env.isDev
    })
  }

  stripeCall = <T = Record<string, any>>(
    method: string,
    path: string,
    form?: Record<string, unknown>,
    idempotencyKey?: string
  ): Promise<T> => {
    const { baseUrl, apiKey } = this.getCreds('stripe')
    if (!apiKey) return this.#corge.errors.httpError(500, 'Missing STRIPE_API_KEY for production payments', 'CONFIG_ERROR')
    return this.#withBreaker('stripe', 1, () =>
      requestStripeApi<T>(baseUrl, apiKey, this.#corge.config.payments.stripe.apiVersion, method, path, form, idempotencyKey)
    )
  }

  dodoCall = <T = Record<string, any>>(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string
  ): Promise<T> => {
    const { baseUrl, apiKey } = this.getCreds('dodo')
    if (!apiKey) return this.#corge.errors.httpError(500, 'Missing DODO_API_KEY for production payments', 'CONFIG_ERROR')
    return this.#withBreaker('dodo', 1, () => requestDodoApi<T>(baseUrl, apiKey, method, path, body, idempotencyKey))
  }

  paddleCall = <T = Record<string, any>>(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string
  ): Promise<T> => {
    const { baseUrl, apiKey } = this.getCreds('paddle')
    if (!apiKey) return this.#corge.errors.httpError(500, 'Missing PADDLE_API_KEY for production payments', 'CONFIG_ERROR')
    return this.#withBreaker('paddle', 1, () => requestPaddleApi<T>(baseUrl, apiKey, method, path, body, idempotencyKey))
  }

  #resolveItem = (rawInput: Parameters<typeof resolvePurchaseItem>[0], userId: string): ResolvedPurchaseItem => {
    const res = resolvePurchaseItem(rawInput, userId, Boolean(this.#corge.env.isDev), this.#corge.config.payments.defaultCurrency)
    if ('error' in res) return this.#corge.errors.httpError(400, res.error, 'INVALID_PAYMENT_ITEM')
    return res
  }

  ensureCustomer = async (
    userId: EntryId,
    provider: PaymentProvider
  ): Promise<{ doc: SelectModel<'payment_customer'>; providerCustomerId: string }> =>
    this.#corge.internals.resilience.singleflight(
      `pay_cust:${provider}:${userId}`,
      async () => {
        const defaultPlanId = this.#corge.config.payments.defaultPlanId
        let doc = await this.#corge.db.read('payment_customer', userId, false, { bypassRbac: true })
        if (!doc) {
          doc = await this.#corge.db.create(
            'payment_customer',
            {
              id: userId,
              userId,
              planId: defaultPlanId,
              subscriptionStatus: 'none',
              cancelAtPeriodEnd: false,
              bonusAiTokens: 0,
              credits: 0,
              bonusMetrics: {}
            },
            { bypassRbac: true }
          )
        }
        const existingCusId =
          provider === 'stripe'
            ? doc.stripeCustomerId
            : provider === 'dodo'
              ? doc.dodoCustomerId
              : doc.paddleCustomerId
        if (existingCusId) return { doc, providerCustomerId: existingCusId }

        let providerCustomerId = `cus_dev_${provider}_${userId}`
        if (!this.getCreds(provider).isSyntheticDev) {
          const custIdemKey = `cust_${provider}_${userId}`
          const fallbackEmail = doc.email ?? `${userId}@customer.local`
          if (provider === 'stripe') {
            const created = await this.stripeCall(
              'POST',
              '/customers',
              { ...(doc.email ? { email: doc.email } : {}), ...(doc.name ? { name: doc.name } : {}), metadata: { userId } },
              custIdemKey
            )
            providerCustomerId = String(created.id ?? providerCustomerId)
          } else if (provider === 'dodo') {
            const created = await this.dodoCall(
              'POST',
              '/customers',
              { email: fallbackEmail, name: doc.name ?? userId, metadata: { userId } },
              custIdemKey
            )
            providerCustomerId = String(created.customer_id ?? created.id ?? providerCustomerId)
          } else {
            try {
              const created = await this.paddleCall(
                'POST',
                '/customers',
                { email: fallbackEmail, name: doc.name ?? userId, custom_data: { userId } },
                custIdemKey
              )
              providerCustomerId = String(created.id ?? providerCustomerId)
            } catch (err) {
              const status = typeof err === 'object' && err ? (err as { status?: number }).status : undefined
              if (status !== 409) throw err
              const existingList = await this.paddleCall<Record<string, any>[]>(
                'GET',
                `/customers?email=${encodeURIComponent(fallbackEmail)}`
              )
              const firstId = Array.isArray(existingList) ? existingList[0]?.id : undefined
              if (!firstId) throw err
              providerCustomerId = String(firstId)
            }
          }
        }
        const patch =
          provider === 'stripe'
            ? { stripeCustomerId: providerCustomerId, activeProvider: provider }
            : provider === 'dodo'
              ? { dodoCustomerId: providerCustomerId, activeProvider: provider }
              : { paddleCustomerId: providerCustomerId, activeProvider: provider }
        await this.#corge.db.update('payment_customer', userId, patch, { bypassRbac: true })
        return { doc: { ...doc, ...patch }, providerCustomerId }
      },
      { scope: 'global' }
    )

  applyProductGrants = async (userId: EntryId, productId?: string, grantKey?: string): Promise<void> => {
    const prod = productId ? getProductDefinition(productId) : undefined
    if (!prod?.grants) return
    const db = this.#corge.db.firestore()
    const custRef = db.collection('payment_customer').doc(userId)
    const grantRef = grantKey
      ? db.collection('_idempotency').doc(`pay_grant_${userId}_${grantKey.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96)}`)
      : undefined
    await this.#corge.internals.resilience.acquireLimit('firestore')
    await db.runTransaction(async (tx) => {
      const [custSnap, grantSnap] = await Promise.all([
        tx.get(custRef),
        grantRef ? tx.get(grantRef) : Promise.resolve(undefined)
      ])
      if (grantSnap?.exists) return
      const data = custSnap.data() ?? {}
      const bonusMetrics: Record<string, number> = { ...(data.bonusMetrics ?? {}) }
      for (const [m, delta] of Object.entries(prod.grants?.metrics ?? {})) bonusMetrics[m] = (bonusMetrics[m] ?? 0) + delta
      const now = new Date()
      if (grantRef) {
        tx.set(grantRef, { key: grantRef.id, userId, productId, createdAt: now, expiresAt: new Date(now.getTime() + 86_400_000) })
      }
      tx.set(
        custRef,
        {
          id: userId,
          userId,
          planId: data.planId ?? this.#corge.config.payments.defaultPlanId,
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

  #createPaddleCheckoutTransaction = async (
    providerCustomerId: string,
    item: ResolvedPurchaseItem,
    fallbackUrl: string,
    idemKey?: string
  ): Promise<{ txnId: string; url: string; subscriptionId?: string }> => {
    const isDev = Boolean(this.#corge.env.isDev)
    const pCfg = this.#corge.config.payments.paddle
    const configuredCheckoutUrl = resolveEnvScopedValue(pCfg.checkoutUrl, isDev)
    const res = await this.paddleCall(
      'POST',
      '/transactions',
      {
        collection_mode: 'automatic',
        customer_id: providerCustomerId,
        items: [buildPaddleItem(item, pCfg.taxCategory)],
        custom_data: item.metadata,
        ...(configuredCheckoutUrl ? { checkout: { url: configuredCheckoutUrl } } : {})
      },
      idemKey
    )
    const txnId = String(res.id ?? `txn_${Date.now()}`)
    const sep = fallbackUrl.includes('?') ? '&' : '?'
    const url = String(res.checkout?.url ?? `${fallbackUrl}${sep}_ptxn=${txnId}`)
    const subscriptionId = typeof res.subscription_id === 'string' ? res.subscription_id : undefined
    return { txnId, url, ...(subscriptionId ? { subscriptionId } : {}) }
  }

  createCheckout = async (rawInput: CreateCheckoutInput, opts?: PaymentCallOptions): Promise<CheckoutSessionResult> => {
    const parsed = createCheckoutInput.parse(rawInput)
    const userId = opts?.userId ?? this.#corge.userId
    const isDev = Boolean(this.#corge.env.isDev)
    const item = this.#resolveItem(parsed, userId)
    const cfgUrls = this.#corge.config.payments.urls
    const successUrl = parsed.successUrl ?? resolveEnvScopedValue(cfgUrls.successUrl, isDev) ?? 'https://localhost/success'
    const cancelUrl = parsed.cancelUrl ?? resolveEnvScopedValue(cfgUrls.cancelUrl, isDev) ?? 'https://localhost/cancel'
    const idemKey = idempotencyPaymentKey('chk', parsed.idempotencyKey)

    return this.runWithFailover(opts?.provider, async (provider) => {
      const { providerCustomerId } = await this.ensureCustomer(userId, provider)
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
      if (provider === 'dodo') {
        const res = await this.dodoCall(
          'POST',
          '/checkouts',
          { customer: { customer_id: providerCustomerId }, return_url: successUrl, ...buildDodoCartOrCustom(item), metadata: item.metadata },
          idemKey
        )
        const checkoutId = String(res.checkout_id ?? res.session_id ?? res.id ?? `chk_${Date.now()}`)
        return {
          checkoutId,
          url: String(res.checkout_url ?? res.payment_link ?? res.url ?? `${successUrl}?session_id=${checkoutId}`),
          provider: 'dodo'
        }
      }
      const { txnId, url } = await this.#createPaddleCheckoutTransaction(providerCustomerId, item, successUrl, idemKey)
      return { checkoutId: txnId, url, provider: 'paddle' }
    })
  }

  createPaymentLink = async (rawInput: CreatePaymentLinkInput, opts?: PaymentCallOptions): Promise<PaymentLinkResult> => {
    const parsed = createPaymentLinkInput.parse(rawInput)
    const userId = opts?.userId ?? this.#corge.userId
    const isDev = Boolean(this.#corge.env.isDev)
    const item = this.#resolveItem(parsed, userId)
    const returnUrl = parsed.returnUrl ?? resolveEnvScopedValue(this.#corge.config.payments.urls.returnUrl, isDev) ?? 'https://localhost/billing'
    const idemKey = idempotencyPaymentKey('pl', parsed.idempotencyKey)

    return this.runWithFailover(opts?.provider, async (provider) => {
      const { providerCustomerId } = await this.ensureCustomer(userId, provider)
      if (this.getCreds(provider).isSyntheticDev) {
        const paymentLinkId = `pl_dev_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
        return { paymentLinkId, url: `${returnUrl}?payment_link=${paymentLinkId}`, provider }
      }
      if (provider === 'stripe') {
        const res = await this.stripeCall(
          'POST',
          '/payment_links',
          {
            line_items: [buildStripeLineItem(item)],
            after_completion: { type: 'redirect', redirect: { url: returnUrl } },
            metadata: item.metadata
          },
          idemKey
        )
        return {
          paymentLinkId: String(res.id ?? `plink_${Date.now()}`),
          url: String(res.url ?? `${returnUrl}?payment_link=${res.id}`),
          provider: 'stripe'
        }
      }
      if (provider === 'dodo') {
        const res = await this.dodoCall(
          'POST',
          '/payments',
          {
            payment_link: true,
            customer: { customer_id: providerCustomerId },
            return_url: returnUrl,
            ...buildDodoCartOrCustom(item),
            metadata: item.metadata
          },
          idemKey
        )
        const paymentLinkId = String(res.payment_id ?? res.id ?? `plink_${Date.now()}`)
        return {
          paymentLinkId,
          url: String(res.payment_link ?? res.url ?? `${returnUrl}?payment_link=${paymentLinkId}`),
          provider: 'dodo'
        }
      }
      const { txnId, url } = await this.#createPaddleCheckoutTransaction(providerCustomerId, item, returnUrl, idemKey)
      return { paymentLinkId: txnId, url, provider: 'paddle' }
    })
  }

  createInvoice = async (rawInput: CreateInvoiceInput, opts?: PaymentCallOptions): Promise<InvoiceResult> => {
    const parsed = createInvoiceInput.parse(rawInput)
    const userId = opts?.userId ?? this.#corge.userId
    const isDev = Boolean(this.#corge.env.isDev)
    const item = this.#resolveItem(parsed, userId)
    const totalAmount = item.amount * item.quantity
    const idemKey = idempotencyPaymentKey('inv', parsed.idempotencyKey)
    const returnUrl = resolveEnvScopedValue(this.#corge.config.payments.urls.returnUrl, isDev) ?? 'https://localhost/billing'

    return this.runWithFailover(opts?.provider, async (provider) => {
      const { providerCustomerId } = await this.ensureCustomer(userId, provider)
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
        await this.stripeCall('POST', '/invoiceitems', {
          customer: providerCustomerId,
          amount: totalAmount,
          currency: item.currency,
          description: item.name
        })
        const draft = await this.stripeCall(
          'POST',
          '/invoices',
          {
            customer: providerCustomerId,
            collection_method: 'send_invoice',
            days_until_due: parsed.daysUntilDue,
            metadata: item.metadata
          },
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
      if (provider === 'dodo') {
        const { baseUrl } = this.getCreds('dodo')
        const res = await this.dodoCall(
          'POST',
          '/payments',
          {
            payment_link: true,
            generate_invoice: true,
            customer: { customer_id: providerCustomerId },
            billing: {
              amount: totalAmount,
              currency: item.currency,
              name: item.name,
              ...(item.description ? { description: item.description } : {})
            },
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

      const pCfg = this.#corge.config.payments.paddle
      const configuredCheckoutUrl = resolveEnvScopedValue(pCfg.checkoutUrl, isDev)
      const created = await this.paddleCall(
        'POST',
        '/transactions',
        {
          collection_mode: 'manual',
          status: 'billed',
          customer_id: providerCustomerId,
          items: [buildPaddleItem(item, pCfg.taxCategory)],
          billing_details: {
            enable_checkout: true,
            payment_terms: {
              interval: 'day',
              frequency: parsed.daysUntilDue
            }
          },
          custom_data: item.metadata,
          ...(configuredCheckoutUrl ? { checkout: { url: configuredCheckoutUrl } } : {})
        },
        idemKey
      )
      const invoiceId = String(created.id ?? `txn_${Date.now()}`)
      const sep = returnUrl.includes('?') ? '&' : '?'
      const hostedInvoiceUrl = String(created.checkout?.url ?? `${returnUrl}${sep}_ptxn=${invoiceId}`)
      let pdfUrl: string | undefined
      try {
        const pdfRes = await this.paddleCall<{ url?: string }>('GET', `/transactions/${invoiceId}/invoice`)
        if (pdfRes?.url) pdfUrl = String(pdfRes.url)
      } catch {}

      return {
        invoiceId,
        status: 'open',
        amount: totalAmount,
        currency: item.currency,
        hostedInvoiceUrl,
        ...(pdfUrl ? { pdfUrl } : {}),
        provider: 'paddle'
      }
    })
  }

  charge = async (rawInput: DirectChargeInput, opts?: PaymentCallOptions): Promise<ChargeResult> => {
    const parsed = directChargeInput.parse(rawInput)
    const userId = opts?.userId ?? this.#corge.userId
    const isDev = Boolean(this.#corge.env.isDev)
    const item = this.#resolveItem(parsed, userId)
    const totalAmount = item.amount * item.quantity
    const idemKey = idempotencyPaymentKey('chg', parsed.idempotencyKey)
    const returnUrl = resolveEnvScopedValue(this.#corge.config.payments.urls.returnUrl, isDev) ?? 'https://localhost/billing'

    const existingCust = await this.#corge.db.read('payment_customer', userId, false, { bypassRbac: true })
    const pinnedOverride =
      opts?.provider ?? (parsed.paymentMethodId && existingCust?.activeProvider ? existingCust.activeProvider : undefined)

    return this.runWithFailover(pinnedOverride, async (provider) => {
      const { doc: custDoc, providerCustomerId } = await this.ensureCustomer(userId, provider)
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
      if (provider === 'dodo') {
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

      const pCfg = this.#corge.config.payments.paddle
      if (
        custDoc.activeProvider === 'paddle' &&
        custDoc.subscriptionId &&
        !custDoc.subscriptionId.startsWith('sub_dev_') &&
        (custDoc.subscriptionStatus === 'active' || custDoc.subscriptionStatus === 'trialing')
      ) {
        const charged = await this.paddleCall(
          'POST',
          `/subscriptions/${custDoc.subscriptionId}/charge`,
          {
            effective_from: 'immediately',
            items: [buildPaddleItem({ ...item, kind: 'product' }, pCfg.taxCategory)]
          },
          idemKey
        )
        const chargeId = String(charged.id ?? `chg_${Date.now()}`)
        if (item.kind === 'product') await this.applyProductGrants(userId, item.id, chargeId)
        return {
          chargeId,
          status: 'succeeded',
          amount: totalAmount,
          currency: item.currency,
          provider: 'paddle'
        }
      }

      const { txnId, url } = await this.#createPaddleCheckoutTransaction(providerCustomerId, item, returnUrl, idemKey)
      return {
        chargeId: txnId,
        status: 'requires_action',
        amount: totalAmount,
        currency: item.currency,
        provider: 'paddle',
        checkoutUrl: url
      }
    })
  }

  subscribe = async (rawInput: SubscribeInput, opts?: PaymentCallOptions): Promise<SubscribeResult> => {
    const parsed = subscribeInput.parse(rawInput)
    const userId = opts?.userId ?? this.#corge.userId
    const isDev = Boolean(this.#corge.env.isDev)
    const plan = getPlanDefinition(parsed.plan)
    if (!plan) return this.#corge.errors.httpError(400, `Unknown plan alias: ${parsed.plan}`, 'INVALID_PLAN')

    const returnUrl = parsed.returnUrl ?? resolveEnvScopedValue(this.#corge.config.payments.urls.returnUrl, isDev) ?? 'https://localhost/billing'
    const idemKey = idempotencyPaymentKey('sub', parsed.idempotencyKey)

    return this.runWithFailover(opts?.provider, async (provider) => {
      const { providerCustomerId } = await this.ensureCustomer(userId, provider)
      if (plan.interval === 'free' || plan.amount === 0 || this.getCreds(provider).isSyntheticDev) {
        const subscriptionId = `sub_dev_${plan.id}_${userId}`
        await this.#corge.db.update(
          'payment_customer',
          userId,
          { planId: plan.id, subscriptionId, subscriptionStatus: 'active', activeProvider: provider, cancelAtPeriodEnd: false },
          { bypassRbac: true }
        )
        return { subscriptionId, planId: plan.id, status: 'active', provider }
      }

      const item = this.#resolveItem({ plan: plan.id, metadata: parsed.metadata }, userId)
      if (provider === 'paddle') {
        const { txnId, url, subscriptionId: pSubId } = await this.#createPaddleCheckoutTransaction(
          providerCustomerId,
          item,
          returnUrl,
          idemKey
        )
        const subscriptionId = pSubId ?? txnId
        await this.#corge.db.update(
          'payment_customer',
          userId,
          { planId: plan.id, subscriptionId, subscriptionStatus: 'none', activeProvider: 'paddle' },
          { bypassRbac: true }
        )
        return {
          subscriptionId,
          planId: plan.id,
          status: 'requires_action',
          provider: 'paddle',
          checkoutUrl: url
        }
      }

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
              {
                customer: { customer_id: providerCustomerId },
                product_id: item.dodoProductId ?? plan.id,
                quantity: 1,
                payment_link: true,
                return_url: returnUrl,
                metadata: item.metadata
              },
              idemKey
            )
      const subscriptionId = String(res.subscription_id ?? res.id ?? `sub_${Date.now()}`)
      const status = res.status === 'active' ? 'active' : res.status === 'trialing' ? 'trialing' : 'requires_action'
      const checkoutUrl = res.payment_link ?? res.checkout_url
      await this.#corge.db.update(
        'payment_customer',
        userId,
        { planId: plan.id, subscriptionId, subscriptionStatus: status === 'requires_action' ? 'none' : status, activeProvider: provider },
        { bypassRbac: true }
      )
      return {
        subscriptionId,
        planId: plan.id,
        status,
        provider,
        ...(checkoutUrl ? { checkoutUrl: String(checkoutUrl) } : {})
      }
    })
  }

  changeSubscriptionTier = async (rawInput: ChangeTierInput, opts?: PaymentCallOptions): Promise<SubscriptionRecord> => {
    const parsed = changeTierInput.parse(rawInput)
    const userId = opts?.userId ?? this.#corge.userId
    const plan = getPlanDefinition(parsed.plan)
    if (!plan) return this.#corge.errors.httpError(400, `Unknown plan alias: ${parsed.plan}`, 'INVALID_PLAN')

    const cust = await this.#corge.db.read('payment_customer', userId, false, { bypassRbac: true })
    if (!cust?.subscriptionId) return this.#corge.errors.httpError(400, 'No active subscription to change tier', 'NO_ACTIVE_SUBSCRIPTION')
    const provider = this.resolveProvider(opts?.provider ?? cust.activeProvider)
    const isDev = Boolean(this.#corge.env.isDev)
    const idemKey = idempotencyPaymentKey('tier', parsed.idempotencyKey)

    if (!this.getCreds(provider).isSyntheticDev) {
      if (provider === 'stripe') {
        const sub = await this.stripeCall('GET', `/subscriptions/${cust.subscriptionId}`)
        const itemId = sub.items?.data?.[0]?.id
        const priceId = resolveEnvScopedValue(plan.providers?.stripe?.priceId, isDev) ?? plan.id
        const prorationBehavior =
          parsed.proration === 'prorated_immediately'
            ? 'always_invoice'
            : parsed.proration === 'next_cycle'
              ? 'create_prorations'
              : 'none'
        await this.stripeCall(
          'POST',
          `/subscriptions/${cust.subscriptionId}`,
          { items: [{ ...(itemId ? { id: itemId } : {}), price: priceId }], proration_behavior: prorationBehavior, metadata: { userId, planId: plan.id } },
          idemKey
        )
      } else if (provider === 'dodo') {
        const productId = resolveEnvScopedValue(plan.providers?.dodo?.productId, isDev) ?? plan.id
        await this.dodoCall(
          'POST',
          `/subscriptions/${cust.subscriptionId}/change-plan`,
          { product_id: productId, proration_billing_mode: parsed.proration, quantity: 1 },
          idemKey
        )
      } else {
        const item = this.#resolveItem({ plan: plan.id }, userId)
        const prorationMode =
          parsed.proration === 'prorated_immediately'
            ? 'prorated_immediately'
            : parsed.proration === 'next_cycle'
              ? 'prorated_next_billing_period'
              : 'do_not_bill'
        await this.paddleCall(
          'PATCH',
          `/subscriptions/${cust.subscriptionId}`,
          {
            items: [buildPaddleItem(item, this.#corge.config.payments.paddle.taxCategory)],
            proration_billing_mode: prorationMode,
            custom_data: { userId, planId: plan.id }
          },
          idemKey
        )
      }
    }

    await this.#corge.db.update(
      'payment_customer',
      userId,
      { planId: plan.id, subscriptionStatus: 'active', cancelAtPeriodEnd: false },
      { bypassRbac: true }
    )
    const usageId = paymentUsageDocId(userId, currentPeriodKey(cust.currentPeriodStart))
    const usageDoc = await this.#corge.db.read('payment_usage', usageId, false, { bypassRbac: true })
    if (usageDoc) await this.#corge.db.update('payment_usage', usageId, { planId: plan.id }, { bypassRbac: true })

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
    const userId = opts?.userId ?? this.#corge.userId
    const cust = await this.#corge.db.read('payment_customer', userId, false, { bypassRbac: true })
    if (!cust?.subscriptionId) return this.#corge.errors.httpError(400, 'No active subscription to cancel', 'NO_ACTIVE_SUBSCRIPTION')
    const provider = this.resolveProvider(opts?.provider ?? cust.activeProvider)
    const idemKey = idempotencyPaymentKey('can', parsed.idempotencyKey)

    if (!this.getCreds(provider).isSyntheticDev) {
      if (provider === 'stripe') {
        await (parsed.immediately
          ? this.stripeCall('DELETE', `/subscriptions/${cust.subscriptionId}`, undefined, idemKey)
          : this.stripeCall('POST', `/subscriptions/${cust.subscriptionId}`, { cancel_at_period_end: true }, idemKey))
      } else if (provider === 'dodo') {
        await this.dodoCall(
          'PATCH',
          `/subscriptions/${cust.subscriptionId}`,
          parsed.immediately ? { status: 'cancelled' } : { cancel_at_next_billing_date: true },
          idemKey
        )
      } else {
        await this.paddleCall(
          'POST',
          `/subscriptions/${cust.subscriptionId}/cancel`,
          { effective_from: parsed.immediately ? 'immediately' : 'next_billing_period' },
          idemKey
        )
      }
    }

    const newStatus = parsed.immediately ? 'cancelled' : cust.subscriptionStatus === 'none' ? 'active' : cust.subscriptionStatus
    const newPlanId = parsed.immediately ? this.#corge.config.payments.defaultPlanId : cust.planId
    await this.#corge.db.update(
      'payment_customer',
      userId,
      { planId: newPlanId, subscriptionStatus: newStatus, cancelAtPeriodEnd: !parsed.immediately },
      { bypassRbac: true }
    )
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
