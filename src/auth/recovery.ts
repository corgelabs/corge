import { randomBytes, randomInt } from 'node:crypto'
import type { UserRecord } from 'firebase-admin/auth'
import type { EntryId } from '../db'
import type { Core } from '../index'
import {
  completeAccountRecoveryBody,
  forgotPasswordBody,
  initiateAccountRecoveryBody,
  resetPasswordBody,
  setRecoveryEmailBody,
  verifyEmailBody,
  verifyRecoveryEmailBody,
  type AuthEmailPurpose,
  type AuthTokenPurpose,
  type AuthUser,
  type CompleteAccountRecoveryInput,
  type ForgotPasswordInput,
  type InitiateAccountRecoveryInput,
  type ResetPasswordInput,
  type SetRecoveryEmailInput,
  type TransactionalEmailPayload,
  type VerifyEmailInput,
  type VerifyRecoveryEmailInput
} from './schema'
import type { AuthSessionEngine } from './session'
import { hashToken, normalizeDate, safeEqualHex } from './utils'

export class AuthRecoveryEngine {
  readonly #core: Core
  readonly #session: AuthSessionEngine

  constructor(coreClient: Core, session: AuthSessionEngine) {
    this.#core = coreClient
    this.#session = session
  }

  getLastDevEmail = (to: string, purpose: AuthEmailPurpose): TransactionalEmailPayload | undefined =>
    this.#core.internals.emails.getLastDevEmail(to, purpose)

  #issueAuthToken = async (
    userId: EntryId,
    purpose: AuthTokenPurpose,
    targetEmail: string,
    expiresInMinutes = this.#core.config.emails.otpTtlMinutes
  ): Promise<TransactionalEmailPayload> => {
    const normalizedTarget = targetEmail.trim().toLowerCase()
    const code = String(randomInt(100_000, 1_000_000))
    const token = randomBytes(32).toString('base64url')
    const tokenHash = hashToken(code)
    const urlTokenHash = hashToken(token)
    const now = new Date()
    const expiresAt = new Date(now.getTime() + expiresInMinutes * 60_000)
    const docId = `${userId}_${purpose}`

    await this.#core.db
      .firestore()
      .collection('auth_tokens')
      .doc(docId)
      .set({
        id: docId,
        userId,
        purpose,
        targetEmail: normalizedTarget,
        tokenHash,
        urlTokenHash,
        attempts: 0,
        expiresAt,
        consumedAt: null,
        deleted: false,
        createdAt: now,
        updatedAt: now
      })

    const payload: TransactionalEmailPayload = {
      to: normalizedTarget,
      purpose,
      code,
      token,
      expiresInMinutes,
      userId
    }
    await this.#core.internals.emails.dispatchAuthEmail(payload)
    return payload
  }

  #consumeAuthToken = async (
    userId: EntryId,
    purpose: AuthTokenPurpose,
    expectedTargetEmail: string,
    codeOrToken: string
  ): Promise<void> => {
    const db = this.#core.db.firestore()
    const docRef = db.collection('auth_tokens').doc(`${userId}_${purpose}`)
    const maxAttempts = this.#core.config.emails.maxVerifyAttempts
    const normalizedExpected = expectedTargetEmail.trim().toLowerCase()
    const candidateHash = hashToken(codeOrToken)

    type ConsumeOutcome = 'valid' | 'missing_or_consumed' | 'expired' | 'max_attempts' | 'mismatch'

    const outcome = await db.runTransaction<ConsumeOutcome>(async (tx) => {
      const snap = await tx.get(docRef)
      if (!snap.exists) return 'missing_or_consumed'
      const data = snap.data() as Record<string, unknown> | undefined
      if (!data || data.deleted === true || data.consumedAt != null) return 'missing_or_consumed'

      const attempts = typeof data.attempts === 'number' ? data.attempts : 0
      if (attempts >= maxAttempts) return 'max_attempts'

      const now = new Date()
      if (normalizeDate(data.expiresAt, new Date(0)).getTime() <= now.getTime()) {
        tx.update(docRef, { deleted: true, updatedAt: now })
        return 'expired'
      }

      const targetEmail = String(data.targetEmail ?? '').trim().toLowerCase()
      const tokenHash = String(data.tokenHash ?? '')
      const urlTokenHash = typeof data.urlTokenHash === 'string' ? data.urlTokenHash : ''
      const matches =
        targetEmail === normalizedExpected &&
        (safeEqualHex(candidateHash, tokenHash) ||
          (Boolean(urlTokenHash) && safeEqualHex(candidateHash, urlTokenHash)))

      if (!matches) {
        const nextAttempts = attempts + 1
        const exhausted = nextAttempts >= maxAttempts
        tx.update(docRef, {
          attempts: nextAttempts,
          ...(exhausted ? { deleted: true, consumedAt: now } : {}),
          updatedAt: now
        })
        return exhausted ? 'max_attempts' : 'mismatch'
      }

      tx.update(docRef, { consumedAt: now, deleted: true, updatedAt: now })
      return 'valid'
    })

    if (outcome === 'valid') return
    if (outcome === 'expired') this.#core.errors.httpError(400, 'Verification token has expired', 'TOKEN_EXPIRED')
    if (outcome === 'max_attempts') {
      this.#core.errors.httpError(
        400,
        'Maximum verification attempts exceeded; token invalidated',
        'TOKEN_MAX_ATTEMPTS_EXCEEDED'
      )
    }
    this.#core.errors.httpError(400, 'Invalid or expired verification code', 'INVALID_TOKEN')
  }

  #requireUserByEmail = async (
    email: string,
    errMessage: string,
    errCode: string,
    rejectDisabled = false
  ): Promise<{ user: UserRecord; normalizedEmail: string }> => {
    const normalizedEmail = email.trim().toLowerCase()
    const user = await this.#session
      .getAuth()
      .getUserByEmail(normalizedEmail)
      .catch(() => undefined)
    if (!user || !user.email || (rejectDisabled && user.disabled)) {
      return this.#core.errors.httpError(400, errMessage, errCode)
    }
    return { user, normalizedEmail }
  }

  #revokeAllUserSessions = async (uid: EntryId): Promise<void> => {
    this.#session.evictUserTokens(uid)
    await Promise.all([
      this.#session.recordRevocation(uid, this.#core.env.isDev),
      this.#session
        .getAuth()
        .revokeRefreshTokens(uid)
        .catch(() => {})
    ])
  }

  sendVerificationEmail = async (
    userId: EntryId = this.#core.userId
  ): Promise<{ sent: true; expiresInMinutes: number }> => {
    if (!userId) return this.#core.errors.httpError(401, 'Unauthorized', 'UNAUTHORIZED')
    const user = await this.#session
      .getAuth()
      .getUser(userId)
      .catch(() => undefined)
    if (!user || !user.email) {
      return this.#core.errors.httpError(400, 'User does not have a primary email address', 'MISSING_EMAIL')
    }
    const expiresInMinutes = this.#core.config.emails.otpTtlMinutes
    await this.#issueAuthToken(user.uid, 'verify_email', user.email, expiresInMinutes)
    return { sent: true, expiresInMinutes }
  }

  #consumeAndUpsertMeta = async (
    uid: EntryId,
    purpose: AuthTokenPurpose,
    targetEmail: string,
    codeOrToken: string,
    metaPatch: Parameters<AuthSessionEngine['upsertUserAuthMeta']>[1]
  ): Promise<void> => {
    await this.#consumeAuthToken(uid, purpose, targetEmail, codeOrToken)
    await this.#session.upsertUserAuthMeta(uid, metaPatch, this.#core.env.isDev)
  }

  verifyEmail = async (raw: VerifyEmailInput): Promise<{ verified: true; userId: string }> => {
    const { email, codeOrToken } = verifyEmailBody.parse(raw)
    const { user, normalizedEmail } = await this.#requireUserByEmail(
      email,
      'Invalid email or verification token',
      'INVALID_TOKEN'
    )
    await this.#consumeAndUpsertMeta(user.uid, 'verify_email', user.email!, codeOrToken, {
      email: normalizedEmail,
      emailVerified: true
    })
    await this.#session.getAuth().updateUser(user.uid, { emailVerified: true })
    this.#session.evictUserTokens(user.uid)
    return { verified: true, userId: user.uid }
  }

  forgotPassword = async (raw: ForgotPasswordInput): Promise<{ sent: true }> => {
    const { email } = forgotPasswordBody.parse(raw)
    const normalizedEmail = email.trim().toLowerCase()
    const user = await this.#session
      .getAuth()
      .getUserByEmail(normalizedEmail)
      .catch(() => undefined)
    if (user && user.email && !user.disabled) {
      await this.#issueAuthToken(user.uid, 'reset_password', user.email, this.#core.config.emails.otpTtlMinutes)
    }
    return { sent: true }
  }

  resetPassword = async (raw: ResetPasswordInput): Promise<{ reset: true }> => {
    const { email, codeOrToken, newPassword } = resetPasswordBody.parse(raw)
    const { user } = await this.#requireUserByEmail(email, 'Invalid email or reset token', 'INVALID_TOKEN')
    await this.#consumeAuthToken(user.uid, 'reset_password', user.email!, codeOrToken)
    await this.#session.getAuth().updateUser(user.uid, { password: newPassword })
    await this.#revokeAllUserSessions(user.uid)
    return { reset: true }
  }

  setRecoveryEmail = async (
    raw: SetRecoveryEmailInput,
    userId: EntryId = this.#core.userId
  ): Promise<{ recoveryEmail: string; recoveryEmailVerified: false; sent: true }> => {
    if (!userId) return this.#core.errors.httpError(401, 'Unauthorized', 'UNAUTHORIZED')
    const { recoveryEmail } = setRecoveryEmailBody.parse(raw)
    const normalizedRecovery = recoveryEmail.trim().toLowerCase()
    const user = await this.#session
      .getAuth()
      .getUser(userId)
      .catch(() => undefined)
    if (!user) return this.#core.errors.httpError(404, 'User not found', 'NOT_FOUND')

    const primaryEmail = (user.email ?? '').trim().toLowerCase()
    if (primaryEmail && normalizedRecovery === primaryEmail) {
      return this.#core.errors.httpError(
        400,
        'Recovery email must be different from primary email',
        'INVALID_RECOVERY_EMAIL'
      )
    }

    await this.#session.upsertUserAuthMeta(
      user.uid,
      {
        ...(primaryEmail ? { email: primaryEmail } : {}),
        recoveryEmail: normalizedRecovery,
        recoveryEmailVerified: false
      },
      this.#core.env.isDev
    )
    await this.#issueAuthToken(
      user.uid,
      'verify_recovery_email',
      normalizedRecovery,
      this.#core.config.emails.otpTtlMinutes
    )
    return { recoveryEmail: normalizedRecovery, recoveryEmailVerified: false, sent: true }
  }

  verifyRecoveryEmail = async (
    raw: VerifyRecoveryEmailInput,
    userId: EntryId = this.#core.userId
  ): Promise<{ recoveryEmail: string; recoveryEmailVerified: true; verified: true }> => {
    if (!userId) return this.#core.errors.httpError(401, 'Unauthorized', 'UNAUTHORIZED')
    const { codeOrToken } = verifyRecoveryEmailBody.parse(raw)
    const meta = await this.#session.getUserAuthMeta(userId, this.#core.env.isDev)
    if (!meta?.recoveryEmail) {
      return this.#core.errors.httpError(
        400,
        'No recovery email configured for this account',
        'MISSING_RECOVERY_EMAIL'
      )
    }
    await this.#consumeAndUpsertMeta(userId, 'verify_recovery_email', meta.recoveryEmail, codeOrToken, {
      recoveryEmailVerified: true
    })
    return { recoveryEmail: meta.recoveryEmail, recoveryEmailVerified: true, verified: true }
  }

  initiateAccountRecovery = async (raw: InitiateAccountRecoveryInput): Promise<{ initiated: true }> => {
    const { primaryEmail, recoveryEmail } = initiateAccountRecoveryBody.parse(raw)
    const normPrimary = primaryEmail.trim().toLowerCase()
    const normRecovery = recoveryEmail.trim().toLowerCase()
    const user = await this.#session
      .getAuth()
      .getUserByEmail(normPrimary)
      .catch(() => undefined)
    if (user && !user.disabled && (user.email ?? '').trim().toLowerCase() === normPrimary) {
      const meta = await this.#session.getUserAuthMeta(user.uid, this.#core.env.isDev)
      if (meta?.recoveryEmail === normRecovery && meta.recoveryEmailVerified === true) {
        await this.#issueAuthToken(
          user.uid,
          'account_recovery',
          normRecovery,
          this.#core.config.emails.recoveryOtpTtlMinutes
        )
      }
    }
    return { initiated: true }
  }

  completeAccountRecovery = async (
    raw: CompleteAccountRecoveryInput
  ): Promise<{ user: AuthUser; sessionCookie: string }> => {
    const { primaryEmail, recoveryEmail, codeOrToken, newPrimaryEmail, newPassword } =
      completeAccountRecoveryBody.parse(raw)
    const normPrimary = primaryEmail.trim().toLowerCase()
    const normRecovery = recoveryEmail.trim().toLowerCase()
    const normNewPrimary = newPrimaryEmail.trim().toLowerCase()

    const { user } = await this.#requireUserByEmail(
      normPrimary,
      'Invalid account recovery request or token',
      'INVALID_RECOVERY_REQUEST',
      true
    )
    if ((user.email ?? '').trim().toLowerCase() !== normPrimary) {
      return this.#core.errors.httpError(400, 'Invalid account recovery request or token', 'INVALID_RECOVERY_REQUEST')
    }

    const meta = await this.#session.getUserAuthMeta(user.uid, this.#core.env.isDev)
    if (!meta || meta.recoveryEmail !== normRecovery || meta.recoveryEmailVerified !== true) {
      return this.#core.errors.httpError(400, 'Invalid account recovery request or token', 'INVALID_RECOVERY_REQUEST')
    }

    await this.#consumeAndUpsertMeta(user.uid, 'account_recovery', normRecovery, codeOrToken, {
      email: normNewPrimary,
      emailVerified: true
    })
    await this.#session.getAuth().updateUser(user.uid, {
      email: normNewPrimary,
      emailVerified: true,
      ...(newPassword ? { password: newPassword } : {})
    })
    await this.#revokeAllUserSessions(user.uid)

    return this.#session.mintSessionForUid(user.uid, {
      email: normNewPrimary,
      emailVerified: true
    })
  }
}
