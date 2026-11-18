import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleVertex } from '@ai-sdk/google-vertex'
import { createVertexAnthropic } from '@ai-sdk/google-vertex/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModelV4 } from '@ai-sdk/provider'
import { embed, generateText, jsonSchema, Output, type ModelMessage } from 'ai'
import type { Corge } from '../index'
import {
  DEFAULT_EXTRACTION_PROMPT,
  envelopeSchema,
  type AiGenerateOptions,
  type AiGenerateResult,
  type AiProvider,
  type AiUsageSummary,
  type DecideResult,
  type DecisionQuestion,
  type DocAiProcessResponse,
  type GeminiDecisionsWireResponse,
  type JinaEmbeddingsWireResponse,
  type OpenAiDecisionsWireResponse,
  type VisionOptions,
  type VisionResult
} from './schema'
import {
  buildStructuredDecideSpec,
  formatDocAiPages,
  isAiFailoverEligible,
  normalizeGeminiDecisionAnswers,
  normalizeOpenAiDecisionAnswers,
  normalizeUsage,
  parseStructuredDecideOutput,
  resolveModelForProvider,
  toGeminiDecisionQuestions,
  toOpenAiDecisionQuestions
} from './utils'

let cachedVertexKey = ''
let cachedVertexAnthropic: ReturnType<typeof createVertexAnthropic> | undefined
let cachedVertexGoogle: ReturnType<typeof createGoogleVertex> | undefined
let cachedVertexEmbedding: ReturnType<typeof createGoogleVertex> | undefined

let cachedAnthropicKey = ''
let cachedAnthropic: ReturnType<typeof createAnthropic> | undefined

let cachedOpenAiKey = ''
let cachedOpenAi: ReturnType<typeof createOpenAI> | undefined

let cachedDocAiKey = ''
let cachedDocAiProcessorUrl = ''
let geminiDecisionsUnavailableUntil = 0

const withSignalTimeout = (ms: number, signal?: AbortSignal): AbortSignal => {
  const timeout = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

const httpStatusError = (message: string, status: number): Error => Object.assign(new Error(message), { status })

export class AiService {
  readonly #corge: Corge

  constructor(corgeClient: Corge) {
    this.#corge = corgeClient
  }

  #vertexProviders = () => {
    const project = this.#corge.config.gcpProject
    const location = this.#corge.config.ai.vertex.location
    const key = `${project}:${location}`
    if (!cachedVertexAnthropic || !cachedVertexGoogle || !cachedVertexEmbedding || cachedVertexKey !== key) {
      cachedVertexKey = key
      cachedVertexAnthropic = createVertexAnthropic({ project, location })
      cachedVertexGoogle = createGoogleVertex({ project, location })
      cachedVertexEmbedding = createGoogleVertex({
        project,
        location: location === 'global' ? 'us-central1' : location
      })
    }
    return {
      vertexAnthropic: cachedVertexAnthropic,
      vertexGoogle: cachedVertexGoogle,
      vertexEmbeddingProvider: cachedVertexEmbedding
    }
  }

  #anthropicProvider = () => {
    const apiKey = this.#corge.env.ANTHROPIC_API_KEY?.trim() ?? ''
    const baseURL = this.#corge.config.ai.anthropic.baseUrl.replace(/\/+$/, '')
    const key = `${baseURL}:${apiKey}`
    if (!cachedAnthropic || cachedAnthropicKey !== key) {
      cachedAnthropicKey = key
      cachedAnthropic = createAnthropic({ apiKey, baseURL })
    }
    return cachedAnthropic
  }

  #openAiProvider = () => {
    const apiKey = this.#corge.env.OPENAI_API_KEY?.trim() ?? ''
    const baseURL = this.#corge.config.ai.openai.baseUrl.replace(/\/+$/, '')
    const key = `${baseURL}:${apiKey}`
    if (!cachedOpenAi || cachedOpenAiKey !== key) {
      cachedOpenAiKey = key
      cachedOpenAi = createOpenAI({ apiKey, baseURL })
    }
    return cachedOpenAi
  }

  #hasProviderCreds = (provider: AiProvider): boolean => {
    if (provider === 'vertex') return Boolean(this.#corge.config.gcpProject)
    if (provider === 'anthropic') return Boolean(this.#corge.env.ANTHROPIC_API_KEY?.trim())
    return Boolean(this.#corge.env.OPENAI_API_KEY?.trim())
  }

  #resolveAiProviderChain = (override?: AiProvider): AiProvider[] => {
    if (override) return [override]
    const aiCfg = this.#corge.config.ai
    const ordered = [...new Set<AiProvider>([aiCfg.provider, ...(aiCfg.fallbackProviders ?? []).slice(0, 2)])]
    const ready = ordered.filter((p) => this.#hasProviderCreds(p))
    return ready.length > 0 ? ready : [aiCfg.provider]
  }

  #runWithAiFailover = async <T>(override: AiProvider | undefined, fn: (provider: AiProvider) => Promise<T>): Promise<T> => {
    const chain = this.#resolveAiProviderChain(override)
    let lastErr: unknown
    for (let i = 0; i < chain.length; i++) {
      const provider = chain[i]!
      try {
        return await fn(provider)
      } catch (err) {
        lastErr = err
        if (i === chain.length - 1 || !isAiFailoverEligible(err)) throw err
      }
    }
    throw lastErr
  }

  #rawLanguageModel = (provider: AiProvider, modelOrTier?: string): LanguageModelV4 => {
    const resolvedId = resolveModelForProvider(provider, modelOrTier, this.#corge.config.ai)
    if (provider === 'vertex') {
      const { vertexGoogle, vertexAnthropic } = this.#vertexProviders()
      return (resolvedId.startsWith('gemini-') ? vertexGoogle(resolvedId) : vertexAnthropic(resolvedId)) as LanguageModelV4
    }
    if (provider === 'anthropic') {
      return this.#anthropicProvider()(resolvedId)
    }
    return this.#openAiProvider()(resolvedId)
  }

  languageModel = (modelOrTier?: string, providerOverride?: AiProvider): LanguageModelV4 => {
    const chain = this.#resolveAiProviderChain(providerOverride)
    const primary = chain[0]!
    const primaryModelId = resolveModelForProvider(primary, modelOrTier, this.#corge.config.ai)

    const proxy: LanguageModelV4 = {
      specificationVersion: 'v4',
      provider: `corge.${primary}`,
      modelId: primaryModelId,
      supportedUrls: {},
      doGenerate: (options) =>
        this.#runWithAiFailover(providerOverride, (prov) =>
          this.#corge.internals.resilience.circuitBreaker(
            `ai-${prov}`,
            () => Promise.resolve(this.#rawLanguageModel(prov, modelOrTier).doGenerate(options)),
            undefined,
            { isDev: this.#corge.env.isDev }
          )
        ),
      doStream: (options) =>
        this.#runWithAiFailover(providerOverride, (prov) =>
          this.#corge.internals.resilience.circuitBreaker(
            `ai-${prov}`,
            () => Promise.resolve(this.#rawLanguageModel(prov, modelOrTier).doStream(options)),
            undefined,
            { isDev: this.#corge.env.isDev }
          )
        )
    }
    return proxy
  }

  #resolveDocAiProcessorUrl = async (): Promise<string> => {
    const project = this.#corge.config.gcpProject
    const vCfg = this.#corge.config.ai.vertex
    const loc = vCfg.docAiLocation || 'eu'
    const displayName = vCfg.docAiProcessorDisplayName || 'corge-ocr'
    const explicitId = vCfg.docAiProcessorId
    const baseHost = `https://${loc}-documentai.googleapis.com/v1`

    if (explicitId) return `${baseHost}/projects/${project}/locations/${loc}/processors/${explicitId}`
    const cacheKey = `${project}:${loc}:${displayName}`
    if (cachedDocAiProcessorUrl && cachedDocAiKey === cacheKey) return cachedDocAiProcessorUrl

    return this.#corge.internals.resilience.singleflight(
      `docai:processor:${cacheKey}`,
      async () => {
        if (cachedDocAiProcessorUrl && cachedDocAiKey === cacheKey) return cachedDocAiProcessorUrl
        const token = await this.#corge.internals.registry.getGcpAccessToken()
        const headers = {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'x-goog-user-project': project
        }
        const parentUrl = `${baseHost}/projects/${project}/locations/${loc}/processors`
        const listRes = await fetch(`${parentUrl}?pageSize=100`, {
          headers,
          signal: AbortSignal.timeout(10_000)
        })
        if (!listRes.ok) {
          throw httpStatusError(`Document AI list processors HTTP ${listRes.status}: ${await listRes.text()}`, listRes.status)
        }
        const listData = (await listRes.json()) as {
          processors?: { name?: string; displayName?: string; type?: string; state?: string }[]
        }
        const existing = (listData.processors ?? []).find(
          (p) => p.type === 'OCR_PROCESSOR' && p.displayName === displayName && p.state === 'ENABLED' && p.name
        )
        if (existing?.name) {
          cachedDocAiKey = cacheKey
          return (cachedDocAiProcessorUrl = `${baseHost}/${existing.name}`)
        }

        const createRes = await fetch(parentUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({ displayName, type: 'OCR_PROCESSOR' }),
          signal: AbortSignal.timeout(15_000)
        })
        if (!createRes.ok) {
          throw httpStatusError(`Document AI create processor HTTP ${createRes.status}: ${await createRes.text()}`, createRes.status)
        }
        const created = (await createRes.json()) as { name?: string }
        if (!created.name) throw new Error('Document AI create processor returned empty name')
        cachedDocAiKey = cacheKey
        return (cachedDocAiProcessorUrl = `${baseHost}/${created.name}`)
      },
      { scope: 'global' }
    )
  }

  #extractAnnotationFromMarkdown = async (
    provider: AiProvider,
    markdown: string,
    rawSchema: Record<string, unknown>,
    prompt?: string,
    signal?: AbortSignal
  ): Promise<{ annotation: Record<string, unknown>; usage: AiUsageSummary }> => {
    await this.#corge.internals.resilience.acquireLimit('ai')
    const modelId = resolveModelForProvider(provider, 'fast', this.#corge.config.ai)
    const { $schema: _$schema, ...cleanSchema } = rawSchema
    const res = await generateText({
      model: this.languageModel('fast', provider),
      system: prompt ?? DEFAULT_EXTRACTION_PROMPT,
      prompt: markdown.slice(0, 120_000),
      output: Output.object({ schema: jsonSchema(cleanSchema) }),
      abortSignal: withSignalTimeout(25_000, signal)
    })
    const usage = normalizeUsage(modelId, res.usage)
    await this.#corge.internals.payments.trackAiUsage({
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      source: 'vision'
    })
    return { annotation: (res.output as Record<string, unknown>) ?? {}, usage }
  }

  #multimodalVisionPass = async (
    provider: AiProvider,
    mimeType: string,
    base64: string,
    opts?: VisionOptions
  ): Promise<VisionResult> => {
    await this.#corge.internals.resilience.acquireLimit('ai')
    const aiCfg = this.#corge.config.ai
    const modelId =
      provider === 'anthropic'
        ? aiCfg.anthropic.ocrModel
        : provider === 'openai'
          ? aiCfg.openai.ocrModel
          : aiCfg.vertex.fastModel

    if (opts?.schema) {
      const { $schema: _$schema, ...cleanSchema } = opts.schema
      const combinedSchema = {
        type: 'object',
        properties: {
          markdown: {
            type: 'string',
            description: 'Complete markdown transcription of the document preserving headings, tables, and page breaks (### Page N).'
          },
          annotation: cleanSchema
        },
        required: ['markdown', 'annotation'],
        additionalProperties: false
      }
      const res = await generateText({
        model: this.languageModel(modelId, provider),
        system: opts.prompt ?? DEFAULT_EXTRACTION_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'file', data: base64, mediaType: mimeType },
              {
                type: 'text',
                text: 'Transcribe the full document into markdown and extract the structured annotation fields matching the schema.'
              }
            ]
          }
        ],
        output: Output.object({ schema: jsonSchema(combinedSchema) }),
        abortSignal: withSignalTimeout(35_000, opts.signal)
      })
      const out = (res.output ?? {}) as { markdown?: string; annotation?: Record<string, unknown> }
      const usage = normalizeUsage(modelId, res.usage)
      await this.#corge.internals.payments.trackAiUsage({
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        source: 'vision'
      })
      return {
        markdown: (out.markdown ?? '').trim(),
        annotation: out.annotation ?? {},
        usage
      }
    }

    const res = await generateText({
      model: this.languageModel(modelId, provider),
      abortSignal: withSignalTimeout(30_000, opts?.signal),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'file', data: base64, mediaType: mimeType },
            {
              type: 'text',
              text: 'Transcribe and describe what is shown in this document/image accurately in markdown, preserving page structure (### Page N) if multi-page.'
            }
          ]
        }
      ]
    })
    const trimmed = res.text.trim()
    if (!trimmed) throw new Error('vision model returned empty description')
    const usage = normalizeUsage(modelId, res.usage)
    await this.#corge.internals.payments.trackAiUsage({
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      source: 'vision'
    })
    return { markdown: trimmed, annotation: {}, usage }
  }

  describeImage = async (documentUrl: string, signal?: AbortSignal): Promise<string> => {
    await this.#corge.internals.resilience.acquireLimit('ai')
    const match = /^data:([^;,]+);base64,(.+)$/.exec(documentUrl)
    const mediaType = match?.[1] ?? 'image/jpeg'
    const base64 = match?.[2] ?? documentUrl
    const { text } = await generateText({
      model: this.languageModel('fast'),
      abortSignal: withSignalTimeout(25_000, signal),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'file', data: base64, mediaType },
            { type: 'text', text: 'Describe or transcribe what is shown in this document/image concisely in markdown.' }
          ]
        }
      ]
    })
    const trimmed = text.trim()
    if (!trimmed) throw new Error('vision model returned empty description')
    return trimmed
  }

  #vertexDocAiVision = async (mimeType: string, base64: string, documentUrl: string, opts?: VisionOptions): Promise<VisionResult> => {
    const hasSchema = Boolean(opts?.schema)
    const allowFallback = opts?.fallbackVision !== false

    return this.#corge.internals.resilience.circuitBreaker(
      'docai',
      async () => {
        await this.#corge.internals.resilience.acquireLimit('docai')
        const [processorUrl, token] = await Promise.all([
          this.#resolveDocAiProcessorUrl(),
          this.#corge.internals.registry.getGcpAccessToken()
        ])
        const res = await fetch(`${processorUrl}:process`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'x-goog-user-project': this.#corge.config.gcpProject
          },
          body: JSON.stringify({
            skipHumanReview: true,
            imagelessMode: true,
            rawDocument: { mimeType, content: base64 },
            ...(mimeType === 'application/pdf' ? { processOptions: { fromStart: 30 } } : {})
          }),
          signal: withSignalTimeout(25_000, opts?.signal)
        })
        if (!res.ok) {
          throw httpStatusError(`Document AI OCR HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`, res.status)
        }
        const docRes = (await res.json()) as DocAiProcessResponse
        const pagesProcessed = docRes.document?.pages?.length || 1
        if (pagesProcessed > 1) {
          await this.#corge.internals.resilience.chargeLimit('docai', pagesProcessed - 1)
        }

        let markdown = formatDocAiPages(docRes)
        if (!markdown && (opts?.fallbackVision ?? !hasSchema)) {
          markdown = await this.describeImage(documentUrl, opts?.signal)
        }

        let annotation: Record<string, unknown> = {}
        const ocrUsage = normalizeUsage('documentai-ocr', null, pagesProcessed)
        await this.#corge.internals.payments.trackAiUsage({
          model: ocrUsage.model,
          inputTokens: ocrUsage.inputTokens,
          outputTokens: ocrUsage.outputTokens,
          totalTokens: ocrUsage.totalTokens,
          source: 'vision'
        })

        if (opts?.schema && markdown) {
          const ext = await this.#extractAnnotationFromMarkdown('vertex', markdown, opts.schema, opts.prompt, opts?.signal)
          annotation = ext.annotation
        }

        return { markdown, annotation, usage: ocrUsage }
      },
      allowFallback ? () => this.#multimodalVisionPass('vertex', mimeType, base64, opts) : undefined,
      { isDev: this.#corge.env.isDev }
    )
  }

  vision = async (documentUrl: string, opts?: VisionOptions): Promise<VisionResult> => {
    const match = /^data:([^;,]+);base64,(.+)$/.exec(documentUrl)
    if (!match?.[1] || !match[2]) {
      throw httpStatusError('Invalid base64 data URL format for vision OCR', 400)
    }
    const mimeType = match[1]
    const base64 = match[2]
    await this.#corge.internals.payments.enforceAiQuota()

    return this.#runWithAiFailover(opts?.provider, (provider) =>
      provider === 'vertex'
        ? this.#vertexDocAiVision(mimeType, base64, documentUrl, opts)
        : this.#multimodalVisionPass(provider, mimeType, base64, opts)
    )
  }

  #structuredDecideOnProvider = async (
    provider: AiProvider,
    state: unknown,
    questions: Record<string, DecisionQuestion>
  ): Promise<DecideResult> => {
    await this.#corge.internals.resilience.acquireLimit('ai')
    const aiCfg = this.#corge.config.ai
    const modelId =
      provider === 'anthropic'
        ? aiCfg.anthropic.decisionsModel
        : provider === 'openai'
          ? aiCfg.openai.decisionsModel
          : aiCfg.vertex.fastModel
    const { schema, promptBlock } = buildStructuredDecideSpec(questions)
    const stateText = typeof state === 'string' ? state : JSON.stringify(state)
    const res = await generateText({
      model: this.languageModel(modelId, provider),
      system: 'Evaluate every question accurately against the input state and return calibrated probabilities/choices.',
      prompt: `State:\n${stateText.slice(0, 120_000)}\n\nQuestions:\n${promptBlock}`,
      output: Output.object({ schema }),
      abortSignal: AbortSignal.timeout(15_000)
    })
    const rawOut = (res.output ?? {}) as Record<string, Record<string, unknown>>
    const answers = parseStructuredDecideOutput(questions, rawOut)
    const usage = normalizeUsage(modelId, res.usage)
    await this.#corge.internals.payments.trackAiUsage({
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      source: 'decide'
    })
    return { ...envelopeSchema.parse({ model: modelId, answers }), usage }
  }

  #decideViaVertex = async (state: unknown, questions: Record<string, DecisionQuestion>): Promise<DecideResult> => {
    const modelId = this.#corge.config.ai.vertex.decisionsModel
    const apiKey = this.#corge.env.GEMINI_API_KEY?.trim()
    if (!apiKey || Date.now() < geminiDecisionsUnavailableUntil) {
      return this.#structuredDecideOnProvider('vertex', state, questions)
    }

    return this.#corge.internals.resilience.circuitBreaker(
      'decisions-vertex',
      async () => {
        const { wireQuestions, trivialAnswers } = toGeminiDecisionQuestions(questions)
        if (Object.keys(wireQuestions).length === 0) {
          return envelopeSchema.parse({ model: modelId, answers: trivialAnswers })
        }

        await this.#corge.internals.resilience.acquireLimit('decisions')
        const inputText = typeof state === 'string' ? state : JSON.stringify(state)
        const res = await fetch('https://generativelanguage.googleapis.com/v1beta/decisions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey
          },
          body: JSON.stringify({
            model: modelId,
            input: inputText.slice(0, 500_000),
            questions: wireQuestions
          }),
          signal: AbortSignal.timeout(12_000)
        })
        if (res.status === 401 || res.status === 402 || res.status === 403) {
          geminiDecisionsUnavailableUntil = Date.now() + 5 * 60_000
          return this.#structuredDecideOnProvider('vertex', state, questions)
        }
        if (!res.ok) {
          throw httpStatusError(`Gemini Decisions HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status)
        }
        const raw = (await res.json()) as GeminiDecisionsWireResponse
        const normalizedAnswers = normalizeGeminiDecisionAnswers(questions, raw.answers, trivialAnswers)
        const parsed = envelopeSchema.safeParse({
          model: raw.model || modelId,
          answers: normalizedAnswers
        })
        if (!parsed.success || !Object.keys(questions).every((q) => parsed.data.answers[q]?.type === questions[q]?.type)) {
          throw new Error('Gemini Decisions API returned an incomplete answer envelope')
        }
        const usage = normalizeUsage(raw.model || modelId, {
          inputTokens: raw.usage?.total_input_tokens ?? 0,
          outputTokens: raw.usage?.total_output_tokens ?? 0,
          totalTokens: raw.usage?.total_tokens ?? raw.usage?.total_input_tokens ?? 0
        })
        await this.#corge.internals.payments.trackAiUsage({
          model: usage.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          source: 'decide'
        })
        return { ...parsed.data, usage }
      },
      () => this.#structuredDecideOnProvider('vertex', state, questions),
      { isDev: this.#corge.env.isDev }
    )
  }

  #decideViaOpenAi = async (state: unknown, questions: Record<string, DecisionQuestion>): Promise<DecideResult> => {
    const oCfg = this.#corge.config.ai.openai
    const modelId = oCfg.decisionsModel
    const apiKey = this.#corge.env.OPENAI_API_KEY?.trim()
    if (!apiKey) {
      throw httpStatusError('Missing OPENAI_API_KEY for OpenAI Decisions API', 500)
    }

    return this.#corge.internals.resilience.circuitBreaker(
      'decisions-openai',
      async () => {
        const { wireQuestions, trivialAnswers } = toOpenAiDecisionQuestions(questions)
        if (wireQuestions.length === 0) {
          return envelopeSchema.parse({ model: modelId, answers: trivialAnswers })
        }

        await this.#corge.internals.resilience.acquireLimit('decisions')
        const inputText = (typeof state === 'string' ? state : JSON.stringify(state)).slice(0, 500_000)
        const res = await fetch(`${oCfg.baseUrl.replace(/\/+$/, '')}/decisions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: modelId,
            input: [
              {
                role: 'user',
                content: [{ type: 'input_text', text: inputText }]
              }
            ],
            questions: wireQuestions
          }),
          signal: AbortSignal.timeout(12_000)
        })
        if (!res.ok) {
          throw httpStatusError(`OpenAI Decisions HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status)
        }
        const raw = (await res.json()) as OpenAiDecisionsWireResponse
        const normalizedAnswers = normalizeOpenAiDecisionAnswers(questions, raw.answers, trivialAnswers)
        const parsed = envelopeSchema.safeParse({
          model: raw.model || modelId,
          answers: normalizedAnswers
        })
        if (!parsed.success || !Object.keys(questions).every((q) => parsed.data.answers[q]?.type === questions[q]?.type)) {
          throw new Error('OpenAI Decisions API returned an incomplete answer envelope')
        }
        const inTok = raw.usage?.input_tokens ?? raw.usage?.prompt_tokens ?? 0
        const outTok = raw.usage?.output_tokens ?? raw.usage?.completion_tokens ?? 0
        const usage = normalizeUsage(raw.model || modelId, {
          inputTokens: inTok,
          outputTokens: outTok,
          totalTokens: raw.usage?.total_tokens ?? inTok + outTok
        })
        await this.#corge.internals.payments.trackAiUsage({
          model: usage.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          source: 'decide'
        })
        return { ...parsed.data, usage }
      },
      undefined,
      { isDev: this.#corge.env.isDev }
    )
  }

  decide = async (state: unknown, questions: Record<string, DecisionQuestion>): Promise<DecideResult> => {
    const aiCfg = this.#corge.config.ai
    if (Object.keys(questions).length === 0) {
      const defaultDecisionModel =
        aiCfg.provider === 'openai'
          ? aiCfg.openai.decisionsModel
          : aiCfg.provider === 'anthropic'
            ? aiCfg.anthropic.decisionsModel
            : aiCfg.vertex.decisionsModel
      return { model: defaultDecisionModel, answers: {} }
    }
    await this.#corge.internals.payments.enforceAiQuota()

    return this.#runWithAiFailover(undefined, (provider) => {
      if (provider === 'vertex') return this.#decideViaVertex(state, questions)
      if (provider === 'openai') return this.#decideViaOpenAi(state, questions)
      return this.#structuredDecideOnProvider('anthropic', state, questions)
    })
  }

  generate = async <O = string>(
    promptOrMessages: string | ModelMessage[],
    opts?: AiGenerateOptions<O>
  ): Promise<AiGenerateResult<O>> => {
    await this.#corge.internals.payments.enforceAiQuota()
    await this.#corge.internals.resilience.acquireLimit('ai')
    const requestedModel = opts?.model ?? 'default'
    const model = this.languageModel(requestedModel, opts?.provider)
    const messages: ModelMessage[] =
      typeof promptOrMessages === 'string'
        ? [{ role: 'user', content: [{ type: 'text', text: promptOrMessages }] }]
        : promptOrMessages

    if (opts?.schema) {
      const res = await generateText({
        model,
        system: opts.system,
        messages,
        output: Output.object({ schema: opts.schema }),
        abortSignal: opts.signal
      })
      const norm = normalizeUsage(res.response.modelId || model.modelId, res.usage)
      await this.#corge.internals.payments.trackAiUsage({
        model: norm.model,
        inputTokens: norm.inputTokens,
        outputTokens: norm.outputTokens,
        totalTokens: norm.totalTokens,
        source: 'generate'
      })
      return { text: res.text, output: res.output as O, usage: res.usage }
    }

    const res = await generateText({
      model,
      system: opts?.system,
      messages,
      abortSignal: opts?.signal
    })
    const norm = normalizeUsage(res.response.modelId || model.modelId, res.usage)
    await this.#corge.internals.payments.trackAiUsage({
      model: norm.model,
      inputTokens: norm.inputTokens,
      outputTokens: norm.outputTokens,
      totalTokens: norm.totalTokens,
      source: 'generate'
    })
    return { text: res.text, output: res.text as unknown as O, usage: res.usage }
  }

  #embedViaJina = async (text: string): Promise<number[] | null> => {
    const jinaKey = this.#corge.env.JINA_API_KEY?.trim()
    if (!jinaKey) return null
    const jCfg = this.#corge.config.ai.jina
    return this.#corge.internals.resilience.circuitBreaker(
      'ai-jina',
      async () => {
        await this.#corge.internals.resilience.acquireLimit('ai')
        const res = await fetch(`${jCfg.baseUrl.replace(/\/+$/, '')}/embeddings`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${jinaKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: jCfg.embeddingModel,
            dimensions: 768,
            task: 'retrieval.passage',
            input: [text]
          }),
          signal: AbortSignal.timeout(15_000)
        })
        if (!res.ok) {
          throw httpStatusError(`Jina Embeddings HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status)
        }
        const json = (await res.json()) as JinaEmbeddingsWireResponse
        const vec = json.data?.[0]?.embedding
        return Array.isArray(vec) && vec.length === 768 ? vec : null
      },
      undefined,
      { isDev: this.#corge.env.isDev }
    )
  }

  #embedOnSlot = async (provider: AiProvider, text: string): Promise<number[] | null> => {
    const aiCfg = this.#corge.config.ai
    if (provider === 'anthropic') {
      return this.#embedViaJina(text)
    }
    if (provider === 'openai') {
      if (!this.#corge.env.OPENAI_API_KEY?.trim()) return null
      return this.#corge.internals.resilience.circuitBreaker(
        'ai-openai',
        async () => {
          await this.#corge.internals.resilience.acquireLimit('ai')
          const { embedding } = await embed({
            model: this.#openAiProvider().embeddingModel(aiCfg.openai.embeddingModel),
            value: text,
            dimensions: 768,
            maxRetries: 0,
            abortSignal: AbortSignal.timeout(15_000),
            providerOptions: {
              openai: { dimensions: 768 }
            }
          })
          return Array.isArray(embedding) && embedding.length === 768 ? embedding : null
        },
        undefined,
        { isDev: this.#corge.env.isDev }
      )
    }
    if (!this.#corge.config.gcpProject) return null
    return this.#corge.internals.resilience.circuitBreaker(
      'ai-vertex',
      async () => {
        await this.#corge.internals.resilience.acquireLimit('ai')
        const embeddingModel = this.#vertexProviders().vertexEmbeddingProvider.textEmbeddingModel(
          aiCfg.vertex.embeddingModel
        )
        const { embedding } = await embed({
          model: embeddingModel,
          value: text,
          dimensions: 768,
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(15_000),
          providerOptions: {
            vertex: { outputDimensionality: 768 }
          }
        })
        return Array.isArray(embedding) && embedding.length === 768 ? embedding : null
      },
      undefined,
      { isDev: this.#corge.env.isDev }
    )
  }

  embed = async (text: string): Promise<number[] | null> => {
    const normalized = text.trim()
    if (normalized.length < 15) return null
    const sliced = normalized.slice(0, 8000)
    const aiCfg = this.#corge.config.ai
    const ordered = [...new Set<AiProvider>([aiCfg.provider, ...(aiCfg.fallbackProviders ?? []).slice(0, 2)])]

    for (let i = 0; i < ordered.length; i++) {
      try {
        const vec = await this.#embedOnSlot(ordered[i]!, sliced)
        if (vec) return vec
      } catch (err) {
        if (i === ordered.length - 1 || !isAiFailoverEligible(err)) return null
      }
    }
    return null
  }
}
