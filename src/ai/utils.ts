import { z } from 'zod'
import type {
  AiConfig,
  AiProvider,
  AiUsageSummary,
  DecisionAnswer,
  DecisionQuestion,
  DocAiLayoutUnit,
  DocAiProcessResponse,
  GeminiDecisionsWireResponse,
  OpenAiDecisionAnswerWire,
  OpenAiDecisionProbabilityEntry,
  OpenAiDecisionQuestionWire
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

export const resolveModelForProvider = (
  provider: AiProvider,
  requested: string | undefined,
  aiCfg: AiConfig
): string => {
  const spec = aiCfg[provider]
  if (!requested || requested === 'default') return spec.defaultModel
  if (requested === 'expert') return spec.expertModel

  const isNative =
    provider === 'vertex'
      ? requested.startsWith('claude-') || requested.startsWith('gemini-')
      : provider === 'anthropic'
        ? requested.startsWith('claude-')
        : requested.startsWith('gpt-') || /^o\d/.test(requested)
  if (isNative) return requested

  const lower = requested.toLowerCase()
  if (/(sonnet|opus|fable|astra|sol|pro|argon|carbon|hydrogen)/.test(lower)) return spec.expertModel
  return spec.defaultModel
}

const unwrapSdkError = (err: unknown): Record<string, unknown> => {
  if (!err || typeof err !== 'object') return {}
  const rec = err as Record<string, unknown>
  if (rec.lastError && typeof rec.lastError === 'object') return rec.lastError as Record<string, unknown>
  if (Array.isArray(rec.errors) && rec.errors.length > 0) {
    const last = rec.errors[rec.errors.length - 1]
    if (last && typeof last === 'object') return last as Record<string, unknown>
  }
  if (rec.cause && typeof rec.cause === 'object') return rec.cause as Record<string, unknown>
  return rec
}

export const isAiFailoverEligible = (err: unknown): boolean => {
  if (!err) return false
  if (typeof err === 'object' && (err as { isCircuitBreakerOpen?: unknown }).isCircuitBreakerOpen === true) {
    return true
  }
  const top = typeof err === 'object' ? (err as Record<string, unknown>) : {}
  const inner = unwrapSdkError(err)
  const rawStatus =
    typeof top.statusCode === 'number'
      ? top.statusCode
      : typeof top.status === 'number'
        ? top.status
        : typeof inner.statusCode === 'number'
          ? inner.statusCode
          : typeof inner.status === 'number'
            ? inner.status
            : undefined
  const msg = `${err instanceof Error ? err.message : String(err)} ${typeof inner.message === 'string' ? inner.message : ''}`
  const lower = msg.toLowerCase()
  const parsedStatusMatch = /\b(?:status(?:\s+code)?|http)\s*[:=]?\s*(\d{3})\b/i.exec(msg)
  const status = rawStatus ?? (parsedStatusMatch?.[1] ? Number(parsedStatusMatch[1]) : undefined)

  if (status !== undefined) {
    return status === 408 || status === 429 || status >= 500
  }

  return (
    top.name === 'AbortError' ||
    top.name === 'TimeoutError' ||
    inner.name === 'AbortError' ||
    inner.name === 'TimeoutError' ||
    lower.includes('timed out') ||
    lower.includes('timeout') ||
    lower.includes('econnreset') ||
    lower.includes('econnrefused') ||
    lower.includes('etimedout') ||
    lower.includes('socket hang up') ||
    lower.includes('fetch failed') ||
    lower.includes('overloaded') ||
    lower.includes('service unavailable') ||
    lower.includes('bad gateway')
  )
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

const normalizeOpenAiProbabilities = (
  raw?: OpenAiDecisionProbabilityEntry[] | Record<string, number>
): Record<string, number> => {
  if (!raw) return {}
  if (!Array.isArray(raw)) return raw
  const out: Record<string, number> = {}
  for (const item of raw) {
    const key = item.value ?? item.level
    if (key !== undefined && typeof item.probability === 'number') {
      out[key] = item.probability
    }
  }
  return out
}

export const toOpenAiDecisionQuestions = (
  questions: Record<string, DecisionQuestion>
): { wireQuestions: OpenAiDecisionQuestionWire[]; trivialAnswers: Record<string, DecisionAnswer> } => {
  const wireQuestions: OpenAiDecisionQuestionWire[] = []
  const trivialAnswers: Record<string, DecisionAnswer> = {}

  for (const [name, q] of Object.entries(questions)) {
    if (q.type === 'noul') {
      const instructions = [
        q.instructions,
        q.criteria?.true ? `Criteria for true:\n${q.criteria.true}` : undefined,
        q.criteria?.false ? `Criteria for false:\n${q.criteria.false}` : undefined
      ]
        .filter((part): part is string => Boolean(part))
        .join('\n\n')
      wireQuestions.push({ type: 'predicate', name, instructions })
    } else if (q.type === 'choice') {
      const entries = Object.entries(q.criteria)
      if (entries.length === 1) {
        const only = entries[0]![0]
        trivialAnswers[name] = { type: 'choice', choice: only, probabilities: { [only]: 1 }, confidence: 1 }
      } else {
        wireQuestions.push({
          type: 'choice',
          name,
          instructions: q.instructions,
          choices: entries.map(([value, description]) => ({ value, description }))
        })
      }
    } else {
      wireQuestions.push({
        type: 'score',
        name,
        instructions: q.instructions,
        levels: q.criteria.map((description, idx) => ({ label: String(idx), description }))
      })
    }
  }

  return { wireQuestions, trivialAnswers }
}

export const normalizeOpenAiDecisionAnswers = (
  questions: Record<string, DecisionQuestion>,
  rawAnswers: OpenAiDecisionAnswerWire[] = [],
  trivialAnswers: Record<string, DecisionAnswer> = {}
): Record<string, DecisionAnswer> => {
  const out: Record<string, DecisionAnswer> = { ...trivialAnswers }
  const byName = new Map<string, OpenAiDecisionAnswerWire>()
  for (const item of rawAnswers) {
    if (item && typeof item.name === 'string') byName.set(item.name, item)
  }

  for (const [key, q] of Object.entries(questions)) {
    if (key in out) continue
    const raw = byName.get(key)
    if (!raw || raw.type === 'refusal') continue
    if (q.type === 'noul' && raw.type === 'predicate' && typeof raw.probability === 'number') {
      const p = Math.min(1, Math.max(0, raw.probability))
      out[key] = { type: 'noul', noul: p, confidence: Math.max(p, 1 - p) }
    } else if (q.type === 'choice' && raw.type === 'choice' && typeof raw.choice === 'string') {
      const probs = normalizeOpenAiProbabilities(raw.probabilities)
      const finalProbs = Object.keys(probs).length > 0 ? probs : { [raw.choice]: 1 }
      const confidence = finalProbs[raw.choice] ?? Math.max(...Object.values(finalProbs), 1)
      out[key] = { type: 'choice', choice: raw.choice, probabilities: finalProbs, confidence }
    } else if (q.type === 'score' && raw.type === 'score' && typeof raw.score === 'number') {
      const probs = normalizeOpenAiProbabilities(raw.probabilities)
      const probValues = Object.values(probs)
      const confidence = probValues.length > 0 ? Math.max(...probValues) : 0.8
      out[key] = { type: 'score', score: raw.score, probabilities: probs, confidence }
    }
  }
  return out
}

export const buildStructuredDecideSpec = (questions: Record<string, DecisionQuestion>) => {
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

export const parseStructuredDecideOutput = (
  questions: Record<string, DecisionQuestion>,
  rawOut: Record<string, Record<string, unknown>>
): Record<string, DecisionAnswer> => {
  const answers: Record<string, DecisionAnswer> = {}
  for (const [key, q] of Object.entries(questions)) {
    const item = rawOut[key] ?? {}
    if (q.type === 'noul') {
      const noul = Math.min(1, Math.max(0, Number(item.noul ?? 0)))
      const conf = Math.min(1, Math.max(0, Number(item.confidence ?? Math.max(noul, 1 - noul))))
      answers[key] = { type: 'noul', noul, confidence: conf }
    } else if (q.type === 'choice') {
      const chosen = String(item.choice ?? Object.keys(q.criteria)[0] ?? '')
      const conf = Math.min(1, Math.max(0, Number(item.confidence ?? 0.8)))
      answers[key] = { type: 'choice', choice: chosen, probabilities: { [chosen]: conf }, confidence: conf }
    } else {
      const sc = Number(item.score ?? 0)
      const conf = Math.min(1, Math.max(0, Number(item.confidence ?? 0.8)))
      answers[key] = { type: 'score', score: sc, probabilities: {}, confidence: conf }
    }
  }
  return answers
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
