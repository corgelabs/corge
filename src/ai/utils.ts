import { z } from 'zod'
import type {
  AiUsageSummary,
  DecisionAnswer,
  DecisionQuestion,
  DocAiLayoutUnit,
  DocAiProcessResponse,
  GeminiDecisionsWireResponse
} from './schema'

const sliceUnitText = (fullText: string, unit: DocAiLayoutUnit): string =>
  (unit.layout?.textAnchor?.textSegments ?? [])
    .map((seg) => fullText.slice(Number(seg.startIndex ?? 0), Number(seg.endIndex ?? 0)))
    .join('')
    .trim()

export const formatDocAiPages = (res: DocAiProcessResponse): string => {
  const fullText = res.document?.text ?? ''
  if (!fullText.trim()) return ''
  const pages = res.document?.pages ?? []
  if (pages.length === 0) return `### Page 1\n${fullText.trim()}`

  const rendered = pages
    .map((p, i) => {
      const units = p.paragraphs?.length ? p.paragraphs : p.lines?.length ? p.lines : (p.blocks ?? [])
      const text = units
        .filter((u) => (u.layout?.confidence ?? 1) >= 0.35)
        .map((u) => sliceUnitText(fullText, u))
        .filter(Boolean)
        .join('\n\n')
      const resolved = text || (pages.length === 1 ? fullText.trim() : '')
      return resolved ? `### Page ${p.pageNumber ?? i + 1}\n${resolved}` : ''
    })
    .filter(Boolean)
    .join('\n\n')

  return rendered || `### Page 1\n${fullText.trim()}`
}

export const toGeminiDecisionQuestions = (
  questions: Record<string, DecisionQuestion>
): { wireQuestions: Record<string, unknown>; trivialAnswers: Record<string, DecisionAnswer> } => {
  const wireQuestions: Record<string, unknown> = {}
  const trivialAnswers: Record<string, DecisionAnswer> = {}

  for (const [key, q] of Object.entries(questions)) {
    if (q.type === 'noul') {
      wireQuestions[key] = {
        type: 'noul',
        instructions: q.instructions,
        ...(q.criteria
          ? {
              criteria: {
                true_description: q.criteria.true,
                false_description: q.criteria.false
              }
            }
          : {})
      }
    } else if (q.type === 'choice') {
      const optionKeys = Object.keys(q.criteria)
      if (optionKeys.length === 1) {
        const only = optionKeys[0]!
        trivialAnswers[key] = { type: 'choice', choice: only, probabilities: { [only]: 1 }, confidence: 1 }
      } else {
        wireQuestions[key] = { type: 'choice', instructions: q.instructions, criteria: q.criteria }
      }
    } else {
      wireQuestions[key] = { type: 'score', instructions: q.instructions, criteria: q.criteria }
    }
  }

  return { wireQuestions, trivialAnswers }
}

export const normalizeGeminiDecisionAnswers = (
  questions: Record<string, DecisionQuestion>,
  rawAnswers: GeminiDecisionsWireResponse['answers'] = {},
  trivialAnswers: Record<string, DecisionAnswer> = {}
): Record<string, DecisionAnswer> => {
  const out: Record<string, DecisionAnswer> = { ...trivialAnswers }
  for (const [key, q] of Object.entries(questions)) {
    if (key in out) continue
    const raw = rawAnswers[key]
    if (!raw) continue
    if (q.type === 'noul' && typeof raw.noul === 'number') {
      out[key] = {
        type: 'noul',
        noul: Math.min(1, Math.max(0, raw.noul)),
        ...(typeof raw.confidence === 'number' ? { confidence: raw.confidence } : {})
      }
    } else if (q.type === 'choice' && typeof raw.choice === 'string') {
      out[key] = {
        type: 'choice',
        choice: raw.choice,
        probabilities: raw.probabilities ?? { [raw.choice]: 1 },
        confidence: typeof raw.confidence === 'number' ? raw.confidence : 1
      }
    } else if (q.type === 'score' && typeof raw.score === 'number') {
      out[key] = {
        type: 'score',
        score: raw.score,
        probabilities: raw.probabilities ?? {},
        confidence: typeof raw.confidence === 'number' ? raw.confidence : 1
      }
    }
  }
  return out
}

export const buildVertexDecideFallbackSpec = (questions: Record<string, DecisionQuestion>) => {
  const shape: Record<string, z.ZodTypeAny> = {}
  const promptLines: string[] = []

  for (const [key, q] of Object.entries(questions)) {
    if (q.type === 'noul') {
      shape[key] = z.object({ noul: z.number().min(0).max(1), confidence: z.number().min(0).max(1) })
      const crit = q.criteria ? ` (true: ${q.criteria.true} | false: ${q.criteria.false})` : ''
      promptLines.push(`- "${key}" [noul 0..1]: ${q.instructions}${crit}`)
    } else if (q.type === 'choice') {
      const opts = Object.keys(q.criteria)
      const enumSchema = opts.length >= 2 ? z.enum(opts as [string, ...string[]]) : z.string()
      shape[key] = z.object({ choice: enumSchema, confidence: z.number().min(0).max(1) })
      promptLines.push(`- "${key}" [choice]: ${q.instructions} Options: ${JSON.stringify(q.criteria)}`)
    } else {
      const maxIdx = Math.max(1, q.criteria.length - 1)
      shape[key] = z.object({ score: z.number().min(0).max(maxIdx), confidence: z.number().min(0).max(1) })
      promptLines.push(`- "${key}" [score 0..${maxIdx}]: ${q.instructions} Rubric: ${JSON.stringify(q.criteria)}`)
    }
  }

  return { schema: z.object(shape), promptBlock: promptLines.join('\n') }
}

export const normalizeUsage = (
  model: string,
  raw?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null,
  pages?: number
): AiUsageSummary => {
  const inputTokens = raw?.inputTokens ?? 0
  const outputTokens = raw?.outputTokens ?? 0
  const totalTokens = raw?.totalTokens ?? (inputTokens + outputTokens || (pages ? pages * 1000 : 0))
  return {
    model,
    inputTokens,
    outputTokens,
    totalTokens,
    ...(pages !== undefined ? { pages } : {})
  }
}
