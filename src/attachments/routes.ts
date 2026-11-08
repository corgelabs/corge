import { core } from '../index'
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
    shortCircuit: ({ input }: { input: ScanAttachmentInput }) => core.internals.context.scanShortCircuit({ input }),
    handler: ({ input, step }: { input: ScanAttachmentInput; step: StepRunner }) =>
      core.attachments.scan(input, { step })
  },
  'attachments.process': {
    mode: 'workflow' as const,
    input: processAttachmentsInput,
    output: processAttachmentsOutput,
    handler: ({ input, step }: { input: ProcessAttachmentsInput; step: StepRunner }) =>
      core.attachments.process(input, { step })
  }
}
