import type { Context } from 'hono'
import type { AppEnv } from '../config'
import type { Core } from '../index'
import {
  cancelSubscriptionInput,
  changeTierInput,
  chargeResultSchema,
  checkoutSessionResultSchema,
  createCheckoutInput,
  createInvoiceInput,
  createPaymentLinkInput,
  directChargeInput,
  invoiceResultSchema,
  paymentLinkResultSchema,
  paymentWebhookParamsSchema,
  subscribeInput,
  subscribeResultSchema,
  subscriptionRecordSchema,
  type CancelSubscriptionInput,
  type ChangeTierInput,
  type CreateCheckoutInput,
  type CreateInvoiceInput,
  type CreatePaymentLinkInput,
  type DirectChargeInput,
  type PaymentWebhookParams,
  type SubscribeInput
} from './schema'

export const corePaymentRoutes = {
  'payments.checkout': {
    input: createCheckoutInput,
    output: checkoutSessionResultSchema,
    handler: async ({ core, input }: { core: Core; input: CreateCheckoutInput }) => core.payments.createCheckout(input)
  },
  'payments.paymentLink': {
    input: createPaymentLinkInput,
    output: paymentLinkResultSchema,
    handler: async ({ core, input }: { core: Core; input: CreatePaymentLinkInput }) => core.payments.createPaymentLink(input)
  },
  'payments.invoice': {
    input: createInvoiceInput,
    output: invoiceResultSchema,
    handler: async ({ core, input }: { core: Core; input: CreateInvoiceInput }) => core.payments.createInvoice(input)
  },
  'payments.charge': {
    input: directChargeInput,
    output: chargeResultSchema,
    handler: async ({ core, input }: { core: Core; input: DirectChargeInput }) => core.payments.charge(input)
  },
  'payments.subscribe': {
    input: subscribeInput,
    output: subscribeResultSchema,
    handler: async ({ core, input }: { core: Core; input: SubscribeInput }) => core.payments.subscribe(input)
  },
  'payments.changeTier': {
    input: changeTierInput,
    output: subscriptionRecordSchema,
    handler: async ({ core, input }: { core: Core; input: ChangeTierInput }) => core.payments.changeSubscriptionTier(input)
  },
  'payments.cancelSubscription': {
    input: cancelSubscriptionInput,
    output: subscriptionRecordSchema,
    handler: async ({ core, input }: { core: Core; input: CancelSubscriptionInput }) => core.payments.cancelSubscription(input)
  },
  'payments.status': {
    handler: async ({ core }: { core: Core }) => ({
      subscription: await core.payments.getSubscription(),
      usage: await core.payments.getUsage()
    })
  },
  'payments.webhook': {
    params: paymentWebhookParamsSchema,
    handler: async ({
      core,
      c,
      params,
      rawBody
    }: {
      core: Core
      c: Context<AppEnv>
      params: PaymentWebhookParams
      rawBody?: string
    }) => {
      const headers: Record<string, string | undefined> = {}
      c?.req.raw.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value
      })
      const body = rawBody ?? (c ? await c.req.text() : '')
      return core.internals.payments.verifyAndProcessWebhook(params.provider, body, headers)
    }
  }
}
