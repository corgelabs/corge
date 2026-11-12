import { createHash, timingSafeEqual } from 'node:crypto'
import type { UserRecord } from 'firebase-admin/auth'
import { CORGE_CONFIG, type DbRole } from '../config'
import type { EntryId } from '../db'
import type { AuthUser, LinkedProvider, OAuthProvider, UserAuthMetaRecord } from './schema'

export const resolveUserRole = (userId?: EntryId, explicitRole?: DbRole): DbRole => {
  if (explicitRole === 'admin' || explicitRole === 'user' || explicitRole === 'anon') return explicitRole
  if (userId === CORGE_CONFIG.auth.adminUserId) return 'admin'
  return userId ? 'user' : 'anon'
}

export const resolveTokenRole = (decoded: Record<string, unknown>, uid: EntryId): DbRole =>
  uid === CORGE_CONFIG.auth.adminUserId || decoded.role === 'admin' || decoded.admin === true ? 'admin' : 'user'

export const normalizeDate = (val: unknown, fallback = new Date()): Date => {
  if (val instanceof Date) return val
  if (
    val &&
    typeof val === 'object' &&
    'toDate' in val &&
    typeof (val as { toDate: () => Date }).toDate === 'function'
  ) {
    return (val as { toDate: () => Date }).toDate()
  }
  if (typeof val === 'string' || typeof val === 'number') {
    const d = new Date(val)
    if (!Number.isNaN(d.getTime())) return d
  }
  return fallback
}

export const safeEqualHex = (aHex: string, bHex: string): boolean => {
  if (!aHex || !bHex || aHex.length !== bHex.length) return false
  try {
    const a = Buffer.from(aHex, 'hex')
    const b = Buffer.from(bHex, 'hex')
    return a.length > 0 && a.length === b.length && timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export const hashToken = (raw: string): string => createHash('sha256').update(raw.trim()).digest('hex')

export const parseLinkedProviders = (rawProviders: unknown, fallbackDate = new Date()): LinkedProvider[] => {
  if (!Array.isArray(rawProviders)) return []
  return rawProviders
    .filter((p): p is Record<string, unknown> => Boolean(p && typeof p === 'object'))
    .map((p) => ({
      provider: (p.provider === 'apple' ? 'apple' : 'google') as OAuthProvider,
      providerUserId: String(p.providerUserId ?? ''),
      ...(p.email !== undefined ? { email: (p.email as string | null) ?? null } : {}),
      linkedAt: normalizeDate(p.linkedAt, fallbackDate)
    }))
    .filter((p) => Boolean(p.providerUserId))
}

export const mapUserRecord = (u: UserRecord, meta?: UserAuthMetaRecord): AuthUser => {
  const createdAt = new Date(u.metadata.creationTime || Date.now())
  const updatedAt = new Date(u.metadata.lastRefreshTime || u.metadata.creationTime || Date.now())
  const fbProviders: LinkedProvider[] = (u.providerData ?? [])
    .filter((p) => p.providerId === 'google.com' || p.providerId === 'apple.com')
    .map((p) => ({
      provider: (p.providerId === 'apple.com' ? 'apple' : 'google') as OAuthProvider,
      providerUserId: p.uid,
      ...(p.email ? { email: p.email } : {}),
      linkedAt: createdAt
    }))
  const mergedProvidersMap = new Map<string, LinkedProvider>()
  for (const p of fbProviders) mergedProvidersMap.set(`${p.provider}:${p.providerUserId}`, p)
  for (const p of meta?.linkedProviders ?? []) mergedProvidersMap.set(`${p.provider}:${p.providerUserId}`, p)
  const linkedProviders = [...mergedProvidersMap.values()]
  const avatarUrl = u.photoURL ?? meta?.avatarUrl ?? undefined

  return {
    id: u.uid,
    email: u.email ?? meta?.email ?? null,
    emailVerified: Boolean(u.emailVerified || meta?.emailVerified),
    name: u.displayName ?? meta?.name ?? null,
    ...(avatarUrl !== undefined ? { avatarUrl } : {}),
    ...(meta?.recoveryEmail !== undefined ? { recoveryEmail: meta.recoveryEmail } : {}),
    ...(meta?.recoveryEmailVerified !== undefined ? { recoveryEmailVerified: meta.recoveryEmailVerified } : {}),
    ...(linkedProviders.length > 0 ? { linkedProviders } : {}),
    ...(u.customClaims ? { customClaims: u.customClaims } : {}),
    deleted: u.disabled,
    createdAt,
    updatedAt
  }
}

export const fetchIdentityToolkit = async <T = Record<string, unknown>>(
  endpoint: string,
  apiKey: string,
  body: Record<string, unknown>,
  timeoutMs = 10_000
): Promise<{ ok: boolean; status: number; data: T }> => {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/${endpoint}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  })
  const data = (await res.json().catch(() => ({}))) as T
  return { ok: res.ok, status: res.status, data }
}
