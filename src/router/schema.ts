import type { Context } from 'hono'
import type { z } from 'zod'
import { processAttachmentsInput, scanAttachmentInput, type AttachmentTypesMap } from '../attachments'
import {
  blockUserBody, completeAccountRecoveryBody, customTokenBody, emailSignInBody, emailSignUpBody,
  eraseUserInput, eraseUserOutput, forgotPasswordBody, initiateAccountRecoveryBody, resetPasswordBody,
  sendVerificationEmailBody, sessionBody, setRecoveryEmailBody, signOutBody, socialSignInInput,
  verifyEmailBody, verifyRecoveryEmailBody
} from '../auth'
import { openaiCompletionsBody, saveChatBody, streamChatBody, type AgentConfig, type ContextItemSpec } from '../chat'
import type { AppBindings, AppEnv, DbRole, RateLimitConfig } from '../config'
import { fileScan, type CollectionDefinition, type CollectionName, type EntryId } from '../db'
import {
  emailLogsQuerySchema, emailWebhookParamsSchema, sendBatchEmailInputSchema, sendBatchEmailResultSchema,
  sendEmailInputSchema, sendEmailResultSchema, type EmailTemplatesMap, type SendEmailInput
} from '../emails'
import type { Core } from '../index'
import {
  cancelSubscriptionInput, changeTierInput, chargeResultSchema, checkoutSessionResultSchema,
  createCheckoutInput, createInvoiceInput, createPaymentLinkInput, directChargeInput, invoiceResultSchema,
  paymentLinkResultSchema, paymentWebhookParamsSchema, subscribeInput, subscribeResultSchema,
  subscriptionRecordSchema, type CancelSubscriptionInput, type ChangeTierInput, type CreateCheckoutInput,
  type CreateInvoiceInput, type CreatePaymentLinkInput, type DirectChargeInput, type PlansMap,
  type ProductsMap, type SubscribeInput
} from '../payments'
import type { RollbackLeg, StepRetryPolicy, StepRunner } from '../tasks'
import type { Duration } from '../utils'

export type AuthLevel = 'public' | 'user' | 'strict' | 'admin' | false | 'none' | 'authenticated' | 'api-key'

export type RouteMode = 'rest' | 'workflow'

export interface ResourceGuardConfig<I = any> {
  checkFileRef?: boolean | ((input: I, c?: Context<AppEnv>) => string | string[] | undefined)
  checkUserId?: boolean | ((input: I, c?: Context<AppEnv>) => string | undefined)
  checkCollectionField?: { collection: CollectionName; param: string }
  requireEmailVerified?: boolean
  custom?: (ctx: {
    userId: EntryId
    role: DbRole
    input: I
    env: AppBindings
    c?: Context<AppEnv>
  }) => boolean | Promise<boolean>
}

export interface RouteExecutionContext<
  I = any,
  P = Record<string, string>,
  Q = Record<string, string>
> {
  core: Core
  env: AppBindings
  userId: EntryId
  role: DbRole
  mode: RouteMode
  step: StepRunner
  allWithRollback: <T extends readonly unknown[]>(legs: { [K in keyof T]: RollbackLeg<T[K]> }) => Promise<T>
  input: I
  params: P
  query: Q
  rawBody?: string
  c: Context<AppEnv>
}

export interface BaseRouteConfig<I = any, O = any, P = any, Q = any> {
  mode?: RouteMode
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'ALL'
  path?: string
  workflowName?: string
  description?: string
  auth?: AuthLevel
  rateLimit?: RateLimitConfig
  guard?: ResourceGuardConfig<I>
  params?: z.ZodType<P>
  query?: z.ZodType<Q>
  input?: z.ZodType<I>
  output?: z.ZodType<O>
  rawBody?: boolean
  mcp?: boolean
  tool?: boolean
  timeout?: Duration
  retry?: number | StepRetryPolicy
  idempotencyKey?: (input: I, ctx: { userId: EntryId }) => string | undefined
}

export interface RouteConfig<I = any, O = any, P = any, Q = any> extends BaseRouteConfig<I, O, P, Q> {
  shortCircuit?: (ctx: RouteExecutionContext<I, P, Q>) => Promise<O | undefined | null> | O | undefined | null
  handler: (ctx: RouteExecutionContext<I, P, Q>) => Response | O | Promise<Response | O>
}

export type CoreRouteId =
  | 'health'
  | 'auth.custom-token'
  | 'auth.session.create'
  | 'auth.session.get'
  | 'auth.sign-up.email'
  | 'auth.sign-in.email'
  | 'auth.sign-in.social'
  | 'auth.email.send-verification'
  | 'auth.email.verify'
  | 'auth.password.forgot'
  | 'auth.password.reset'
  | 'auth.recovery-email.set'
  | 'auth.recovery-email.verify'
  | 'auth.account-recovery.initiate'
  | 'auth.account-recovery.complete'
  | 'auth.users.list'
  | 'auth.users.block'
  | 'auth.users.delete'
  | 'auth.sign-out'
  | 'files.upload'
  | 'files.list'
  | 'files.get'
  | 'files.delete'
  | 'chat.list'
  | 'chat.get'
  | 'chat.messages'
  | 'chat.save'
  | 'chat.delete'
  | 'chat.stream'
  | 'chat.cancel'
  | 'openai.models'
  | 'openai.completions'
  | 'attachments.scan'
  | 'attachments.process'
  | 'routes.list'
  | 'tasks.status'
  | 'tasks.signal'
  | 'tasks.cancel'
  | 'emails.send'
  | 'emails.batch'
  | 'emails.logs'
  | 'emails.webhook'
  | 'payments.checkout'
  | 'payments.paymentLink'
  | 'payments.invoice'
  | 'payments.charge'
  | 'payments.subscribe'
  | 'payments.changeTier'
  | 'payments.cancelSubscription'
  | 'payments.status'
  | 'payments.webhook'

export type CoreRouteOverride = Partial<
  Pick<RouteConfig, 'auth' | 'rateLimit' | 'guard' | 'mcp' | 'tool' | 'timeout' | 'retry' | 'description'>
>

export type CoreRouteOverrides = Partial<Record<CoreRouteId, CoreRouteOverride>>

export interface WorkflowRegistryEntry {
  name: string
  description: string
  input: z.ZodType<any>
  output?: z.ZodType<any>
  mode: RouteMode
  deadlineSeconds?: number
  guard?: BaseRouteConfig['guard']
  runTask: (params: any, step: StepRunner) => Promise<unknown>
  invoke: (
    params: any,
    userId: EntryId,
    c?: Context<AppEnv>,
    role?: DbRole,
    opts?: { wait?: boolean }
  ) => Promise<unknown>
}

export interface CoreAppInit {
  coreRouteOverrides?: CoreRouteOverrides
  attachmentTypes?: AttachmentTypesMap
  emailTemplates?: EmailTemplatesMap
  plans?: PlansMap
  products?: ProductsMap
  agents?: Record<string, AgentConfig>
  routes?: Record<string, RouteConfig<any, any, any, any>>
  collections?: Record<string, CollectionDefinition<any>>
  context?: readonly ContextItemSpec[]
}

export const defineRoute = <C extends RouteConfig<any, any, any, any>>(config: C): C => ({ mcp: false, ...config })

export const defineRoutes = <T extends Record<string, RouteConfig<any, any, any, any>>>(routes: T): T => routes

export const defineRouteOverrides = <T extends CoreRouteOverrides>(overrides: T): T => overrides

export const CORE_ROUTE_DEFAULTS: Record<CoreRouteId, BaseRouteConfig> = {
  health: { mode: 'rest', method: 'GET', path: '/health', auth: 'public', description: 'Public service health check endpoint.' },
  'auth.custom-token': { mode: 'rest', method: 'POST', path: '/auth/custom-token', auth: 'admin', input: customTokenBody },
  'auth.session.create': { mode: 'rest', method: 'POST', path: '/auth/session', auth: 'public', input: sessionBody },
  'auth.session.get': { mode: 'rest', method: 'GET', path: '/auth/session', auth: 'strict' },
  'auth.sign-up.email': { mode: 'rest', method: 'POST', path: '/auth/sign-up/email', auth: 'public', input: emailSignUpBody },
  'auth.sign-in.email': { mode: 'rest', method: 'POST', path: '/auth/sign-in/email', auth: 'public', input: emailSignInBody },
  'auth.sign-in.social': {
    mode: 'rest',
    method: 'POST',
    path: '/auth/sign-in/social',
    auth: 'public',
    description: 'Sign in or link user account using Google or Apple OIDC ID token (Web & iOS/Capacitor).',
    input: socialSignInInput
  },
  'auth.email.send-verification': {
    mode: 'rest',
    method: 'POST',
    path: '/auth/email/send-verification',
    auth: 'user',
    description: 'Generate and send a 6-digit OTP and magic token to verify the caller primary email.',
    input: sendVerificationEmailBody
  },
  'auth.email.verify': {
    mode: 'rest',
    method: 'POST',
    path: '/auth/email/verify',
    auth: 'public',
    description: 'Verify primary email ownership via OTP code or magic token and evict stale token cache entries.',
    input: verifyEmailBody
  },
  'auth.password.forgot': {
    mode: 'rest',
    method: 'POST',
    path: '/auth/password/forgot',
    auth: 'public',
    description: 'Request a password reset OTP/token without revealing account existence.',
    input: forgotPasswordBody
  },
  'auth.password.reset': {
    mode: 'rest',
    method: 'POST',
    path: '/auth/password/reset',
    auth: 'public',
    description: 'Reset user password using a valid OTP/token and revoke all active sessions.',
    input: resetPasswordBody
  },
  'auth.recovery-email.set': {
    mode: 'rest',
    method: 'POST',
    path: '/auth/recovery-email/set',
    auth: 'strict',
    description: 'Bind a secondary recovery email address and send a verification OTP.',
    input: setRecoveryEmailBody
  },
  'auth.recovery-email.verify': {
    mode: 'rest',
    method: 'POST',
    path: '/auth/recovery-email/verify',
    auth: 'strict',
    description: 'Verify ownership of the secondary recovery email via OTP code or token.',
    input: verifyRecoveryEmailBody
  },
  'auth.account-recovery.initiate': {
    mode: 'rest',
    method: 'POST',
    path: '/auth/account-recovery/initiate',
    auth: 'public',
    description: 'Initiate full account recovery by sending a recovery OTP to a verified secondary recovery email.',
    input: initiateAccountRecoveryBody
  },
  'auth.account-recovery.complete': {
    mode: 'rest',
    method: 'POST',
    path: '/auth/account-recovery/complete',
    auth: 'public',
    description: 'Complete account recovery, update primary email (and optional password), revoke old sessions, and mint a fresh session.',
    input: completeAccountRecoveryBody
  },
  'auth.users.list': { mode: 'rest', method: 'GET', path: '/auth/users', auth: 'admin' },
  'auth.users.block': { mode: 'rest', method: 'POST', path: '/auth/users/block', auth: 'strict', guard: { checkUserId: true }, input: blockUserBody },
  'auth.users.delete': {
    mode: 'workflow',
    method: 'POST',
    path: '/erase-user',
    workflowName: 'erase-user',
    description: 'Cascade-erase a user across Storage, Firestore collections, and Firebase Auth.',
    auth: 'strict',
    guard: { checkUserId: true },
    mcp: false,
    input: eraseUserInput,
    output: eraseUserOutput
  },
  'auth.sign-out': { mode: 'rest', method: 'POST', path: '/auth/sign-out', auth: 'public', input: signOutBody },
  'files.upload': { mode: 'rest', method: 'POST', path: '/files', auth: 'user' },
  'files.list': { mode: 'rest', method: 'GET', path: '/files', auth: 'user' },
  'files.get': { mode: 'rest', method: 'GET', path: '/files/:ref', auth: 'user', guard: { checkFileRef: true } },
  'files.delete': { mode: 'rest', method: 'DELETE', path: '/files/:ref', auth: 'user', guard: { checkFileRef: true } },
  'chat.list': { mode: 'rest', method: 'GET', path: '/chats', auth: 'user' },
  'chat.get': { mode: 'rest', method: 'GET', path: '/chats/:chatId', auth: 'user', guard: { checkCollectionField: { collection: 'chat', param: 'chatId' } } },
  'chat.messages': { mode: 'rest', method: 'GET', path: '/chats/:chatId/messages', auth: 'user', guard: { checkCollectionField: { collection: 'chat', param: 'chatId' } } },
  'chat.save': { mode: 'rest', method: 'POST', path: '/chats', auth: 'user', input: saveChatBody },
  'chat.delete': { mode: 'rest', method: 'DELETE', path: '/chats/:chatId', auth: 'user', guard: { checkCollectionField: { collection: 'chat', param: 'chatId' } } },
  'chat.stream': { mode: 'rest', method: 'POST', path: '/chats/:chatId', auth: 'user', input: streamChatBody },
  'chat.cancel': { mode: 'rest', method: 'POST', path: '/chats/:chatId/cancel', auth: 'user', guard: { checkCollectionField: { collection: 'chat', param: 'chatId' } } },
  'openai.models': { mode: 'rest', method: 'GET', path: '/v1/models', auth: 'user' },
  'openai.completions': { mode: 'rest', method: 'POST', path: '/v1/chat/completions', auth: 'user', input: openaiCompletionsBody },
  'attachments.scan': {
    mode: 'workflow',
    method: 'POST',
    path: '/scan-attachment',
    workflowName: 'scan-attachment',
    description: 'OCR + classify + extract structured fields for a single attachment ref.',
    auth: 'user',
    guard: { checkFileRef: true },
    mcp: true,
    tool: true,
    input: scanAttachmentInput,
    output: fileScan
  },
  'attachments.process': {
    mode: 'workflow',
    method: 'POST',
    path: '/process-attachments',
    workflowName: 'process-attachments',
    description: 'Fan out scan-attachment across 1..N file refs with cache short-circuit and sharded parallelism.',
    auth: 'user',
    guard: { checkFileRef: true },
    mcp: true,
    tool: true,
    input: processAttachmentsInput
  },
  'routes.list': { mode: 'rest', method: 'GET', path: '/routes', auth: 'admin' },
  'tasks.status': { mode: 'rest', method: 'GET', path: '/tasks/:taskId', auth: 'user' },
  'tasks.signal': { mode: 'rest', method: 'POST', path: '/tasks/:taskId/signal', auth: 'user' },
  'tasks.cancel': { mode: 'rest', method: 'DELETE', path: '/tasks/:taskId', auth: 'user' },
  'emails.send': {
    mode: 'rest',
    method: 'POST',
    path: '/emails/send',
    auth: 'admin',
    rateLimit: { max: 60, windowMs: 60_000, keyBy: 'user' },
    idempotencyKey: (inp: SendEmailInput | undefined) => inp?.idempotencyKey,
    description: 'Send a transactional email via SendGrid or Resend with template resolution and audit logging.',
    input: sendEmailInputSchema,
    output: sendEmailResultSchema
  },
  'emails.batch': {
    mode: 'rest',
    method: 'POST',
    path: '/emails/batch',
    auth: 'admin',
    rateLimit: { max: 20, windowMs: 60_000, keyBy: 'user' },
    description: 'Send up to 100 transactional emails in a single batch.',
    input: sendBatchEmailInputSchema,
    output: sendBatchEmailResultSchema
  },
  'emails.logs': {
    mode: 'rest',
    method: 'GET',
    path: '/emails/logs',
    auth: 'admin',
    rateLimit: { max: 120, windowMs: 60_000, keyBy: 'user' },
    description: 'List email delivery audit logs with filtering by recipient, template, purpose, and status.',
    query: emailLogsQuerySchema
  },
  'emails.webhook': {
    mode: 'rest',
    method: 'POST',
    path: '/emails/webhooks/:provider',
    auth: 'none',
    rawBody: true,
    rateLimit: { max: 600, windowMs: 60_000, keyBy: 'ip' },
    description: 'Receive and verify HMAC-SHA256 delivery/bounce/complaint webhooks from SendGrid or Resend.',
    params: emailWebhookParamsSchema
  },
  'payments.checkout': {
    mode: 'rest',
    method: 'POST',
    path: '/payments/checkout',
    auth: 'user',
    rateLimit: { max: 30, windowMs: 60_000, keyBy: 'user' },
    idempotencyKey: (inp: CreateCheckoutInput | undefined) => inp?.idempotencyKey,
    description: 'Create a hosted checkout session for a predefined plan, product, or custom ad-hoc amount.',
    input: createCheckoutInput,
    output: checkoutSessionResultSchema
  },
  'payments.paymentLink': {
    mode: 'rest',
    method: 'POST',
    path: '/payments/payment-link',
    auth: 'user',
    rateLimit: { max: 30, windowMs: 60_000, keyBy: 'user' },
    idempotencyKey: (inp: CreatePaymentLinkInput | undefined) => inp?.idempotencyKey,
    description: 'Generate a shareable payment link for a predefined plan, product, or custom ad-hoc amount.',
    input: createPaymentLinkInput,
    output: paymentLinkResultSchema
  },
  'payments.invoice': {
    mode: 'rest',
    method: 'POST',
    path: '/payments/invoice',
    auth: 'user',
    rateLimit: { max: 20, windowMs: 60_000, keyBy: 'user' },
    idempotencyKey: (inp: CreateInvoiceInput | undefined) => inp?.idempotencyKey,
    description: 'Generate a finalized invoice with hosted payment URL and PDF link.',
    input: createInvoiceInput,
    output: invoiceResultSchema
  },
  'payments.charge': {
    mode: 'rest',
    method: 'POST',
    path: '/payments/charge',
    auth: 'user',
    rateLimit: { max: 20, windowMs: 60_000, keyBy: 'user' },
    idempotencyKey: (inp: DirectChargeInput | undefined) => inp?.idempotencyKey,
    description: 'Execute a direct one-time charge for a predefined product or custom amount.',
    input: directChargeInput,
    output: chargeResultSchema
  },
  'payments.subscribe': {
    mode: 'rest',
    method: 'POST',
    path: '/payments/subscribe',
    auth: 'user',
    rateLimit: { max: 15, windowMs: 60_000, keyBy: 'user' },
    idempotencyKey: (inp: SubscribeInput | undefined) => inp?.idempotencyKey,
    description: 'Subscribe the caller to a defined recurring or free plan tier.',
    input: subscribeInput,
    output: subscribeResultSchema
  },
  'payments.changeTier': {
    mode: 'rest',
    method: 'POST',
    path: '/payments/subscription/change-tier',
    auth: 'user',
    rateLimit: { max: 15, windowMs: 60_000, keyBy: 'user' },
    idempotencyKey: (inp: ChangeTierInput | undefined) => inp?.idempotencyKey,
    description: 'Upgrade or downgrade the caller active subscription tier with proration.',
    input: changeTierInput,
    output: subscriptionRecordSchema
  },
  'payments.cancelSubscription': {
    mode: 'rest',
    method: 'POST',
    path: '/payments/subscription/cancel',
    auth: 'user',
    rateLimit: { max: 15, windowMs: 60_000, keyBy: 'user' },
    idempotencyKey: (inp: CancelSubscriptionInput | undefined) => inp?.idempotencyKey,
    description: 'Cancel the caller active subscription immediately or at period end.',
    input: cancelSubscriptionInput,
    output: subscriptionRecordSchema
  },
  'payments.status': {
    mode: 'rest',
    method: 'GET',
    path: '/payments/status',
    auth: 'user',
    rateLimit: { max: 120, windowMs: 60_000, keyBy: 'user' },
    description: 'Get the caller current subscription tier, billing status, and AI token/metric usage summary.'
  },
  'payments.webhook': {
    mode: 'rest',
    method: 'POST',
    path: '/payments/webhooks/:provider',
    auth: 'none',
    rawBody: true,
    rateLimit: { max: 600, windowMs: 60_000, keyBy: 'ip' },
    description: 'Receive and verify HMAC-SHA256 webhooks from Stripe or Dodo Payments with idempotent state reconciliation.',
    params: paymentWebhookParamsSchema
  }
}
