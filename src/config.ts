import type { Context } from 'hono'
import type { Core } from './index'

try {
  process.loadEnvFile()
} catch {}

export type DbRole = 'admin' | 'user' | 'anon'
export type DbAction = 'read' | 'write' | 'create' | 'delete' | '*'
export type DbAccessScope = 'own' | 'any'

export type RbacRoleScopes = {
  [Scope in DbAccessScope]?: readonly DbAction[]
}

export type RbacConfig = {
  [Role in DbRole]?: RbacRoleScopes
}

export const SECRET_NAMES = [
  'SDK_API_KEY',
  'MISTRAL_API_KEY',
  'TYPESAFE_API_KEY',
  'JINA_API_KEY',
  'WEB_API_KEY'
] as const

export const EMAIL_SECRET_NAMES = [
  'RESEND_API_KEY',
  'SENDGRID_API_KEY',
  'EMAIL_WEBHOOK_SECRET',
  'EMAIL_SANDBOX_WEBHOOK_SECRET'
] as const

export const PAYMENT_SECRET_NAMES = [
  'STRIPE_API_KEY',
  'STRIPE_SANDBOX_API_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_SANDBOX_WEBHOOK_SECRET',
  'DODO_API_KEY',
  'DODO_SANDBOX_API_KEY',
  'DODO_WEBHOOK_SECRET',
  'DODO_SANDBOX_WEBHOOK_SECRET'
] as const

export interface AppBindings {
  SDK_API_KEY: string
  MISTRAL_API_KEY: string
  TYPESAFE_API_KEY: string
  JINA_API_KEY: string
  WEB_API_KEY: string
  RESEND_API_KEY: string
  SENDGRID_API_KEY: string
  EMAIL_WEBHOOK_SECRET: string
  EMAIL_SANDBOX_WEBHOOK_SECRET: string
  STRIPE_API_KEY: string
  STRIPE_SANDBOX_API_KEY: string
  STRIPE_WEBHOOK_SECRET: string
  STRIPE_SANDBOX_WEBHOOK_SECRET: string
  DODO_API_KEY: string
  DODO_SANDBOX_API_KEY: string
  DODO_WEBHOOK_SECRET: string
  DODO_SANDBOX_WEBHOOK_SECRET: string
  isDev: boolean
}

export interface AppEnv {
  Bindings: AppBindings
  Variables: { userId: string; userRole: DbRole }
}

export interface RateLimitSpec {
  max: number
  windowMs: number
  keyBy?: 'user' | 'ip' | ((c: Context<AppEnv>) => string)
}

export type RateLimitConfig = RateLimitSpec | false

export type EmailProvider = 'sendgrid' | 'resend' | 'firebase'

export type AuthTokenPurpose =
  | 'verify_email'
  | 'reset_password'
  | 'verify_recovery_email'
  | 'account_recovery'

export type AuthEmailPurpose =
  | AuthTokenPurpose
  | 'welcome'
  | 'security_alert'

export interface TransactionalEmailPayload {
  to: string
  purpose: AuthEmailPurpose
  code: string
  token: string
  expiresInMinutes: number
  userId: string
}

export interface AuthEmailVariables {
  appName: string
  userId: string
  email: string
  purpose: AuthEmailPurpose
  code: string
  token: string
  actionUrl: string
  expiresInMinutes: number
  [key: string]: unknown
}

export type AuthFlowEmailHook = (
  payload: AuthEmailVariables,
  context: { core: Core; env: AppBindings }
) => Promise<boolean | Partial<AuthEmailVariables> | void>

export interface AuthFlowConfigSpec {
  templateId?: string
  subject?: string
  actionPath?: string
  onSend?: AuthFlowEmailHook
}

export interface EmailsConfig {
  provider: EmailProvider
  fromEmail: string
  fromName: string
  replyTo?: string
  actionBaseUrl: string
  otpTtlMinutes: number
  recoveryOtpTtlMinutes: number
  maxVerifyAttempts: number
  enforceSuppressionList: boolean
  webhookToleranceSeconds: number
  onAuthEmail?: AuthFlowEmailHook
  authFlows: Record<AuthEmailPurpose, AuthFlowConfigSpec>
  sendgrid: {
    baseUrl: string
  }
  resend: {
    baseUrl: string
  }
}

export type PaymentProvider = 'stripe' | 'dodo'

export type EnvScopedString = string | { prod: string; dev: string }

export interface PaymentsConfig {
  enabled: boolean
  provider: PaymentProvider
  defaultCurrency: Lowercase<string>
  defaultPlanId: string
  autoTrackAiTokens: boolean
  aiTokenMeterName: string
  webhookToleranceSeconds: number
  urls: {
    successUrl: EnvScopedString
    cancelUrl: EnvScopedString
    returnUrl: EnvScopedString
  }
  dodo: {
    liveBaseUrl: string
    testBaseUrl: string
  }
  stripe: {
    baseUrl: string
    apiVersion: string
  }
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? (T[K] extends (...args: any[]) => any ? T[K] : DeepPartial<T[K]>) : T[K]
}

export interface CoreConfig {
  appName: string
  gcpProject: string
  region: string
  secrets: readonly string[]
  firestoreDbs: { prod: string; dev: string }
  storageBuckets: { prod: string; dev: string }
  db: {
    rbac: RbacConfig
  }
  context: {
    dir: string
    maxSources: number
    userContextTimeoutMs: number
  }
  serviceAccount: string
  computeAccount: string
  workerUris: { prod: string; dev: string }
  queueBaseNames: { prod: string; dev: string }
  cloudRun: {
    memory: '1GiB' | '2GiB' | '4GiB' | '8GiB'
    cpu: number
    http: { timeoutSeconds: number; concurrency: number; maxInstances: number; invoker: 'public' | 'private' }
    worker: { timeoutSeconds: number; concurrency: number; maxInstances: number }
  }
  tasks: {
    useCloudTasks: boolean
    defaultShardsCount: number
    batchCreateSize: number
    maxAttempts: number
    hedgeAfterMs: number
    heartbeatIntervalMs: number
    heartbeatStaleMs: number
    timeoutMs: number
    ttlMs: number
    scanDeadlineSeconds: number
    defaultDeadlineSeconds: number
    claimCheckThresholdBytes: number
    yieldBudgetRatio: number
  }
  models: {
    vertex: string
    vertexExpert: string
    vertexEmbedding: string
    vertexLocation: string
    mistralOcr: string
    jev: string
    defaultAgentMaxSteps: number
  }
  limits: {
    maxAttachments: number
    maxChatAttachments: number
    chatMessagesLimit: number
    defaultListLimit: number
    maxFileBytes: number
    maxBodyBytes: number
    maxWaitMs: number
    httpUser: RateLimitSpec
    httpIp: RateLimitSpec
    buckets: {
      mistral: { windowMs: number; max: number }
      jev: { windowMs: number; max: number }
      ai: { windowMs: number; max: number }
      workflows: { windowMs: number; max: number }
      firestore: { windowMs: number; max: number }
      storage: { windowMs: number; max: number }
      emails: { windowMs: number; max: number }
      payments: { windowMs: number; max: number }
    }
  }
  auth: {
    sessionCookie: string
    sessionExpiresInMs: number
    tokenCacheTtlMs: number
    tokenCacheMaxSize: number
    adminUserId: string
    allowedOrigins: (string | RegExp)[]
    oauth?: {
      googleClientIds?: string[]
      appleClientIds?: string[]
    }
  }
  emails: EmailsConfig
  payments: PaymentsConfig
}

const gcpProject = process.env.GCP_PROJECT ?? ''
const region = 'me-central1'
const defaultWebBaseUrl = `https://${gcpProject || 'app'}.web.app`

export const CORE_CONFIG: CoreConfig = {
  appName: gcpProject,
  gcpProject,
  region,
  secrets: [],
  firestoreDbs: { prod: gcpProject, dev: `${gcpProject}-dev` },
  storageBuckets: { prod: `${gcpProject}.firebasestorage.app`, dev: `${gcpProject}-dev` },
  db: {
    rbac: {
      admin: { any: ['*'] },
      user: { own: ['*'] },
      anon: {}
    }
  },
  context: {
    dir: 'src/context',
    maxSources: 5,
    userContextTimeoutMs: 3_500
  },
  serviceAccount: `firebase-adminsdk-fbsvc@${gcpProject}.iam.gserviceaccount.com`,
  computeAccount: '68329189121-compute@developer.gserviceaccount.com',
  workerUris: {
    prod: `https://${region}-${gcpProject}.cloudfunctions.net/${gcpProject}-tasks`,
    dev: `https://${region}-${gcpProject}.cloudfunctions.net/${gcpProject}-tasks-dev`
  },
  queueBaseNames: {
    prod: `${gcpProject}-tasks`,
    dev: `${gcpProject}-tasks-dev`
  },
  cloudRun: {
    memory: '4GiB',
    cpu: 2,
    http: { timeoutSeconds: 180, concurrency: 80, maxInstances: 50, invoker: 'public' },
    worker: { timeoutSeconds: 540, concurrency: 20, maxInstances: 20 }
  },
  tasks: {
    useCloudTasks: Boolean(process.env.K_SERVICE),
    defaultShardsCount: 20,
    batchCreateSize: 100,
    maxAttempts: 3,
    hedgeAfterMs: 65_000,
    heartbeatIntervalMs: 20_000,
    heartbeatStaleMs: 30_000,
    timeoutMs: 510_000,
    ttlMs: 3_600_000,
    scanDeadlineSeconds: 120,
    defaultDeadlineSeconds: 540,
    claimCheckThresholdBytes: 204_800,
    yieldBudgetRatio: 0.75
  },
  models: {
    vertex: 'claude-haiku-5-5',
    vertexExpert: 'claude-sonnet-4-5',
    vertexEmbedding: 'text-embedding-005',
    vertexLocation: 'global',
    mistralOcr: 'mistral-ocr-latest',
    jev: 'jev-latest',
    defaultAgentMaxSteps: 8
  },
  limits: {
    maxAttachments: 500,
    maxChatAttachments: 20,
    chatMessagesLimit: 15,
    defaultListLimit: 100,
    maxFileBytes: 20 * 1024 * 1024,
    maxBodyBytes: 25 * 1024 * 1024,
    maxWaitMs: 60_000,
    httpUser: { max: 300, windowMs: 60_000, keyBy: 'user' },
    httpIp: { max: 60, windowMs: 60_000, keyBy: 'ip' },
    buckets: {
      mistral: { windowMs: 60_000, max: 1250 },
      jev: { windowMs: 60_000, max: 1200 },
      ai: { windowMs: 60_000, max: 2000 },
      workflows: { windowMs: 1_000, max: 500 },
      firestore: { windowMs: 1_000, max: 500 },
      storage: { windowMs: 1_000, max: 1000 },
      emails: { windowMs: 1_000, max: 50 },
      payments: { windowMs: 1_000, max: 100 }
    }
  },
  auth: {
    sessionCookie: 'session',
    sessionExpiresInMs: 14 * 24 * 60 * 60 * 1000,
    tokenCacheTtlMs: 5 * 60_000,
    tokenCacheMaxSize: 2000,
    adminUserId: 'admin',
    allowedOrigins: [
      /^https:\/\/[a-z0-9-]+\.a\.run\.app$/i,
      /^https:\/\/([a-z0-9-]+\.)?(web\.app|firebaseapp\.com)$/i,
      /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i
    ]
  },
  emails: {
    provider: 'resend',
    fromEmail: `no-reply@${gcpProject || 'app'}.firebaseapp.com`,
    fromName: gcpProject || 'App',
    actionBaseUrl: `https://${gcpProject || 'app'}.web.app`,
    otpTtlMinutes: 15,
    recoveryOtpTtlMinutes: 10,
    maxVerifyAttempts: 5,
    enforceSuppressionList: true,
    webhookToleranceSeconds: 300,
    authFlows: {
      verify_email: { actionPath: '/auth/verify-email', subject: 'Verify your email address' },
      reset_password: { actionPath: '/auth/reset-password', subject: 'Reset your password' },
      verify_recovery_email: { actionPath: '/auth/verify-recovery', subject: 'Verify your recovery email' },
      account_recovery: { actionPath: '/auth/account-recovery', subject: 'Recover your account' },
      welcome: { actionPath: '/dashboard', subject: 'Welcome!' },
      security_alert: { actionPath: '/settings/security', subject: 'Security alert on your account' }
    },
    sendgrid: {
      baseUrl: 'https://api.sendgrid.com/v3'
    },
    resend: {
      baseUrl: 'https://api.resend.com'
    }
  },
  payments: {
    enabled: false,
    provider: 'dodo',
    defaultCurrency: 'usd',
    defaultPlanId: 'free',
    autoTrackAiTokens: true,
    aiTokenMeterName: 'ai_tokens',
    webhookToleranceSeconds: 300,
    urls: {
      successUrl: `${defaultWebBaseUrl}/billing/success`,
      cancelUrl: `${defaultWebBaseUrl}/billing/cancel`,
      returnUrl: `${defaultWebBaseUrl}/billing`
    },
    dodo: {
      liveBaseUrl: 'https://live.dodopayments.com',
      testBaseUrl: 'https://test.dodopayments.com'
    },
    stripe: {
      baseUrl: 'https://api.stripe.com/v1',
      apiVersion: '2025-02-24.acacia'
    }
  }
}

const mergeDeep = <T extends Record<string, any>>(target: T, source?: DeepPartial<T>): T => {
  if (!source) return target
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof RegExp) && typeof target[k] === 'object') {
      mergeDeep(target[k], v as any)
    } else if (v !== undefined) {
      ;(target as any)[k] = v
    }
  }
  return target
}

export const defineConfig = (overrides?: DeepPartial<CoreConfig>): CoreConfig => {
  if (overrides?.gcpProject && overrides.gcpProject !== CORE_CONFIG.gcpProject) {
    const p = overrides.gcpProject
    const r = overrides.region ?? CORE_CONFIG.region
    CORE_CONFIG.appName = p
    CORE_CONFIG.firestoreDbs = { prod: p, dev: `${p}-dev` }
    CORE_CONFIG.storageBuckets = { prod: `${p}.firebasestorage.app`, dev: `${p}-dev` }
    CORE_CONFIG.serviceAccount = `firebase-adminsdk-fbsvc@${p}.iam.gserviceaccount.com`
    CORE_CONFIG.workerUris = {
      prod: `https://${r}-${p}.cloudfunctions.net/${p}-tasks`,
      dev: `https://${r}-${p}.cloudfunctions.net/${p}-tasks-dev`
    }
    CORE_CONFIG.queueBaseNames = {
      prod: `${p}-tasks`,
      dev: `${p}-tasks-dev`
    }
    CORE_CONFIG.emails.fromEmail = `no-reply@${p}.firebaseapp.com`
    CORE_CONFIG.emails.fromName = p
    CORE_CONFIG.emails.actionBaseUrl = `https://${p}.web.app`
    CORE_CONFIG.payments.urls = {
      successUrl: `https://${p}.web.app/billing/success`,
      cancelUrl: `https://${p}.web.app/billing/cancel`,
      returnUrl: `https://${p}.web.app/billing`
    }
  }
  return mergeDeep(CORE_CONFIG, overrides)
}
