import { CORE_CONFIG } from '../config'
import { getRegisteredCollectionNames, type EntryId } from '../db'
import type { Core } from '../index'
import type { StepRunner } from '../tasks'
import { AuthOidcEngine } from './oidc'
import { AuthRecoveryEngine } from './recovery'
import {
  eraseUserInput,
  eraseUserOutput,
  type AuthUser,
  type CompleteAccountRecoveryInput,
  type EraseUserInput,
  type EraseUserOutput,
  type ForgotPasswordInput,
  type InitiateAccountRecoveryInput,
  type ResetPasswordInput,
  type SetRecoveryEmailInput,
  type SocialSignInInput,
  type VerifyEmailInput,
  type VerifyRecoveryEmailInput
} from './schema'
import { AuthSessionEngine, tokenCache } from './session'
import { hashToken, mapUserRecord, resolveUserRole } from './utils'

export class AuthService {
  readonly #core: Core
  readonly #session: AuthSessionEngine
  readonly #oidc: AuthOidcEngine
  readonly #recovery: AuthRecoveryEngine

  constructor(coreClient: Core) {
    this.#core = coreClient
    this.#session = new AuthSessionEngine(coreClient)
    this.#oidc = new AuthOidcEngine(coreClient, this.#session)
    this.#recovery = new AuthRecoveryEngine(coreClient, this.#session)
  }

  signInSocial = (raw: SocialSignInInput): Promise<{ user: AuthUser; sessionCookie: string }> =>
    this.#oidc.signInSocial(raw)

  sendVerificationEmail = (userId?: EntryId): Promise<{ sent: true; expiresInMinutes: number }> =>
    this.#recovery.sendVerificationEmail(userId)

  verifyEmail = (raw: VerifyEmailInput): Promise<{ verified: true; userId: string }> =>
    this.#recovery.verifyEmail(raw)

  forgotPassword = (raw: ForgotPasswordInput): Promise<{ sent: true }> => this.#recovery.forgotPassword(raw)

  resetPassword = (raw: ResetPasswordInput): Promise<{ reset: true }> => this.#recovery.resetPassword(raw)

  setRecoveryEmail = (
    raw: SetRecoveryEmailInput,
    userId?: EntryId
  ): Promise<{ recoveryEmail: string; recoveryEmailVerified: false; sent: true }> =>
    this.#recovery.setRecoveryEmail(raw, userId)

  verifyRecoveryEmail = (
    raw: VerifyRecoveryEmailInput,
    userId?: EntryId
  ): Promise<{ recoveryEmail: string; recoveryEmailVerified: true; verified: true }> =>
    this.#recovery.verifyRecoveryEmail(raw, userId)

  initiateAccountRecovery = (raw: InitiateAccountRecoveryInput): Promise<{ initiated: true }> =>
    this.#recovery.initiateAccountRecovery(raw)

  completeAccountRecovery = (raw: CompleteAccountRecoveryInput): Promise<{ user: AuthUser; sessionCookie: string }> =>
    this.#recovery.completeAccountRecovery(raw)

  getUser = async (uid: EntryId): Promise<AuthUser | undefined> => {
    try {
      const [u, meta] = await Promise.all([
        this.#session.getAuth().getUser(uid),
        this.#session.getUserAuthMeta(uid, this.#core.env.isDev)
      ])
      return mapUserRecord(u, meta)
    } catch {
      return undefined
    }
  }

  setClaims = async (uid: EntryId, claims: Record<string, unknown> | null): Promise<void> => {
    await this.#session.getAuth().setCustomUserClaims(uid, claims)
    this.#session.evictUserTokens(uid)
    await this.#session.recordRevocation(uid, this.#core.env.isDev)
  }

  listUsers = async (includeDeleted = false): Promise<AuthUser[]> => {
    const { users } = await this.#session.getAuth().listUsers(1000)
    return users.map((u) => mapUserRecord(u)).filter((u) => includeDeleted || !u.deleted)
  }

  blockUser = async (
    userId: EntryId = this.#core.userId,
    blocked = true
  ): Promise<{ userId: EntryId; blocked: boolean; deleted: boolean }> => {
    const auth = this.#session.getAuth()
    this.#session.evictUserTokens(userId)
    await Promise.all([
      blocked
        ? this.#session.recordRevocation(userId, this.#core.env.isDev)
        : this.#session.clearUserRevocation(userId, this.#core.env.isDev),
      ...(blocked ? [auth.revokeRefreshTokens(userId).catch(() => {})] : []),
      auth.updateUser(userId, { disabled: blocked }).catch(() => {})
    ])
    return { userId, blocked, deleted: blocked }
  }

  #triggerFirestoreBackup = async (userId: string): Promise<string> => {
    const projectId = this.#core.config.gcpProject
    const dbId = this.#core.env.isDev ? this.#core.config.firestoreDbs.dev : this.#core.config.firestoreDbs.prod
    const bucketName = this.#core.env.isDev
      ? this.#core.config.storageBuckets.dev
      : this.#core.config.storageBuckets.prod
    const outputUriPrefix = `gs://${bucketName}/backups/${dbId}-${userId}-${Date.now()}`
    const accessToken = await this.#core.internals.registry.getGcpAccessToken()
    const res = await fetch(
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${dbId}:exportDocuments`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ outputUriPrefix, collectionIds: getRegisteredCollectionNames() })
      }
    )
    if (!res.ok) throw new Error(`Firestore exportDocuments failed (${res.status}): ${await res.text()}`)
    const data = (await res.json()) as { name?: string }
    return data.name ?? outputUriPrefix
  }

  eraseUser = async (raw: EraseUserInput, step: StepRunner = this.#core.step): Promise<EraseUserOutput> => {
    const { userId, backupBeforeErase } = eraseUserInput.parse(raw)
    const backupOperation = backupBeforeErase
      ? await step('backup', () => this.#triggerFirestoreBackup(userId))
      : undefined

    const { erasedFiles, erasedChats, erasedCollections } =
      await this.#core.internals.registry.cascadeEraseUserCollections(userId, step)

    const erasedUser = await step('erase-user', async () => {
      this.#session.evictUserTokens(userId)
      await Promise.all([
        this.#session.recordRevocation(userId, this.#core.env.isDev),
        this.#session.getAuth().deleteUser(userId).catch(() => {})
      ])
      return true
    })

    return eraseUserOutput.parse({
      userId,
      ...(backupOperation ? { backupOperation } : {}),
      erasedFiles,
      erasedChats,
      ...(Object.keys(erasedCollections).length ? { erasedCollections } : {}),
      erasedUser
    })
  }

  get internals() {
    const getAuthWarm = this.#session.getAuthWarm
    return {
      verifyToken: this.#session.verifyToken,
      hashToken,
      resolveUserRole,
      tokenCache,
      setTokenCache: this.#session.setTokenCache,
      recordRevocation: this.#session.recordRevocation,
      syncRevocations: this.#session.syncRevocations,
      getLastDevEmail: this.#recovery.getLastDevEmail,
      registerTestOidcPublicKey: this.#oidc.registerTestOidcPublicKey,
      get sessionCookie() {
        return CORE_CONFIG.auth.sessionCookie
      },
      get authWarm() {
        return getAuthWarm()
      },
      mintCustomToken: this.#session.mintCustomToken,
      createSession: this.#session.createSession,
      signUpEmail: this.#oidc.signUpEmail,
      signInEmail: this.#oidc.signInEmail,
      revokeSession: this.#session.revokeSession,
      setSessionCookie: this.#session.setSessionCookie
    }
  }
}
