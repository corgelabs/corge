import { z } from 'zod'
import {
  CORGE_CONFIG,
  type AuthEmailPurpose,
  type AuthTokenPurpose,
  type DbRole,
  type TransactionalEmailPayload
} from '../config'
import { entryId, type BaseEntryFields, type EntryId } from '../db'

export { type AuthEmailPurpose, type AuthTokenPurpose, type TransactionalEmailPayload }

export const SESSION_COOKIE = CORGE_CONFIG.auth.sessionCookie
export const SESSION_EXPIRES_IN = CORGE_CONFIG.auth.sessionExpiresInMs
export const ADMIN_USER_ID: EntryId = CORGE_CONFIG.auth.adminUserId

export type OAuthProvider = 'google' | 'apple'

export interface LinkedProvider {
  provider: OAuthProvider
  providerUserId: string
  email?: string | null
  linkedAt: Date
}

export interface CachedTokenEntry {
  uid: EntryId
  role: DbRole
  exp: number
  cachedAt: number
  strictVerified: boolean
  emailVerified?: boolean
}

export interface UserAuthMetaRecord {
  email?: string | null
  emailVerified?: boolean
  name?: string | null
  avatarUrl?: string | null
  recoveryEmail?: string | null
  recoveryEmailVerified?: boolean
  linkedProviders?: LinkedProvider[]
  providerKeys?: string[]
  createdAt?: Date
  updatedAt?: Date
}

export interface VerifiedOidcClaims {
  sub: string
  email: string | null
  emailVerified: boolean
  name?: string
  picture?: string
}

export interface AuthUser {
  id: EntryId
  email: string | null
  emailVerified: boolean
  name: string | null
  avatarUrl?: string | null
  /** Secondary recovery email (stored normalized/lowercase) */
  recoveryEmail?: string | null
  /** True only after the user verifies ownership of `recoveryEmail` via OTP */
  recoveryEmailVerified?: boolean
  linkedProviders?: LinkedProvider[]
  customClaims?: Record<string, unknown>
  deleted: boolean
  createdAt: Date
  updatedAt: Date
}

export interface AuthTokenDoc extends BaseEntryFields {
  userId: EntryId
  purpose: AuthTokenPurpose
  /** Target email address (primary email or recovery email) */
  targetEmail: string
  /** SHA-256 hex digest of the 6-digit OTP code or 32-byte URL token */
  tokenHash: string
  urlTokenHash?: string
  /** Max 5 failed verification attempts before automatic invalidation */
  attempts: number
  expiresAt: Date
  consumedAt?: Date | null
}

export const eraseUserInput = z.object({
  userId: entryId,
  backupBeforeErase: z.boolean().default(false)
})
export const eraseUserOutput = z.object({
  userId: entryId,
  backupOperation: z.string().optional(),
  erasedFiles: z.number(),
  erasedChats: z.number(),
  erasedCollections: z.record(z.string(), z.number()).optional(),
  erasedUser: z.boolean()
})
export type EraseUserInput = z.input<typeof eraseUserInput>
export type EraseUserOutput = z.infer<typeof eraseUserOutput>

export const customTokenBody = z
  .object({ uid: entryId.refine((id) => id !== CORGE_CONFIG.auth.adminUserId, 'Reserved UID').optional() })
  .default({})
export const sessionBody = z.object({ idToken: z.string().min(1) })
export const emailSignUpBody = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(120).optional()
})
export const emailSignInBody = z.object({ email: z.string().email(), password: z.string().min(1).max(128) })

export const socialSignInInput = z.object({
  provider: z.enum(['google', 'apple']),
  /** OIDC ID token returned by Apple Sign-In (iOS/Capacitor/Web) or Google Sign-In */
  idToken: z.string().min(20),
  /** Optional raw nonce for Apple Sign-In replay protection */
  nonce: z.string().optional(),
  /** Optional access token (Google) */
  accessToken: z.string().optional(),
  /**
   * Apple iOS/Capacitor quirk: Apple ONLY sends the user's `name` on the VERY FIRST authorization.
   * Accept optional first-time profile data from the client and persist it immediately.
   */
  profile: z
    .object({
      name: z.string().min(1).max(128).optional(),
      avatarUrl: z.string().url().optional()
    })
    .optional()
})
export type SocialSignInInput = z.infer<typeof socialSignInInput>

export const sendVerificationEmailBody = z.object({}).default({})
export const verifyEmailBody = z.object({
  email: z.string().email(),
  codeOrToken: z.string().min(4).max(512)
})
export type VerifyEmailInput = z.infer<typeof verifyEmailBody>

export const forgotPasswordBody = z.object({
  email: z.string().email()
})
export type ForgotPasswordInput = z.infer<typeof forgotPasswordBody>

export const resetPasswordBody = z.object({
  email: z.string().email(),
  codeOrToken: z.string().min(4).max(512),
  newPassword: z.string().min(8).max(128)
})
export type ResetPasswordInput = z.infer<typeof resetPasswordBody>

export const setRecoveryEmailBody = z.object({
  recoveryEmail: z.string().email()
})
export type SetRecoveryEmailInput = z.infer<typeof setRecoveryEmailBody>

export const verifyRecoveryEmailBody = z.object({
  codeOrToken: z.string().min(4).max(512)
})
export type VerifyRecoveryEmailInput = z.infer<typeof verifyRecoveryEmailBody>

export const initiateAccountRecoveryBody = z.object({
  primaryEmail: z.string().email(),
  recoveryEmail: z.string().email()
})
export type InitiateAccountRecoveryInput = z.infer<typeof initiateAccountRecoveryBody>

export const completeAccountRecoveryBody = z.object({
  primaryEmail: z.string().email(),
  recoveryEmail: z.string().email(),
  codeOrToken: z.string().min(4).max(512),
  newPrimaryEmail: z.string().email(),
  newPassword: z.string().min(8).max(128).optional()
})
export type CompleteAccountRecoveryInput = z.infer<typeof completeAccountRecoveryBody>

export const blockUserBody = z
  .object({ userId: entryId.optional(), blocked: z.boolean().default(true) })
  .default({ blocked: true })
export const signOutBody = z.object({ deleteUser: z.boolean().optional() }).default({})
