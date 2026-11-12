import type { Context } from 'hono'
import type { AppEnv } from '../config'
import type { Corge } from '../index'
import {
  emailLogsQuerySchema,
  emailWebhookParamsSchema,
  sendBatchEmailInputSchema,
  sendBatchEmailResultSchema,
  sendEmailInputSchema,
  sendEmailResultSchema,
  type EmailLogsQuery,
  type EmailWebhookParams,
  type SendBatchEmailInput,
  type SendEmailInput
} from './schema'

export const coreEmailRoutes = {
  'emails.send': {
    input: sendEmailInputSchema,
    output: sendEmailResultSchema,
    handler: async ({ corge, input }: { corge: Corge; input: SendEmailInput }) => corge.emails.send(input)
  },
  'emails.batch': {
    input: sendBatchEmailInputSchema,
    output: sendBatchEmailResultSchema,
    handler: async ({ corge, input }: { corge: Corge; input: SendBatchEmailInput }) => corge.emails.sendBatch(input.emails)
  },
  'emails.logs': {
    query: emailLogsQuerySchema,
    handler: async ({ corge, query }: { corge: Corge; query: EmailLogsQuery }) =>
      corge.emails.listLogs({
        ...(query.userId ? { userId: query.userId } : {}),
        ...(query.limit ? { limit: query.limit } : {}),
        ...(query.cursor ? { cursor: query.cursor } : {}),
        where: {
          ...(query.to ? { to: query.to.trim().toLowerCase() } : {}),
          ...(query.template ? { template: query.template } : {}),
          ...(query.purpose ? { purpose: query.purpose } : {}),
          ...(query.status ? { status: query.status } : {})
        }
      })
  },
  'emails.webhook': {
    params: emailWebhookParamsSchema,
    handler: async ({
      corge,
      c,
      params,
      rawBody
    }: {
      corge: Corge
      c: Context<AppEnv>
      params: EmailWebhookParams
      rawBody?: string
    }) => {
      const headers: Record<string, string | undefined> = {}
      c?.req.raw.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value
      })
      const body = rawBody ?? (c ? await c.req.text() : '')
      return corge.internals.emails.verifyAndProcessWebhook(params.provider, body, headers)
    }
  }
}
