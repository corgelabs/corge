import type { Context } from 'hono'
import type { AppEnv } from '../config'
import type { Core } from '../index'
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
    handler: async ({ core, input }: { core: Core; input: SendEmailInput }) => core.emails.send(input)
  },
  'emails.batch': {
    input: sendBatchEmailInputSchema,
    output: sendBatchEmailResultSchema,
    handler: async ({ core, input }: { core: Core; input: SendBatchEmailInput }) => core.emails.sendBatch(input.emails)
  },
  'emails.logs': {
    query: emailLogsQuerySchema,
    handler: async ({ core, query }: { core: Core; query: EmailLogsQuery }) =>
      core.emails.listLogs({
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
      core,
      c,
      params,
      rawBody
    }: {
      core: Core
      c: Context<AppEnv>
      params: EmailWebhookParams
      rawBody?: string
    }) => {
      const headers: Record<string, string | undefined> = {}
      c?.req.raw.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value
      })
      const body = rawBody ?? (c ? await c.req.text() : '')
      return core.internals.emails.verifyAndProcessWebhook(params.provider, body, headers)
    }
  }
}
