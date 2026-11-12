import { deleteCookie, getCookie } from 'hono/cookie'
import type { Context } from 'hono'
import type { z } from 'zod'
import { CORGE_CONFIG, type AppEnv, type DbRole } from '../config'
import type { EntryId } from '../db'
import { corge } from '../index'
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
  corge.internals.auth.setSessionCookie(c, sessionCookie)
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
      if (input.uid && role !== 'admin' && userId !== CORGE_CONFIG.auth.adminUserId) {
        return corge.errors.httpError(403, 'Admin privileges required to mint token for specific UID', 'FORBIDDEN')
      }
      return corge.internals.auth.mintCustomToken(input.uid)
    }
  },
  'auth.session.create': {
    input: sessionBody,
    handler: async ({ c, input }: { c: Context<AppEnv>; input: z.infer<typeof sessionBody> }) =>
      respondWithSession(c, corge.internals.auth.createSession(input.idToken)).catch(() =>
        corge.errors.httpError(401, 'Invalid ID token', 'INVALID_ID_TOKEN')
      )
  },
  'auth.session.get': {
    handler: async ({ userId }: { userId: EntryId }) => ({ userId })
  },
  'auth.sign-up.email': {
    input: emailSignUpBody,
    handler: async ({ c, input }: { c: Context<AppEnv>; input: z.infer<typeof emailSignUpBody> }) =>
      respondWithSession(c, corge.internals.auth.signUpEmail(input.email, input.password, input.name))
  },
  'auth.sign-in.email': {
    input: emailSignInBody,
    handler: async ({ c, input }: { c: Context<AppEnv>; input: z.infer<typeof emailSignInBody> }) =>
      respondWithSession(c, corge.internals.auth.signInEmail(input.email, input.password))
  },
  'auth.sign-in.social': {
    input: socialSignInInput,
    handler: async ({ c, input }: { c: Context<AppEnv>; input: z.infer<typeof socialSignInInput> }) =>
      respondWithSession(c, corge.auth.signInSocial(input))
  },
  'auth.email.send-verification': {
    input: sendVerificationEmailBody,
    handler: async ({ userId }: { userId: EntryId }) => corge.auth.sendVerificationEmail(userId)
  },
  'auth.email.verify': {
    input: verifyEmailBody,
    handler: async ({ input }: { input: z.infer<typeof verifyEmailBody> }) => corge.auth.verifyEmail(input)
  },
  'auth.password.forgot': {
    input: forgotPasswordBody,
    handler: async ({ input }: { input: z.infer<typeof forgotPasswordBody> }) => corge.auth.forgotPassword(input)
  },
  'auth.password.reset': {
    input: resetPasswordBody,
    handler: async ({ input }: { input: z.infer<typeof resetPasswordBody> }) => corge.auth.resetPassword(input)
  },
  'auth.recovery-email.set': {
    input: setRecoveryEmailBody,
    handler: async ({ userId, input }: { userId: EntryId; input: z.infer<typeof setRecoveryEmailBody> }) =>
      corge.auth.setRecoveryEmail(input, userId)
  },
  'auth.recovery-email.verify': {
    input: verifyRecoveryEmailBody,
    handler: async ({ userId, input }: { userId: EntryId; input: z.infer<typeof verifyRecoveryEmailBody> }) =>
      corge.auth.verifyRecoveryEmail(input, userId)
  },
  'auth.account-recovery.initiate': {
    input: initiateAccountRecoveryBody,
    handler: async ({ input }: { input: z.infer<typeof initiateAccountRecoveryBody> }) =>
      corge.auth.initiateAccountRecovery(input)
  },
  'auth.account-recovery.complete': {
    input: completeAccountRecoveryBody,
    handler: async ({ c, input }: { c: Context<AppEnv>; input: z.infer<typeof completeAccountRecoveryBody> }) =>
      respondWithSession(c, corge.auth.completeAccountRecovery(input))
  },
  'auth.users.list': {
    handler: async () => corge.auth.listUsers()
  },
  'auth.users.block': {
    input: blockUserBody,
    handler: async ({ userId, input }: { userId: EntryId; input: z.infer<typeof blockUserBody> }) =>
      corge.auth.blockUser(input.userId ?? userId, input.blocked)
  },
  'auth.users.delete': {
    mode: 'workflow' as const,
    workflowName: 'erase-user',
    input: eraseUserInput,
    output: eraseUserOutput,
    handler: async ({ input, step }: { input: EraseUserInput; step: StepRunner }) => corge.auth.eraseUser(input, step)
  },
  'auth.sign-out': {
    input: signOutBody,
    handler: async ({ c, input }: { c: Context<AppEnv>; input: z.infer<typeof signOutBody> }) => {
      const cookie = getCookie(c, CORGE_CONFIG.auth.sessionCookie)
      if (cookie) await corge.internals.auth.revokeSession(cookie, Boolean(input.deleteUser)).catch(() => {})
      deleteCookie(c, CORGE_CONFIG.auth.sessionCookie, { path: '/' })
      return { ok: true }
    }
  }
}
