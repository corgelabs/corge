import type { Context } from 'hono'
import type { AppEnv } from '../config'
import type { EntryId } from '../db'
import { corge } from '../index'
import type { FileType } from './schema'

export const coreFilesRoutes = {
  'files.list': {
    handler: async ({ userId }: { userId: EntryId }) => corge.db.list('file', { userId }, { bypassRbac: true })
  },
  'files.upload': {
    handler: async ({ c, userId }: { c: Context<AppEnv>; userId: EntryId }) => {
      const file = (await c!.req.formData()).get('file')
      if (!(file instanceof File)) return corge.errors.httpError(400, 'Missing "file" field', 'INVALID_FILE')
      return corge.files.upload(
        {
          bytes: new Uint8Array(await file.arrayBuffer()),
          name: file.name || 'upload',
          type: file.type as FileType
        },
        userId
      )
    }
  },
  'files.get': {
    handler: async ({ c }: { c: Context<AppEnv> }) => {
      const ref = c!.req.param('ref') ?? ''
      if (c!.req.query('meta') === 'true') {
        const entry = await corge.db.read('file', ref, false, { bypassRbac: true })
        return entry ?? corge.errors.httpError(404, 'File not found', 'NOT_FOUND')
      }
      if (c!.req.query('signed') === 'true') {
        return corge.files.getSignedDownloadUrl(ref)
      }
      const { bytes, type } = await corge.files.get(ref)
      return new Response(Buffer.from(bytes), {
        headers: { 'content-type': type, 'cache-control': 'private, max-age=3600, immutable' }
      })
    }
  },
  'files.delete': {
    handler: async ({ c }: { c: Context<AppEnv> }) => corge.files.delete(c!.req.param('ref') ?? '')
  }
}
