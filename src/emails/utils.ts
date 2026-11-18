import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { z } from 'zod'
import type {
  AuthEmailVariables,
  EmailLogStatus,
  EmailProvider,
  EmailsConfig,
  EmailTemplateDefinition,
  MailtrapWebhookEvent,
  NormalizedEmailRequest,
  PostmarkWebhookEvent,
  ResolvedAttachment,
  ResendWebhookEvent,
  SendBatchEmailResult,
  SendEmailResult,
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

const escapeHtmlEntities = (str: string): string =>
  str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const lookupVarPath = (vars: Record<string, unknown>, rawPath: string): string => {
  const parts = rawPath.trim().split('.')
  let cur: unknown = vars
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return ''
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur === null || cur === undefined ? '' : String(cur)
}

export const interpolateEmailTemplate = (
  template: string | ((vars: Record<string, unknown>) => string) | undefined,
  vars: Record<string, unknown>,
  escapeHtml = false
): string | undefined => {
  if (template === undefined) return undefined
  if (typeof template === 'function') return template(vars)
  const withRaw = template.replace(/\{\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}\}/g, (_, key: string) => lookupVarPath(vars, key))
  return withRaw.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_, key: string) => {
    const val = lookupVarPath(vars, key)
    return escapeHtml ? escapeHtmlEntities(val) : val
  })
}

export const resolveTemplateFields = (
  parsed: z.infer<typeof sendEmailInputSchema>,
  tmpl: EmailTemplateDefinition<any> | undefined,
  vars: Record<string, unknown>,
  emailsCfg: EmailsConfig
) => {
  const subject = parsed.subject ?? interpolateEmailTemplate(tmpl?.subject, vars, false)
  const html = parsed.html ?? interpolateEmailTemplate(tmpl?.html, vars, true)
  const text = parsed.text ?? interpolateEmailTemplate(tmpl?.text, vars, false)
  const fromEmail = parsed.fromEmail ?? tmpl?.fromEmail ?? emailsCfg.fromEmail
  const fromName = parsed.fromName ?? tmpl?.fromName ?? emailsCfg.fromName
  const replyTo = parsed.replyTo ?? tmpl?.replyTo ?? emailsCfg.replyTo
  const category = tmpl?.category ?? parsed.template ?? parsed.purpose

  return { subject, html, text, fromEmail, fromName, replyTo, category }
}

export const buildNormalizedEmailRequest = (
  emailId: string,
  toList: string[],
  parsed: z.infer<typeof sendEmailInputSchema>,
  tmpl: EmailTemplateDefinition<any> | undefined,
  vars: Record<string, unknown>,
  emailsCfg: EmailsConfig,
  attachments: ResolvedAttachment[],
  userId?: string
): NormalizedEmailRequest => {
  const f = resolveTemplateFields(parsed, tmpl, vars, emailsCfg)
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
    ...(f.category ? { category: f.category } : {}),
    variables: vars,
    attachments,
    ...(parsed.tags ? { tags: parsed.tags } : {}),
    ...(parsed.idempotencyKey ? { idempotencyKey: parsed.idempotencyKey } : {}),
    ...(parsed.purpose ? { purpose: parsed.purpose } : {}),
    ...(userId ? { userId } : {})
  }
}

export const isEmailFailoverEligible = (err: unknown): boolean => {
  if (!err) return false
  if (typeof err === 'object' && (err as { isCircuitBreakerOpen?: unknown }).isCircuitBreakerOpen === true) {
    return true
  }
  const rec = typeof err === 'object' ? (err as Record<string, unknown>) : {}
  const rawStatus =
    typeof rec.status === 'number'
      ? rec.status
      : typeof rec.statusCode === 'number'
        ? rec.statusCode
        : undefined
  const msg = err instanceof Error ? err.message : String(err)
  const lower = msg.toLowerCase()
  const parsedMatch = /\bhttp\s+(\d{3})\b/i.exec(msg)
  const status = rawStatus ?? (parsedMatch?.[1] ? Number(parsedMatch[1]) : undefined)

  if (status !== undefined) {
    return status === 408 || status === 429 || status >= 500
  }

  return (
    rec.name === 'AbortError' ||
    rec.name === 'TimeoutError' ||
    lower.includes('timed out') ||
    lower.includes('timeout') ||
    lower.includes('econnreset') ||
    lower.includes('econnrefused') ||
    lower.includes('etimedout') ||
    lower.includes('socket hang up') ||
    lower.includes('fetch failed')
  )
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

export const POSTMARK_STATUS_MAP: Record<string, EmailLogStatus> = {
  Delivery: 'delivered',
  Open: 'opened',
  Click: 'clicked',
  SpamComplaint: 'complained',
  Bounce: 'bounced'
}

export const MAILTRAP_STATUS_MAP: Record<string, EmailLogStatus> = {
  delivery: 'delivered',
  open: 'opened',
  click: 'clicked',
  bounce: 'bounced',
  reject: 'bounced',
  suspension: 'bounced',
  'spam complaint': 'complained',
  spam: 'complained'
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
      html: `<p>Welcome to <strong>${escapeHtmlEntities(vars.appName)}</strong>!</p><p><a href="${escapeHtmlEntities(vars.actionUrl)}">Open ${escapeHtmlEntities(vars.appName)}</a></p>`,
      text: `Welcome to ${vars.appName}! Open: ${vars.actionUrl}`
    }
  }
  return {
    subject,
    html: [
      `<p>Your <strong>${escapeHtmlEntities(vars.appName)}</strong> verification code is:</p>`,
      `<p style="font-size:24px;font-weight:bold;letter-spacing:2px">${escapeHtmlEntities(vars.code)}</p>`,
      `<p>Or click the link below (expires in ${vars.expiresInMinutes} minutes):</p>`,
      `<p><a href="${escapeHtmlEntities(vars.actionUrl)}">${escapeHtmlEntities(vars.actionUrl)}</a></p>`
    ].join('\n'),
    text: `Your ${vars.appName} code is ${vars.code} (expires in ${vars.expiresInMinutes} minutes).\nLink: ${vars.actionUrl}`
  }
}

export const buildResendPayload = (req: NormalizedEmailRequest): Record<string, unknown> => ({
  from: req.fromName ? `${req.fromName} <${req.fromEmail}>` : req.fromEmail,
  to: req.to,
  ...(req.cc?.length ? { cc: req.cc } : {}),
  ...(req.bcc?.length ? { bcc: req.bcc } : {}),
  ...(req.replyTo ? { reply_to: req.replyTo } : {}),
  subject: req.subject ?? req.template ?? 'Notification',
  ...(req.html ? { html: req.html } : {}),
  ...(req.text ? { text: req.text } : {}),
  ...(!req.html && !req.text ? { text: req.subject ?? 'Notification' } : {}),
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

export const buildPostmarkPayload = (req: NormalizedEmailRequest, messageStream = 'outbound'): Record<string, unknown> => ({
  From: req.fromName ? `${req.fromName} <${req.fromEmail}>` : req.fromEmail,
  To: req.to.join(', '),
  ...(req.cc?.length ? { Cc: req.cc.join(', ') } : {}),
  ...(req.bcc?.length ? { Bcc: req.bcc.join(', ') } : {}),
  ...(req.replyTo ? { ReplyTo: req.replyTo } : {}),
  Subject: req.subject ?? req.template ?? 'Notification',
  ...(req.html ? { HtmlBody: req.html } : {}),
  ...(req.text ? { TextBody: req.text } : {}),
  ...(!req.html && !req.text ? { TextBody: req.subject ?? 'Notification' } : {}),
  MessageStream: messageStream,
  ...(req.category ? { Tag: req.category.slice(0, 64) } : {}),
  ...(req.tags ? { Metadata: req.tags } : {}),
  ...(req.attachments.length
    ? {
        Attachments: req.attachments.map((a) => ({
          Name: a.filename,
          Content: a.contentBase64,
          ContentType: a.contentType
        }))
      }
    : {})
})

export const buildMailtrapPayload = (req: NormalizedEmailRequest): Record<string, unknown> => ({
  from: { email: req.fromEmail, ...(req.fromName ? { name: req.fromName } : {}) },
  to: req.to.map((email) => ({ email })),
  ...(req.cc?.length ? { cc: req.cc.map((email) => ({ email })) } : {}),
  ...(req.bcc?.length ? { bcc: req.bcc.map((email) => ({ email })) } : {}),
  ...(req.replyTo ? { headers: { 'Reply-To': req.replyTo } } : {}),
  subject: req.subject ?? req.template ?? 'Notification',
  ...(req.html ? { html: req.html } : {}),
  ...(req.text ? { text: req.text } : {}),
  ...(!req.html && !req.text ? { text: req.subject ?? 'Notification' } : {}),
  ...(req.category ? { category: req.category.slice(0, 255) } : {}),
  ...(req.tags ? { custom_variables: req.tags } : {}),
  ...(req.attachments.length
    ? {
        attachments: req.attachments.map((a) => ({
          filename: a.filename,
          content: a.contentBase64,
          type: a.contentType,
          disposition: 'attachment'
        }))
      }
    : {})
})

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

export const postPostmarkEmail = async (
  baseUrl: string,
  apiKey: string,
  messageStream: string,
  req: NormalizedEmailRequest
): Promise<{ externalId: string }> => {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/email`, {
    method: 'POST',
    headers: {
      'X-Postmark-Server-Token': apiKey,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(buildPostmarkPayload(req, messageStream)),
    signal: AbortSignal.timeout(15_000)
  })
  if (!res.ok) {
    const err = new Error(`Postmark HTTP ${res.status}: ${await res.text().catch(() => '')}`)
    ;(err as { status?: number }).status = res.status
    throw err
  }
  const data = (await res.json().catch(() => ({}))) as { MessageID?: string }
  return { externalId: data.MessageID || `pm_${req.emailId}` }
}

export const postPostmarkBatch = async (
  baseUrl: string,
  apiKey: string,
  messageStream: string,
  reqs: NormalizedEmailRequest[]
): Promise<{ externalIds: string[] }> => {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/email/batch`, {
    method: 'POST',
    headers: {
      'X-Postmark-Server-Token': apiKey,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(reqs.map((r) => buildPostmarkPayload(r, messageStream))),
    signal: AbortSignal.timeout(20_000)
  })
  if (!res.ok) {
    const err = new Error(`Postmark Batch HTTP ${res.status}: ${await res.text().catch(() => '')}`)
    ;(err as { status?: number }).status = res.status
    throw err
  }
  const raw = (await res.json().catch(() => [])) as { MessageID?: string }[]
  const items = Array.isArray(raw) ? raw : []
  return { externalIds: reqs.map((r, idx) => items[idx]?.MessageID || `pm_${r.emailId}`) }
}

export const postMailtrapEmail = async (
  sendUrl: string,
  apiKey: string,
  req: NormalizedEmailRequest
): Promise<{ externalId: string }> => {
  const res = await fetch(sendUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(buildMailtrapPayload(req)),
    signal: AbortSignal.timeout(15_000)
  })
  if (!res.ok) {
    const err = new Error(`Mailtrap HTTP ${res.status}: ${await res.text().catch(() => '')}`)
    ;(err as { status?: number }).status = res.status
    throw err
  }
  const data = (await res.json().catch(() => ({}))) as { message_ids?: string[] }
  return { externalId: data.message_ids?.[0] || `mt_${req.emailId}` }
}

export const postMailtrapBatch = async (
  batchUrl: string,
  apiKey: string,
  reqs: NormalizedEmailRequest[]
): Promise<{ externalIds: string[] }> => {
  const res = await fetch(batchUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ requests: reqs.map(buildMailtrapPayload) }),
    signal: AbortSignal.timeout(20_000)
  })
  if (!res.ok) {
    const err = new Error(`Mailtrap Batch HTTP ${res.status}: ${await res.text().catch(() => '')}`)
    ;(err as { status?: number }).status = res.status
    throw err
  }
  const data = (await res.json().catch(() => ({}))) as {
    responses?: { success?: boolean; message_ids?: string[] }[]
  }
  const items = Array.isArray(data.responses) ? data.responses : []
  return { externalIds: reqs.map((r, idx) => items[idx]?.message_ids?.[0] || `mt_${r.emailId}`) }
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

export const verifyPostmarkWebhookAuth = (
  rawBody: string,
  headers: Record<string, string | undefined>,
  secret: string
): PostmarkWebhookEvent[] => {
  if (!secret) throw new Error('Missing Postmark webhook secret')
  const headerToken = getHeader(headers, 'x-postmark-webhook-secret') ?? getHeader(headers, 'x-webhook-secret')
  const authHeader = getHeader(headers, 'authorization')

  let matched = Boolean(headerToken && constantTimeEqual(headerToken, secret))
  if (!matched && authHeader) {
    if (authHeader.toLowerCase().startsWith('basic ')) {
      const decoded = Buffer.from(authHeader.slice(6).trim(), 'base64').toString('utf8')
      const colonIdx = decoded.indexOf(':')
      const passwordPart = colonIdx >= 0 ? decoded.slice(colonIdx + 1) : decoded
      matched = constantTimeEqual(decoded, secret) || constantTimeEqual(passwordPart, secret)
    } else if (authHeader.toLowerCase().startsWith('bearer ')) {
      matched = constantTimeEqual(authHeader.slice(7).trim(), secret)
    }
  }
  if (!matched) {
    throw new Error('Invalid Postmark webhook secret')
  }

  const parsed = JSON.parse(rawBody) as unknown
  return Array.isArray(parsed) ? (parsed as PostmarkWebhookEvent[]) : [parsed as PostmarkWebhookEvent]
}

export const verifyMailtrapWebhookHmac = (
  rawBody: string,
  headers: Record<string, string | undefined>,
  secret: string
): MailtrapWebhookEvent[] => {
  const sigHeader = getHeader(headers, 'mailtrap-signature')
  if (!sigHeader || !secret) {
    throw new Error('Missing Mailtrap-Signature header or webhook secret')
  }
  const cleanSig = sigHeader.startsWith('sha256=') ? sigHeader.slice(7).trim() : sigHeader.trim()
  const expectedHex = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  if (!constantTimeEqual(cleanSig, expectedHex)) {
    throw new Error('Invalid Mailtrap webhook HMAC signature')
  }

  const parsed = JSON.parse(rawBody) as { events?: MailtrapWebhookEvent[] } | MailtrapWebhookEvent[] | MailtrapWebhookEvent
  if (Array.isArray(parsed)) return parsed
  if (parsed && typeof parsed === 'object' && 'events' in parsed && Array.isArray(parsed.events)) {
    return parsed.events
  }
  return [parsed as MailtrapWebhookEvent]
}

export interface NormalizedWebhookUpdate {
  externalId?: string
  recipient?: string
  status: EmailLogStatus
  rawEvent: string
}

export const parseAndVerifyEmailWebhook = (
  provider: EmailProvider,
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
        ? [
            {
              ...(event.data?.email_id ? { externalId: event.data.email_id } : {}),
              ...(recipient ? { recipient } : {}),
              status,
              rawEvent: rawBody
            }
          ]
        : []
    }
  }

  if (provider === 'postmark') {
    const events = verifyPostmarkWebhookAuth(rawBody, headers, secret)
    const updates: NormalizedWebhookUpdate[] = []
    for (const ev of events) {
      if (!ev.RecordType) continue
      if (
        ev.RecordType === 'Bounce' &&
        ev.Type &&
        ev.Type !== 'HardBounce' &&
        ev.Type !== 'BadEmailAddress' &&
        ev.Type !== 'SpamNotification'
      ) {
        continue
      }
      const status = POSTMARK_STATUS_MAP[ev.RecordType]
      if (!status) continue
      const recipient = ev.Email ?? ev.Recipient
      updates.push({
        ...(ev.MessageID ? { externalId: ev.MessageID } : {}),
        ...(recipient ? { recipient } : {}),
        status,
        rawEvent: JSON.stringify(ev)
      })
    }
    return { processed: events.length, updates }
  }

  const events = verifyMailtrapWebhookHmac(rawBody, headers, secret)
  const updates: NormalizedWebhookUpdate[] = []
  for (const ev of events) {
    const eventName = ev.event?.toLowerCase() ?? ''
    const status = MAILTRAP_STATUS_MAP[eventName]
    if (!status) continue
    updates.push({
      ...(ev.message_id ? { externalId: ev.message_id } : {}),
      ...(ev.email ? { recipient: ev.email } : {}),
      status,
      rawEvent: JSON.stringify(ev)
    })
  }
  return { processed: events.length, updates }
}
