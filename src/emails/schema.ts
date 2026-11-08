import { z } from 'zod'
import type {
  AuthEmailPurpose,
  AuthEmailVariables,
  AuthFlowConfigSpec,
  AuthFlowEmailHook,
  EmailProvider,
  EmailsConfig,
  TransactionalEmailPayload
} from '../config'
import { entryId, fileRef, type EntryId } from '../db'

export type {
  AuthEmailPurpose,
  AuthEmailVariables,
  AuthFlowConfigSpec,
  AuthFlowEmailHook,
  EmailProvider,
  EmailsConfig,
  TransactionalEmailPayload
}

export const emailLogStatusSchema = z.enum([
  'queued',
  'sent',
  'delivered',
  'opened',
  'clicked',
  'bounced',
  'complained',
  'failed',
  'suppressed'
])
export type EmailLogStatus = z.infer<typeof emailLogStatusSchema>

export interface EmailTemplateProviderSpec<V = Record<string, unknown>> {
  sendgrid?: {
    templateId: string
  }
  resend?: {
    templateId?: string
    subject?: string | ((vars: V) => string)
    html?: string | ((vars: V) => string)
    text?: string | ((vars: V) => string)
  }
}

export interface EmailTemplateDefinition<S extends z.ZodTypeAny = z.ZodType<Record<string, unknown>>> {
  id?: string
  description?: string
  subject?: string | ((vars: z.infer<S>) => string)
  html?: string | ((vars: z.infer<S>) => string)
  text?: string | ((vars: z.infer<S>) => string)
  fromEmail?: string
  fromName?: string
  replyTo?: string
  category?: string
  variables?: S
  providers?: EmailTemplateProviderSpec<z.infer<S>>
  onBeforeSend?: (vars: z.infer<S>, recipient: string) => Promise<z.infer<S> | false>
}

export type EmailTemplatesMap = Record<string, EmailTemplateDefinition<any>>

const registeredEmailTemplates: EmailTemplatesMap = {}

export const registerEmailTemplates = (templates?: EmailTemplatesMap, reset = false): void => {
  if (reset) {
    for (const k of Object.keys(registeredEmailTemplates)) delete registeredEmailTemplates[k]
  }
  if (!templates) return
  for (const [k, def] of Object.entries(templates)) {
    registeredEmailTemplates[k] = { ...def, id: def.id ?? k }
  }
}

export const clearEmailTemplates = (): void => {
  for (const k of Object.keys(registeredEmailTemplates)) delete registeredEmailTemplates[k]
}

export const defineEmailTemplates = <T extends EmailTemplatesMap>(templates: T): T => {
  const normalized = Object.fromEntries(
    Object.entries(templates).map(([k, def]) => [k, { ...def, id: def.id ?? k }])
  ) as T
  registerEmailTemplates(normalized, false)
  return normalized
}

export const getEmailTemplate = (id: string): EmailTemplateDefinition<any> | undefined =>
  registeredEmailTemplates[id]

export const getRegisteredEmailTemplates = (): EmailTemplatesMap => registeredEmailTemplates

export const emailAttachmentInputSchema = z
  .object({
    filename: z.string().min(1),
    fileRef: fileRef.optional(),
    contentBase64: z.string().optional(),
    contentType: z.string().optional()
  })
  .refine((v) => Boolean(v.fileRef || v.contentBase64), {
    message: 'Attachment requires either fileRef or contentBase64'
  })
export type EmailAttachmentInput = z.infer<typeof emailAttachmentInputSchema>

export const sendEmailInputSchema = z
  .object({
    to: z.union([z.string().email(), z.array(z.string().email()).min(1).max(50)]),
    template: z.string().optional(),
    providerTemplateId: z.string().optional(),
    variables: z.record(z.string(), z.unknown()).default({}),
    subject: z.string().max(300).optional(),
    html: z.string().optional(),
    text: z.string().optional(),
    fromEmail: z.string().email().optional(),
    fromName: z.string().max(120).optional(),
    replyTo: z.string().email().optional(),
    cc: z.array(z.string().email()).optional(),
    bcc: z.array(z.string().email()).optional(),
    attachments: z.array(emailAttachmentInputSchema).max(10).optional(),
    tags: z.record(z.string(), z.string()).optional(),
    idempotencyKey: z.string().max(200).optional(),
    purpose: z.string().optional()
  })
  .refine((v) => Boolean(v.template || v.providerTemplateId || v.html || v.text), {
    message: 'Provide a template alias, providerTemplateId, or html/text body'
  })

export type SendEmailInput<T = Record<string, unknown>> = Omit<z.input<typeof sendEmailInputSchema>, 'variables'> & {
  variables?: T
}

export const sendBatchEmailInputSchema = z.object({
  emails: z.array(sendEmailInputSchema).min(1).max(100)
})
export type SendBatchEmailInput = z.input<typeof sendBatchEmailInputSchema>

export const emailLogsQuerySchema = z.object({
  to: z.string().optional(),
  template: z.string().optional(),
  purpose: z.string().optional(),
  status: emailLogStatusSchema.optional(),
  userId: entryId.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  cursor: z.string().optional()
})
export type EmailLogsQuery = z.infer<typeof emailLogsQuerySchema>

export const emailWebhookParamsSchema = z.object({
  provider: z.enum(['sendgrid', 'resend'])
})
export type EmailWebhookParams = z.infer<typeof emailWebhookParamsSchema>

export const sendEmailResultSchema = z.object({
  emailId: entryId,
  externalMessageId: z.string().optional(),
  status: emailLogStatusSchema,
  provider: z.enum(['sendgrid', 'resend', 'firebase', 'dev']),
  deduplicated: z.boolean().optional()
})
export type SendEmailResult = z.infer<typeof sendEmailResultSchema>

export const sendBatchEmailResultSchema = z.object({
  total: z.number().int().nonnegative(),
  sent: z.number().int().nonnegative(),
  suppressed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  results: z.array(sendEmailResultSchema)
})
export type SendBatchEmailResult = z.infer<typeof sendBatchEmailResultSchema>

export interface EmailCallOptions {
  provider?: 'sendgrid' | 'resend'
  userId?: EntryId
}

export interface ResolvedAttachment {
  filename: string
  contentBase64: string
  contentType: string
}

export interface NormalizedEmailRequest {
  emailId: EntryId
  to: string[]
  fromEmail: string
  fromName: string
  replyTo?: string
  cc?: string[]
  bcc?: string[]
  subject?: string
  html?: string
  text?: string
  template?: string
  providerTemplateId?: string
  variables: Record<string, unknown>
  attachments: ResolvedAttachment[]
  tags?: Record<string, string>
  idempotencyKey?: string
  purpose?: string
  userId?: EntryId
}

export interface ResendWebhookEvent {
  type:
    | 'email.sent'
    | 'email.delivered'
    | 'email.delivery_delayed'
    | 'email.complained'
    | 'email.bounced'
    | 'email.opened'
    | 'email.clicked'
    | (string & {})
  created_at?: string
  data: {
    email_id?: string
    to?: string[] | string
    from?: string
    subject?: string
    bounce?: { message?: string; type?: string }
  }
}

export interface SendGridWebhookEvent {
  event:
    | 'processed'
    | 'delivered'
    | 'open'
    | 'click'
    | 'bounce'
    | 'dropped'
    | 'spamreport'
    | (string & {})
  email?: string
  sg_message_id?: string
  timestamp?: number
  reason?: string
  type?: string
}
