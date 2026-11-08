import { Agent } from 'node:https'
import { getApp, getApps, initializeApp } from 'firebase-admin/app'
import { FieldValue, getFirestore, type Firestore } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'
import { CORE_CONFIG, type DbAction, type DbRole } from '../config'
import { Core } from '../index'
import type { StepRunner } from '../tasks'
import {
  collectionRegistry,
  getCollectionDef,
  type CollectionName,
  type DbCallContext,
  type DbListOptions,
  type DbListPage,
  type EntryId,
  type InsertData,
  type PaginatedList,
  type SelectModel,
  type UpdateData
} from './schema'
import {
  attachNextCursor,
  buildScopedCollectionQuery,
  drainQueryBatchDelete,
  executeFilteredListQuery,
  fromFirestoreDoc,
  isCreateOwnScopeAllowed,
  resolveAllowedScope,
  resolveJunction,
  runChunked,
  stripImmutableUpdateFields,
  wireCoreCollectionHooks
} from './utils'

type StorageBucket = ReturnType<ReturnType<typeof getStorage>['bucket']>

const dbs: [Firestore | undefined, Firestore | undefined] = [undefined, undefined]
const buckets: [StorageBucket | undefined, StorageBucket | undefined] = [undefined, undefined]

let cachedToken = ''
let cachedTokenExp = 0

export class DbService {
  readonly #core: Core

  constructor(coreClient: Core) {
    this.#core = coreClient
    wireCoreCollectionHooks()
  }

  #ensureFirebaseApp = (): void => {
    if (!getApps().length) {
      initializeApp({
        projectId: CORE_CONFIG.gcpProject,
        storageBucket: CORE_CONFIG.storageBuckets.prod,
        serviceAccountId: CORE_CONFIG.serviceAccount,
        httpAgent: new Agent({ keepAlive: true })
      })
    }
  }

  firestore = (isDev: boolean = this.#core.env.isDev): Firestore => {
    this.#ensureFirebaseApp()
    const idx = isDev ? 1 : 0
    if (!dbs[idx]) {
      const db = getFirestore(isDev ? CORE_CONFIG.firestoreDbs.dev : CORE_CONFIG.firestoreDbs.prod)
      try {
        db.settings({ ignoreUndefinedProperties: true })
      } catch {}
      dbs[idx] = db
    }
    return dbs[idx]!
  }

  bucket = (isDev: boolean = this.#core.env.isDev): StorageBucket => {
    this.#ensureFirebaseApp()
    const idx = isDev ? 1 : 0
    if (!buckets[idx]) {
      buckets[idx] = getStorage().bucket(isDev ? CORE_CONFIG.storageBuckets.dev : CORE_CONFIG.storageBuckets.prod)
    }
    return buckets[idx]!
  }

  #getGcpAccessToken = async (): Promise<string> => {
    this.#ensureFirebaseApp()
    if (cachedToken && cachedTokenExp > Date.now() + 60_000) return cachedToken
    return this.#core.internals.resilience.singleflight(
      'gcp:token',
      async () => {
        const token = await getApp().options.credential?.getAccessToken()
        if (!token?.access_token) throw new Error('Unable to acquire GCP ADC access token')
        cachedToken = token.access_token
        cachedTokenExp = Date.now() + (token.expires_in ? token.expires_in * 1000 : 3_000_000)
        return cachedToken
      },
      { scope: 'global' }
    )
  }

  #effectiveCtx = (ctx?: DbCallContext): DbCallContext => ({
    userId: this.#core.userId,
    userRole: this.#core.role,
    ...ctx
  })

  #resolveRole = (ctx?: DbCallContext): DbRole =>
    this.#core.internals.auth.resolveUserRole(ctx?.userId, ctx?.userRole)

  #isEntryOwner = async (
    collection: CollectionName,
    doc: Record<string, any>,
    userId: EntryId
  ): Promise<boolean> => {
    if (!userId) return false
    if (userId === this.#core.config.auth.adminUserId) return true
    const def = getCollectionDef(collection)
    const rel = def.userRelation?.type ?? '1:N'
    if (rel === 'global') return false
    if (rel === '1:1') return doc[def.userRelation?.userField ?? 'id'] === userId
    if (rel === '1:N') return doc[def.userRelation?.userField ?? 'userId'] === userId
    if (rel === 'M:N' && def.userRelation?.junction) {
      const { collection: jCol, userField, targetField } = resolveJunction(collection, def.userRelation.junction)
      const jSnap = await this.firestore()
        .collection(jCol)
        .where(userField, '==', userId)
        .where(targetField, '==', doc.id)
        .limit(1)
        .get()
      return !jSnap.empty
    }
    const arr = doc[def.userRelation?.userIdsField ?? 'userIds']
    return Array.isArray(arr) && arr.includes(userId)
  }

  #fetchRawEntry = async <T extends CollectionName>(
    collection: T,
    id: string
  ): Promise<SelectModel<T> | undefined> => {
    if (!id) return undefined
    await this.#core.internals.resilience.acquireLimit('firestore')
    const snap = await this.firestore().collection(collection).doc(id).get()
    if (!snap.exists) return undefined
    const doc = fromFirestoreDoc(collection, snap.id, snap.data() ?? {})
    return doc.deleted ? undefined : doc
  }

  canAccess = async <N extends CollectionName>(
    collection: N,
    docOrId: string | Record<string, any> | undefined,
    userId: EntryId = this.#core.userId,
    action: DbAction = 'read',
    userRole?: DbRole
  ): Promise<boolean> => {
    const role = this.#resolveRole({
      userId,
      userRole: userRole ?? (userId === this.#core.userId ? this.#core.role : undefined)
    })
    const scope = resolveAllowedScope(collection, role, action)
    if (scope === 'none') return false
    if (scope === 'any') {
      if (!docOrId) return true
      return typeof docOrId === 'string' ? Boolean(await this.#fetchRawEntry(collection, docOrId)) : true
    }
    if (!userId) return false
    const doc =
      typeof docOrId === 'string'
        ? await this.#fetchRawEntry(collection, docOrId)
        : (docOrId as Record<string, any> | undefined)
    return doc ? this.#isEntryOwner(collection, doc, userId) : false
  }

  create = async <N extends CollectionName>(
    collection: N,
    data: InsertData<N>,
    ctx?: DbCallContext
  ): Promise<SelectModel<N>> => {
    const effective = this.#effectiveCtx(ctx)
    if (!effective.bypassRbac) {
      const role = this.#resolveRole(effective)
      const scope = resolveAllowedScope(collection, role, 'create')
      if (scope === 'none') this.#core.errors.httpError(403, 'Forbidden', 'FORBIDDEN')
      if (scope === 'own' && !isCreateOwnScopeAllowed(collection, effective.userId, data as Record<string, any>)) {
        this.#core.errors.httpError(403, 'Forbidden', 'FORBIDDEN')
      }
    }
    await this.#core.internals.resilience.acquireLimit('firestore')
    const def = getCollectionDef(collection)
    const rel = def.userRelation?.type ?? '1:N'
    const userField = def.userRelation?.userField ?? (rel === '1:1' ? 'id' : 'userId')
    const col = this.firestore().collection(collection)
    const explicitId =
      data.id ?? (rel === '1:1' && userField === 'id' ? (data as Record<string, any>).userId : undefined)
    const docRef = explicitId ? col.doc(String(explicitId)) : col.doc()
    const now = new Date()
    const fullDoc = def.schema.parse({ deleted: false, ...data, id: docRef.id, createdAt: now, updatedAt: now })
    await docRef.set(fullDoc)
    return fullDoc as SelectModel<N>
  }

  read = async <N extends CollectionName>(
    collection: N,
    id: EntryId,
    includeDeleted = false,
    ctx?: DbCallContext
  ): Promise<SelectModel<N> | undefined> => {
    if (!id) return undefined
    await this.#core.internals.resilience.acquireLimit('firestore')
    const snap = await this.firestore().collection(collection).doc(id).get()
    if (!snap.exists) return undefined
    const doc = fromFirestoreDoc(collection, snap.id, snap.data() ?? {})
    if (!includeDeleted && doc.deleted) return undefined
    const effective = this.#effectiveCtx(ctx)
    if (!effective.bypassRbac) {
      const role = this.#resolveRole(effective)
      const scope = resolveAllowedScope(collection, role, 'read')
      if (scope === 'none') this.#core.errors.httpError(403, 'Forbidden', 'FORBIDDEN')
      if (scope === 'own') {
        if (!effective.userId || !(await this.#isEntryOwner(collection, doc, effective.userId))) {
          this.#core.errors.httpError(403, 'Forbidden', 'FORBIDDEN')
        }
      }
    }
    return doc
  }

  #batchReadByIds = async <T extends CollectionName>(
    collection: T,
    ids: string[],
    includeDeleted = false,
    hasSelect = false
  ): Promise<SelectModel<T>[]> => {
    const uniqueIds = [...new Set(ids.filter(Boolean))]
    if (!uniqueIds.length) return []
    const byId = new Map<string, SelectModel<T>>()
    const db = this.firestore()
    for (let i = 0; i < uniqueIds.length; i += 100) {
      await this.#core.internals.resilience.acquireLimit('firestore')
      const snaps = await db.getAll(...uniqueIds.slice(i, i + 100).map((id) => db.collection(collection).doc(id)))
      for (const s of snaps) {
        if (!s.exists) continue
        const doc = fromFirestoreDoc(collection, s.id, s.data() ?? {}, hasSelect)
        if (includeDeleted || !doc.deleted) byId.set(s.id, doc)
      }
    }
    return ids.map((id) => byId.get(id)).filter((d): d is SelectModel<T> => Boolean(d))
  }

  list = async <N extends CollectionName>(
    collection: N,
    opts?: DbListOptions<SelectModel<N>>,
    ctx?: DbCallContext
  ): Promise<PaginatedList<SelectModel<N>>> => {
    const effective = this.#effectiveCtx(ctx)
    const bypass = Boolean(opts?.bypassRbac || effective.bypassRbac)
    let scopedUserId = opts?.userId
    if (!bypass) {
      const role = this.#resolveRole(effective)
      const scope = resolveAllowedScope(collection, role, 'read')
      if (scope === 'none') this.#core.errors.httpError(403, 'Forbidden', 'FORBIDDEN')
      if (scope === 'own') {
        if (!effective.userId) this.#core.errors.httpError(403, 'Forbidden', 'FORBIDDEN')
        if (scopedUserId && scopedUserId !== effective.userId) this.#core.errors.httpError(403, 'Forbidden', 'FORBIDDEN')
        scopedUserId = effective.userId
      }
    }

    const def = getCollectionDef(collection)
    const db = this.firestore()
    const rel = def.userRelation?.type ?? '1:N'
    const maxDocs = opts?.limit ?? this.#core.config.limits.defaultListLimit
    const hasSelect = Boolean(opts?.select?.length)

    if (opts?.ids) {
      const docs = await this.#batchReadByIds(collection, opts.ids, opts.includeDeleted, hasSelect)
      if (!scopedUserId || rel === 'global') return attachNextCursor(docs.slice(0, maxDocs), maxDocs)
      const ownership = await Promise.all(docs.map((doc) => this.#isEntryOwner(collection, doc, scopedUserId)))
      return attachNextCursor(docs.filter((_, i) => ownership[i]).slice(0, maxDocs), maxDocs)
    }

    await this.#core.internals.resilience.acquireLimit('firestore')

    if (scopedUserId) {
      if (rel === '1:1' && (def.userRelation?.userField ?? 'id') === 'id') {
        const single = await this.read(collection, scopedUserId, opts?.includeDeleted, { bypassRbac: true })
        return attachNextCursor(single ? [single] : [], maxDocs)
      }
      if (rel === 'M:N' && def.userRelation?.junction) {
        const { collection: jCol, userField, targetField } = resolveJunction(collection, def.userRelation.junction)
        const jSnap = await db.collection(jCol).where(userField, '==', scopedUserId).limit(maxDocs).get()
        const targetIds = jSnap.docs.map((d) => String(d.data()[targetField] ?? '')).filter(Boolean)
        const docs = await this.#batchReadByIds(collection, targetIds, opts?.includeDeleted, hasSelect)
        return attachNextCursor(docs, maxDocs)
      }
    }

    const baseQuery = buildScopedCollectionQuery(
      db.collection(collection),
      collection,
      scopedUserId,
      opts?.where as Record<string, unknown> | undefined,
      opts?.select
    )
    const docs = await executeFilteredListQuery(
      db,
      collection,
      baseQuery,
      opts,
      maxDocs,
      hasSelect,
      this.#core.config.limits.defaultListLimit
    )
    return attachNextCursor(docs.slice(0, maxDocs), maxDocs)
  }

  listPage = async <N extends CollectionName>(
    collection: N,
    opts?: DbListOptions<SelectModel<N>>,
    ctx?: DbCallContext
  ): Promise<DbListPage<SelectModel<N>>> => {
    const items = await this.list(collection, opts, ctx)
    return { items, nextCursor: items.nextCursor ?? null }
  }

  update = async <N extends CollectionName>(
    collection: N,
    id: EntryId,
    data: UpdateData<N>,
    ctx?: DbCallContext
  ): Promise<{ id: EntryId; updated: true }> => {
    const effective = this.#effectiveCtx(ctx)
    if (!effective.bypassRbac) {
      const allowed = await this.canAccess(collection, id, effective.userId ?? '', 'write', effective.userRole)
      if (!allowed) this.#core.errors.httpError(403, 'Forbidden', 'FORBIDDEN')
    }
    const cleanPatch = stripImmutableUpdateFields(collection, data, Boolean(effective.bypassRbac))
    await this.#core.internals.resilience.acquireLimit('firestore')
    await this.firestore()
      .collection(collection)
      .doc(id)
      .update({ ...cleanPatch, updatedAt: new Date() })
    return { id, updated: true }
  }

  delete = async <N extends CollectionName>(
    collection: N,
    id: EntryId,
    ctx?: DbCallContext
  ): Promise<{ id: EntryId; deleted: true }> => {
    const existing = await this.read(collection, id, false, { bypassRbac: true })
    if (!existing) throw new Error(`Not found: ${collection}/${id}`)
    const effective = this.#effectiveCtx(ctx)
    if (!effective.bypassRbac) {
      const allowed = await this.canAccess(collection, existing, effective.userId ?? '', 'delete', effective.userRole)
      if (!allowed) this.#core.errors.httpError(403, 'Forbidden', 'FORBIDDEN')
    }
    await this.update(collection, id, { deleted: true } as UpdateData<N>, { bypassRbac: true })
    return { id, deleted: true }
  }

  hardDelete = async <N extends CollectionName>(
    collection: N,
    id: EntryId,
    ctx?: DbCallContext
  ): Promise<{ id: EntryId; deleted: true; hard: true }> => {
    const def = getCollectionDef(collection)
    const effective = this.#effectiveCtx(ctx)
    const existing =
      def.onHardDelete || !effective.bypassRbac
        ? await this.read(collection, id, true, { bypassRbac: true })
        : undefined
    if (!effective.bypassRbac) {
      if (!existing) throw new Error(`Not found: ${collection}/${id}`)
      const allowed = await this.canAccess(collection, existing, effective.userId ?? '', 'delete', effective.userRole)
      if (!allowed) this.#core.errors.httpError(403, 'Forbidden', 'FORBIDDEN')
    }
    await this.#core.internals.resilience.acquireLimit('firestore')
    await this.firestore().collection(collection).doc(id).delete()
    if (def.onHardDelete && (existing || collection === 'chat')) {
      const scopedCore =
        effective.core ??
        new Core({
          env: this.#core.env,
          userId: effective.userId ?? this.#core.config.auth.adminUserId,
          role: 'admin'
        })
      const targetDoc = existing ?? ({ id } as SelectModel<N>)
      await def.onHardDelete(targetDoc, scopedCore).catch(() => {})
    }
    return { id, deleted: true, hard: true }
  }

  #eraseOwnedEntries = async (name: string, userId: EntryId): Promise<number> => {
    let total = 0
    while (true) {
      const docs = await this.list(name, { userId, includeDeleted: true, limit: 500, bypassRbac: true })
      if (!docs.length) break
      await runChunked(docs, (d) => this.hardDelete(name, d.id, { bypassRbac: true }).catch(() => {}), 25)
      total += docs.length
      if (docs.length < 500) break
    }
    return total
  }

  #cascadeEraseUserCollections = async (
    userId: EntryId,
    step: StepRunner = this.#core.step
  ): Promise<{ erasedFiles: number; erasedChats: number; erasedCollections: Record<string, number> }> => {
    const erasedFiles = await step('erase-files', () => this.#eraseOwnedEntries('file', userId))
    const erasedChats = await step('erase-chats', async () => {
      const count = await this.#eraseOwnedEntries('chat', userId)
      const db = this.firestore()
      await drainQueryBatchDelete(db, db.collectionGroup('messages').where('userId', '==', userId)).catch(() => 0)
      return count
    })

    const erasedCollections: Record<string, number> = {}
    const db = this.firestore()

    for (const [name, def] of collectionRegistry) {
      if (name === 'file' || name === 'chat') continue
      const rel = def.userRelation?.type ?? '1:N'
      if (rel === 'global') continue

      erasedCollections[name] = await step(`erase-${name}`, async () => {
        if (rel === '1:1' || rel === '1:N') return this.#eraseOwnedEntries(name, userId)
        if (rel === 'M:N' && def.userRelation?.junction) {
          const { collection: jCol, userField } = resolveJunction(name, def.userRelation.junction)
          const jSnap = await db.collection(jCol).where(userField, '==', userId).get()
          await runChunked(jSnap.docs, (d) => d.ref.delete().catch(() => {}), 25)
          return jSnap.size
        }
        const userIdsField = def.userRelation?.userIdsField ?? 'userIds'
        const docs = await this.list(name, { userId, includeDeleted: true, limit: 500, bypassRbac: true })
        await runChunked(docs, async (d) => {
          const currentIds: string[] = Array.isArray(d[userIdsField]) ? d[userIdsField] : []
          if (def.userRelation?.deleteWhenEmpty && currentIds.filter((u) => u !== userId).length === 0) {
            await this.hardDelete(name, d.id, { bypassRbac: true }).catch(() => {})
          } else {
            await db.collection(name).doc(d.id).update({ [userIdsField]: FieldValue.arrayRemove(userId), updatedAt: new Date() }).catch(() => {})
          }
        })
        return docs.length
      })
    }

    await step('erase-tasks', async () => {
      const snap = await db.collection('_tasks').where('userId', '==', userId).get()
      const bucket = this.bucket()
      const docsToDelete = snap.docs.filter(
        (d) => d.data().workflowName !== 'erase-user' || d.data().status !== 'running'
      )
      await Promise.all([
        runChunked(
          docsToDelete,
          (d) =>
            Promise.all([
              d.ref.delete().catch(() => {}),
              bucket.deleteFiles({ prefix: `_tasks/${d.id}/` }).catch(() => {})
            ]),
          25
        ),
        drainQueryBatchDelete(db, db.collection('_idempotency').where('userId', '==', userId)).catch(() => 0)
      ])
      return snap.size
    })

    return { erasedFiles, erasedChats, erasedCollections }
  }

  get internals() {
    return {
      ensureFirebaseApp: this.#ensureFirebaseApp,
      getGcpAccessToken: this.#getGcpAccessToken,
      cascadeEraseUserCollections: this.#cascadeEraseUserCollections
    }
  }
}
