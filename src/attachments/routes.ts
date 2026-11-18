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

export const corgeAttachmentsRoutes = {
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
    shortCircuit: ({ input }: { input: ProcessAttachmentsInput }) =>
      corge.internals.context.processShortCircuit({ input }),
    handler: ({ input, step }: { input: ProcessAttachmentsInput; step: StepRunner }) =>
      corge.attachments.process(input, { step })
  }
}
