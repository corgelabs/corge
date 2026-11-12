import { corge } from '../index'
import type { StepRunner } from '../tasks'
import {
  processAttachmentsInput,
  processAttachmentsOutput,
  scanAttachmentInput,
  scanAttachmentOutput,
  type ProcessAttachmentsInput,
  type ScanAttachmentInput
} from './schema'

export const coreAttachmentsRoutes = {
  'attachments.scan': {
    mode: 'workflow' as const,
    input: scanAttachmentInput,
    output: scanAttachmentOutput,
    shortCircuit: ({ input }: { input: ScanAttachmentInput }) => corge.internals.context.scanShortCircuit({ input }),
    handler: ({ input, step }: { input: ScanAttachmentInput; step: StepRunner }) =>
      corge.attachments.scan(input, { step })
  },
  'attachments.process': {
    mode: 'workflow' as const,
    input: processAttachmentsInput,
    output: processAttachmentsOutput,
    handler: ({ input, step }: { input: ProcessAttachmentsInput; step: StepRunner }) =>
      corge.attachments.process(input, { step })
  }
}
