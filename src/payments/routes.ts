import type { Context } from 'hono'
import type { AppEnv } from '../config'
import type { Corge } from '../index'
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
    handler: async ({ corge, input }: { corge: Corge; input: CreateCheckoutInput }) => corge.payments.createCheckout(input)
  },
  'payments.paymentLink': {
    input: createPaymentLinkInput,
    output: paymentLinkResultSchema,
    handler: async ({ corge, input }: { corge: Corge; input: CreatePaymentLinkInput }) => corge.payments.createPaymentLink(input)
  },
  'payments.invoice': {
    input: createInvoiceInput,
    output: invoiceResultSchema,
    handler: async ({ corge, input }: { corge: Corge; input: CreateInvoiceInput }) => corge.payments.createInvoice(input)
  },
  'payments.charge': {
    input: directChargeInput,
    output: chargeResultSchema,
    handler: async ({ corge, input }: { corge: Corge; input: DirectChargeInput }) => corge.payments.charge(input)
  },
  'payments.subscribe': {
    input: subscribeInput,
    output: subscribeResultSchema,
    handler: async ({ corge, input }: { corge: Corge; input: SubscribeInput }) => corge.payments.subscribe(input)
  },
  'payments.changeTier': {
    input: changeTierInput,
    output: subscriptionRecordSchema,
    handler: async ({ corge, input }: { corge: Corge; input: ChangeTierInput }) => corge.payments.changeSubscriptionTier(input)
  },
  'payments.cancelSubscription': {
    input: cancelSubscriptionInput,
    output: subscriptionRecordSchema,
    handler: async ({ corge, input }: { corge: Corge; input: CancelSubscriptionInput }) => corge.payments.cancelSubscription(input)
  },
  'payments.status': {
    handler: async ({ corge }: { corge: Corge }) => ({
      subscription: await corge.payments.getSubscription(),
      usage: await corge.payments.getUsage()
    })
  },
  'payments.webhook': {
    params: paymentWebhookParamsSchema,
    handler: async ({
      corge,
      c,
      params,
      rawBody
    }: {
      corge: Corge
      c: Context<AppEnv>
      params: PaymentWebhookParams
      rawBody?: string
    }) => {
      const headers: Record<string, string | undefined> = {}
      c?.req.raw.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value
      })
      const body = rawBody ?? (c ? await c.req.text() : '')
      return corge.internals.payments.verifyAndProcessWebhook(params.provider, body, headers)
    }
  }
}
