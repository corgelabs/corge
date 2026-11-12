import { createHash, createPublicKey, verify as cryptoVerify, type JsonWebKey } from 'node:crypto'
import type { UserRecord } from 'firebase-admin/auth'
import { HTTPException } from 'hono/http-exception'
import { CORGE_CONFIG } from '../config'
import type { Corge } from '../index'
import {
  socialSignInInput,
  type AuthUser,
  type LinkedProvider,
  type OAuthProvider,
  type SocialSignInInput,
  type VerifiedOidcClaims
} from './schema'
import type { AuthSessionEngine } from './session'
import { fetchIdentityToolkit } from './utils'

interface JwksCacheEntry {
  keys: (JsonWebKey & { kid?: string })[]
  fetchedAt: number
}

const jwksCache = new Map<OAuthProvider, JwksCacheEntry>()
const JWKS_TTL_MS = 60 * 60 * 1000
const JWKS_URLS: Record<OAuthProvider, string> = {
  google: 'https://www.googleapis.com/oauth2/v3/certs',
  apple: 'https://appleid.apple.com/auth/keys'
}

let testOidcPublicKeyJwk: (JsonWebKey & { kid?: string }) | null = null

export class AuthOidcEngine {
  readonly #corge: Corge
  readonly #session: AuthSessionEngine

  constructor(corgeClient: Corge, session: AuthSessionEngine) {
    this.#corge = corgeClient
    this.#session = session
  }

  registerTestOidcPublicKey = (jwk: (JsonWebKey & { kid?: string }) | null): void => {
    testOidcPublicKeyJwk = jwk
  }

  #getProviderJwks = async (
    provider: OAuthProvider,
    force = false
  ): Promise<(JsonWebKey & { kid?: string })[]> => {
    const cached = jwksCache.get(provider)
    if (!force && cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) {
      return cached.keys
    }
    const res = await fetch(JWKS_URLS[provider], { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`Failed to fetch ${provider} JWKS (${res.status})`)
    const data = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] }
    const keys = data.keys ?? []
    jwksCache.set(provider, { keys, fetchedAt: Date.now() })
    return keys
  }

  #verifyNonceClaim = (rawNonce: string | undefined, tokenNonce: unknown): void => {
    if (!rawNonce) return
    if (typeof tokenNonce !== 'string' || !tokenNonce) {
      this.#corge.errors.httpError(401, 'Missing OIDC nonce claim in ID token', 'INVALID_NONCE')
    }
    const sha256Hex = createHash('sha256').update(rawNonce).digest('hex')
    const sha256B64 = createHash('sha256').update(rawNonce).digest('base64url')
    if (tokenNonce !== rawNonce && tokenNonce !== sha256Hex && tokenNonce !== sha256B64) {
      this.#corge.errors.httpError(401, 'OIDC nonce mismatch', 'INVALID_NONCE')
    }
  }

  #verifyOidcSignature = async (
    provider: OAuthProvider,
    header: { kid?: string; alg?: string },
    headerB64: string,
    payloadB64: string,
    sigB64: string,
    isDev: boolean
  ): Promise<void> => {
    let jwk: (JsonWebKey & { kid?: string }) | undefined
    if (isDev && testOidcPublicKeyJwk && header.kid === (testOidcPublicKeyJwk.kid ?? 'test-oidc-key')) {
      jwk = testOidcPublicKeyJwk
    } else {
      const keys = await this.#getProviderJwks(provider)
      jwk = keys.find((k) => k.kid === header.kid)
      if (!jwk && header.kid) {
        const refreshed = await this.#getProviderJwks(provider, true)
        jwk = refreshed.find((k) => k.kid === header.kid)
      }
    }
    if (!jwk) {
      this.#corge.errors.httpError(401, 'Unable to find matching OIDC JWK for token kid', 'INVALID_ID_TOKEN')
    }
    try {
      const pubKey = createPublicKey({ key: jwk!, format: 'jwk' })
      const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8')
      const signature = Buffer.from(sigB64, 'base64url')
      const valid = cryptoVerify('RSA-SHA256', signingInput, pubKey, signature)
      if (!valid) this.#corge.errors.httpError(401, 'Invalid OIDC ID token signature', 'INVALID_ID_TOKEN')
    } catch (err) {
      if (err instanceof HTTPException) throw err
      this.#corge.errors.httpError(401, 'OIDC signature verification failed', 'INVALID_ID_TOKEN')
    }
  }

  verifyOidcIdToken = async (
    provider: OAuthProvider,
    idToken: string,
    nonce?: string,
    isDev?: boolean
  ): Promise<VerifiedOidcClaims> => {
    const parts = idToken.split('.')
    if (parts.length !== 3) return this.#corge.errors.httpError(401, 'Malformed OIDC ID token', 'INVALID_ID_TOKEN')
    const [headerB64, payloadB64, sigB64] = parts as [string, string, string]

    let header: { kid?: string; alg?: string }
    let payload: Record<string, unknown>
    try {
      header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')) as { kid?: string; alg?: string }
      payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as Record<string, unknown>
    } catch {
      return this.#corge.errors.httpError(401, 'Malformed OIDC ID token JSON', 'INVALID_ID_TOKEN')
    }

    if (header.alg !== 'RS256') {
      return this.#corge.errors.httpError(401, 'Unsupported OIDC signature algorithm', 'INVALID_ID_TOKEN')
    }

    const exp = typeof payload.exp === 'number' ? payload.exp : 0
    if (exp * 1000 <= Date.now()) {
      return this.#corge.errors.httpError(401, 'OIDC ID token has expired', 'TOKEN_EXPIRED')
    }

    const iss = String(payload.iss ?? '')
    const validIss =
      provider === 'google'
        ? iss === 'https://accounts.google.com' || iss === 'accounts.google.com'
        : iss === 'https://appleid.apple.com'
    if (!validIss) {
      return this.#corge.errors.httpError(401, `Invalid OIDC issuer for ${provider}: ${iss}`, 'INVALID_ISSUER')
    }

    const allowedClientIds =
      provider === 'google' ? CORGE_CONFIG.auth.oauth?.googleClientIds : CORGE_CONFIG.auth.oauth?.appleClientIds
    if (allowedClientIds && allowedClientIds.length > 0) {
      const aud = payload.aud
      const audList = Array.isArray(aud) ? aud.map(String) : [String(aud ?? '')]
      if (!audList.some((a) => allowedClientIds.includes(a))) {
        return this.#corge.errors.httpError(401, `Invalid OIDC audience for ${provider}`, 'INVALID_AUDIENCE')
      }
    }

    this.#verifyNonceClaim(nonce, payload.nonce)
    await this.#verifyOidcSignature(
      provider,
      header,
      headerB64,
      payloadB64,
      sigB64,
      this.#session.resolveDefaultIsDev(isDev)
    )

    const sub = String(payload.sub ?? '').trim()
    if (!sub) return this.#corge.errors.httpError(401, 'Missing OIDC subject (sub) claim', 'INVALID_ID_TOKEN')
    const email = typeof payload.email === 'string' && payload.email ? payload.email.trim().toLowerCase() : null
    const emailVerified = payload.email_verified === true || payload.email_verified === 'true'

    return {
      sub,
      email,
      emailVerified,
      ...(typeof payload.name === 'string' && payload.name ? { name: payload.name } : {}),
      ...(typeof payload.picture === 'string' && payload.picture ? { picture: payload.picture } : {})
    }
  }

  #tryIdentityToolkitIdp = async (
    key: string,
    provider: OAuthProvider,
    idToken: string,
    nonce?: string,
    accessToken?: string
  ): Promise<{
    firebaseIdToken: string
    localId: string
    federatedId?: string
    email?: string
    emailVerified?: boolean
    displayName?: string
    photoUrl?: string
  } | null> => {
    try {
      const providerId = provider === 'apple' ? 'apple.com' : 'google.com'
      const params = new URLSearchParams({ providerId })
      if (idToken) params.set('id_token', idToken)
      if (accessToken) params.set('access_token', accessToken)
      if (nonce) params.set('rawNonce', nonce)

      const { ok, data } = await fetchIdentityToolkit<{
        idToken?: string
        localId?: string
        federatedId?: string
        email?: string
        emailVerified?: boolean
        displayName?: string
        photoUrl?: string
      }>('accounts:signInWithIdp', key, {
        postBody: params.toString(),
        requestUri: 'http://localhost',
        returnIdpCredential: true,
        returnSecureToken: true
      })
      if (!ok || !data.idToken || !data.localId) return null
      return {
        firebaseIdToken: data.idToken,
        localId: data.localId,
        ...(data.federatedId ? { federatedId: data.federatedId } : {}),
        ...(data.email ? { email: data.email.trim().toLowerCase() } : {}),
        ...(typeof data.emailVerified === 'boolean' ? { emailVerified: data.emailVerified } : {}),
        ...(data.displayName ? { displayName: data.displayName } : {}),
        ...(data.photoUrl ? { photoUrl: data.photoUrl } : {})
      }
    } catch {
      return null
    }
  }

  #resolveOrCreateSocialUser = async (
    providerKey: string,
    oidcClaims: VerifiedOidcClaims & { _idpResult?: { localId: string } },
    resolvedName: string | undefined,
    resolvedAvatar: string | undefined,
    isDev: boolean
  ): Promise<{ userRecord: UserRecord; isNewUser: boolean }> => {
    const auth = this.#session.getAuth()
    const db = this.#corge.db.firestore(isDev)
    let userRecord: UserRecord | undefined

    const existingProviderSnap = await db
      .collection('user_auth_meta')
      .where('providerKeys', 'array-contains', providerKey)
      .limit(1)
      .get()

    if (!existingProviderSnap.empty) {
      userRecord = await auth.getUser(existingProviderSnap.docs[0]!.id).catch(() => undefined)
    }

    if (!userRecord && oidcClaims.email && oidcClaims.emailVerified) {
      userRecord = await auth.getUserByEmail(oidcClaims.email).catch(() => undefined)
      if (userRecord && !userRecord.emailVerified) {
        userRecord = await auth.updateUser(userRecord.uid, { emailVerified: true }).catch(() => userRecord)
      }
    }

    if (!userRecord && oidcClaims._idpResult?.localId) {
      userRecord = await auth.getUser(oidcClaims._idpResult.localId).catch(() => undefined)
    }

    if (!userRecord) {
      const created = await auth.createUser({
        ...(oidcClaims.email ? { email: oidcClaims.email } : {}),
        emailVerified: oidcClaims.emailVerified,
        ...(resolvedName ? { displayName: resolvedName } : {}),
        ...(resolvedAvatar ? { photoURL: resolvedAvatar } : {})
      })
      return { userRecord: created, isNewUser: true }
    }

    const updates: { displayName?: string; photoURL?: string; emailVerified?: boolean } = {}
    if (resolvedName && !userRecord.displayName) updates.displayName = resolvedName
    if (resolvedAvatar && !userRecord.photoURL) updates.photoURL = resolvedAvatar
    if (oidcClaims.emailVerified && !userRecord.emailVerified && userRecord.email === oidcClaims.email) {
      updates.emailVerified = true
    }
    if (Object.keys(updates).length > 0) {
      userRecord = await auth.updateUser(userRecord.uid, updates).catch(() => userRecord!)
    }
    return { userRecord, isNewUser: false }
  }

  #maybeSendWelcomeEmail = async (userId: string, email?: string | null): Promise<void> => {
    const normalized = email?.trim().toLowerCase()
    if (!normalized) return
    const flowCfg = this.#corge.config.emails.authFlows.welcome
    const hasWelcome =
      Boolean(this.#corge.internals.registry.getEmailTemplate(flowCfg?.templateId ?? 'welcome')) ||
      Boolean(flowCfg?.onSend) ||
      Boolean(this.#corge.config.emails.onAuthEmail)
    if (!hasWelcome) return
    await this.#corge.internals.emails
      .dispatchAuthEmail({
        to: normalized,
        purpose: 'welcome',
        code: '',
        token: '',
        expiresInMinutes: 0,
        userId
      })
      .catch(() => {})
  }

  signInSocial = async (raw: SocialSignInInput): Promise<{ user: AuthUser; sessionCookie: string }> => {
    const { provider, idToken, nonce, accessToken, profile } = socialSignInInput.parse(raw)
    const targetIsDev = this.#corge.env.isDev

    const oidcClaims = await this.verifyOidcIdToken(provider, idToken, nonce, targetIsDev).catch(async (err) => {
      if (err instanceof HTTPException) throw err
      const idp = await this.#tryIdentityToolkitIdp(this.#corge.env.WEB_API_KEY, provider, idToken, nonce, accessToken)
      if (!idp) throw err
      return {
        sub: idp.federatedId ?? idp.localId,
        email: idp.email ?? null,
        emailVerified: Boolean(idp.emailVerified),
        ...(idp.displayName ? { name: idp.displayName } : {}),
        ...(idp.photoUrl ? { picture: idp.photoUrl } : {}),
        _idpResult: idp
      } as VerifiedOidcClaims & { _idpResult?: { localId: string } }
    })

    const providerKey = `${provider}:${oidcClaims.sub}`
    const resolvedName = profile?.name ?? oidcClaims.name
    const resolvedAvatar = profile?.avatarUrl ?? oidcClaims.picture
    const { userRecord, isNewUser } = await this.#resolveOrCreateSocialUser(
      providerKey,
      oidcClaims,
      resolvedName,
      resolvedAvatar,
      targetIsDev
    )

    const existingMeta = await this.#session.getUserAuthMeta(userRecord.uid, targetIsDev)
    const existingProviders = existingMeta?.linkedProviders ?? []
    const now = new Date()
    const updatedProviders: LinkedProvider[] = [
      ...existingProviders.filter((p) => !(p.provider === provider && p.providerUserId === oidcClaims.sub)),
      {
        provider,
        providerUserId: oidcClaims.sub,
        ...(oidcClaims.email ? { email: oidcClaims.email } : {}),
        linkedAt:
          existingProviders.find((p) => p.provider === provider && p.providerUserId === oidcClaims.sub)?.linkedAt ?? now
      }
    ]

    await this.#session.upsertUserAuthMeta(
      userRecord.uid,
      {
        email: userRecord.email ?? oidcClaims.email ?? existingMeta?.email ?? null,
        emailVerified: Boolean(userRecord.emailVerified || oidcClaims.emailVerified || existingMeta?.emailVerified),
        name: userRecord.displayName ?? resolvedName ?? existingMeta?.name ?? null,
        ...(resolvedAvatar || userRecord.photoURL || existingMeta?.avatarUrl
          ? { avatarUrl: userRecord.photoURL ?? resolvedAvatar ?? existingMeta?.avatarUrl ?? null }
          : {}),
        linkedProviders: updatedProviders,
        providerKeys: updatedProviders.map((p) => `${p.provider}:${p.providerUserId}`)
      },
      targetIsDev
    )

    if (isNewUser) {
      await this.#maybeSendWelcomeEmail(userRecord.uid, userRecord.email ?? oidcClaims.email)
    }

    return this.#session.mintSessionForUid(userRecord.uid, {
      ...(userRecord.email ?? oidcClaims.email ? { email: (userRecord.email ?? oidcClaims.email)! } : {}),
      ...(userRecord.displayName ?? resolvedName ? { name: (userRecord.displayName ?? resolvedName)! } : {}),
      ...(userRecord.photoURL ?? resolvedAvatar ? { avatarUrl: (userRecord.photoURL ?? resolvedAvatar)! } : {}),
      emailVerified: Boolean(userRecord.emailVerified || oidcClaims.emailVerified)
    })
  }

  #identityToolkit = async (
    key: string,
    endpoint: 'accounts:signUp' | 'accounts:signInWithPassword',
    email: string,
    password: string,
    displayName?: string
  ): Promise<{ idToken: string; localId: string; displayName?: string }> => {
    const { ok, data } = await fetchIdentityToolkit<{
      idToken?: string
      localId?: string
      displayName?: string
      error?: { message?: string }
    }>(endpoint, key, { email, password, ...(displayName ? { displayName } : {}), returnSecureToken: true })
    if (!ok || !data.idToken) {
      const msg = data.error?.message ?? 'AUTH_FAILED'
      return this.#corge.errors.httpError(msg === 'EMAIL_EXISTS' ? 409 : 401, msg, msg)
    }
    return data as { idToken: string; localId: string; displayName?: string }
  }

  signUpEmail = async (
    email: string,
    password: string,
    name?: string
  ): Promise<{ user: AuthUser; sessionCookie: string }> => {
    const { idToken } = await this.#identityToolkit(
      this.#corge.env.WEB_API_KEY,
      'accounts:signUp',
      email,
      password,
      name
    )
    const session = await this.#session.createSession(idToken, { email, name })
    await this.#maybeSendWelcomeEmail(session.user.id, session.user.email ?? email)
    return session
  }

  signInEmail = async (email: string, password: string): Promise<{ user: AuthUser; sessionCookie: string }> => {
    const { idToken, displayName } = await this.#identityToolkit(
      this.#corge.env.WEB_API_KEY,
      'accounts:signInWithPassword',
      email,
      password
    )
    return this.#session.createSession(idToken, { email, ...(displayName ? { name: displayName } : {}) })
  }
}
