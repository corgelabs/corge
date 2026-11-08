import { z } from 'zod'
import type { FileScanError, UnparseableReason } from '../files'
import {
  getRegisteredAttachmentTypes,
  processAttachmentsInput,
  type AttachmentTypesMap,
  type ProcessAttachmentsInput,
  type ScanAttachmentInput
} from './schema'

export const schemaFor = (
  type: string,
  types: AttachmentTypesMap = getRegisteredAttachmentTypes()
): Record<string, unknown> | undefined =>
  type in types ? (z.toJSONSchema(types[type]!.schema, { io: 'output' }) as Record<string, unknown>) : undefined

export const parseFields = (
  type: string,
  fields: Record<string, unknown>,
  types: AttachmentTypesMap = getRegisteredAttachmentTypes()
): Record<string, unknown> => (type in types ? (types[type]!.schema.parse(fields) as Record<string, unknown>) : {})

export const extractAttachmentTasks = (input: ProcessAttachmentsInput): ScanAttachmentInput[] =>
  processAttachmentsInput.parse(input).refs.map((item) => (typeof item === 'string' ? { ref: item } : item))

export const buildScanError = (
  reason: UnparseableReason,
  agentHint: string,
  diagnosticMessage?: string
): FileScanError => ({
  status: 'unparseable',
  reason,
  agentHint,
  ...(diagnosticMessage ? { diagnosticMessage: diagnosticMessage.slice(0, 500) } : {}),
  failedAt: new Date().toISOString()
})

export const extractHttpStatus = (err: unknown): number | undefined => {
  if (!err || typeof err !== 'object') return undefined
  const rec = err as Record<string, unknown>
  if (typeof rec.statusCode === 'number') return rec.statusCode
  if (typeof rec.status === 'number') return rec.status
  const msg = err instanceof Error ? err.message : String(err)
  const match = /\b(?:status(?:\s+code)?|http)\s*[:=]?\s*(4\d\d|5\d\d)\b/i.exec(msg)
  return match?.[1] ? Number(match[1]) : undefined
}

const TRANSIENT_TOKENS = ['aborted', 'timed out', 'econnreset', 'etimedout', 'socket hang up', 'rate limit']

const DEFECT_RULES: ReadonlyArray<{
  reason: UnparseableReason
  hint: string
  match: (status: number | undefined, lower: string) => boolean
}> = [
  {
    reason: 'PASSWORD_PROTECTED',
    hint: 'This document is password-protected or encrypted and cannot be read. Please upload an unlocked copy of the document.',
    match: (_, lower) => lower.includes('password') || lower.includes('encrypted')
  },
  {
    reason: 'UNSUPPORTED_FORMAT',
    hint: 'This file format is not supported by the document scanner. Please upload a valid PDF or standard image (JPEG, PNG, WebP).',
    match: (status, lower) =>
      status === 415 || lower.includes('unsupported media') || lower.includes('unsupported format')
  },
  {
    reason: 'EMPTY_OR_UNREADABLE',
    hint: 'The uploaded document appears blank or unreadable. Please upload a clear, legible scan or photo of the document.',
    match: (_, lower) =>
      lower.includes('empty description') ||
      lower.includes('empty_or_unreadable') ||
      lower.includes('no readable text')
  },
  {
    reason: 'CLASSIFICATION_REJECTED',
    hint: 'The document could not be classified into a valid document type. Please upload a clear, complete document.',
    match: (_, lower) => lower.includes('classification_rejected')
  },
  {
    reason: 'CORRUPTED_FILE',
    hint: 'This file appears corrupted or malformed and could not be parsed. Please export or re-upload a valid PDF or image file.',
    match: (status, lower) =>
      status === 400 ||
      status === 422 ||
      lower.includes('corrupt') ||
      lower.includes('malformed') ||
      lower.includes('invalid pdf') ||
      lower.includes('invalid image') ||
      lower.includes('failed to process document') ||
      lower.includes('could not parse')
  }
]

export const classifyPermanentScanDefect = (err: unknown): FileScanError | null => {
  if (!err) return null
  const bodyStr =
    typeof err === 'object' && 'body' in err && typeof (err as { body?: unknown }).body === 'string'
      ? (err as { body: string }).body
      : ''
  const msg = `${err instanceof Error ? err.message : String(err)} ${bodyStr}`.trim()
  const lower = msg.toLowerCase()
  const status = extractHttpStatus(err)

  if (
    status === 408 ||
    status === 429 ||
    (status !== undefined && status >= 500) ||
    TRANSIENT_TOKENS.some((t) => lower.includes(t))
  ) {
    return null
  }

  const matched = DEFECT_RULES.find((rule) => rule.match(status, lower))
  return matched ? buildScanError(matched.reason, matched.hint, msg) : null
}
