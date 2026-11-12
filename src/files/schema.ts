import { z } from 'zod'
import { CORGE_CONFIG } from '../config'
import {
  fileRef,
  fileScan,
  fileScanError,
  unparseableReason,
  type FileRef,
  type FileScan,
  type FileScanError,
  type UnparseableReason
} from '../db'
import { hasValidMagicBytes } from './utils'

export {
  fileRef,
  fileScan,
  fileScanError,
  unparseableReason,
  type FileRef,
  type FileScan,
  type FileScanError,
  type UnparseableReason
}

export const fileType = z.enum([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/tiff',
  'image/avif'
])
export type FileType = z.infer<typeof fileType>

export const fileBody = z
  .object({
    bytes: z
      .instanceof(Uint8Array)
      .refine((b) => b.byteLength > 0 && b.byteLength <= CORGE_CONFIG.limits.maxFileBytes, 'File size must be 1B..20MiB'),
    name: z.string().min(1).max(256),
    type: fileType
  })
  .refine((f) => hasValidMagicBytes(f.type, f.bytes), {
    message: 'File binary header does not match declared MIME type',
    path: ['bytes']
  })
export type FileBody = z.infer<typeof fileBody>

export const signedUploadInput = z.object({
  sha256: z.string().regex(/^[a-fA-F0-9]{24,64}$/, 'Invalid SHA-256 hex digest'),
  name: z.string().min(1).max(256),
  type: fileType,
  size: z
    .number()
    .int()
    .positive()
    .refine((s) => s <= CORGE_CONFIG.limits.maxFileBytes, 'File size exceeds maxFileBytes')
    .optional()
})
export type SignedUploadInput = z.infer<typeof signedUploadInput>

export interface SignedUploadUrlResult {
  ref: FileRef
  url: string
  expiresAt: string
  deduplicated: boolean
}

export interface SignedDownloadUrlResult {
  ref: FileRef
  url: string
  expiresAt: string
}
