import { z } from 'zod'
import { CORE_CONFIG } from '../config'
import { fileRef, fileScan } from '../files'

export const processedAttachment = z.union([
  z.object({ ref: fileRef, scan: fileScan }),
  z.object({ ref: fileRef, error: z.string() })
])
export type ProcessedAttachment = z.infer<typeof processedAttachment>

export interface AttachmentTypeSpec<S extends z.ZodType = z.ZodType> {
  description: string
  schema: S
}
export type AttachmentTypesMap = Record<string, AttachmentTypeSpec>

export const defineAttachmentTypes = <T extends AttachmentTypesMap>(types: T): T => types

const registeredAttachmentTypes: AttachmentTypesMap = {}

export const registerAttachmentTypes = (types?: AttachmentTypesMap, reset = false): void => {
  if (reset) {
    for (const k of Object.keys(registeredAttachmentTypes)) delete registeredAttachmentTypes[k]
  }
  if (!types) return
  Object.assign(registeredAttachmentTypes, types)
}

export const getRegisteredAttachmentTypes = (): AttachmentTypesMap => registeredAttachmentTypes

export const scanAttachmentInput = z.object({ ref: fileRef, type: z.string().optional() })
export const scanAttachmentOutput = fileScan
export type ScanAttachmentInput = z.input<typeof scanAttachmentInput>
export type ScanAttachmentOutput = z.infer<typeof scanAttachmentOutput>

export const attachmentInput = z.union([fileRef, scanAttachmentInput])
export const processAttachmentsInput = z.object({
  refs: z
    .array(attachmentInput)
    .min(1)
    .refine((arr) => arr.length <= CORE_CONFIG.limits.maxAttachments, 'Too many attachments')
})
export const processAttachmentsOutput = z.object({ attachments: z.array(processedAttachment) })
export type ProcessAttachmentsInput = z.input<typeof processAttachmentsInput>
export type ProcessAttachmentsOutput = z.infer<typeof processAttachmentsOutput>
