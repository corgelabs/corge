import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, test } from 'node:test'
import { z } from 'zod'
import {
  normalizeOpenAiDecisionAnswers,
  resolveModelForProvider,
  toOpenAiDecisionQuestions
} from '../src/ai/utils'
import {
  buildMailtrapPayload,
  buildPostmarkPayload,
  buildResendPayload,
  interpolateEmailTemplate,
  parseAndVerifyEmailWebhook,
  postMailtrapBatch,
  postMailtrapEmail,
  postPostmarkBatch,
  postPostmarkEmail,
  postResendEmail
} from '../src/emails/utils'
import { Corge, corge } from '../src/index'
import {
  buildPaddleItem,
  computeUsageDelta,
  normalizePaymentWebhook,
  requestPaddleApi
} from '../src/payments/utils'

interface RecordedRequest {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

describe('3x3 Multi-Provider Contracts, Webhooks & Runtime Failover (AI · Emails · Payments)', () => {
  let mockUrl = ''
  const requests: RecordedRequest[] = []
  let failOpenAiDecisions = false
  let failOpenAiEmbed = false
  let failAnthropicMessages = false
  let resendStatus = 200
  let postmarkStatus = 200
  let stripeStatus = 200

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const url = req.url ?? '/'
      requests.push({ method: req.method ?? 'GET', url, headers: req.headers, body })

      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }

      // --- Mock Emails ---
      if (url === '/resend/emails') {
        if (resendStatus !== 200) return json(resendStatus, { message: `Resend error ${resendStatus}` })
        return json(200, { id: 're_msg_001' })
      }
      if (url === '/resend/emails/batch') {
        if (resendStatus !== 200) return json(resendStatus, { message: `Resend batch error ${resendStatus}` })
        const arr = JSON.parse(body) as unknown[]
        return json(200, { data: arr.map((_, i) => ({ id: `re_batch_${i + 1}` })) })
      }
      if (url === '/postmark/email') {
        if (postmarkStatus !== 200) return json(postmarkStatus, { Message: `Postmark error ${postmarkStatus}` })
        return json(200, { MessageID: 'pm_msg_001', ErrorCode: 0 })
      }
      if (url === '/postmark/email/batch') {
        if (postmarkStatus !== 200) return json(postmarkStatus, { Message: `Postmark batch error ${postmarkStatus}` })
        const arr = JSON.parse(body) as unknown[]
        return json(
          200,
          arr.map((_, i) => ({ MessageID: `pm_batch_${i + 1}`, ErrorCode: 0 }))
        )
      }
      if (url === '/mailtrap/api/send') {
        return json(200, { success: true, message_ids: ['mt_msg_001'] })
      }
      if (url === '/mailtrap/api/batch') {
        const parsed = JSON.parse(body) as { requests: unknown[] }
        return json(200, {
          success: true,
          responses: parsed.requests.map((_, i) => ({ success: true, message_ids: [`mt_batch_${i + 1}`] }))
        })
      }

      // --- Mock Stripe & Paddle Billing v2 ---
      if (url.startsWith('/stripe/')) {
        if (stripeStatus !== 200) return json(stripeStatus, { error: { message: `Stripe HTTP ${stripeStatus}` } })
        if (url === '/stripe/customers') return json(200, { id: 'cus_stripe_001' })
        if (url === '/stripe/checkout/sessions') {
          return json(200, { id: 'cs_stripe_001', url: 'https://checkout.stripe.test/pay/cs_stripe_001' })
        }
      }
      if (url === '/paddle/customers' && req.method === 'POST') {
        return json(201, { data: { id: 'ctm_pdl_001' } })
      }
      if (url === '/paddle/transactions' && req.method === 'POST') {
        const parsed = JSON.parse(body) as { collection_mode?: string }
        const txnId = parsed.collection_mode === 'manual' ? 'txn_inv_001' : 'txn_chk_001'
        return json(201, {
          data: {
            id: txnId,
            status: parsed.collection_mode === 'manual' ? 'billed' : 'draft',
            checkout: { url: `https://checkout.paddle.test/pay?_ptxn=${txnId}` }
          }
        })
      }
      if (url === '/paddle/transactions/txn_inv_001/invoice' && req.method === 'GET') {
        return json(200, { data: { url: 'https://checkout.paddle.test/invoices/txn_inv_001.pdf' } })
      }

      // --- Mock AI (OpenAI Decisions, OpenAI Responses/Embeddings, Anthropic Messages, Jina Embeddings) ---
      if (url === '/openai/decisions' && req.method === 'POST') {
        if (failOpenAiDecisions) return json(503, { error: { message: 'OpenAI Decisions overloaded' } })
        return json(200, {
          id: 'dec_001',
          model: 'gpt-6-luna',
          answers: [
            { name: 'isRelevant', type: 'predicate', probability: 0.92 },
            {
              name: 'route',
              type: 'choice',
              choice: 'billing',
              probabilities: [
                { value: 'billing', probability: 0.88 },
                { value: 'support', probability: 0.12 }
              ]
            },
            {
              name: 'urgency',
              type: 'score',
              score: 1.75,
              probabilities: [
                { value: '0', probability: 0.05 },
                { value: '1', probability: 0.15 },
                { value: '2', probability: 0.8 }
              ]
            }
          ],
          usage: { input_tokens: 64, output_tokens: 0, total_tokens: 64 }
        })
      }

      if (url === '/anthropic/messages' && req.method === 'POST') {
        if (failAnthropicMessages) return json(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })
        const parsed = JSON.parse(body) as { model: string; tools?: { name: string }[] }
        const structuredJson = JSON.stringify({
          isRelevant: { noul: 0.85, confidence: 0.85 },
          route: { choice: 'support', confidence: 0.9 },
          urgency: { score: 1.5, confidence: 0.82 }
        })
        if (parsed.tools?.length) {
          return json(200, {
            id: 'msg_ant_001',
            type: 'message',
            role: 'assistant',
            model: parsed.model,
            content: [
              {
                type: 'tool_use',
                id: 'toolu_01',
                name: parsed.tools[0]!.name,
                input: JSON.parse(structuredJson)
              }
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 50, output_tokens: 20 }
          })
        }
        return json(200, {
          id: 'msg_ant_002',
          type: 'message',
          role: 'assistant',
          model: parsed.model,
          content: [{ type: 'text', text: structuredJson }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 50, output_tokens: 20 }
        })
      }

      if (url === '/openai/responses' && req.method === 'POST') {
        const parsed = JSON.parse(body) as { model: string; text?: { format?: { type?: string } } }
        const outText =
          parsed.text?.format?.type === 'json_schema'
            ? JSON.stringify({ markdown: '### Page 1\nInvoice #42', annotation: { invoiceNumber: 'INV-42' } })
            : 'Hello from OpenAI fallback!'
        return json(200, {
          id: 'resp_oai_001',
          object: 'response',
          created_at: Math.floor(Date.now() / 1000),
          model: parsed.model,
          status: 'completed',
          output: [
            {
              type: 'message',
              id: 'msg_oai_001',
              status: 'completed',
              role: 'assistant',
              content: [{ type: 'output_text', text: outText, annotations: [] }]
            }
          ],
          usage: { input_tokens: 30, output_tokens: 12, total_tokens: 42 }
        })
      }

      if (url === '/openai/embeddings' && req.method === 'POST') {
        if (failOpenAiEmbed) return json(503, { error: { message: 'Embeddings unavailable' } })
        return json(200, {
          object: 'list',
          model: 'text-embedding-3-small',
          data: [{ index: 0, embedding: Array.from({ length: 768 }, (_, i) => (i === 0 ? 0.5 : 0.001)) }],
          usage: { prompt_tokens: 8, total_tokens: 8 }
        })
      }

      if (url === '/jina/embeddings' && req.method === 'POST') {
        return json(200, {
          model: 'jina-embeddings-v3',
          data: [{ index: 0, embedding: Array.from({ length: 768 }, (_, i) => (i === 1 ? 0.75 : 0.002)) }],
          usage: { prompt_tokens: 8, total_tokens: 8 }
        })
      }

      return json(404, { error: `Unhandled mock route: ${req.method} ${url}` })
    })
  })

  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as AddressInfo
    mockUrl = `http://127.0.0.1:${addr.port}`
  })

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const createInMemoryDbCorge = (envOverrides: Partial<corge.types.AppBindings>): Corge => {
    const client = new Corge({
      env: { ...corge.env, ...envOverrides, isDev: true },
      userId: 'usr_test_1',
      role: 'user'
    })
    const mem = new Map<string, Record<string, any>>()
    ;(client.db as Record<string, any>).read = async (col: string, id: string) => mem.get(`${col}:${id}`)
    ;(client.db as Record<string, any>).create = async (col: string, data: Record<string, any>) => {
      const id = data.id ?? `${col}_${Date.now()}`
      const doc = { ...data, id, deleted: false, createdAt: new Date(), updatedAt: new Date() }
      mem.set(`${col}:${id}`, doc)
      return doc
    }
    ;(client.db as Record<string, any>).update = async (col: string, id: string, patch: Record<string, any>) => {
      const prev = mem.get(`${col}:${id}`) ?? { id }
      const next = { ...prev, ...patch, updatedAt: new Date() }
      mem.set(`${col}:${id}`, next)
      return next
    }
    ;(client.db as Record<string, any>).list = async () => []
    return client
  }

  test('Emails: {{var}} / {{{var}}} interpolation, Resend/Postmark/Mailtrap webhooks & 3-provider runtime failover', async () => {
    const vars = { user: { name: 'Alice <Admin>' }, link: 'https://corge.dev/verify?a=1&b=2' }
    assert.equal(interpolateEmailTemplate('Welcome {{user.name}}', vars, false), 'Welcome Alice <Admin>')
    assert.equal(
      interpolateEmailTemplate('<p>Hi {{user.name}}, <a href="{{{link}}}">Verify</a></p>', vars, true),
      '<p>Hi Alice &lt;Admin&gt;, <a href="https://corge.dev/verify?a=1&b=2">Verify</a></p>'
    )

    const sampleReq = {
      emailId: 'em_test_001',
      to: ['bob@example.com'],
      fromEmail: 'no-reply@corge.dev',
      fromName: 'Corge',
      replyTo: 'support@corge.dev',
      subject: 'Verify Account',
      html: '<p>Code: 123456</p>',
      text: 'Code: 123456',
      category: 'verify_email',
      variables: {},
      attachments: [{ filename: 'doc.txt', contentBase64: Buffer.from('hi').toString('base64'), contentType: 'text/plain' }],
      tags: { env: 'test' }
    }

    assert.equal(buildResendPayload(sampleReq).from, 'Corge <no-reply@corge.dev>')
    assert.equal(buildPostmarkPayload(sampleReq, 'outbound').MessageStream, 'outbound')
    assert.deepEqual(buildMailtrapPayload(sampleReq).from, { email: 'no-reply@corge.dev', name: 'Corge' })

    assert.equal((await postResendEmail(`${mockUrl}/resend`, 're_key', sampleReq)).externalId, 're_msg_001')
    assert.equal((await postPostmarkEmail(`${mockUrl}/postmark`, 'pm_token', 'outbound', sampleReq)).externalId, 'pm_msg_001')
    assert.deepEqual((await postPostmarkBatch(`${mockUrl}/postmark`, 'pm_token', 'outbound', [sampleReq, sampleReq])).externalIds, [
      'pm_batch_1',
      'pm_batch_2'
    ])
    assert.equal((await postMailtrapEmail(`${mockUrl}/mailtrap/api/send`, 'mt_token', sampleReq)).externalId, 'mt_msg_001')
    assert.deepEqual(
      (await postMailtrapBatch(`${mockUrl}/mailtrap/api/batch`, 'mt_token', [sampleReq, sampleReq])).externalIds,
      ['mt_batch_1', 'mt_batch_2']
    )

    // Postmark webhook verification (Basic Auth + soft-bounce ignore vs HardBounce capture)
    const pmBody = JSON.stringify([
      { RecordType: 'Bounce', Type: 'Transient', Email: 'soft@example.com', MessageID: 'pm_soft' },
      { RecordType: 'Bounce', Type: 'HardBounce', Email: 'hard@example.com', MessageID: 'pm_hard' }
    ])
    const basicHeader = `Basic ${Buffer.from('postmark:pm_wh_sec', 'utf8').toString('base64')}`
    const pmWh = parseAndVerifyEmailWebhook('postmark', pmBody, { authorization: basicHeader }, 'pm_wh_sec', 300)
    assert.equal(pmWh.updates.length, 1)
    assert.equal(pmWh.updates[0]!.recipient, 'hard@example.com')

    // Mailtrap webhook HMAC-SHA256 verification
    const mtBody = JSON.stringify({
      events: [{ event: 'spam complaint', email: 'spam@example.com', message_id: 'mt_99' }]
    })
    const mtSig = createHmac('sha256', 'mt_wh_sec').update(mtBody, 'utf8').digest('hex')
    const mtWh = parseAndVerifyEmailWebhook('mailtrap', mtBody, { 'mailtrap-signature': mtSig }, 'mt_wh_sec', 300)
    assert.equal(mtWh.updates.length, 1)
    assert.equal(mtWh.updates[0]!.status, 'complained')

    // Full EmailsService runtime failover: Resend 503 -> Postmark 503 -> Mailtrap 200!
    corge.define.config({
      emails: {
        provider: 'resend',
        fallbackProviders: ['postmark', 'mailtrap'],
        enforceSuppressionList: false,
        resend: { baseUrl: `${mockUrl}/resend` },
        postmark: { baseUrl: `${mockUrl}/postmark`, messageStream: 'outbound' },
        mailtrap: { baseUrl: `${mockUrl}/mailtrap`, sandboxBaseUrl: `${mockUrl}/mailtrap` }
      }
    })
    corge.define.emailTemplates({
      welcome_tpl: {
        variables: z.object({ name: z.string() }),
        subject: 'Hello {{name}}',
        html: '<p>Welcome, {{name}}!</p>'
      }
    })
    const emailClient = createInMemoryDbCorge({
      RESEND_API_KEY: 're_live',
      POSTMARK_API_KEY: 'pm_live',
      MAILTRAP_API_KEY: 'mt_live'
    })

    resendStatus = 503
    postmarkStatus = 503
    const failoverSend = await emailClient.emails.send({
      to: 'alice@example.com',
      template: 'welcome_tpl',
      variables: { name: 'Alice' }
    })
    assert.equal(failoverSend.status, 'sent')
    assert.equal(failoverSend.provider, 'mailtrap')
    assert.equal(failoverSend.externalMessageId, 'mt_msg_001')

    // Batch runtime failover: Resend 503 -> Postmark 200
    postmarkStatus = 200
    const batchFailover = await emailClient.emails.sendBatch([
      { to: 'u1@example.com', subject: 'B1', text: 'One' },
      { to: 'u2@example.com', subject: 'B2', text: 'Two' }
    ])
    assert.equal(batchFailover.sent, 2)
    assert.equal(batchFailover.results[0]!.provider, 'postmark')

    // 400 validation error from primary MUST NOT fail over to secondary
    resendStatus = 400
    await assert.rejects(
      () => emailClient.emails.send({ to: 'bad@example.com', subject: 'Bad', text: 'No failover on 400' }),
      /Resend HTTP 400/
    )
    resendStatus = 200
  })

  test('Payments: Paddle inline custom checkout/invoice, Paddle-Signature HMAC, batched overages & Stripe->Paddle 503 failover', async () => {
    const planItem = buildPaddleItem(
      {
        kind: 'plan',
        id: 'pro',
        name: 'Pro Monthly',
        description: 'Pro SaaS Tier',
        amount: 2900,
        currency: 'usd',
        quantity: 1,
        interval: 'month',
        metadata: { userId: 'usr_1', planId: 'pro' }
      },
      'saas'
    ) as Record<string, any>
    assert.deepEqual(planItem.price.billing_cycle, { interval: 'month', frequency: 1 })
    assert.deepEqual(planItem.price.unit_price, { amount: '2900', currency_code: 'USD' })
    assert.equal(planItem.price.product.tax_category, 'saas')

    const pdlCust = await requestPaddleApi<{ id: string }>(`${mockUrl}/paddle`, 'pdl_key', 'POST', '/customers', {
      email: 'test@corge.dev'
    })
    assert.equal(pdlCust.id, 'ctm_pdl_001')

    // Verify Paddle-Signature HMAC + recurring renewal detection
    const ts = String(Math.floor(Date.now() / 1000))
    const pdlRaw = JSON.stringify({
      event_id: 'evt_pdl_001',
      event_type: 'transaction.completed',
      data: {
        id: 'txn_renew_001',
        origin: 'subscription_recurring',
        subscription_id: 'sub_pdl_001',
        customer_id: 'ctm_pdl_001',
        currency_code: 'USD',
        details: { totals: { total: '2900' } },
        billing_period: {
          starts_at: '2026-11-01T00:00:00.000Z',
          ends_at: '2026-12-01T00:00:00.000Z'
        },
        custom_data: { userId: 'usr_1', planId: 'pro' }
      }
    })
    const h1 = createHmac('sha256', 'pdl_wh_secret').update(`${ts}:${pdlRaw}`, 'utf8').digest('hex')
    const normWh = normalizePaymentWebhook(
      'paddle',
      pdlRaw,
      { 'paddle-signature': `ts=${ts};h1=${h1}` },
      'pdl_wh_secret',
      300
    )
    assert.equal(normWh.txType, 'subscription.renewed')
    assert.equal(normWh.resetPeriodUsage, true)
    assert.equal(normWh.amount, 2900)
    assert.equal(normWh.currency, 'usd')

    // Verify Paddle threshold-batched overage accumulation (1M unit blocks, zero lost tokens)
    const plan = {
      id: 'pro',
      name: 'Pro',
      interval: 'month' as const,
      amount: 2900,
      quota: {
        aiTokens: 1_000_000,
        overage: { enabled: true, unitTokens: 1_000_000, rateCents: 100 }
      }
    }
    const d1 = computeUsageDelta({}, {}, plan, { metric: 'ai_tokens', amount: 1_600_000 }, false, 1_000_000)
    assert.equal(d1.overageUnits, 0)
    assert.equal(d1.overageCarryTokens, 600_000)

    const d2 = computeUsageDelta(d1, {}, plan, { metric: 'ai_tokens', amount: 650_000 }, false, 1_000_000)
    assert.equal(d2.overageUnits, 1)
    assert.equal(d2.overageDelta, 1_000_000)
    assert.equal(d2.overageCarryTokens, 250_000)

    // Full PaymentsService runtime failover: Stripe 503 -> Paddle 201 checkout & manual invoice + PDF!
    corge.define.config({
      payments: {
        enabled: true,
        provider: 'stripe',
        fallbackProviders: ['paddle'],
        stripe: { baseUrl: `${mockUrl}/stripe` },
        paddle: { liveBaseUrl: `${mockUrl}/paddle`, testBaseUrl: `${mockUrl}/paddle`, taxCategory: 'saas' }
      }
    })
    const payClient = createInMemoryDbCorge({
      STRIPE_SANDBOX_API_KEY: 'sk_test_stripe',
      PADDLE_SANDBOX_API_KEY: 'pdl_test_key'
    })

    stripeStatus = 503
    const chk = await payClient.payments.createCheckout({
      custom: { name: 'Custom SaaS Seat', amount: 4900, currency: 'usd' }
    })
    assert.equal(chk.provider, 'paddle')
    assert.equal(chk.checkoutId, 'txn_chk_001')
    assert.equal(chk.url, 'https://checkout.paddle.test/pay?_ptxn=txn_chk_001')

    const inv = await payClient.payments.createInvoice({
      custom: { name: 'Enterprise Annual', amount: 250_000, currency: 'usd' },
      daysUntilDue: 30
    })
    assert.equal(inv.provider, 'paddle')
    assert.equal(inv.invoiceId, 'txn_inv_001')
    assert.equal(inv.pdfUrl, 'https://checkout.paddle.test/invoices/txn_inv_001.pdf')
    stripeStatus = 200
  })

  test('AI: tier/slug mapping, OpenAI /v1/decisions -> Anthropic failover, LanguageModelV4 529 failover & locked Jina embed failover', async () => {
    corge.define.config({
      gcpProject: '',
      payments: { enabled: false },
      ai: {
        provider: 'openai',
        fallbackProviders: ['anthropic'],
        openai: { baseUrl: `${mockUrl}/openai` },
        anthropic: { baseUrl: `${mockUrl}/anthropic` },
        jina: { baseUrl: `${mockUrl}/jina` }
      }
    })

    assert.equal(corge.config.ai.vertex.extractionModel, 'gemini-3.5-flash-lite')
    assert.equal(resolveModelForProvider('vertex', 'default', corge.config.ai), 'claude-haiku-5-5')
    assert.equal(resolveModelForProvider('vertex', 'expert', corge.config.ai), 'claude-sonnet-5-5')
    assert.equal(resolveModelForProvider('vertex', 'gemini-3.5-flash-lite', corge.config.ai), 'gemini-3.5-flash-lite')
    assert.equal(resolveModelForProvider('openai', 'gemini-3.5-flash-lite', corge.config.ai), 'gpt-6-luna')
    assert.equal(resolveModelForProvider('anthropic', 'gemini-3.5-flash-lite', corge.config.ai), 'claude-haiku-5-5')
    assert.equal(resolveModelForProvider('openai', 'claude-sonnet-5-5', corge.config.ai), 'gpt-6.2-sol')
    assert.equal(resolveModelForProvider('openai', 'claude-haiku-5-5', corge.config.ai), 'gpt-6-luna')
    assert.equal(resolveModelForProvider('anthropic', 'gpt-6.2-sol', corge.config.ai), 'claude-sonnet-5-5')

    const questions = {
      isRelevant: { type: 'noul' as const, instructions: 'Is billing relevant?' },
      route: { type: 'choice' as const, instructions: 'Pick dept', criteria: { billing: 'Invoices', support: 'Bugs' } },
      urgency: { type: 'score' as const, instructions: 'Urgency', criteria: ['Low', 'Med', 'High'] }
    }
    const { wireQuestions } = toOpenAiDecisionQuestions(questions)
    assert.equal(wireQuestions.length, 3)
    assert.equal(wireQuestions[0]!.type, 'predicate')

    const client = new Corge({
      env: {
        ...corge.env,
        OPENAI_API_KEY: 'sk-test-openai',
        ANTHROPIC_API_KEY: 'sk-ant-test',
        JINA_API_KEY: 'jina-test-key',
        isDev: true
      },
      userId: 'admin',
      role: 'admin'
    })

    // OpenAI /v1/decisions primary success (gpt-6-luna)
    failOpenAiDecisions = false
    const dec1 = await client.ai.decide({ ticket: 'Refund my invoice' }, questions)
    assert.equal(dec1.model, 'gpt-6-luna')
    assert.equal(dec1.answers.isRelevant?.type, 'noul')
    assert.equal(dec1.answers.isRelevant.noul, 0.92)
    assert.equal(dec1.answers.route?.type, 'choice')
    assert.equal(dec1.answers.route.choice, 'billing')

    // OpenAI /v1/decisions 503 -> automatic failover to Anthropic claude-haiku-5-5 structured output
    failOpenAiDecisions = true
    failAnthropicMessages = false
    const dec2 = await client.ai.decide({ ticket: 'App crashed' }, questions)
    assert.equal(dec2.model, 'claude-haiku-5-5')
    assert.equal(dec2.answers.route?.type, 'choice')
    assert.equal(dec2.answers.route.choice, 'support')

    // Single-pass multimodal PDF vision() with schema on OpenAI (gpt-6-luna)
    const samplePdfDataUrl = `data:application/pdf;base64,${Buffer.from('%PDF-1.4 mock').toString('base64')}`
    const vis = await client.ai.vision(samplePdfDataUrl, {
      provider: 'openai',
      schema: z.toJSONSchema(z.object({ invoiceNumber: z.string() })) as Record<string, unknown>
    })
    assert.equal(vis.markdown, '### Page 1\nInvoice #42')
    assert.deepEqual(vis.annotation, { invoiceNumber: 'INV-42' })

    // LanguageModelV4 proxy failover: Anthropic 529 Overloaded -> OpenAI gpt-6-luna 200
    corge.define.config({
      ai: {
        provider: 'anthropic',
        fallbackProviders: ['openai']
      }
    })
    failAnthropicMessages = true
    const genRes = await client.ai.generate('Say hello')
    assert.equal(genRes.text, 'Hello from OpenAI fallback!')

    // Provider-chain-locked embed(): OpenAI primary 503 -> Anthropic fallback at index 1 maps to Jina 768d!
    corge.define.config({
      ai: {
        provider: 'openai',
        fallbackProviders: ['anthropic']
      }
    })
    failOpenAiEmbed = false
    const vecOpenAi = await client.ai.embed('Semantic vector recall test document content')
    assert.equal(vecOpenAi?.length, 768)
    assert.equal(vecOpenAi?.[0], 0.5)

    failOpenAiEmbed = true
    const vecJinaFallback = await client.ai.embed('Semantic vector recall test document content')
    assert.equal(vecJinaFallback?.length, 768)
    assert.equal(vecJinaFallback?.[1], 0.75)

    assert.ok(typeof normalizeOpenAiDecisionAnswers === 'function')
  })
})
