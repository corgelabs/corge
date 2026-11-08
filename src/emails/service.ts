import type { DbListOptions, EntryId, PaginatedList, SelectModel } from '../db'
import type { Core } from '../index'
import {
  getEmailTemplate,
  sendEmailInputSchema,
  type AuthEmailPurpose,
  type AuthEmailVariables,
  type EmailAttachmentInput,
  type EmailCallOptions,
  type EmailLogStatus,
  type EmailProvider,
  type NormalizedEmailRequest,
  type ResolvedAttachment,
  type SendBatchEmailResult,
  type SendEmailInput,
  type SendEmailResult,
  type TransactionalEmailPayload
} from './schema'
import {
  buildAuthActionUrl,
  buildNormalizedEmailRequest,
  idempotencyEmailDocId,
  normalizeEmail,
  parseAndVerifyEmailWebhook,
  postFirebaseOobCode,
  postResendBatch,
  postResendEmail,
  postSendGridMail,
  renderDefaultAuthEmail,
  summarizeBatchEmailResults,
  suppressionDocId
} from './utils'

export class EmailsService {
  readonly #core: Core
  readonly #devEmailOutbox = new Map<string, TransactionalEmailPayload>()

  constructor(coreClient: Core) {
    this.#core = coreClient
  }

  #resolveProvider = (override?: EmailProvider): EmailProvider | 'dev' => {
    const preferred = override ?? this.#core.config.emails.provider
    const hasResend = Boolean(this.#core.env.RESEND_API_KEY?.trim())
    const hasSendGrid = Boolean(this.#core.env.SENDGRID_API_KEY?.trim())
    if (preferred === 'sendgrid') {
      if (hasSendGrid) return 'sendgrid'
      if (!override && hasResend) return 'resend'
    } else if (preferred === 'resend') {
      if (hasResend) return 'resend'
      if (!override && hasSendGrid) return 'sendgrid'
    } else if (preferred === 'firebase') {
      return this.#core.env.isDev && !this.#core.env.WEB_API_KEY ? 'dev' : 'firebase'
    }
    return this.#core.env.isDev ? 'dev' : 'firebase'
  }

  #resolveAttachments = async (attachments?: EmailAttachmentInput[]): Promise<ResolvedAttachment[]> =>
    attachments?.length
      ? Promise.all(
          attachments.map(async (att) => {
            if (att.contentBase64) {
              return {
                filename: att.filename,
                contentBase64: att.contentBase64,
                contentType: att.contentType ?? 'application/octet-stream'
              }
            }
            const { bytes, type } = await this.#core.files.get(att.fileRef!)
            return {
              filename: att.filename,
              contentBase64: Buffer.from(bytes).toString('base64'),
              contentType: att.contentType ?? type
            }
          })
        )
      : []

  #withEmailBreaker = async <T>(cost: number, fn: () => Promise<T>): Promise<T> => {
    await this.#core.internals.resilience.acquireLimit('emails', cost)
    return this.#core.internals.resilience.circuitBreaker('emails', fn)
  }

  #sendViaSendGrid = (req: NormalizedEmailRequest): Promise<{ externalId: string }> =>
    this.#withEmailBreaker(1, () =>
      postSendGridMail(this.#core.config.emails.sendgrid.baseUrl, this.#core.env.SENDGRID_API_KEY, req)
    )

  #sendViaResend = (req: NormalizedEmailRequest): Promise<{ externalId: string }> =>
    this.#withEmailBreaker(1, () =>
      postResendEmail(this.#core.config.emails.resend.baseUrl, this.#core.env.RESEND_API_KEY, req)
    )

  #sendBatchViaResend = (reqs: NormalizedEmailRequest[]): Promise<{ externalIds: string[] }> =>
    this.#withEmailBreaker(reqs.length, () =>
      postResendBatch(this.#core.config.emails.resend.baseUrl, this.#core.env.RESEND_API_KEY, reqs)
    )

  #sendFirebaseOobEmail = async (payload: TransactionalEmailPayload): Promise<void> => {
    const apiKey = this.#core.env.WEB_API_KEY
    if (!apiKey) return
    try {
      const customToken =
        payload.purpose === 'verify_email'
          ? (await this.#core.internals.auth.mintCustomToken(payload.userId)).customToken
          : undefined
      await postFirebaseOobCode(
        apiKey,
        customToken,
        payload,
        this.#core.config.emails.actionBaseUrl || 'http://localhost'
      )
    } catch {}
  }

  #prepareEmailRequest = async (
    rawInput: SendEmailInput<any>,
    provider: EmailProvider | 'dev',
    opts?: EmailCallOptions
  ): Promise<{ req: NormalizedEmailRequest; cancelled: boolean }> => {
    const parsed = sendEmailInputSchema.parse(rawInput)
    const toList = (Array.isArray(parsed.to) ? parsed.to : [parsed.to]).map(normalizeEmail)
    const tmpl = parsed.template ? getEmailTemplate(parsed.template) : undefined
    if (parsed.template && !tmpl && !parsed.providerTemplateId && !parsed.html && !parsed.text) {
      return this.#core.errors.httpError(400, `Unregistered email template: ${parsed.template}`, 'INVALID_TEMPLATE')
    }

    let vars: Record<string, unknown> = { ...(parsed.variables ?? {}) }
    if (tmpl?.variables) vars = tmpl.variables.parse(vars) as Record<string, unknown>
    const emailId = parsed.idempotencyKey
      ? idempotencyEmailDocId(parsed.idempotencyKey)
      : `em_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`
    const emailsCfg = this.#core.config.emails

    if (tmpl?.onBeforeSend) {
      const hookResult = await tmpl.onBeforeSend(vars, toList[0]!)
      if (hookResult === false) {
        return {
          cancelled: true,
          req: {
            emailId,
            to: toList,
            fromEmail: parsed.fromEmail ?? tmpl.fromEmail ?? emailsCfg.fromEmail,
            fromName: parsed.fromName ?? tmpl.fromName ?? emailsCfg.fromName,
            variables: vars,
            attachments: []
          }
        }
      }
      vars = hookResult as Record<string, unknown>
    }

    const attachments = await this.#resolveAttachments(parsed.attachments)
    const userId = opts?.userId ?? (this.#core.userId || undefined)
    return {
      cancelled: false,
      req: buildNormalizedEmailRequest(emailId, toList, parsed, tmpl, provider, vars, emailsCfg, attachments, userId)
    }
  }

  #recordEmailLog = async (
    req: NormalizedEmailRequest,
    provider: EmailProvider | 'dev',
    status: EmailLogStatus,
    externalMessageId?: string,
    errorMessage?: string
  ): Promise<SendEmailResult> => {
    const template = req.template ?? req.providerTemplateId
    await this.#core.db.create(
      'email_log',
      {
        id: req.emailId,
        ...(req.userId ? { userId: req.userId } : {}),
        provider,
        ...(externalMessageId ? { externalMessageId } : {}),
        to: req.to[0]!,
        from: req.fromName ? `${req.fromName} <${req.fromEmail}>` : req.fromEmail,
        ...(req.subject ? { subject: req.subject } : {}),
        ...(template ? { template } : {}),
        ...(req.purpose ? { purpose: req.purpose } : {}),
        status,
        ...(errorMessage ? { errorMessage } : {}),
        sentAt: new Date().toISOString()
      },
      { bypassRbac: true }
    )
    return { emailId: req.emailId, ...(externalMessageId ? { externalMessageId } : {}), status, provider }
  }

  isSuppressed = async (email: string): Promise<boolean> =>
    Boolean(await this.#core.db.read('email_suppression', suppressionDocId(email), false, { bypassRbac: true }))

  #isRecipientListSuppressed = async (recipients: string[]): Promise<boolean> =>
    this.#core.config.emails.enforceSuppressionList
      ? (await Promise.all(recipients.map((addr) => this.isSuppressed(addr)))).some(Boolean)
      : false

  getLog = async (emailId: EntryId): Promise<SelectModel<'email_log'> | undefined> =>
    this.#core.db.read('email_log', emailId, false, { bypassRbac: true })

  listLogs = async (
    options?: DbListOptions<SelectModel<'email_log'>>
  ): Promise<PaginatedList<SelectModel<'email_log'>>> =>
    this.#core.db.list('email_log', options, { bypassRbac: true })

  #checkExistingIdempotentEmail = async (idempotencyKey?: string): Promise<SendEmailResult | undefined> => {
    if (!idempotencyKey) return undefined
    const existing = await this.#core.db.read('email_log', idempotencyEmailDocId(idempotencyKey), false, { bypassRbac: true })
    if (!existing || existing.status === 'failed') return undefined
    return {
      emailId: existing.id,
      ...(existing.externalMessageId ? { externalMessageId: existing.externalMessageId } : {}),
      status: existing.status,
      provider: existing.provider,
      deduplicated: true
    }
  }

  #sendOnce = async <T = Record<string, unknown>>(input: SendEmailInput<T>, opts?: EmailCallOptions): Promise<SendEmailResult> => {
    const existing = await this.#checkExistingIdempotentEmail(input.idempotencyKey)
    if (existing) return existing

    const provider = this.#resolveProvider(opts?.provider)
    const { req, cancelled } = await this.#prepareEmailRequest(input, provider, opts)
    if (cancelled || (await this.#isRecipientListSuppressed(req.to))) {
      return this.#recordEmailLog(req, provider, 'suppressed')
    }

    try {
      const externalId =
        provider === 'sendgrid'
          ? (await this.#sendViaSendGrid(req)).externalId
          : provider === 'resend'
            ? (await this.#sendViaResend(req)).externalId
            : `${provider}_${req.emailId}`
      return this.#recordEmailLog(req, provider, 'sent', externalId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await this.#recordEmailLog(req, provider, 'failed', undefined, msg).catch(() => {})
      throw err
    }
  }

  send = async <T = Record<string, unknown>>(input: SendEmailInput<T>, opts?: EmailCallOptions): Promise<SendEmailResult> =>
    input.idempotencyKey
      ? this.#core.internals.resilience.singleflight(
          `email_send:${idempotencyEmailDocId(input.idempotencyKey)}`,
          () => this.#sendOnce(input, opts),
          { scope: 'global' }
        )
      : this.#sendOnce(input, opts)

  sendBatch = async (inputs: SendEmailInput[], opts?: EmailCallOptions): Promise<SendBatchEmailResult> => {
    const provider = this.#resolveProvider(opts?.provider)
    if (provider !== 'resend' || !inputs.length) {
      return summarizeBatchEmailResults(await Promise.all(inputs.map((inp) => this.send(inp, opts))))
    }

    const prepared = await Promise.all(inputs.map((inp) => this.#prepareEmailRequest(inp, 'resend', opts)))
    const results: SendEmailResult[] = []
    const activeReqs: { idx: number; req: NormalizedEmailRequest }[] = []

    for (let i = 0; i < prepared.length; i++) {
      const dedup = await this.#checkExistingIdempotentEmail(inputs[i]?.idempotencyKey)
      if (dedup) {
        results[i] = dedup
        continue
      }
      const { req, cancelled } = prepared[i]!
      if (cancelled || (await this.#isRecipientListSuppressed(req.to))) {
        results[i] = await this.#recordEmailLog(req, 'resend', 'suppressed')
      } else {
        activeReqs.push({ idx: i, req })
      }
    }

    if (activeReqs.length > 0) {
      const { externalIds } = await this.#sendBatchViaResend(activeReqs.map((a) => a.req))
      await Promise.all(
        activeReqs.map(async ({ idx, req }, k) => {
          results[idx] = await this.#recordEmailLog(req, 'resend', 'sent', externalIds[k])
        })
      )
    }
    return summarizeBatchEmailResults(results)
  }

  sendAuthEmail = async (
    purpose: AuthEmailPurpose,
    to: string,
    vars?: Partial<AuthEmailVariables>,
    opts?: EmailCallOptions
  ): Promise<SendEmailResult> =>
    this.#dispatchAuthEmail(
      {
        to,
        purpose,
        code: vars?.code ?? '',
        token: vars?.token ?? '',
        expiresInMinutes: vars?.expiresInMinutes ?? this.#core.config.emails.otpTtlMinutes,
        userId: vars?.userId ?? this.#core.userId
      },
      vars,
      opts
    )

  #getLastDevEmail = (to: string, purpose: AuthEmailPurpose): TransactionalEmailPayload | undefined =>
    this.#devEmailOutbox.get(`${purpose}:${normalizeEmail(to)}`)

  #runAuthFlowHooks = async (
    initialVars: AuthEmailVariables,
    purpose: AuthEmailPurpose
  ): Promise<AuthEmailVariables | false> => {
    const emailsCfg = this.#core.config.emails
    const flowCfg = emailsCfg.authFlows[purpose]
    let authVars = initialVars
    for (const hook of [emailsCfg.onAuthEmail, flowCfg?.onSend]) {
      if (!hook) continue
      const hookOut = await hook(authVars, { core: this.#core, env: this.#core.env })
      if (hookOut === false) return false
      if (hookOut && typeof hookOut === 'object') authVars = { ...authVars, ...hookOut }
    }
    return authVars
  }

  #dispatchAuthEmail = async (
    payload: TransactionalEmailPayload,
    extraVars?: Partial<AuthEmailVariables>,
    opts?: EmailCallOptions
  ): Promise<SendEmailResult> => {
    const normalizedTo = normalizeEmail(payload.to)
    const normalizedPayload: TransactionalEmailPayload = { ...payload, to: normalizedTo }
    if (this.#core.env.isDev || !process.env.K_SERVICE) {
      const outboxKey = `${payload.purpose}:${normalizedTo}`
      if (!this.#devEmailOutbox.has(outboxKey) && this.#devEmailOutbox.size >= 500) {
        this.#devEmailOutbox.delete(this.#devEmailOutbox.keys().next().value!)
      }
      this.#devEmailOutbox.set(outboxKey, normalizedPayload)
    }

    const emailsCfg = this.#core.config.emails
    const flowCfg = emailsCfg.authFlows[payload.purpose]
    const actionUrl = buildAuthActionUrl(emailsCfg.actionBaseUrl, flowCfg?.actionPath ?? '/', normalizedPayload)
    const authVars = await this.#runAuthFlowHooks(
      {
        appName: this.#core.config.appName || emailsCfg.fromName || 'App',
        userId: payload.userId,
        email: normalizedTo,
        purpose: payload.purpose,
        code: payload.code,
        token: payload.token,
        actionUrl,
        expiresInMinutes: payload.expiresInMinutes,
        ...extraVars
      },
      payload.purpose
    )
    if (authVars === false) return { emailId: `em_hook_${Date.now()}`, status: 'sent', provider: 'dev' }
    const callOpts = { ...opts, userId: payload.userId || opts?.userId }

    const registeredTmpl = getEmailTemplate(payload.purpose)
    if (registeredTmpl || flowCfg?.templateId) {
      const hasTmplSubject = Boolean(registeredTmpl?.subject || registeredTmpl?.providers?.resend?.subject)
      return this.send(
        {
          to: normalizedTo,
          ...(registeredTmpl ? { template: payload.purpose } : {}),
          ...(flowCfg?.templateId ? { providerTemplateId: flowCfg.templateId } : {}),
          ...(!hasTmplSubject && flowCfg?.subject ? { subject: flowCfg.subject } : {}),
          variables: authVars,
          purpose: payload.purpose
        },
        callOpts
      )
    }

    const provider = this.#resolveProvider(opts?.provider)
    if (provider === 'sendgrid' || provider === 'resend' || this.#core.env.isDev) {
      return this.send(
        {
          to: normalizedTo,
          ...renderDefaultAuthEmail(authVars, flowCfg?.subject),
          variables: authVars,
          purpose: payload.purpose
        },
        callOpts
      )
    }

    await this.#sendFirebaseOobEmail(normalizedPayload)
    return this.#recordEmailLog(
      {
        emailId: `em_fb_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
        to: [normalizedTo],
        fromEmail: emailsCfg.fromEmail,
        fromName: emailsCfg.fromName,
        subject: flowCfg?.subject ?? payload.purpose,
        variables: authVars,
        attachments: [],
        purpose: payload.purpose,
        userId: payload.userId
      },
      'firebase',
      'sent'
    )
  }

  #applyWebhookStatus = async (
    provider: 'sendgrid' | 'resend',
    externalId: string | undefined,
    recipient: string | undefined,
    status: EmailLogStatus,
    rawEvent: string
  ): Promise<void> => {
    const nowIso = new Date().toISOString()
    const normRecipient = recipient ? normalizeEmail(recipient) : undefined
    if ((status === 'bounced' || status === 'complained') && normRecipient) {
      const supId = suppressionDocId(normRecipient)
      const now = new Date()
      await this.#core.internals.resilience.acquireLimit('firestore')
      await this.#core.db.firestore().collection('email_suppression').doc(supId).set(
        {
          id: supId,
          email: normRecipient,
          reason: status === 'complained' ? 'spam_complaint' : 'hard_bounce',
          provider,
          rawEvent: rawEvent.slice(0, 1000),
          suppressedAt: nowIso,
          deleted: false,
          createdAt: now,
          updatedAt: now
        },
        { merge: true }
      )
    }

    const logs = externalId
      ? await this.listLogs({ where: { externalMessageId: externalId }, limit: 5 })
      : normRecipient
        ? await this.listLogs({ where: { to: normRecipient }, limit: 1 })
        : []

    const patch = {
      status,
      ...(status === 'delivered' ? { deliveredAt: nowIso } : {}),
      ...(status === 'bounced' || status === 'complained' ? { bouncedAt: nowIso } : {})
    }
    await Promise.all(logs.map((log) => this.#core.db.update('email_log', log.id, patch, { bypassRbac: true })))
  }

  #verifyAndProcessWebhook = async (
    provider: 'sendgrid' | 'resend',
    rawBody: string,
    headers: Record<string, string | undefined>
  ): Promise<{ received: true; processed: number }> => {
    const secret =
      this.#core.env.isDev && this.#core.env.EMAIL_SANDBOX_WEBHOOK_SECRET
        ? this.#core.env.EMAIL_SANDBOX_WEBHOOK_SECRET
        : this.#core.env.EMAIL_WEBHOOK_SECRET || this.#core.env.EMAIL_SANDBOX_WEBHOOK_SECRET
    try {
      const parsed = parseAndVerifyEmailWebhook(
        provider,
        rawBody,
        headers,
        secret,
        this.#core.config.emails.webhookToleranceSeconds
      )
      for (const u of parsed.updates) {
        await this.#applyWebhookStatus(provider, u.externalId, u.recipient, u.status, u.rawEvent)
      }
      return { received: true, processed: parsed.processed }
    } catch (err) {
      return this.#core.errors.httpError(
        401,
        err instanceof Error ? err.message : `Invalid ${provider} webhook signature`,
        'INVALID_WEBHOOK_SIGNATURE'
      )
    }
  }

  get internals() {
    return {
      dispatchAuthEmail: this.#dispatchAuthEmail,
      verifyAndProcessWebhook: this.#verifyAndProcessWebhook,
      getLastDevEmail: this.#getLastDevEmail
    }
  }
}
