import type { JevQuestion } from '../ai'
import type { SelectModel } from '../db'
import { fileScan, fileScanError, type FileRef, type FileScan, type FileScanError } from '../files'
import type { Corge } from '../index'
import type { StepRunner } from '../tasks'
import {
  getRegisteredAttachmentTypes,
  processAttachmentsOutput,
  scanAttachmentInput,
  scanAttachmentOutput,
  type AttachmentTypesMap,
  type ProcessedAttachment,
  type ProcessAttachmentsInput,
  type ProcessAttachmentsOutput,
  type ScanAttachmentInput,
  type ScanAttachmentOutput
} from './schema'
import {
  buildScanError,
  classifyPermanentScanDefect,
  extractAttachmentTasks,
  parseFields,
  schemaFor
} from './utils'

export class AttachmentsService {
  readonly #corge: Corge

  constructor(corgeClient: Corge) {
    this.#corge = corgeClient
  }

  #wrapScanStep = async <T>(fn: () => Promise<T>, onDefect: (defect: FileScanError) => void): Promise<T> => {
    try {
      return await fn()
    } catch (err) {
      const defect = classifyPermanentScanDefect(err)
      if (defect) {
        onDefect(defect)
        return this.#corge.errors.nonRetryableError(defect.agentHint, defect.reason)
      }
      throw err
    }
  }

  #findCrossUserByShaSum = async (
    ref: FileRef,
    shaSum: string,
    requestedType?: string
  ): Promise<{ scan?: FileScan; scanError?: FileScanError } | undefined> => {
    if (!shaSum || shaSum.length < 24) return undefined
    try {
      await this.#corge.internals.resilience.acquireLimit('firestore')
      const snap = await this.#corge.db.firestore().collection('file').where('shaSum', '==', shaSum).limit(5).get()
      for (const doc of snap.docs) {
        if (doc.id === ref) continue
        const data = doc.data()
        if (data.deleted === true) continue
        if (data.scan) {
          const parsedScan = fileScan.safeParse(data.scan)
          if (parsedScan.success && (!requestedType || parsedScan.data.type === requestedType)) {
            return { scan: parsedScan.data }
          }
        }
        if (data.scanError) {
          const parsedErr = fileScanError.safeParse(data.scanError)
          if (parsedErr.success) {
            return { scanError: parsedErr.data }
          }
        }
      }
    } catch {}
    return undefined
  }

  classify = async (
    attachmentContent: string,
    types: AttachmentTypesMap = getRegisteredAttachmentTypes()
  ): Promise<{ attachmentType: string; confidence: number }> => {
    const entries = Object.entries(types)
    if (!entries.length) return { attachmentType: 'other', confidence: 1 }
    const questions: Record<string, JevQuestion> = {
      documentType: {
        type: 'choice',
        instructions:
          'Classify the attached document (its full text is the state) into exactly one type. Choose "other" when it matches none of the specific types.',
        criteria: {
          ...Object.fromEntries(entries.map(([k, v]) => [k, v.description])),
          other: 'Unrecognized document, plain image/diagram, or none of the specific attachment types'
        }
      }
    }
    const { answers } = await this.#corge.ai.decide({ document: attachmentContent.slice(0, 80_000) }, questions)
    const ans = answers.documentType
    return ans?.type === 'choice'
      ? { attachmentType: ans.choice, confidence: ans.confidence }
      : { attachmentType: 'other', confidence: 0 }
  }

  #executeScanOcrAndClassify = async (opts: {
    ref: FileRef
    contentType: string
    initialType?: string
    types: AttachmentTypesMap
    step: StepRunner
    onDefect: (d: FileScanError) => void
  }): Promise<FileScan> => {
    const { ref, contentType, initialType, types, step, onDefect } = opts
    const isImage = contentType.startsWith('image/')
    let dataUrlP: Promise<string> | undefined
    const getDataUrl = () =>
      (dataUrlP ??= (async () =>
        `data:${contentType};base64,${(await this.#corge.files.download(ref)).toString('base64')}`)())

    const hasTypes = Object.keys(types).length > 0
    let resolvedType: string | undefined = hasTypes ? initialType : 'other'
    let confidence = 1
    let markdown = ''

    if (!resolvedType || resolvedType === 'other') {
      const ocrRes = await step('ocr', ({ signal }) =>
        this.#wrapScanStep(async () => this.#corge.ai.vision(await getDataUrl(), { signal }), onDefect)
      )
      markdown = ocrRes.markdown
      if (!markdown) {
        markdown = await step('vision', ({ signal }) =>
          this.#wrapScanStep(async () => this.#corge.ai.describeImage(await getDataUrl(), signal), onDefect)
        )
        resolvedType = 'other'
      } else {
        if (!resolvedType) {
          const classified = await step('classify', () =>
            this.#wrapScanStep(() => this.classify(markdown, types), onDefect)
          )
          resolvedType = classified.attachmentType
          confidence = classified.confidence
        }
        if (hasTypes && resolvedType === 'other' && isImage) {
          const visionDesc = await step('vision', ({ signal }) =>
            this.#wrapScanStep(async () => this.#corge.ai.describeImage(await getDataUrl(), signal), onDefect)
          )
          markdown = `${markdown}\n\n${visionDesc}`.trim()
        }
      }
    }

    let fields: Record<string, unknown> = {}
    const schema = resolvedType && resolvedType !== 'other' ? schemaFor(resolvedType, types) : undefined
    if (schema && resolvedType) {
      const extract = await step('extract', ({ signal }) =>
        this.#wrapScanStep(async () => this.#corge.ai.vision(await getDataUrl(), { schema, signal }), onDefect)
      )
      fields = parseFields(resolvedType, extract.annotation, types)
      if (!markdown) markdown = extract.markdown
    }

    if (markdown.trim().length < 5 && Object.keys(fields).length === 0) {
      const defect = buildScanError(
        'EMPTY_OR_UNREADABLE',
        'The uploaded document appears blank or unreadable (fewer than 5 characters detected). Please upload a clear, legible scan or photo of the document.'
      )
      onDefect(defect)
      return this.#corge.errors.nonRetryableError(defect.agentHint, defect.reason)
    }

    return { type: resolvedType ?? 'other', confidence, fields, markdown }
  }

  scan = async (
    raw: ScanAttachmentInput,
    opts?: { types?: AttachmentTypesMap; step?: StepRunner; preloadedFile?: SelectModel<'file'> }
  ): Promise<ScanAttachmentOutput> => {
    const step = opts?.step ?? this.#corge.step
    const types = opts?.types ?? getRegisteredAttachmentTypes()
    const preloadedFile = opts?.preloadedFile
    const { ref, type } = scanAttachmentInput.parse(raw)
    if (type && type !== 'other' && Object.keys(types).length > 0 && !(type in types)) {
      throw new Error(`Invalid attachment type: ${type}`)
    }

    return this.#corge.internals.resilience.singleflight(
      `scan:${this.#corge.env.isDev ? 'dev' : 'prod'}:${ref}:${type ?? ''}`,
      async () => {
        const entry =
          preloadedFile ?? (await step('read-meta', () => this.#corge.db.read('file', ref, false, { bypassRbac: true })))
        if (!entry) throw new Error(`File not found: ${ref}`)
        if (entry.scan) return scanAttachmentOutput.parse(entry.scan)
        if (entry.scanError) {
          return this.#corge.errors.nonRetryableError(entry.scanError.agentHint, entry.scanError.reason)
        }

        const shaSum = entry.shaSum || ref.slice(-24)
        const crossUserMatch = await this.#findCrossUserByShaSum(ref, shaSum, type)
        if (crossUserMatch?.scan) {
          await step('persist', () =>
            this.#corge.db.update('file', ref, { scan: crossUserMatch.scan!, scanError: null }, { bypassRbac: true })
          )
          return scanAttachmentOutput.parse(crossUserMatch.scan)
        }
        if (crossUserMatch?.scanError) {
          await this.#corge.db
            .update('file', ref, { scanError: crossUserMatch.scanError, scan: null }, { bypassRbac: true })
            .catch(() => {})
          return this.#corge.errors.nonRetryableError(
            crossUserMatch.scanError.agentHint,
            crossUserMatch.scanError.reason
          )
        }

        let capturedDefect: FileScanError | undefined
        try {
          const scan = await this.#executeScanOcrAndClassify({
            ref,
            contentType: entry.contentType || 'application/pdf',
            initialType: type,
            types,
            step,
            onDefect: (d) => {
              capturedDefect = d
            }
          })
          await step('persist', () =>
            this.#corge.db.update('file', ref, { scan, scanError: null }, { bypassRbac: true })
          )
          return scanAttachmentOutput.parse(scan)
        } catch (err) {
          const defect = capturedDefect ?? classifyPermanentScanDefect(err)
          if (defect) {
            await this.#corge.db
              .update('file', ref, { scanError: defect, scan: null }, { bypassRbac: true })
              .catch(() => {})
            if (err instanceof this.#corge.errors.NonRetryableError) throw err
            return this.#corge.errors.nonRetryableError(defect.agentHint, defect.reason)
          }
          throw err
        }
      }
    )
  }

  #scanShortCircuit = async ({ input }: { input: ScanAttachmentInput }): Promise<ScanAttachmentOutput | undefined> => {
    const entry = await this.#corge.db.read('file', input.ref, false, { bypassRbac: true })
    if (entry?.scan) return scanAttachmentOutput.parse(entry.scan)
    if (entry?.scanError) {
      return this.#corge.errors.nonRetryableError(entry.scanError.agentHint, entry.scanError.reason)
    }
    return undefined
  }

  #scanTask = async ({
    input,
    step,
    types,
    preloadedFile
  }: {
    input: ScanAttachmentInput
    step: StepRunner
    types?: AttachmentTypesMap
    preloadedFile?: SelectModel<'file'>
  }): Promise<ProcessedAttachment> => {
    try {
      return { ref: input.ref, scan: await this.scan(input, { step, types, preloadedFile }) }
    } catch (err) {
      if (this.#corge.errors.isNonRetryableError(err)) {
        return { ref: input.ref, error: err instanceof Error ? err.message : String(err) }
      }
      return { ref: input.ref, error: 'Temporary scanning service unavailability. Please retry.' }
    }
  }

  process = async (
    raw: ProcessAttachmentsInput,
    opts?: { types?: AttachmentTypesMap; step?: StepRunner }
  ): Promise<ProcessAttachmentsOutput> => {
    const tasks = extractAttachmentTasks(raw)
    const step = opts?.step ?? this.#corge.step

    const uniqueRefs = [...new Set(tasks.map((t) => t.ref))]
    const existingFiles = await this.#corge.db.list('file', { ids: uniqueRefs }, { bypassRbac: true })
    const fileMap = new Map<FileRef, SelectModel<'file'>>(existingFiles.map((f) => [f.id, f]))

    const attachments = await step.map(
      'process-attachments',
      tasks,
      (taskInput) =>
        this.#scanTask({
          input: taskInput,
          step: this.#corge.internals.workflows.createStepRunner('workflow'),
          types: opts?.types,
          preloadedFile: fileMap.get(taskInput.ref)
        }),
      {
        timeout: `${this.#corge.config.tasks.scanDeadlineSeconds}s`,
        shortCircuit: (taskInput) => {
          const fileDoc = fileMap.get(taskInput.ref)
          if (fileDoc?.scan) {
            return { ref: taskInput.ref, scan: scanAttachmentOutput.parse(fileDoc.scan) }
          }
          if (fileDoc?.scanError) {
            return { ref: taskInput.ref, error: fileDoc.scanError.agentHint }
          }
          return undefined
        }
      }
    )

    return processAttachmentsOutput.parse({ attachments })
  }

  get internals() {
    return {
      scanShortCircuit: this.#scanShortCircuit
    }
  }
}
