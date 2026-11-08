import type { OCRPageObject } from '@mistralai/mistralai/models/components'
import type { AiUsageSummary } from './schema'

export const formatOcrPages = (pages: OCRPageObject[]): string =>
  pages
    .map((p, i) => {
      const text = p.blocks
        ? p.blocks
            .filter(
              (b) =>
                b.type !== 'image' &&
                ('confidenceScores' in b ? (b.confidenceScores?.averageContentConfidenceScore ?? 1) : 1) >= 0.5
            )
            .map((b) => ('content' in b ? b.content.trim() : ''))
            .filter(Boolean)
            .join('\n\n')
        : p.markdown.replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim()
      return text ? `### Page ${i + 1}\n${text}` : ''
    })
    .filter(Boolean)
    .join('\n\n')

export const normalizeUsage = (
  model: string,
  raw?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; tokens?: number } | null,
  pages?: number
): AiUsageSummary => {
  const inputTokens = raw?.inputTokens ?? raw?.tokens ?? 0
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
