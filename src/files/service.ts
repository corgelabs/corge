import { createHash } from 'node:crypto'
import type { Bucket } from '@google-cloud/storage'
import type { DbRole } from '../config'
import {
  entryId,
  type DbListOptions,
  type EntryId,
  type PaginatedList,
  type SelectModel
} from '../db'
import type { Core } from '../index'
import {
  fileBody,
  fileRef,
  signedUploadInput,
  type FileBody,
  type FileRef,
  type FileType,
  type SignedDownloadUrlResult,
  type SignedUploadInput,
  type SignedUploadUrlResult
} from './schema'
import { canAccessFile } from './utils'

export class FilesService {
  readonly #core: Core

  constructor(coreClient: Core) {
    this.#core = coreClient
  }

  bucket = (isDev: boolean = this.#core.env.isDev): Bucket => this.#core.db.bucket(isDev)

  canAccess = (
    ref: string,
    userId: EntryId = this.#core.userId,
    role: DbRole = this.#core.role
  ): boolean => canAccessFile(userId, ref, role)

  #assertAccess = (ref: FileRef): void => {
    if (!this.canAccess(ref)) this.#core.errors.httpError(403, 'Forbidden: file access denied', 'FORBIDDEN')
  }

  upload = async (
    file: FileBody,
    userId: EntryId = this.#core.userId || this.#core.config.auth.adminUserId
  ): Promise<{ ref: FileRef }> => {
    entryId.parse(userId)
    fileBody.parse(file)
    const shaSum = createHash('sha256').update(file.bytes).digest('hex').slice(0, 24)
    const ref = fileRef.parse(`${userId}_${shaSum}`)
    const existing = await this.#core.db.read('file', ref, true, { bypassRbac: true })
    const step = this.#core.step

    if (!existing) {
      await step(
        'upload-storage',
        async () => {
          await this.#core.internals.resilience.acquireLimit('storage')
          await this.bucket().file(ref).save(Buffer.from(file.bytes), {
            resumable: false,
            contentType: file.type,
            metadata: {
              cacheControl: 'private, max-age=31536000, immutable',
              metadata: { fileName: file.name, userId, shaSum }
            }
          })
        },
        {
          rollback: async () => {
            await this.#core.internals.resilience.acquireLimit('storage')
            await this.bucket().file(ref).delete({ ignoreNotFound: true })
          }
        }
      )
    }

    await step(
      'upload-meta',
      async () => {
        if (!existing) {
          await this.#core.db.create(
            'file',
            {
              id: ref,
              shaSum,
              fileName: file.name,
              contentType: file.type,
              size: file.bytes.byteLength,
              userId,
              scan: null,
              scanError: null,
              deleted: false
            },
            { bypassRbac: true }
          )
        } else if (existing.deleted) {
          await this.#core.db.update('file', ref, { deleted: false, fileName: file.name }, { bypassRbac: true })
        }
      },
      {
        rollback: async () => {
          if (!existing) await this.#core.db.hardDelete('file', ref, { bypassRbac: true }).catch(() => {})
          else if (existing.deleted) {
            await this.#core.db.update('file', ref, { deleted: true }, { bypassRbac: true }).catch(() => {})
          }
        }
      }
    )

    return { ref }
  }

  #signGcsUrl = async (
    ref: FileRef,
    action: 'read' | 'write',
    expiresMs: number,
    contentType?: FileType
  ): Promise<string> => {
    await this.#core.internals.resilience.acquireLimit('storage')
    const bucket = this.bucket()
    try {
      const [signed] = await bucket.file(ref).getSignedUrl({
        version: 'v4',
        action,
        expires: expiresMs,
        ...(contentType ? { contentType } : {})
      })
      return signed
    } catch (err) {
      if (!this.#core.env.isDev && Boolean(process.env.K_SERVICE)) {
        return this.#core.errors.httpError(502, 'Failed to generate signed file URL', 'GCS_SIGN_FAILED')
      }
      const query = action === 'write' ? `uploadType=media&expires=${expiresMs}` : `alt=media&expires=${expiresMs}`
      return `https://storage.googleapis.com/${bucket.name}/${encodeURIComponent(ref)}?${query}`
    }
  }

  getSignedUploadUrl = async (
    rawInput: SignedUploadInput,
    userId: EntryId = this.#core.userId || this.#core.config.auth.adminUserId,
    expiresInMs = 15 * 60_000
  ): Promise<SignedUploadUrlResult> => {
    entryId.parse(userId)
    const input = signedUploadInput.parse(rawInput)
    const shaSum = input.sha256.toLowerCase().slice(0, 24)
    const ref = fileRef.parse(`${userId}_${shaSum}`)
    const existing = await this.#core.db.read('file', ref, true, { bypassRbac: true })
    const expiresMs = Date.now() + Math.max(60_000, expiresInMs)
    const expiresAt = new Date(expiresMs).toISOString()

    if (existing && !existing.deleted) {
      return { ref, url: '', expiresAt, deduplicated: true }
    }

    const url = await this.#signGcsUrl(ref, 'write', expiresMs, input.type)
    return { ref, url, expiresAt, deduplicated: false }
  }

  getSignedDownloadUrl = async (ref: FileRef, expiresInMs = 15 * 60_000): Promise<SignedDownloadUrlResult> => {
    fileRef.parse(ref)
    this.#assertAccess(ref)
    const doc = await this.#core.db.read('file', ref, false, { bypassRbac: true })
    if (!doc) this.#core.errors.httpError(404, `File not found: ${ref}`, 'NOT_FOUND')

    const expiresMs = Date.now() + Math.max(60_000, expiresInMs)
    const expiresAt = new Date(expiresMs).toISOString()
    const url = await this.#signGcsUrl(ref, 'read', expiresMs)
    return { ref, url, expiresAt }
  }

  download = async (ref: FileRef): Promise<Buffer> => {
    await this.#core.internals.resilience.acquireLimit('storage')
    try {
      return (await this.bucket().file(ref).download())[0]
    } catch {
      throw new Error(`File not found: ${ref}`)
    }
  }

  get = async (ref: FileRef): Promise<FileBody> => {
    fileRef.parse(ref)
    this.#assertAccess(ref)
    const [bytes, doc] = await Promise.all([
      this.download(ref),
      this.#core.db.read('file', ref, false, { bypassRbac: true })
    ])
    if (!doc) throw new Error(`File not found: ${ref}`)
    return fileBody.parse({
      bytes,
      name: doc.fileName || ref,
      type: (doc.contentType as FileType) || 'application/pdf'
    })
  }

  list = async (options?: DbListOptions<SelectModel<'file'>>): Promise<PaginatedList<SelectModel<'file'>>> =>
    this.#core.db.list('file', {
      ...(this.#core.userId && this.#core.role !== 'admin' ? { userId: this.#core.userId } : {}),
      ...options
    })

  delete = async (ref: FileRef): Promise<{ ref: FileRef; deleted: true }> => {
    fileRef.parse(ref)
    this.#assertAccess(ref)
    await this.#core.db.delete('file', ref, { bypassRbac: true })
    return { ref, deleted: true }
  }

  hardDelete = async (ref: FileRef): Promise<{ ref: FileRef }> => {
    fileRef.parse(ref)
    this.#assertAccess(ref)
    const step = this.#core.step
    await step(
      'hard-delete-file',
      async () => {
        const prev = await this.#core.db.read('file', ref, true, { bypassRbac: true })
        await this.#core.db.hardDelete('file', ref, { bypassRbac: true })
        return prev ?? null
      },
      {
        rollback: async (prev) => {
          if (!prev) return
          await this.#core.db
            .firestore()
            .collection('file')
            .doc(ref)
            .set({
              ...prev,
              createdAt: prev.createdAt ? new Date(prev.createdAt) : new Date(),
              updatedAt: new Date()
            })
            .catch(() => {})
        }
      }
    )
    return { ref }
  }
}
