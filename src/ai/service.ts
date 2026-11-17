import { createGoogleVertex } from '@ai-sdk/google-vertex'
import { createVertexAnthropic } from '@ai-sdk/google-vertex/anthropic'
import { embed, generateText, jsonSchema, Output, type LanguageModel, type ModelMessage } from 'ai'
import type { Corge } from '../index'
import {
  DEFAULT_EXTRACTION_PROMPT,
  envelopeSchema,
  type AiGenerateOptions,
  type AiGenerateResult,
  type AiUsageSummary,
  type DecideResult,
  type DecisionAnswer,
  type DecisionQuestion,
  type DocAiProcessResponse,
  type GeminiDecisionsWireResponse,
  type VisionOptions,
  type VisionResult
} from './schema'
import {
  buildVertexDecideFallbackSpec,
  formatDocAiPages,
  normalizeGeminiDecisionAnswers,
  normalizeUsage,
  toGeminiDecisionQuestions
} from './utils'

let cachedVertexKey = ''
let cachedVertexAnthropic: ReturnType<typeof createVertexAnthropic> | undefined
let cachedVertexGoogle: ReturnType<typeof createGoogleVertex> | undefined
let cachedVertexEmbedding: ReturnType<typeof createGoogleVertex> | undefined

let cachedDocAiKey = ''
let cachedDocAiProcessorUrl = ''
let decisionsBillingUnavailableUntil = 0

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
    const location = this.#corge.config.models.vertexLocation
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

  languageModel = (modelId: string = this.#corge.config.models.vertex): LanguageModel => {
    const providers = this.#vertexProviders()
    return modelId.startsWith('gemini-') ? providers.vertexGoogle(modelId) : providers.vertexAnthropic(modelId)
  }

  #resolveDocAiProcessorUrl = async (): Promise<string> => {
    const project = this.#corge.config.gcpProject
    const loc = this.#corge.config.models.docAiLocation || 'eu'
    const displayName = this.#corge.config.models.docAiProcessorDisplayName || 'corge-ocr'
    const explicitId = this.#corge.config.models.docAiProcessorId
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
    markdown: string,
    rawSchema: Record<string, unknown>,
    prompt?: string,
    signal?: AbortSignal
  ): Promise<{ annotation: Record<string, unknown>; usage: AiUsageSummary }> => {
    await this.#corge.internals.resilience.acquireLimit('ai')
    const modelId = this.#corge.config.models.vertexFlash
    const { $schema: _$schema, ...cleanSchema } = rawSchema
    const res = await this.#corge.internals.resilience.circuitBreaker('vertex', () =>
      generateText({
        model: this.languageModel(modelId),
        system: prompt ?? DEFAULT_EXTRACTION_PROMPT,
        prompt: markdown.slice(0, 120_000),
        output: Output.object({ schema: jsonSchema(cleanSchema) }),
        abortSignal: withSignalTimeout(20_000, signal)
      })
    )
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

  describeImage = async (documentUrl: string, signal?: AbortSignal): Promise<string> =>
    this.#corge.internals.resilience.circuitBreaker('vertex', async () => {
      await this.#corge.internals.resilience.acquireLimit('ai')
      const match = /^data:([^;,]+);base64,(.+)$/.exec(documentUrl)
      const mediaType = match?.[1] ?? 'image/jpeg'
      const base64 = match?.[2] ?? documentUrl
      const modelId = this.#corge.config.models.vertexFlash
      const { text } = await generateText({
        model: this.languageModel(modelId),
        abortSignal: withSignalTimeout(20_000, signal),
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
    })

  #vertexVisionFallback = async (documentUrl: string, opts?: VisionOptions): Promise<VisionResult> => {
    const markdown = await this.describeImage(documentUrl, opts?.signal)
    if (!opts?.schema) return { markdown, annotation: {} }
    const { annotation, usage } = await this.#extractAnnotationFromMarkdown(markdown, opts.schema, opts.prompt, opts.signal)
    return { markdown, annotation, usage }
  }

  vision = async (documentUrl: string, opts?: VisionOptions): Promise<VisionResult> => {
    const hasSchema = Boolean(opts?.schema)
    const allowFallback = opts?.fallbackVision !== false
    const match = /^data:([^;,]+);base64,(.+)$/.exec(documentUrl)
    if (!match?.[1] || !match[2]) {
      throw httpStatusError('Invalid base64 data URL format for vision OCR', 400)
    }
    const mimeType = match[1]
    const base64 = match[2]
    await this.#corge.internals.payments.enforceAiQuota()

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
          const ext = await this.#extractAnnotationFromMarkdown(markdown, opts.schema, opts.prompt, opts?.signal)
          annotation = ext.annotation
        }

        return { markdown, annotation, usage: ocrUsage }
      },
      allowFallback ? () => this.#vertexVisionFallback(documentUrl, opts) : undefined,
      { isDev: this.#corge.env.isDev }
    )
  }

  #vertexDecideFallback = async (
    state: unknown,
    questions: Record<string, DecisionQuestion>
  ): Promise<DecideResult> => {
    await this.#corge.internals.resilience.acquireLimit('ai')
    const modelId = this.#corge.config.models.vertexFlash
    const { schema, promptBlock } = buildVertexDecideFallbackSpec(questions)
    const stateText = typeof state === 'string' ? state : JSON.stringify(state)
    const res = await this.#corge.internals.resilience.circuitBreaker('vertex', () =>
      generateText({
        model: this.languageModel(modelId),
        system: 'Evaluate every question accurately against the input state and return calibrated probabilities/choices.',
        prompt: `State:\n${stateText.slice(0, 120_000)}\n\nQuestions:\n${promptBlock}`,
        output: Output.object({ schema }),
        abortSignal: AbortSignal.timeout(15_000)
      })
    )
    const rawOut = (res.output ?? {}) as Record<string, Record<string, unknown>>
    const answers: Record<string, DecisionAnswer> = {}
    for (const [key, q] of Object.entries(questions)) {
      const item = rawOut[key] ?? {}
      if (q.type === 'noul') {
        answers[key] = { type: 'noul', noul: Number(item.noul ?? 0), confidence: Number(item.confidence ?? 0.5) }
      } else if (q.type === 'choice') {
        const chosen = String(item.choice ?? Object.keys(q.criteria)[0] ?? '')
        const conf = Number(item.confidence ?? 0.8)
        answers[key] = { type: 'choice', choice: chosen, probabilities: { [chosen]: conf }, confidence: conf }
      } else {
        const sc = Number(item.score ?? 0)
        const conf = Number(item.confidence ?? 0.8)
        answers[key] = { type: 'score', score: sc, probabilities: {}, confidence: conf }
      }
    }
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

  decide = async (state: unknown, questions: Record<string, DecisionQuestion>): Promise<DecideResult> => {
    const modelId = this.#corge.config.models.decisions
    if (Object.keys(questions).length === 0) return { model: modelId, answers: {} }
    await this.#corge.internals.payments.enforceAiQuota()

    const apiKey = this.#corge.env.GEMINI_API_KEY
    if (!apiKey || Date.now() < decisionsBillingUnavailableUntil) {
      return this.#vertexDecideFallback(state, questions)
    }

    return this.#corge.internals.resilience.circuitBreaker(
      'decisions',
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
          decisionsBillingUnavailableUntil = Date.now() + 5 * 60_000
          return this.#vertexDecideFallback(state, questions)
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
      () => this.#vertexDecideFallback(state, questions),
      { isDev: this.#corge.env.isDev }
    )
  }

  generate = async <O = string>(
    promptOrMessages: string | ModelMessage[],
    opts?: AiGenerateOptions<O>
  ): Promise<AiGenerateResult<O>> =>
    this.#corge.internals.resilience.circuitBreaker('vertex', async () => {
      await this.#corge.internals.payments.enforceAiQuota()
      await this.#corge.internals.resilience.acquireLimit('ai')
      const modelId = opts?.model ?? this.#corge.config.models.vertex
      const model = this.languageModel(modelId)
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
        const norm = normalizeUsage(modelId, res.usage)
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
      const norm = normalizeUsage(modelId, res.usage)
      await this.#corge.internals.payments.trackAiUsage({
        model: norm.model,
        inputTokens: norm.inputTokens,
        outputTokens: norm.outputTokens,
        totalTokens: norm.totalTokens,
        source: 'generate'
      })
      return { text: res.text, output: res.text as unknown as O, usage: res.usage }
    })

  embed = async (text: string): Promise<number[] | null> => {
    const normalized = text.trim()
    if (normalized.length < 15) return null
    try {
      return await this.#corge.internals.resilience.circuitBreaker('vertex', async () => {
        await this.#corge.internals.resilience.acquireLimit('ai')
        const embeddingModel = this.#vertexProviders().vertexEmbeddingProvider.textEmbeddingModel(
          this.#corge.config.models.vertexEmbedding
        )
        const { embedding } = await embed({
          model: embeddingModel,
          value: normalized.slice(0, 8000),
          dimensions: 768,
          abortSignal: AbortSignal.timeout(15_000),
          providerOptions: {
            vertex: { outputDimensionality: 768 }
          }
        })
        return Array.isArray(embedding) && embedding.length === 768 ? embedding : null
      })
    } catch {
      return null
    }
  }
}
