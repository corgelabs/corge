import type { DbListOptions, EntryId, SelectModel } from '../db'
import type { Corge } from '../index'
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
  isEmailFailoverEligible,
  normalizeEmail,
  parseAndVerifyEmailWebhook,
  postMailtrapBatch,
  postMailtrapEmail,
  postPostmarkBatch,
  postPostmarkEmail,
  postResendBatch,
  postResendEmail,
  renderDefaultAuthEmail,
  summarizeBatchEmailResults,
  suppressionDocId
} from './utils'

export class EmailsService {
  readonly #corge: Corge
  readonly #devEmailOutbox = new Map<string, TransactionalEmailPayload>()

  constructor(corgeClient: Corge) {
    this.#corge = corgeClient
  }

  #getProviderApiKey = (provider: EmailProvider): string => {
    const env = this.#corge.env
    const isDev = Boolean(env.isDev)
    if (provider === 'resend') return env.RESEND_API_KEY?.trim() ?? ''
    if (provider === 'postmark') {
      return (isDev && env.POSTMARK_SANDBOX_API_KEY?.trim() ? env.POSTMARK_SANDBOX_API_KEY : env.POSTMARK_API_KEY)?.trim() ?? ''
    }
    return (isDev && env.MAILTRAP_SANDBOX_API_KEY?.trim() ? env.MAILTRAP_SANDBOX_API_KEY : env.MAILTRAP_API_KEY)?.trim() ?? ''
  }

  #getMailtrapUrls = (): { sendUrl: string; batchUrl: string } => {
    const env = this.#corge.env
    const mtCfg = this.#corge.config.emails.mailtrap
    const useSandbox = Boolean(env.isDev && env.MAILTRAP_SANDBOX_API_KEY?.trim() && mtCfg.sandboxInboxId)
    if (useSandbox) {
      const sbBase = mtCfg.sandboxBaseUrl.replace(/\/+$/, '')
      return {
        sendUrl: `${sbBase}/api/send/${mtCfg.sandboxInboxId}`,
        batchUrl: `${sbBase}/api/batch/${mtCfg.sandboxInboxId}`
      }
    }
    const base = mtCfg.baseUrl.replace(/\/+$/, '')
    return { sendUrl: `${base}/api/send`, batchUrl: `${base}/api/batch` }
  }

  #resolveProviderChain = (override?: EmailProvider): (EmailProvider | 'dev')[] => {
    if (override) {
      if (this.#getProviderApiKey(override)) return [override]
      if (this.#corge.env.isDev) return ['dev']
      return this.#corge.errors.httpError(
        500,
        `Missing API key for configured email provider "${override}"`,
        'CONFIG_ERROR'
      )
    }

    const emailsCfg = this.#corge.config.emails
    const ordered = [...new Set<EmailProvider>([emailsCfg.provider, ...(emailsCfg.fallbackProviders ?? []).slice(0, 2)])]
    const ready = ordered.filter((p) => Boolean(this.#getProviderApiKey(p)))
    if (ready.length > 0) return ready
    if (this.#corge.env.isDev) return ['dev']
    return this.#corge.errors.httpError(
      500,
      `Missing API key for configured email provider "${emailsCfg.provider}"`,
      'CONFIG_ERROR'
    )
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
            const { bytes, type } = await this.#corge.files.get(att.fileRef!)
            return {
              filename: att.filename,
              contentBase64: Buffer.from(bytes).toString('base64'),
              contentType: att.contentType ?? type
            }
          })
        )
      : []

  #withEmailBreaker = async <T>(provider: EmailProvider, cost: number, fn: () => Promise<T>): Promise<T> => {
    await this.#corge.internals.resilience.acquireLimit('emails', cost)
    return this.#corge.internals.resilience.circuitBreaker(`emails-${provider}`, fn, undefined, {
      isDev: this.#corge.env.isDev
    })
  }

  #dispatchSingleToProvider = (provider: EmailProvider | 'dev', req: NormalizedEmailRequest): Promise<{ externalId: string }> => {
    if (provider === 'dev') return Promise.resolve({ externalId: `dev_${req.emailId}` })
    const apiKey = this.#getProviderApiKey(provider)
    const emailsCfg = this.#corge.config.emails
    if (provider === 'resend') {
      return this.#withEmailBreaker('resend', 1, () => postResendEmail(emailsCfg.resend.baseUrl, apiKey, req))
    }
    if (provider === 'postmark') {
      return this.#withEmailBreaker('postmark', 1, () =>
        postPostmarkEmail(emailsCfg.postmark.baseUrl, apiKey, emailsCfg.postmark.messageStream, req)
      )
    }
    const { sendUrl } = this.#getMailtrapUrls()
    return this.#withEmailBreaker('mailtrap', 1, () => postMailtrapEmail(sendUrl, apiKey, req))
  }

  #dispatchBatchToProvider = (
    provider: EmailProvider | 'dev',
    reqs: NormalizedEmailRequest[]
  ): Promise<{ externalIds: string[] }> => {
    if (provider === 'dev') {
      return Promise.resolve({ externalIds: reqs.map((r) => `dev_${r.emailId}`) })
    }
    const apiKey = this.#getProviderApiKey(provider)
    const emailsCfg = this.#corge.config.emails
    if (provider === 'resend') {
      return this.#withEmailBreaker('resend', reqs.length, () => postResendBatch(emailsCfg.resend.baseUrl, apiKey, reqs))
    }
    if (provider === 'postmark') {
      return this.#withEmailBreaker('postmark', reqs.length, () =>
        postPostmarkBatch(emailsCfg.postmark.baseUrl, apiKey, emailsCfg.postmark.messageStream, reqs)
      )
    }
    const { batchUrl } = this.#getMailtrapUrls()
    return this.#withEmailBreaker('mailtrap', reqs.length, () => postMailtrapBatch(batchUrl, apiKey, reqs))
  }

  #prepareEmailRequest = async (
    rawInput: SendEmailInput<any>,
    opts?: EmailCallOptions
  ): Promise<{ req: NormalizedEmailRequest; cancelled: boolean }> => {
    const parsed = sendEmailInputSchema.parse(rawInput)
    const toList = (Array.isArray(parsed.to) ? parsed.to : [parsed.to]).map(normalizeEmail)
    const tmpl = parsed.template ? getEmailTemplate(parsed.template) : undefined
    if (parsed.template && !tmpl && !parsed.html && !parsed.text) {
      return this.#corge.errors.httpError(400, `Unregistered email template: ${parsed.template}`, 'INVALID_TEMPLATE')
    }

    let vars: Record<string, unknown> = { ...(parsed.variables ?? {}) }
    if (tmpl?.variables) vars = tmpl.variables.parse(vars) as Record<string, unknown>
    const emailId = parsed.idempotencyKey
      ? idempotencyEmailDocId(parsed.idempotencyKey)
      : `em_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`
    const emailsCfg = this.#corge.config.emails

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
    const userId = opts?.userId ?? (this.#corge.userId || undefined)
    return {
      cancelled: false,
      req: buildNormalizedEmailRequest(emailId, toList, parsed, tmpl, vars, emailsCfg, attachments, userId)
    }
  }

  #recordEmailLog = async (
    req: NormalizedEmailRequest,
    provider: EmailProvider | 'dev',
    status: EmailLogStatus,
    externalMessageId?: string,
    errorMessage?: string
  ): Promise<SendEmailResult> => {
    await this.#corge.db.create(
      'email_log',
      {
        id: req.emailId,
        ...(req.userId ? { userId: req.userId } : {}),
        provider,
        ...(externalMessageId ? { externalMessageId } : {}),
        to: req.to[0]!,
        from: req.fromName ? `${req.fromName} <${req.fromEmail}>` : req.fromEmail,
        ...(req.subject ? { subject: req.subject } : {}),
        ...(req.template ? { template: req.template } : {}),
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
    Boolean(await this.#corge.db.read('email_suppression', suppressionDocId(email), false, { bypassRbac: true }))

  #isRecipientListSuppressed = async (recipients: string[]): Promise<boolean> =>
    this.#corge.config.emails.enforceSuppressionList
      ? (await Promise.all(recipients.map((addr) => this.isSuppressed(addr)))).some(Boolean)
      : false

  getLog = async (emailId: EntryId): Promise<SelectModel<'email_log'> | undefined> =>
    this.#corge.db.read('email_log', emailId, false, { bypassRbac: true })

  listLogs = async (
    options?: DbListOptions<SelectModel<'email_log'>>
  ): Promise<SelectModel<'email_log'>[]> =>
    this.#corge.db.list('email_log', options, { bypassRbac: true })

  #checkExistingIdempotentEmail = async (idempotencyKey?: string): Promise<SendEmailResult | undefined> => {
    if (!idempotencyKey) return undefined
    const existing = await this.#corge.db.read('email_log', idempotencyEmailDocId(idempotencyKey), false, { bypassRbac: true })
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

    const chain = this.#resolveProviderChain(opts?.provider)
    const { req, cancelled } = await this.#prepareEmailRequest(input, opts)
    if (cancelled || (await this.#isRecipientListSuppressed(req.to))) {
      return this.#recordEmailLog(req, chain[0]!, 'suppressed')
    }

    let lastErr: unknown
    let lastProvider: EmailProvider | 'dev' = chain[0]!
    for (let i = 0; i < chain.length; i++) {
      const provider = chain[i]!
      lastProvider = provider
      try {
        const { externalId } = await this.#dispatchSingleToProvider(provider, req)
        return await this.#recordEmailLog(req, provider, 'sent', externalId)
      } catch (err) {
        lastErr = err
        if (i === chain.length - 1 || !isEmailFailoverEligible(err)) break
      }
    }

    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr)
    await this.#recordEmailLog(req, lastProvider, 'failed', undefined, msg).catch(() => {})
    throw lastErr
  }

  send = async <T = Record<string, unknown>>(input: SendEmailInput<T>, opts?: EmailCallOptions): Promise<SendEmailResult> =>
    input.idempotencyKey
      ? this.#corge.internals.resilience.singleflight(
          `email_send:${idempotencyEmailDocId(input.idempotencyKey)}`,
          () => this.#sendOnce(input, opts),
          { scope: 'global' }
        )
      : this.#sendOnce(input, opts)

  sendBatch = async (inputs: SendEmailInput[], opts?: EmailCallOptions): Promise<SendBatchEmailResult> => {
    if (!inputs.length) return summarizeBatchEmailResults([])
    const chain = this.#resolveProviderChain(opts?.provider)
    const prepared = await Promise.all(inputs.map((inp) => this.#prepareEmailRequest(inp, opts)))
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
        results[i] = await this.#recordEmailLog(req, chain[0]!, 'suppressed')
      } else {
        activeReqs.push({ idx: i, req })
      }
    }

    if (activeReqs.length > 0) {
      let sentProvider: EmailProvider | 'dev' = chain[0]!
      let externalIds: string[] | undefined
      let lastErr: unknown

      for (let i = 0; i < chain.length; i++) {
        const provider = chain[i]!
        sentProvider = provider
        try {
          const out = await this.#dispatchBatchToProvider(
            provider,
            activeReqs.map((a) => a.req)
          )
          externalIds = out.externalIds
          break
        } catch (err) {
          lastErr = err
          if (i === chain.length - 1 || !isEmailFailoverEligible(err)) {
            await Promise.all(
              activeReqs.map(({ req }) =>
                this.#recordEmailLog(req, provider, 'failed', undefined, err instanceof Error ? err.message : String(err)).catch(
                  () => {}
                )
              )
            )
            throw lastErr
          }
        }
      }

      if (externalIds) {
        await Promise.all(
          activeReqs.map(async ({ idx, req }, k) => {
            results[idx] = await this.#recordEmailLog(req, sentProvider, 'sent', externalIds[k])
          })
        )
      }
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
        expiresInMinutes: vars?.expiresInMinutes ?? this.#corge.config.emails.otpTtlMinutes,
        userId: vars?.userId ?? this.#corge.userId
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
    const emailsCfg = this.#corge.config.emails
    const flowCfg = emailsCfg.authFlows[purpose]
    let authVars = initialVars
    for (const hook of [emailsCfg.onAuthEmail, flowCfg?.onSend]) {
      if (!hook) continue
      const hookOut = await hook(authVars, { corge: this.#corge, env: this.#corge.env })
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
    if (this.#corge.env.isDev || !process.env.K_SERVICE) {
      const outboxKey = `${payload.purpose}:${normalizedTo}`
      if (!this.#devEmailOutbox.has(outboxKey) && this.#devEmailOutbox.size >= 500) {
        this.#devEmailOutbox.delete(this.#devEmailOutbox.keys().next().value!)
      }
      this.#devEmailOutbox.set(outboxKey, normalizedPayload)
    }

    const emailsCfg = this.#corge.config.emails
    const flowCfg = emailsCfg.authFlows[payload.purpose]
    const actionUrl = buildAuthActionUrl(emailsCfg.actionBaseUrl, flowCfg?.actionPath ?? '/', normalizedPayload)
    const authVars = await this.#runAuthFlowHooks(
      {
        appName: this.#corge.config.appName || emailsCfg.fromName || 'App',
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
    if (registeredTmpl) {
      return this.send(
        {
          to: normalizedTo,
          template: payload.purpose,
          ...(!registeredTmpl.subject && flowCfg?.subject ? { subject: flowCfg.subject } : {}),
          variables: authVars,
          purpose: payload.purpose
        },
        callOpts
      )
    }

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

  #applyWebhookStatus = async (
    provider: EmailProvider,
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
      await this.#corge.internals.resilience.acquireLimit('firestore')
      await this.#corge.db.firestore().collection('email_suppression').doc(supId).set(
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
    await Promise.all(logs.map((log) => this.#corge.db.update('email_log', log.id, patch, { bypassRbac: true })))
  }

  #getWebhookSecret = (provider: EmailProvider): string => {
    const env = this.#corge.env
    if (provider === 'resend') return env.RESEND_WEBHOOK_SECRET?.trim() ?? ''
    if (provider === 'postmark') return env.POSTMARK_WEBHOOK_SECRET?.trim() ?? ''
    return env.MAILTRAP_WEBHOOK_SECRET?.trim() ?? ''
  }

  #verifyAndProcessWebhook = async (
    provider: EmailProvider,
    rawBody: string,
    headers: Record<string, string | undefined>
  ): Promise<{ received: true; processed: number }> => {
    const secret = this.#getWebhookSecret(provider)
    try {
      const parsed = parseAndVerifyEmailWebhook(
        provider,
        rawBody,
        headers,
        secret,
        this.#corge.config.emails.webhookToleranceSeconds
      )
      for (const u of parsed.updates) {
        await this.#applyWebhookStatus(provider, u.externalId, u.recipient, u.status, u.rawEvent)
      }
      return { received: true, processed: parsed.processed }
    } catch (err) {
      return this.#corge.errors.httpError(
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
