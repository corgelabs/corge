import { createGoogleVertex } from '@ai-sdk/google-vertex'
import { createVertexAnthropic } from '@ai-sdk/google-vertex/anthropic'
import { HTTPClient, Mistral } from '@mistralai/mistralai'
import { TypeSafeClient } from '@typesafe-ai/sdk'
import { embed, generateText, Output, type LanguageModel, type ModelMessage } from 'ai'
import type { Corge } from '../index'
import {
  DEFAULT_EXTRACTION_PROMPT,
  envelopeSchema,
  type AiGenerateOptions,
  type AiGenerateResult,
  type AiUsageSummary,
  type DecideResult,
  type JevQuestion,
  type VisionOptions,
  type VisionResult
} from './schema'
import { formatOcrPages, normalizeUsage } from './utils'

let cachedVertexKey = ''
let cachedVertexAnthropic: ReturnType<typeof createVertexAnthropic> | undefined
let cachedVertexEmbedding: ReturnType<typeof createGoogleVertex> | undefined

let cachedJevKey = ''
let cachedJev: TypeSafeClient | undefined

let cachedMistralKey = ''
let cachedMistral: Mistral | undefined

export class AiService {
  readonly #corge: Corge

  constructor(corgeClient: Corge) {
    this.#corge = corgeClient
  }

  #vertexProviders = () => {
    const project = this.#corge.config.gcpProject
    const location = this.#corge.config.models.vertexLocation
    const key = `${project}:${location}`
    if (!cachedVertexAnthropic || !cachedVertexEmbedding || cachedVertexKey !== key) {
      cachedVertexKey = key
      cachedVertexAnthropic = createVertexAnthropic({ project, location })
      cachedVertexEmbedding = createGoogleVertex({
        project,
        location: location === 'global' ? 'us-central1' : location
      })
    }
    return { vertexAnthropic: cachedVertexAnthropic, vertexEmbeddingProvider: cachedVertexEmbedding }
  }

  languageModel = (modelId: string = this.#corge.config.models.vertex): LanguageModel =>
    this.#vertexProviders().vertexAnthropic(modelId)

  #jevClient = (apiKey: string): TypeSafeClient =>
    cachedJev && cachedJevKey === apiKey
      ? cachedJev
      : ((cachedJevKey = apiKey),
        (cachedJev = new TypeSafeClient({ apiKey, defaultModel: this.#corge.config.models.jev })))

  #mistralClient = (): Mistral => {
    const apiKey = this.#corge.env.MISTRAL_API_KEY
    if (cachedMistral && cachedMistralKey === apiKey) return cachedMistral
    const httpClient = new HTTPClient()
    httpClient.addHook('response', async (res) => {
      const limit = Number(res.headers.get('x-ratelimit-limit-ocr-pages-minute') ?? '0')
      const remHeader = res.headers.get('x-ratelimit-remaining-ocr-pages-minute')
      const remaining = res.status === 429 ? 0 : remHeader !== null ? Number(remHeader) : undefined
      if (limit > 0 || remaining !== undefined) {
        await this.#corge.internals.resilience.syncLimit('mistral', remaining, limit)
      }
    })
    cachedMistralKey = apiKey
    return (cachedMistral = new Mistral({
      apiKey,
      httpClient,
      retryConfig: {
        strategy: 'backoff',
        backoff: { initialInterval: 5000, maxInterval: 20000, exponent: 1.5, maxElapsedTime: 90000 },
        retryConnectionErrors: true
      }
    }))
  }

  describeImage = async (documentUrl: string, signal?: AbortSignal): Promise<string> =>
    this.#corge.internals.resilience.circuitBreaker('vertex', async () => {
      await this.#corge.internals.resilience.acquireLimit('ai')
      const match = /^data:([^;,]+);base64,(.+)$/.exec(documentUrl)
      const mediaType = match?.[1] ?? 'image/jpeg'
      const base64 = match?.[2] ?? documentUrl
      const modelId = this.#corge.config.models.vertex
      const { text } = await generateText({
        model: this.languageModel(modelId),
        abortSignal: signal,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'file', data: base64, mediaType },
              { type: 'text', text: 'Describe what is illustrated on this image concisely in markdown.' }
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
    let annotation: Record<string, unknown> = {}
    const modelId = this.#corge.config.models.vertex
    let usage: AiUsageSummary | undefined
    if (opts?.schema) {
      await this.#corge.internals.resilience.acquireLimit('ai')
      const match = /^data:([^;,]+);base64,(.+)$/.exec(documentUrl)
      const mediaType = match?.[1] ?? 'application/pdf'
      const base64 = match?.[2] ?? documentUrl
      const res = await this.#corge.internals.resilience.circuitBreaker('vertex', () =>
        generateText({
          model: this.languageModel(modelId),
          abortSignal: opts.signal,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'file', data: base64, mediaType },
                {
                  type: 'text',
                  text: `${opts.prompt ?? DEFAULT_EXTRACTION_PROMPT}\n\nJSON Schema:\n${JSON.stringify(opts.schema)}\n\nRespond with ONLY a valid JSON object.`
                }
              ]
            }
          ]
        })
      )
      usage = normalizeUsage(modelId, res.usage)
      const jsonMatch = /\{[\s\S]*\}/.exec(res.text)
      if (jsonMatch?.[0]) {
        try {
          annotation = JSON.parse(jsonMatch[0]) as Record<string, unknown>
        } catch {}
      }
    }
    return { markdown, annotation, ...(usage ? { usage } : {}) }
  }

  vision = async (documentUrl: string, opts?: VisionOptions): Promise<VisionResult> => {
    const isImage = documentUrl.startsWith('data:image')
    const hasSchema = Boolean(opts?.schema)
    const allowFallback = opts?.fallbackVision !== false
    await this.#corge.internals.payments.enforceAiQuota()

    return this.#corge.internals.resilience.circuitBreaker(
      'mistral',
      async () => {
        await this.#corge.internals.resilience.acquireLimit('mistral')
        const modelId = this.#corge.config.models.mistralOcr
        const result = await this.#mistralClient().ocr.process(
          {
            model: modelId,
            confidenceScoresGranularity: 'block',
            pages: !hasSchema && !isImage ? Array.from({ length: 10 }, (_, i) => i) : undefined,
            document: isImage
              ? { type: 'image_url' as const, imageUrl: documentUrl }
              : { type: 'document_url' as const, documentUrl },
            ...(opts?.schema && {
              documentAnnotationFormat: {
                type: 'json_schema' as const,
                jsonSchema: { name: 'fields', schemaDefinition: opts.schema, strict: true }
              },
              documentAnnotationPrompt: opts.prompt ?? DEFAULT_EXTRACTION_PROMPT
            })
          },
          opts?.signal ? { fetchOptions: { signal: opts.signal } } : undefined
        )
        const pagesProcessed = result.usageInfo?.pagesProcessed ?? result.pages.length
        if (pagesProcessed > 1) {
          await this.#corge.internals.resilience.chargeLimit('mistral', pagesProcessed - 1)
        }
        let markdown = formatOcrPages(result.pages)
        const annotation = JSON.parse(result.documentAnnotation ?? '{}') as Record<string, unknown>

        if (!markdown && (opts?.fallbackVision ?? !hasSchema)) {
          markdown = await this.describeImage(documentUrl, opts?.signal)
        }

        const usage = normalizeUsage(modelId, null, pagesProcessed)
        await this.#corge.internals.payments.trackAiUsage({
          model: usage.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          source: 'vision'
        })
        return { markdown, annotation, usage }
      },
      allowFallback ? () => this.#vertexVisionFallback(documentUrl, opts) : undefined,
      { isDev: this.#corge.env.isDev }
    )
  }

  decide = async (state: unknown, questions: Record<string, JevQuestion>): Promise<DecideResult> =>
    this.#corge.internals.resilience.circuitBreaker(
      'jev',
      async () => {
        await this.#corge.internals.payments.enforceAiQuota()
        await this.#corge.internals.resilience.acquireLimit('jev')
        const raw = await this.#jevClient(this.#corge.env.TYPESAFE_API_KEY).systemOne({
          state: state as never,
          questions: questions as never
        })
        const parsed = envelopeSchema.safeParse(raw)
        if (parsed.success && Object.keys(questions).every((q) => parsed.data.answers[q]?.type === questions[q]?.type)) {
          const usage = normalizeUsage(parsed.data.model || this.#corge.config.models.jev, null)
          await this.#corge.internals.payments.trackAiUsage({
            model: usage.model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
            source: 'decide'
          })
          return {
            ...parsed.data,
            usage
          }
        }
        throw new Error('Jev decision returned no valid answer envelope')
      },
      undefined,
      { isDev: this.#corge.env.isDev }
    )

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
        return {
          text: res.text,
          output: res.output as O,
          usage: res.usage
        }
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
      return {
        text: res.text,
        output: res.text as unknown as O,
        usage: res.usage
      }
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
