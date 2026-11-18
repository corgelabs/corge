import { z } from 'zod'
import type { AiConfig, AiModelTier, AiProvider } from '../config'

export type { AiConfig, AiModelTier, AiProvider }

export type DecisionQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] }

export const answerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('noul'),
    noul: z.number().min(0).max(1),
    confidence: z.number().optional()
  }),
  z.object({
    type: z.literal('choice'),
    choice: z.string(),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number()
  }),
  z.object({
    type: z.literal('score'),
    score: z.number(),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number()
  })
])

export const envelopeSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), answerSchema)
})

export interface AiUsageSummary {
  model: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  pages?: number
}

export type DecisionAnswer = z.infer<typeof answerSchema>
export type DecideResult = z.infer<typeof envelopeSchema> & { usage?: AiUsageSummary }

export interface DocAiTextSegment {
  startIndex?: string | number
  endIndex?: string | number
}

export interface DocAiLayoutUnit {
  layout?: {
    textAnchor?: { textSegments?: DocAiTextSegment[] }
    confidence?: number
  }
}

export interface DocAiPage {
  pageNumber?: number
  paragraphs?: DocAiLayoutUnit[]
  lines?: DocAiLayoutUnit[]
  blocks?: DocAiLayoutUnit[]
}

export interface DocAiProcessResponse {
  document?: {
    text?: string
    pages?: DocAiPage[]
  }
}

export interface GeminiDecisionsWireResponse {
  model?: string
  answers?: Record<
    string,
    {
      noul?: number
      choice?: string
      score?: number
      probabilities?: Record<string, number>
      confidence?: number
    }
  >
  usage?: {
    total_input_tokens?: number
    total_output_tokens?: number
    total_tokens?: number
  }
}

export type OpenAiDecisionQuestionWire =
  | {
      type: 'predicate'
      name: string
      instructions: string
    }
  | {
      type: 'choice'
      name: string
      instructions: string
      choices: { value: string; description?: string }[]
    }
  | {
      type: 'score'
      name: string
      instructions: string
      levels: { label: string; description?: string }[]
    }

export type OpenAiDecisionProbabilityEntry = {
  value?: string
  level?: string
  probability: number
}

export type OpenAiDecisionAnswerWire =
  | {
      name: string
      type: 'predicate'
      probability: number
    }
  | {
      name: string
      type: 'choice'
      choice: string
      probabilities?: OpenAiDecisionProbabilityEntry[] | Record<string, number>
    }
  | {
      name: string
      type: 'score'
      score: number
      probabilities?: OpenAiDecisionProbabilityEntry[] | Record<string, number>
    }
  | {
      name: string | null
      type: 'refusal'
    }

export interface OpenAiDecisionsWireResponse {
  id?: string
  model?: string
  answers?: OpenAiDecisionAnswerWire[]
  usage?: {
    input_tokens?: number
    output_tokens?: number
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

export interface JinaEmbeddingsWireResponse {
  model?: string
  data?: { index?: number; embedding?: number[] }[]
  usage?: { total_tokens?: number; prompt_tokens?: number }
}

export interface VisionOptions {
  provider?: AiProvider
  schema?: Record<string, unknown>
  prompt?: string
  fallbackVision?: boolean
  signal?: AbortSignal
}

export interface VisionResult {
  markdown: string
  annotation: Record<string, unknown>
  usage?: AiUsageSummary
}

export interface AiGenerateOptions<O = string> {
  provider?: AiProvider
  model?: string
  system?: string
  schema?: z.ZodType<O>
  signal?: AbortSignal
}

export interface AiGenerateResult<O = string> {
  text: string
  output: O
  usage: unknown
}

export const DEFAULT_EXTRACTION_PROMPT =
  'Extract the document fields as JSON matching the schema. Transcribe values exactly as printed, translate non-English into English, transliterate names, use Western digits. Empty string if not visible.'
