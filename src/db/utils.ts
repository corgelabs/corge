import { FieldPath, Timestamp } from 'firebase-admin/firestore'
import type { DbAction, DbRole } from '../config'
import type { Core } from '../index'
import {
  collectionRegistry,
  getCollectionDef,
  getEffectiveRbac,
  type CollectionName,
  type DbListOptions,
  type PaginatedList,
  type SelectModel,
  type UserRelationConfig
} from './schema'

export const resolveJunction = (collection: string, j: NonNullable<UserRelationConfig['junction']>) => ({
  collection: j.collection,
  userField: j.userField ?? 'userId',
  targetField: j.targetField ?? `${collection}Id`
})

export const hasAction = (actions: readonly DbAction[] | undefined, target: DbAction): boolean =>
  Boolean(actions && (actions.includes('*') || actions.includes(target)))

export const resolveAllowedScope = (collection: string, role: DbRole, action: DbAction): 'any' | 'own' | 'none' => {
  const rbac = getEffectiveRbac(collection)
  const roleScopes = rbac[role]
  if (!roleScopes) return 'none'
  if (hasAction(roleScopes.any, action)) return 'any'
  if (hasAction(roleScopes.own, action)) return 'own'
  return 'none'
}

export const normalizeDates = (val: unknown): unknown => {
  if (val instanceof Timestamp) return val.toDate()
  if (Array.isArray(val)) return val.map(normalizeDates)
  if (val && typeof val === 'object' && !(val instanceof Date)) {
    return Object.fromEntries(Object.entries(val).map(([k, v]) => [k, normalizeDates(v)]))
  }
  return val
}

export const fromFirestoreDoc = <T extends CollectionName>(
  c: T,
  id: string,
  raw: Record<string, unknown>,
  partial = false
): SelectModel<T> => {
  const norm = normalizeDates({ ...raw, id }) as Record<string, unknown>
  const schema = getCollectionDef(c).schema
  return (partial ? schema.partial().parse(norm) : schema.parse(norm)) as SelectModel<T>
}

export const attachNextCursor = <T extends { id: string }>(items: T[], limit: number): PaginatedList<T> => {
  const nextCursor = items.length >= limit ? (items.at(-1)?.id ?? null) : null
  Object.defineProperty(items, 'nextCursor', { value: nextCursor, enumerable: false, configurable: true })
  return items as PaginatedList<T>
}

export const stripImmutableUpdateFields = (
  collection: string,
  data: unknown,
  allowSystemFields = false
): Record<string, unknown> => {
  const def = getCollectionDef(collection)
  const ownerField = def.userRelation?.userField ?? 'userId'
  const raw = (data ?? {}) as Record<string, unknown>
  const {
    id: _id,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    deleted: _deleted,
    userId: _userId,
    [ownerField]: _ownerField,
    ...mutableData
  } = raw
  if (allowSystemFields && raw.deleted !== undefined) {
    mutableData.deleted = raw.deleted
  }
  const parsed = def.schema.partial().parse(mutableData) as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(mutableData)
      .filter((k) => mutableData[k] !== undefined && k in parsed)
      .map((k) => [k, parsed[k]])
  )
}

export const drainQueryBatchDelete = async (
  db: FirebaseFirestore.Firestore,
  query: FirebaseFirestore.Query,
  batchSize = 400
): Promise<number> => {
  let deleted = 0
  while (true) {
    const snap = await query.limit(batchSize).get()
    if (snap.empty) break
    const batch = db.batch()
    for (const doc of snap.docs) batch.delete(doc.ref)
    await batch.commit()
    deleted += snap.size
    if (snap.size < batchSize) break
  }
  return deleted
}

export const executeFilteredListQuery = async <N extends CollectionName>(
  db: FirebaseFirestore.Firestore,
  collection: N,
  baseQuery: FirebaseFirestore.Query,
  opts: DbListOptions<SelectModel<N>> | undefined,
  maxDocs: number,
  hasSelect: boolean,
  defaultListLimit: number
): Promise<SelectModel<N>[]> => {
  const def = getCollectionDef(collection)
  const sortField = opts?.orderBy?.field ?? (def.sortByUpdated ? 'updatedAt' : undefined)
  const sortDir = opts?.orderBy?.direction ?? 'desc'
  const cursorSnap = opts?.cursor ? await db.collection(collection).doc(opts.cursor).get() : undefined
  const filteredQuery = !opts?.includeDeleted ? baseQuery.where('deleted', '==', false) : baseQuery

  let snap: FirebaseFirestore.QuerySnapshot
  let sortedInDb = false
  let appliedCursorInDb = false
  try {
    let q = sortField ? filteredQuery.orderBy(sortField, sortDir) : filteredQuery.orderBy(FieldPath.documentId(), 'asc')
    if (cursorSnap?.exists) q = q.startAfter(cursorSnap)
    snap = await q.limit(maxDocs).get()
    sortedInDb = true
    appliedCursorInDb = Boolean(cursorSnap?.exists)
  } catch (err) {
    console.warn(
      `[db] composite index missing for "${collection}" (falling back to filtered query):`,
      err instanceof Error ? err.message : err
    )
    const fallbackLimit = sortField || opts?.cursor ? Math.max(maxDocs * 5, defaultListLimit) : maxDocs
    try {
      snap = await filteredQuery.limit(fallbackLimit).get()
    } catch {
      snap = await baseQuery.limit(fallbackLimit).get()
    }
  }

  const docs = snap.docs
    .map((s) => fromFirestoreDoc(collection, s.id, s.data() ?? {}, hasSelect))
    .filter((d) => opts?.includeDeleted || !d.deleted)

  return sortAndSliceFallbackDocs(docs, sortField, sortDir, opts?.cursor, sortedInDb, appliedCursorInDb)
}

export const sortAndSliceFallbackDocs = <T extends Record<string, any> & { id: string }>(
  docs: T[],
  sortField: string | undefined,
  sortDir: 'asc' | 'desc',
  cursor: string | undefined,
  sortedInDb: boolean,
  appliedCursorInDb: boolean
): T[] => {
  let result = docs
  if (!sortedInDb) {
    result.sort((a, b) => {
      if (sortField) {
        const va = a[sortField] instanceof Date ? a[sortField].getTime() : a[sortField]
        const vb = b[sortField] instanceof Date ? b[sortField].getTime() : b[sortField]
        if (va !== vb) return sortDir === 'asc' ? (va > vb ? 1 : -1) : va < vb ? 1 : -1
      }
      return a.id.localeCompare(b.id)
    })
  }
  if (cursor && !appliedCursorInDb) {
    const idx = result.findIndex((d) => d.id === cursor)
    result = idx >= 0 ? result.slice(idx + 1) : []
  }
  return result
}

export const runChunked = async <T>(
  items: readonly T[],
  fn: (item: T) => Promise<unknown>,
  concurrency = 25
): Promise<void> => {
  for (let i = 0; i < items.length; i += concurrency) {
    await Promise.all(items.slice(i, i + concurrency).map(fn))
  }
}

export const isCreateOwnScopeAllowed = (
  collection: string,
  userId: string | undefined,
  data: Record<string, any>
): boolean => {
  if (!userId) return false
  const def = getCollectionDef(collection)
  const rel = def.userRelation?.type ?? '1:N'
  if (rel === 'global') return false
  if (rel === '1:1' || rel === '1:N') {
    const uf = def.userRelation?.userField ?? (rel === '1:1' ? 'id' : 'userId')
    const ownerVal = data[uf] ?? (uf === 'id' ? data.id : undefined)
    if (ownerVal && ownerVal !== userId) return false
  } else if (rel === 'M:N' && !def.userRelation?.junction) {
    const uif = def.userRelation?.userIdsField ?? 'userIds'
    const ownerIds = data[uif]
    if (Array.isArray(ownerIds) && !ownerIds.includes(userId)) return false
  }
  return true
}

export const buildScopedCollectionQuery = (
  baseQuery: FirebaseFirestore.Query,
  collection: string,
  scopedUserId: string | undefined,
  where: Record<string, unknown> | undefined,
  select: readonly (string | symbol | number)[] | undefined
): FirebaseFirestore.Query => {
  const def = getCollectionDef(collection)
  const rel = def.userRelation?.type ?? '1:N'
  let q = baseQuery
  if (scopedUserId && rel !== 'global') {
    q =
      rel === '1:1' || rel === '1:N'
        ? q.where(def.userRelation?.userField ?? 'userId', '==', scopedUserId)
        : q.where(def.userRelation?.userIdsField ?? 'userIds', 'array-contains', scopedUserId)
  }
  if (where) {
    for (const [field, value] of Object.entries(where)) {
      if (value === undefined) continue
      q = Array.isArray(value) ? q.where(field, 'in', value.slice(0, 30)) : q.where(field, '==', value)
    }
  }
  if (select?.length) q = q.select(...(select as string[]))
  return q
}

export const wireCoreCollectionHooks = (): void => {
  const chatDef = collectionRegistry.get('chat')
  if (chatDef && !chatDef.onHardDelete) {
    chatDef.onHardDelete = async (doc: { id?: string }, core: Core) => {
      if (!doc.id) return
      const db = core.db.firestore()
      await core.internals.resilience.acquireLimit('firestore')
      await drainQueryBatchDelete(db, db.collection('chat').doc(doc.id).collection('messages'))
    }
  }
  const fileDef = collectionRegistry.get('file')
  if (fileDef && !fileDef.onHardDelete) {
    fileDef.onHardDelete = async (doc: { id?: string }, core: Core) => {
      if (!doc.id) return
      await core.internals.resilience.acquireLimit('storage')
      await core.files.bucket().file(doc.id).delete({ ignoreNotFound: true }).catch(() => {})
    }
  }
}
