import { deleteCookie, getCookie } from 'hono/cookie'
import type { Context } from 'hono'
import type { z } from 'zod'
import { CORE_CONFIG, type AppEnv, type DbRole } from '../config'
import type { EntryId } from '../db'
import { core } from '../index'
import type { StepRunner } from '../tasks'
import {
  blockUserBody,
  completeAccountRecoveryBody,
  customTokenBody,
  emailSignInBody,
  emailSignUpBody,
  eraseUserInput,
  eraseUserOutput,
  forgotPasswordBody,
  initiateAccountRecoveryBody,
  resetPasswordBody,
  sendVerificationEmailBody,
  sessionBody,
  setRecoveryEmailBody,
  signOutBody,
  socialSignInInput,
  verifyEmailBody,
  verifyRecoveryEmailBody,
  type AuthUser,
  type EraseUserInput
} from './schema'

const respondWithSession = async (
  c: Context<AppEnv>,
  p: Promise<{ user: AuthUser; sessionCookie: string }>
): Promise<AuthUser> => {
  const { user, sessionCookie } = await p
  core.internals.auth.setSessionCookie(c, sessionCookie)
  return user
}

export const coreAuthRoutes = {
  'auth.custom-token': {
    input: customTokenBody,
    handler: async ({
      input,
      userId,
      role
    }: {
      input: z.infer<typeof customTokenBody>
      userId: EntryId
      role: DbRole
    }) => {
      if (input.uid && role !== 'admin' && userId !== CORE_CONFIG.auth.adminUserId) {
        return core.errors.httpError(403, 'Admin privileges required to mint token for specific UID', 'FORBIDDEN')
      }
      return core.internals.auth.mintCustomToken(input.uid)
    }
  },
  'auth.session.create': {
    input: sessionBody,
    handler: async ({ c, input }: { c: Context<AppEnv>; input: z.infer<typeof sessionBody> }) =>
      respondWithSession(c, core.internals.auth.createSession(input.idToken)).catch(() =>
        core.errors.httpError(401, 'Invalid ID token', 'INVALID_ID_TOKEN')
      )
  },
  'auth.session.get': {
    handler: async ({ userId }: { userId: EntryId }) => ({ userId })
  },
  'auth.sign-up.email': {
    input: emailSignUpBody,
    handler: async ({ c, input }: { c: Context<AppEnv>; input: z.infer<typeof emailSignUpBody> }) =>
      respondWithSession(c, core.internals.auth.signUpEmail(input.email, input.password, input.name))
  },
  'auth.sign-in.email': {
    input: emailSignInBody,
    handler: async ({ c, input }: { c: Context<AppEnv>; input: z.infer<typeof emailSignInBody> }) =>
      respondWithSession(c, core.internals.auth.signInEmail(input.email, input.password))
  },
  'auth.sign-in.social': {
    input: socialSignInInput,
    handler: async ({ c, input }: { c: Context<AppEnv>; input: z.infer<typeof socialSignInInput> }) =>
      respondWithSession(c, core.auth.signInSocial(input))
  },
  'auth.email.send-verification': {
    input: sendVerificationEmailBody,
    handler: async ({ userId }: { userId: EntryId }) => core.auth.sendVerificationEmail(userId)
  },
  'auth.email.verify': {
    input: verifyEmailBody,
    handler: async ({ input }: { input: z.infer<typeof verifyEmailBody> }) => core.auth.verifyEmail(input)
  },
  'auth.password.forgot': {
    input: forgotPasswordBody,
    handler: async ({ input }: { input: z.infer<typeof forgotPasswordBody> }) => core.auth.forgotPassword(input)
  },
  'auth.password.reset': {
    input: resetPasswordBody,
    handler: async ({ input }: { input: z.infer<typeof resetPasswordBody> }) => core.auth.resetPassword(input)
  },
  'auth.recovery-email.set': {
    input: setRecoveryEmailBody,
    handler: async ({ userId, input }: { userId: EntryId; input: z.infer<typeof setRecoveryEmailBody> }) =>
      core.auth.setRecoveryEmail(input, userId)
  },
  'auth.recovery-email.verify': {
    input: verifyRecoveryEmailBody,
    handler: async ({ userId, input }: { userId: EntryId; input: z.infer<typeof verifyRecoveryEmailBody> }) =>
      core.auth.verifyRecoveryEmail(input, userId)
  },
  'auth.account-recovery.initiate': {
    input: initiateAccountRecoveryBody,
    handler: async ({ input }: { input: z.infer<typeof initiateAccountRecoveryBody> }) =>
      core.auth.initiateAccountRecovery(input)
  },
  'auth.account-recovery.complete': {
    input: completeAccountRecoveryBody,
    handler: async ({ c, input }: { c: Context<AppEnv>; input: z.infer<typeof completeAccountRecoveryBody> }) =>
      respondWithSession(c, core.auth.completeAccountRecovery(input))
  },
  'auth.users.list': {
    handler: async () => core.auth.listUsers()
  },
  'auth.users.block': {
    input: blockUserBody,
    handler: async ({ userId, input }: { userId: EntryId; input: z.infer<typeof blockUserBody> }) =>
      core.auth.blockUser(input.userId ?? userId, input.blocked)
  },
  'auth.users.delete': {
    mode: 'workflow' as const,
    workflowName: 'erase-user',
    input: eraseUserInput,
    output: eraseUserOutput,
    handler: async ({ input, step }: { input: EraseUserInput; step: StepRunner }) => core.auth.eraseUser(input, step)
  },
  'auth.sign-out': {
    input: signOutBody,
    handler: async ({ c, input }: { c: Context<AppEnv>; input: z.infer<typeof signOutBody> }) => {
      const cookie = getCookie(c, CORE_CONFIG.auth.sessionCookie)
      if (cookie) await core.internals.auth.revokeSession(cookie, Boolean(input.deleteUser)).catch(() => {})
      deleteCookie(c, CORE_CONFIG.auth.sessionCookie, { path: '/' })
      return { ok: true }
    }
  }
}
