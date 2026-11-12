import { getAuth, type Auth } from 'firebase-admin/auth'
import { setCookie } from 'hono/cookie'
import type { Context } from 'hono'
import { CORGE_CONFIG, type AppEnv, type DbRole } from '../config'
import type { EntryId } from '../db'
import type { Corge } from '../index'
import type { AuthUser, CachedTokenEntry, UserAuthMetaRecord } from './schema'
import { fetchIdentityToolkit, normalizeDate, parseLinkedProviders, resolveTokenRole } from './utils'

type InternalVerifier = { signatureVerifier?: { keyFetcher?: { fetchPublicKeys?: () => Promise<unknown> } } }
let authWarmPromise: Promise<unknown> | undefined

const REVOCATION_SYNC_TTL_MS = 3_000
const AUTH_REVOCATIONS_DOC_PATH = '_system/auth_revocations'

export const tokenCache = new Map<string, CachedTokenEntry>()

interface RevocationWatermarkState {
  lastSyncedAt: number
  revokedUsers: Record<string, number>
}

const revocationWatermarks: [RevocationWatermarkState, RevocationWatermarkState] = [
  { lastSyncedAt: 0, revokedUsers: {} },
  { lastSyncedAt: 0, revokedUsers: {} }
]

let bgSyncTimer: ReturnType<typeof setInterval> | null = null

export class AuthSessionEngine {
  readonly #corge: Corge

  constructor(corgeClient: Corge) {
    this.#corge = corgeClient
  }

  getAuth = (): Auth => {
    this.#corge.internals.registry.ensureFirebaseApp()
    return getAuth()
  }

  getAuthWarm = (): Promise<unknown> => {
    if (!authWarmPromise) {
      const auth = this.getAuth()
      const rawAuth = auth as unknown as {
        idTokenVerifier?: InternalVerifier
        sessionCookieVerifier?: InternalVerifier
      }
      authWarmPromise = Promise.all([
        rawAuth.idTokenVerifier?.signatureVerifier?.keyFetcher?.fetchPublicKeys?.(),
        rawAuth.sessionCookieVerifier?.signatureVerifier?.keyFetcher?.fetchPublicKeys?.(),
        auth.getUser(CORGE_CONFIG.auth.adminUserId).catch(() => {})
      ]).catch(() => {})
    }
    return authWarmPromise
  }

  resolveDefaultIsDev = (isDev?: boolean): boolean => isDev ?? this.#corge.env.isDev

  #ensureBackgroundRevocationSync = (): void => {
    if (bgSyncTimer) return
    bgSyncTimer = setInterval(() => {
      if (tokenCache.size === 0) {
        if (bgSyncTimer) {
          clearInterval(bgSyncTimer)
          bgSyncTimer = null
        }
        return
      }
      const defaultIsDev = this.#corge.env.isDev
      for (const isDevSlot of [false, true] as const) {
        const idx = isDevSlot ? 1 : 0
        if (isDevSlot === defaultIsDev || revocationWatermarks[idx].lastSyncedAt > 0) {
          void this.syncRevocations(isDevSlot, true)
        }
      }
    }, 2_000)
    bgSyncTimer.unref?.()
  }

  setTokenCache = (
    token: string,
    uid: EntryId,
    role: DbRole = uid === CORGE_CONFIG.auth.adminUserId ? 'admin' : 'user',
    exp = Date.now() + CORGE_CONFIG.auth.tokenCacheTtlMs,
    strictVerified = false,
    emailVerified = false
  ): void => {
    const existing = tokenCache.get(token)
    if (!existing && tokenCache.size >= CORGE_CONFIG.auth.tokenCacheMaxSize) {
      tokenCache.delete(tokenCache.keys().next().value!)
    }
    tokenCache.set(token, {
      uid,
      role,
      exp,
      cachedAt: Date.now(),
      strictVerified: Boolean(strictVerified || existing?.strictVerified),
      emailVerified: Boolean(emailVerified || existing?.emailVerified)
    })
    this.#ensureBackgroundRevocationSync()
  }

  evictUserTokens = (uid: EntryId, revokedAt?: number): void => {
    for (const [k, v] of tokenCache) {
      if (v.uid === uid && (revokedAt === undefined || v.cachedAt <= revokedAt)) {
        tokenCache.delete(k)
      }
    }
  }

  recordRevocation = async (uid: EntryId, isDev?: boolean): Promise<number> => {
    let revokedAt = Date.now()
    this.evictUserTokens(uid)
    const ttlMs = CORGE_CONFIG.auth.tokenCacheTtlMs
    const targetIsDev = this.resolveDefaultIsDev(isDev)
    const localState = revocationWatermarks[targetIsDev ? 1 : 0]
    localState.revokedUsers[uid] = revokedAt
    localState.lastSyncedAt = revokedAt

    const db = this.#corge.db.firestore(targetIsDev)
    const docRef = db.doc(AUTH_REVOCATIONS_DOC_PATH)
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(docRef)
        const now = Date.now()
        revokedAt = now
        const data = snap.data() as { revokedUsers?: Record<string, number> } | undefined
        const existing = data?.revokedUsers ?? {}
        const pruned: Record<string, number> = {}
        const cutoff = now - ttlMs
        for (const [k, ts] of Object.entries(existing)) {
          if (typeof ts === 'number' && ts > cutoff) pruned[k] = ts
        }
        pruned[uid] = now
        tx.set(docRef, { revokedUsers: pruned, updatedAt: now })
      })
      localState.revokedUsers[uid] = revokedAt
      localState.lastSyncedAt = revokedAt
    } catch {}
    return revokedAt
  }

  clearUserRevocation = async (uid: EntryId, isDev?: boolean): Promise<void> => {
    const targetIsDev = this.resolveDefaultIsDev(isDev)
    const localState = revocationWatermarks[targetIsDev ? 1 : 0]
    delete localState.revokedUsers[uid]
    localState.lastSyncedAt = Date.now()

    const db = this.#corge.db.firestore(targetIsDev)
    const docRef = db.doc(AUTH_REVOCATIONS_DOC_PATH)
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(docRef)
        const data = snap.data() as { revokedUsers?: Record<string, number> } | undefined
        if (!data?.revokedUsers || !(uid in data.revokedUsers)) return
        const next = { ...data.revokedUsers }
        delete next[uid]
        tx.set(docRef, { revokedUsers: next, updatedAt: Date.now() })
      })
    } catch {}
  }

  syncRevocations = async (isDev?: boolean, force = false): Promise<Record<string, number>> => {
    const targetIsDev = this.resolveDefaultIsDev(isDev)
    const state = revocationWatermarks[targetIsDev ? 1 : 0]
    const now = Date.now()
    if (!force && state.lastSyncedAt > 0 && now - state.lastSyncedAt < REVOCATION_SYNC_TTL_MS) {
      return state.revokedUsers
    }
    return this.#corge.internals.resilience.singleflight(
      `auth:revocations:${targetIsDev ? 'dev' : 'prod'}`,
      async () => {
        try {
          const snap = await this.#corge.db.firestore(targetIsDev).doc(AUTH_REVOCATIONS_DOC_PATH).get()
          const remote = (snap.data()?.revokedUsers as Record<string, number> | undefined) ?? {}
          state.revokedUsers = remote
          state.lastSyncedAt = Date.now()
          for (const [uid, revokedAt] of Object.entries(remote)) {
            if (typeof revokedAt === 'number') this.evictUserTokens(uid, revokedAt)
          }
        } catch {
          state.lastSyncedAt = Date.now()
        }
        return state.revokedUsers
      },
      { scope: 'global' }
    )
  }

  verifyToken = async (
    token: string,
    isCookie: boolean,
    checkRevoked: boolean,
    isDev?: boolean
  ): Promise<{ uid: EntryId; role: DbRole; emailVerified: boolean }> => {
    const targetIsDev = this.resolveDefaultIsDev(isDev)
    const state = revocationWatermarks[targetIsDev ? 1 : 0]
    let hit = tokenCache.get(token)
    if (hit && hit.exp > Date.now()) {
      if (Date.now() - state.lastSyncedAt >= REVOCATION_SYNC_TTL_MS) {
        void this.syncRevocations(targetIsDev)
      }
      const revokedAt = state.revokedUsers[hit.uid]
      if (typeof revokedAt === 'number' && revokedAt >= hit.cachedAt) {
        this.evictUserTokens(hit.uid, revokedAt)
        hit = undefined
      }
    }
    if (hit && hit.exp > Date.now() && (!checkRevoked || hit.strictVerified)) {
      return { uid: hit.uid, role: hit.role, emailVerified: Boolean(hit.emailVerified) }
    }
    return this.#corge.internals.resilience.singleflight(
      `auth:${isCookie ? 'c' : 'b'}:${checkRevoked ? '1' : '0'}:${token}`,
      async () => {
        const auth = this.getAuth()
        const d = isCookie
          ? await auth.verifySessionCookie(token, checkRevoked)
          : await auth.verifyIdToken(token, checkRevoked)
        const role = resolveTokenRole(d as unknown as Record<string, unknown>, d.uid)
        const emailVerified = Boolean(d.email_verified)
        this.setTokenCache(
          token,
          d.uid,
          role,
          Math.min(d.exp * 1000, Date.now() + CORGE_CONFIG.auth.tokenCacheTtlMs),
          checkRevoked,
          emailVerified
        )
        return { uid: d.uid, role, emailVerified }
      }
    )
  }

  getUserAuthMeta = async (uid: EntryId, isDev?: boolean): Promise<UserAuthMetaRecord | undefined> => {
    if (!uid) return undefined
    try {
      const snap = await this.#corge.db
        .firestore(this.resolveDefaultIsDev(isDev))
        .collection('user_auth_meta')
        .doc(uid)
        .get()
      if (!snap.exists) return undefined
      const raw = snap.data() as Record<string, unknown> | undefined
      if (!raw || raw.deleted === true) return undefined
      const linkedProviders = parseLinkedProviders(raw.linkedProviders)
      return {
        ...(typeof raw.email === 'string' || raw.email === null ? { email: raw.email } : {}),
        ...(typeof raw.emailVerified === 'boolean' ? { emailVerified: raw.emailVerified } : {}),
        ...(typeof raw.name === 'string' || raw.name === null ? { name: raw.name } : {}),
        ...(typeof raw.avatarUrl === 'string' || raw.avatarUrl === null ? { avatarUrl: raw.avatarUrl } : {}),
        ...(typeof raw.recoveryEmail === 'string' || raw.recoveryEmail === null
          ? { recoveryEmail: raw.recoveryEmail }
          : {}),
        ...(typeof raw.recoveryEmailVerified === 'boolean'
          ? { recoveryEmailVerified: raw.recoveryEmailVerified }
          : {}),
        ...(linkedProviders.length > 0 ? { linkedProviders } : {}),
        ...(Array.isArray(raw.providerKeys) ? { providerKeys: raw.providerKeys.map(String) } : {}),
        createdAt: normalizeDate(raw.createdAt),
        updatedAt: normalizeDate(raw.updatedAt)
      }
    } catch {
      return undefined
    }
  }

  upsertUserAuthMeta = async (
    uid: EntryId,
    patch: Partial<UserAuthMetaRecord>,
    isDev?: boolean
  ): Promise<UserAuthMetaRecord> => {
    const db = this.#corge.db.firestore(this.resolveDefaultIsDev(isDev))
    const docRef = db.collection('user_auth_meta').doc(uid)
    const now = new Date()
    let merged: UserAuthMetaRecord = { ...patch, updatedAt: now }
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(docRef)
      const existing = snap.exists ? (snap.data() as Record<string, unknown>) : undefined
      const createdAt = existing?.createdAt ? normalizeDate(existing.createdAt, now) : now
      const existingProviders = parseLinkedProviders(existing?.linkedProviders, now)
      const nextProviders = patch.linkedProviders ?? existingProviders
      const providerKeys = Array.from(
        new Set([
          ...(Array.isArray(existing?.providerKeys) ? existing.providerKeys.map(String) : []),
          ...(patch.providerKeys ?? []),
          ...nextProviders.map((p) => `${p.provider}:${p.providerUserId}`)
        ])
      )
      const nextDoc: Record<string, unknown> = {
        id: uid,
        deleted: false,
        email: patch.email !== undefined ? patch.email : (existing?.email ?? null),
        emailVerified: patch.emailVerified !== undefined ? patch.emailVerified : Boolean(existing?.emailVerified),
        name: patch.name !== undefined ? patch.name : (existing?.name ?? null),
        avatarUrl: patch.avatarUrl !== undefined ? patch.avatarUrl : (existing?.avatarUrl ?? null),
        recoveryEmail: patch.recoveryEmail !== undefined ? patch.recoveryEmail : (existing?.recoveryEmail ?? null),
        recoveryEmailVerified:
          patch.recoveryEmailVerified !== undefined
            ? patch.recoveryEmailVerified
            : Boolean(existing?.recoveryEmailVerified),
        linkedProviders: nextProviders,
        providerKeys,
        createdAt,
        updatedAt: now
      }
      tx.set(docRef, nextDoc, { merge: true })
      merged = {
        email: nextDoc.email as string | null,
        emailVerified: nextDoc.emailVerified as boolean,
        name: nextDoc.name as string | null,
        avatarUrl: nextDoc.avatarUrl as string | null,
        recoveryEmail: nextDoc.recoveryEmail as string | null,
        recoveryEmailVerified: nextDoc.recoveryEmailVerified as boolean,
        linkedProviders: nextProviders,
        providerKeys,
        createdAt,
        updatedAt: now
      }
    })
    return merged
  }

  setSessionCookie = (c: Context<AppEnv>, sessionCookie: string): void => {
    setCookie(c, CORGE_CONFIG.auth.sessionCookie, sessionCookie, {
      httpOnly: true,
      secure: c.req.header('x-forwarded-proto') === 'https' || c.req.url.startsWith('https://'),
      path: '/',
      sameSite: 'Lax',
      maxAge: Math.floor(CORGE_CONFIG.auth.sessionExpiresInMs / 1000)
    })
  }

  mintCustomToken = async (
    uid = `anon_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
  ): Promise<{ uid: string; customToken: string }> => ({
    uid,
    customToken: await this.getAuth().createCustomToken(uid)
  })

  createSession = async (
    idToken: string,
    profile?: { email?: string; name?: string; avatarUrl?: string; emailVerified?: boolean }
  ): Promise<{ user: AuthUser; sessionCookie: string }> => {
    const auth = this.getAuth()
    const cacheTtl = CORGE_CONFIG.auth.tokenCacheTtlMs
    const sessionExpiresIn = CORGE_CONFIG.auth.sessionExpiresInMs
    const now = new Date()
    const [ { decoded, meta }, sessionCookie ] = await Promise.all([
      auth.verifyIdToken(idToken, true).then(async (d) => {
        const role = resolveTokenRole(d as unknown as Record<string, unknown>, d.uid)
        const emailVerified = Boolean(d.email_verified || profile?.emailVerified)
        this.setTokenCache(idToken, d.uid, role, Math.min(d.exp * 1000, Date.now() + cacheTtl), true, emailVerified)
        const updates: { displayName?: string; photoURL?: string } = {}
        if (profile?.name && d.name !== profile.name) updates.displayName = profile.name
        if (profile?.avatarUrl && d.picture !== profile.avatarUrl) updates.photoURL = profile.avatarUrl
        const [m] = await Promise.all([
          this.getUserAuthMeta(d.uid, this.#corge.env.isDev),
          Object.keys(updates).length > 0 ? auth.updateUser(d.uid, updates).catch(() => {}) : Promise.resolve()
        ])
        return { decoded: d, meta: m }
      }),
      auth.createSessionCookie(idToken, { expiresIn: sessionExpiresIn })
    ])
    const role = resolveTokenRole(decoded as unknown as Record<string, unknown>, decoded.uid)
    const emailVerified = Boolean(decoded.email_verified || profile?.emailVerified || meta?.emailVerified)
    const avatarUrl = profile?.avatarUrl ?? (decoded.picture as string | undefined) ?? meta?.avatarUrl
    const user: AuthUser = {
      id: decoded.uid,
      email: decoded.email ?? profile?.email ?? meta?.email ?? null,
      emailVerified,
      name: profile?.name ?? (decoded.name as string | undefined) ?? meta?.name ?? null,
      ...(avatarUrl !== undefined ? { avatarUrl } : {}),
      ...(meta?.recoveryEmail !== undefined ? { recoveryEmail: meta.recoveryEmail } : {}),
      ...(meta?.recoveryEmailVerified !== undefined ? { recoveryEmailVerified: meta.recoveryEmailVerified } : {}),
      ...(meta?.linkedProviders?.length ? { linkedProviders: meta.linkedProviders } : {}),
      ...(decoded.role || decoded.admin ? { customClaims: { role } } : {}),
      deleted: false,
      createdAt: meta?.createdAt ?? now,
      updatedAt: now
    }
    this.setTokenCache(sessionCookie, user.id, role, Date.now() + cacheTtl, true, emailVerified)
    return { user, sessionCookie }
  }

  mintSessionForUid = async (
    uid: EntryId,
    profile?: { email?: string; name?: string; avatarUrl?: string; emailVerified?: boolean }
  ): Promise<{ user: AuthUser; sessionCookie: string }> => {
    const customToken = await this.getAuth().createCustomToken(uid)
    const { ok, data } = await fetchIdentityToolkit<{ idToken?: string; error?: { message?: string } }>(
      'accounts:signInWithCustomToken',
      this.#corge.env.WEB_API_KEY,
      { token: customToken, returnSecureToken: true }
    )
    if (!ok || !data.idToken) {
      const msg = data.error?.message ?? 'CUSTOM_TOKEN_EXCHANGE_FAILED'
      return this.#corge.errors.httpError(401, msg, msg)
    }
    return this.createSession(data.idToken, profile)
  }

  revokeSession = async (sessionCookie: string, deleteUser = false): Promise<void> => {
    const auth = this.getAuth()
    const uid = tokenCache.get(sessionCookie)?.uid ?? (await auth.verifySessionCookie(sessionCookie)).sub
    this.evictUserTokens(uid)
    tokenCache.delete(sessionCookie)
    await Promise.all([
      this.recordRevocation(uid, this.#corge.env.isDev),
      auth.revokeRefreshTokens(uid).catch(() => {}),
      ...(deleteUser ? [auth.updateUser(uid, { disabled: true }).catch(() => {})] : [])
    ])
  }
}
