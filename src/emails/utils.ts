import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { z } from 'zod'
import type {
  AuthEmailVariables,
  EmailLogStatus,
  EmailProvider,
  EmailsConfig,
  EmailTemplateDefinition,
  NormalizedEmailRequest,
  ResolvedAttachment,
  ResendWebhookEvent,
  SendBatchEmailResult,
  SendEmailResult,
  SendGridWebhookEvent,
  TransactionalEmailPayload,
  sendEmailInputSchema
} from './schema'

export const normalizeEmail = (email: string): string => email.trim().toLowerCase()

export const suppressionDocId = (email: string): string =>
  createHash('sha256').update(normalizeEmail(email)).digest('hex')

export const idempotencyEmailDocId = (idempotencyKey: string): string =>
  `em_${createHash('sha256').update(idempotencyKey.trim()).digest('hex').slice(0, 40)}`

export const summarizeBatchEmailResults = (results: SendEmailResult[]): SendBatchEmailResult => ({
  total: results.length,
  sent: results.filter((r) => r.status === 'sent').length,
  suppressed: results.filter((r) => r.status === 'suppressed').length,
  failed: results.filter((r) => r.status === 'failed').length,
  results
})

export const buildNormalizedEmailRequest = (
  emailId: string,
  toList: string[],
  parsed: z.infer<typeof sendEmailInputSchema>,
  tmpl: EmailTemplateDefinition<any> | undefined,
  provider: EmailProvider | 'dev',
  vars: Record<string, unknown>,
  emailsCfg: EmailsConfig,
  attachments: ResolvedAttachment[],
  userId?: string
): NormalizedEmailRequest => {
  const f = resolveTemplateFields(parsed, tmpl, provider, vars, emailsCfg)
  return {
    emailId,
    to: toList,
    fromEmail: f.fromEmail,
    fromName: f.fromName,
    ...(f.replyTo ? { replyTo: f.replyTo } : {}),
    ...(parsed.cc?.length ? { cc: parsed.cc.map(normalizeEmail) } : {}),
    ...(parsed.bcc?.length ? { bcc: parsed.bcc.map(normalizeEmail) } : {}),
    ...(f.subject ? { subject: f.subject } : {}),
    ...(f.html ? { html: f.html } : {}),
    ...(f.text ? { text: f.text } : {}),
    ...(parsed.template ? { template: parsed.template } : {}),
    ...(f.providerTemplateId ? { providerTemplateId: f.providerTemplateId } : {}),
    variables: vars,
    attachments,
    ...(parsed.tags ? { tags: parsed.tags } : {}),
    ...(parsed.idempotencyKey ? { idempotencyKey: parsed.idempotencyKey } : {}),
    ...(parsed.purpose ? { purpose: parsed.purpose } : {}),
    ...(userId ? { userId } : {})
  }
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

export const RESEND_STATUS_MAP: Record<string, EmailLogStatus> = {
  'email.sent': 'sent',
  'email.delivered': 'delivered',
  'email.opened': 'opened',
  'email.clicked': 'clicked',
  'email.bounced': 'bounced',
  'email.complained': 'complained'
}

export const SENDGRID_STATUS_MAP: Record<string, EmailLogStatus> = {
  processed: 'sent',
  delivered: 'delivered',
  open: 'opened',
  click: 'clicked',
  bounce: 'bounced',
  dropped: 'bounced',
  spamreport: 'complained'
}

export const resolveTemplateFields = (
  parsed: z.infer<typeof sendEmailInputSchema>,
  tmpl: EmailTemplateDefinition<any> | undefined,
  provider: EmailProvider | 'dev',
  vars: Record<string, unknown>,
  emailsCfg: EmailsConfig
) => {
  const rSpec = tmpl?.providers?.resend
  const sgSpec = tmpl?.providers?.sendgrid
  const providerTemplateId =
    parsed.providerTemplateId ??
    (provider === 'sendgrid'
      ? sgSpec?.templateId
      : provider === 'resend'
        ? rSpec?.templateId
        : rSpec?.templateId ?? sgSpec?.templateId)

  const evalField = (val: string | ((v: Record<string, unknown>) => string) | undefined): string | undefined =>
    typeof val === 'function' ? val(vars) : val

  const subject = parsed.subject ?? evalField(rSpec?.subject) ?? evalField(tmpl?.subject)
  const html = parsed.html ?? evalField(rSpec?.html) ?? evalField(tmpl?.html)
  const text = parsed.text ?? evalField(rSpec?.text) ?? evalField(tmpl?.text)
  const fromEmail = parsed.fromEmail ?? tmpl?.fromEmail ?? emailsCfg.fromEmail
  const fromName = parsed.fromName ?? tmpl?.fromName ?? emailsCfg.fromName
  const replyTo = parsed.replyTo ?? tmpl?.replyTo ?? emailsCfg.replyTo

  return { providerTemplateId, subject, html, text, fromEmail, fromName, replyTo }
}

export const buildAuthActionUrl = (
  baseUrl: string,
  actionPath: string,
  payload: TransactionalEmailPayload
): string => {
  const cleanBase = baseUrl.replace(/\/+$/, '')
  const cleanPath = actionPath.startsWith('/') ? actionPath : `/${actionPath}`
  const url = new URL(`${cleanBase}${cleanPath}`)
  if (payload.token) url.searchParams.set('token', payload.token)
  if (payload.code) url.searchParams.set('code', payload.code)
  url.searchParams.set('email', payload.to)
  return url.toString()
}

export const renderDefaultAuthEmail = (
  vars: AuthEmailVariables,
  customSubject?: string
): { subject: string; html: string; text: string } => {
  const subject = customSubject || `${vars.appName} — ${vars.purpose.replace(/_/g, ' ')}`
  if (vars.purpose === 'welcome') {
    return {
      subject,
      html: `<p>Welcome to <strong>${vars.appName}</strong>!</p><p><a href="${vars.actionUrl}">Open ${vars.appName}</a></p>`,
      text: `Welcome to ${vars.appName}! Open: ${vars.actionUrl}`
    }
  }
  return {
    subject,
    html: [
      `<p>Your <strong>${vars.appName}</strong> verification code is:</p>`,
      `<p style="font-size:24px;font-weight:bold;letter-spacing:2px">${vars.code}</p>`,
      `<p>Or click the link below (expires in ${vars.expiresInMinutes} minutes):</p>`,
      `<p><a href="${vars.actionUrl}">${vars.actionUrl}</a></p>`
    ].join('\n'),
    text: `Your ${vars.appName} code is ${vars.code} (expires in ${vars.expiresInMinutes} minutes).\nLink: ${vars.actionUrl}`
  }
}

export const buildSendGridPayload = (req: NormalizedEmailRequest): Record<string, unknown> => {
  const personalization: Record<string, unknown> = {
    to: req.to.map((email) => ({ email })),
    ...(req.cc?.length ? { cc: req.cc.map((email) => ({ email })) } : {}),
    ...(req.bcc?.length ? { bcc: req.bcc.map((email) => ({ email })) } : {}),
    ...(req.providerTemplateId
      ? { dynamic_template_data: req.variables }
      : req.subject
        ? { subject: req.subject }
        : {})
  }
  const content: { type: string; value: string }[] = []
  if (!req.providerTemplateId) {
    if (req.text) content.push({ type: 'text/plain', value: req.text })
    if (req.html) content.push({ type: 'text/html', value: req.html })
    if (!content.length) content.push({ type: 'text/plain', value: req.subject ?? '' })
  }
  return {
    personalizations: [personalization],
    from: { email: req.fromEmail, ...(req.fromName ? { name: req.fromName } : {}) },
    ...(req.replyTo ? { reply_to: { email: req.replyTo } } : {}),
    ...(req.subject ? { subject: req.subject } : {}),
    ...(req.providerTemplateId ? { template_id: req.providerTemplateId } : { content }),
    ...(req.attachments.length
      ? {
          attachments: req.attachments.map((a) => ({
            content: a.contentBase64,
            filename: a.filename,
            type: a.contentType,
            disposition: 'attachment'
          }))
        }
      : {}),
    ...(req.tags ? { custom_args: req.tags } : {})
  }
}

export const buildResendPayload = (req: NormalizedEmailRequest): Record<string, unknown> => ({
  from: req.fromName ? `${req.fromName} <${req.fromEmail}>` : req.fromEmail,
  to: req.to,
  ...(req.cc?.length ? { cc: req.cc } : {}),
  ...(req.bcc?.length ? { bcc: req.bcc } : {}),
  ...(req.replyTo ? { reply_to: req.replyTo } : {}),
  subject: req.subject ?? req.template ?? 'Notification',
  ...(req.providerTemplateId
    ? { template_id: req.providerTemplateId, variables: req.variables }
    : {}),
  ...(req.html ? { html: req.html } : {}),
  ...(req.text ? { text: req.text } : {}),
  ...(!req.html && !req.text && !req.providerTemplateId
    ? { text: req.subject ?? 'Notification' }
    : {}),
  ...(req.attachments.length
    ? {
        attachments: req.attachments.map((a) => ({
          filename: a.filename,
          content: a.contentBase64,
          content_type: a.contentType
        }))
      }
    : {}),
  ...(req.tags
    ? { tags: Object.entries(req.tags).map(([name, value]) => ({ name, value })) }
    : {})
})

export const postSendGridMail = async (
  baseUrl: string,
  apiKey: string,
  req: NormalizedEmailRequest
): Promise<{ externalId: string }> => {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/mail/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(buildSendGridPayload(req)),
    signal: AbortSignal.timeout(15_000)
  })
  if (!res.ok) {
    const err = new Error(`SendGrid HTTP ${res.status}: ${await res.text().catch(() => '')}`)
    ;(err as { status?: number }).status = res.status
    throw err
  }
  return { externalId: res.headers.get('x-message-id')?.trim() || `sg_${req.emailId}` }
}

export const postResendEmail = async (
  baseUrl: string,
  apiKey: string,
  req: NormalizedEmailRequest
): Promise<{ externalId: string }> => {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/emails`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      ...(req.idempotencyKey ? { 'Idempotency-Key': req.idempotencyKey } : {})
    },
    body: JSON.stringify(buildResendPayload(req)),
    signal: AbortSignal.timeout(15_000)
  })
  if (!res.ok) {
    const err = new Error(`Resend HTTP ${res.status}: ${await res.text().catch(() => '')}`)
    ;(err as { status?: number }).status = res.status
    throw err
  }
  const data = (await res.json().catch(() => ({}))) as { id?: string }
  return { externalId: data.id || `re_${req.emailId}` }
}

export const postResendBatch = async (
  baseUrl: string,
  apiKey: string,
  reqs: NormalizedEmailRequest[]
): Promise<{ externalIds: string[] }> => {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/emails/batch`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(reqs.map(buildResendPayload)),
    signal: AbortSignal.timeout(20_000)
  })
  if (!res.ok) {
    const err = new Error(`Resend Batch HTTP ${res.status}: ${await res.text().catch(() => '')}`)
    ;(err as { status?: number }).status = res.status
    throw err
  }
  const raw = (await res.json().catch(() => ({}))) as { data?: { id?: string }[] } | { id?: string }[]
  const items = Array.isArray(raw) ? raw : (raw.data ?? [])
  return { externalIds: reqs.map((r, idx) => items[idx]?.id || `re_${r.emailId}`) }
}

export const postFirebaseOobCode = async (
  apiKey: string,
  customToken: string | undefined,
  payload: TransactionalEmailPayload,
  continueUrl: string
): Promise<void> => {
  const postToolkit = async (endpoint: string, body: Record<string, unknown>) => {
    const res = await fetch(`https://identitytoolkit.googleapis.com/v1/${endpoint}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000)
    })
    return { ok: res.ok, data: (await res.json().catch(() => ({}))) as Record<string, unknown> }
  }
  let body: Record<string, unknown>
  if (payload.purpose === 'verify_email') {
    if (!customToken) return
    const { ok, data } = await postToolkit('accounts:signInWithCustomToken', {
      token: customToken,
      returnSecureToken: true
    })
    if (!ok || typeof data.idToken !== 'string') return
    body = { requestType: 'VERIFY_EMAIL', idToken: data.idToken }
  } else if (payload.purpose === 'reset_password') {
    body = { requestType: 'PASSWORD_RESET', email: payload.to }
  } else {
    body = { requestType: 'EMAIL_SIGNIN', email: payload.to, continueUrl, canHandleCodeInApp: true }
  }
  await postToolkit('accounts:sendOobCode', body)
}

export const verifyResendWebhookHmac = (
  rawBody: string,
  headers: Record<string, string | undefined>,
  secret: string,
  toleranceSeconds: number
): ResendWebhookEvent => {
  const msgId = getHeader(headers, 'svix-id') ?? getHeader(headers, 'webhook-id')
  const msgTimestamp = getHeader(headers, 'svix-timestamp') ?? getHeader(headers, 'webhook-timestamp')
  const msgSignature = getHeader(headers, 'svix-signature') ?? getHeader(headers, 'webhook-signature')
  if (!msgId || !msgTimestamp || !msgSignature || !secret) {
    throw new Error('Missing Resend/Svix webhook signature headers or secret')
  }

  const tsSeconds = Number(msgTimestamp)
  const nowSeconds = Math.floor(Date.now() / 1000)
  if (!Number.isFinite(tsSeconds) || Math.abs(nowSeconds - tsSeconds) > toleranceSeconds) {
    throw new Error('Resend webhook timestamp outside tolerance window')
  }

  const signedContent = `${msgId}.${msgTimestamp}.${rawBody}`
  const rawSecret = secret.startsWith('whsec_') ? secret.slice(6) : secret
  const expectedBase64FromDecoded = createHmac('sha256', Buffer.from(rawSecret, 'base64'))
    .update(signedContent, 'utf8')
    .digest('base64')
  const expectedBase64FromUtf8 = createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(signedContent, 'utf8')
    .digest('base64')

  const candidates = msgSignature
    .split(/\s+/)
    .map((part) => (part.startsWith('v1,') ? part.slice(3) : part.trim()))
    .filter(Boolean)

  const verified = candidates.some(
    (sig) => constantTimeEqual(sig, expectedBase64FromDecoded) || constantTimeEqual(sig, expectedBase64FromUtf8)
  )
  if (!verified) {
    throw new Error('Invalid Resend webhook HMAC signature')
  }

  return JSON.parse(rawBody) as ResendWebhookEvent
}

export const verifySendGridWebhookHmac = (
  rawBody: string,
  headers: Record<string, string | undefined>,
  secret: string,
  toleranceSeconds: number
): SendGridWebhookEvent[] => {
  const timestamp =
    getHeader(headers, 'x-twilio-email-event-webhook-timestamp') ?? getHeader(headers, 'x-sendgrid-timestamp')
  const signature =
    getHeader(headers, 'x-twilio-email-event-webhook-signature') ?? getHeader(headers, 'x-sendgrid-signature')
  if (!timestamp || !signature || !secret) {
    throw new Error('Missing SendGrid webhook signature headers or secret')
  }

  const tsSeconds = Number(timestamp)
  const nowSeconds = Math.floor(Date.now() / 1000)
  if (!Number.isFinite(tsSeconds) || Math.abs(nowSeconds - tsSeconds) > toleranceSeconds) {
    throw new Error('SendGrid webhook timestamp outside tolerance window')
  }

  const signedPayload = `${timestamp}${rawBody}`
  const expectedBase64 = createHmac('sha256', secret).update(signedPayload, 'utf8').digest('base64')
  const expectedHex = createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex')
  const cleanSig = signature.startsWith('v1,') ? signature.slice(3) : signature

  if (!constantTimeEqual(cleanSig, expectedBase64) && !constantTimeEqual(cleanSig, expectedHex)) {
    throw new Error('Invalid SendGrid webhook HMAC signature')
  }

  const parsed = JSON.parse(rawBody) as unknown
  return Array.isArray(parsed) ? (parsed as SendGridWebhookEvent[]) : [parsed as SendGridWebhookEvent]
}

export interface NormalizedWebhookUpdate {
  externalId?: string
  recipient?: string
  status: EmailLogStatus
  rawEvent: string
}

export const parseAndVerifyEmailWebhook = (
  provider: 'sendgrid' | 'resend',
  rawBody: string,
  headers: Record<string, string | undefined>,
  secret: string,
  toleranceSeconds: number
): { processed: number; updates: NormalizedWebhookUpdate[] } => {
  if (provider === 'resend') {
    const event = verifyResendWebhookHmac(rawBody, headers, secret, toleranceSeconds)
    const status = RESEND_STATUS_MAP[event.type]
    const recipient = Array.isArray(event.data?.to) ? event.data.to[0] : event.data?.to
    return {
      processed: 1,
      updates: status
        ? [{ ...(event.data?.email_id ? { externalId: event.data.email_id } : {}), ...(recipient ? { recipient } : {}), status, rawEvent: rawBody }]
        : []
    }
  }

  const events = verifySendGridWebhookHmac(rawBody, headers, secret, toleranceSeconds)
  const updates: NormalizedWebhookUpdate[] = []
  for (const ev of events) {
    const status = SENDGRID_STATUS_MAP[ev.event]
    if (!status) continue
    const cleanMsgId = ev.sg_message_id?.split('.')[0]
    updates.push({
      ...(cleanMsgId ? { externalId: cleanMsgId } : {}),
      ...(ev.email ? { recipient: ev.email } : {}),
      status,
      rawEvent: JSON.stringify(ev)
    })
  }
  return { processed: events.length, updates }
}
