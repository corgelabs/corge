import { z } from 'zod'
import type { Core } from '../index'
import {
  CORE_CONFIG,
  type DbAccessScope,
  type DbAction,
  type DbRole,
  type RbacConfig,
  type RbacRoleScopes
} from '../config'

export { type DbAccessScope, type DbAction, type DbRole, type RbacConfig, type RbacRoleScopes }

export interface DbCallContext {
  userId?: EntryId
  userRole?: DbRole
  bypassRbac?: boolean
  core?: Core
}

export const entryId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
export type EntryId = z.infer<typeof entryId>

export const fileRef = z.string().regex(/^[A-Za-z0-9_-]{1,128}_[a-f0-9]{24}$/)
export type FileRef = z.infer<typeof fileRef>

export const fileScan = z.object({
  type: z.string(),
  confidence: z.number(),
  fields: z.record(z.string(), z.any()),
  markdown: z.string()
})
export type FileScan = z.infer<typeof fileScan>

export const unparseableReason = z.enum([
  'CORRUPTED_FILE',
  'PASSWORD_PROTECTED',
  'EMPTY_OR_UNREADABLE',
  'UNSUPPORTED_FORMAT',
  'CLASSIFICATION_REJECTED'
])
export type UnparseableReason = z.infer<typeof unparseableReason>

export const fileScanError = z.object({
  status: z.literal('unparseable'),
  reason: unparseableReason,
  /** Clear instruction for the LLM agent explaining why the file failed and asking the user to upload a valid replacement */
  agentHint: z.string(),
  diagnosticMessage: z.string().optional(),
  failedAt: z.string()
})
export type FileScanError = z.infer<typeof fileScanError>

export interface BaseEntryFields {
  id: EntryId
  deleted: boolean
  createdAt: Date
  updatedAt: Date
}

export type WithBaseFields<T> = Omit<BaseEntryFields, keyof T> & T

const baseEntrySchemaShape = {
  id: entryId,
  deleted: z.boolean().default(false),
  createdAt: z.date(),
  updatedAt: z.date()
}

export type AuthRelationType = '1:1' | '1:N' | 'N:1' | 'M:N' | 'global'

export interface UserRelationConfig {
  type?: AuthRelationType
  userField?: string
  userIdsField?: string
  junction?: {
    collection: string
    userField?: string
    targetField?: string
  }
  deleteWhenEmpty?: boolean
}

export interface CollectionDefinition<S extends z.ZodObject<any> = z.ZodObject<any>> {
  name?: string
  schema: S
  userRelation?: UserRelationConfig
  rbac?: RbacConfig
  sortByUpdated?: boolean
  onHardDelete?: (doc: WithBaseFields<z.infer<S>>, core: Core) => Promise<void>
}

export interface DbListOptions<M = Record<string, any>> {
  ids?: string[]
  userId?: EntryId
  where?: Partial<{ [K in keyof M]: M[K] | readonly M[K][] }>
  orderBy?: { field: keyof M & string; direction?: 'asc' | 'desc' }
  includeDeleted?: boolean
  limit?: number
  cursor?: string
  select?: (keyof M & string)[]
  bypassRbac?: boolean
}

export type PaginatedList<T> = T[] & { nextCursor?: string | null }

export interface DbListPage<T> {
  items: T[]
  nextCursor: string | null
}

export const defineCollection = <S extends z.ZodObject<any>>(def: CollectionDefinition<S>): CollectionDefinition<S> => {
  const mergedSchema = z.object({
    ...baseEntrySchemaShape,
    ...def.schema.shape
  }) as unknown as S
  const relType = def.userRelation?.type ?? '1:N'
  return {
    ...def,
    userRelation: {
      type: relType,
      userField: relType === '1:1' ? 'id' : 'userId',
      ...def.userRelation
    },
    schema: mergedSchema
  }
}

export const defineCollections = <T extends Record<string, CollectionDefinition<any>>>(defs: T): T =>
  Object.fromEntries(
    Object.entries(defs).map(([name, def]) => [name, defineCollection({ ...def, name: def.name ?? name })])
  ) as T

export const coreCollections = defineCollections({
  chat: {
    schema: z.object({
      userId: entryId,
      agentId: z.string().default('chat'),
      title: z.string().default('New Chat'),
      model: z.string().default(CORE_CONFIG.models.vertex),
      messageCount: z.number().int().nonnegative().default(0),
      summary: z.string().nullable().optional(),
      activeGenerationId: z.string().nullable().optional()
    }),
    userRelation: { type: '1:N', userField: 'userId' },
    sortByUpdated: true
  },
  file: {
    schema: z.object({
      id: fileRef,
      shaSum: z.string(),
      fileName: z.string(),
      contentType: z.string(),
      size: z.number().int().nonnegative(),
      scan: fileScan.nullable().optional(),
      scanError: fileScanError.nullable().optional(),
      userId: entryId
    }),
    userRelation: { type: '1:N', userField: 'userId' }
  },
  user_auth_meta: {
    schema: z.object({
      email: z.string().nullable().optional(),
      emailVerified: z.boolean().default(false),
      name: z.string().nullable().optional(),
      avatarUrl: z.string().nullable().optional(),
      recoveryEmail: z.string().nullable().optional(),
      recoveryEmailVerified: z.boolean().default(false),
      linkedProviders: z
        .array(
          z.object({
            provider: z.enum(['google', 'apple']),
            providerUserId: z.string(),
            email: z.string().nullable().optional(),
            linkedAt: z.date()
          })
        )
        .default([]),
      providerKeys: z.array(z.string()).default([])
    }),
    userRelation: { type: '1:1', userField: 'id' },
    rbac: {
      admin: { any: ['*'] },
      user: { own: ['read'] },
      anon: {}
    }
  },
  auth_tokens: {
    schema: z.object({
      userId: entryId,
      purpose: z.enum(['verify_email', 'reset_password', 'verify_recovery_email', 'account_recovery']),
      targetEmail: z.string(),
      tokenHash: z.string(),
      urlTokenHash: z.string().optional(),
      attempts: z.number().int().nonnegative().default(0),
      expiresAt: z.date(),
      consumedAt: z.date().nullable().optional()
    }),
    userRelation: { type: '1:N', userField: 'userId' },
    rbac: {
      admin: { any: ['*'] },
      user: {},
      anon: {}
    }
  },
  email_log: {
    schema: z.object({
      userId: entryId.optional(),
      provider: z.enum(['sendgrid', 'resend', 'firebase', 'dev']),
      externalMessageId: z.string().optional(),
      to: z.string().email(),
      from: z.string(),
      subject: z.string().optional(),
      template: z.string().optional(),
      purpose: z.string().optional(),
      status: z
        .enum([
          'queued',
          'sent',
          'delivered',
          'opened',
          'clicked',
          'bounced',
          'complained',
          'failed',
          'suppressed'
        ])
        .default('queued'),
      errorMessage: z.string().optional(),
      sentAt: z.string().datetime(),
      deliveredAt: z.string().datetime().optional(),
      bouncedAt: z.string().datetime().optional()
    }),
    userRelation: { type: '1:N', userField: 'userId' },
    sortByUpdated: true,
    rbac: {
      admin: { any: ['*'] },
      user: { own: ['read'] },
      anon: {}
    }
  },
  email_suppression: {
    schema: z.object({
      email: z.string().email(),
      reason: z.enum(['hard_bounce', 'spam_complaint', 'manual']),
      provider: z.enum(['sendgrid', 'resend', 'manual']),
      rawEvent: z.string().optional(),
      suppressedAt: z.string().datetime()
    }),
    userRelation: { type: 'global' },
    rbac: {
      admin: { any: ['*'] },
      user: {},
      anon: {}
    }
  },
  payment_customer: {
    schema: z.object({
      userId: entryId,
      email: z.string().email().optional(),
      name: z.string().optional(),
      stripeCustomerId: z.string().optional(),
      dodoCustomerId: z.string().optional(),
      activeProvider: z.enum(['stripe', 'dodo']).optional(),
      planId: z.string().default('free'),
      subscriptionId: z.string().optional(),
      subscriptionStatus: z
        .enum(['none', 'active', 'trialing', 'past_due', 'on_hold', 'cancelled', 'expired'])
        .default('none'),
      currentPeriodStart: z.string().datetime().optional(),
      currentPeriodEnd: z.string().datetime().optional(),
      cancelAtPeriodEnd: z.boolean().default(false),
      bonusAiTokens: z.number().int().nonnegative().default(0),
      credits: z.number().nonnegative().default(0),
      bonusMetrics: z.record(z.string(), z.number()).default({})
    }),
    userRelation: { type: '1:1', userField: 'id' },
    rbac: {
      admin: { any: ['*'] },
      user: { own: ['read'] },
      anon: {}
    }
  },
  payment_usage: {
    schema: z.object({
      userId: entryId,
      periodKey: z.string(),
      planId: z.string().default('free'),
      aiTokensUsed: z.number().int().nonnegative().default(0),
      aiInputTokens: z.number().int().nonnegative().default(0),
      aiOutputTokens: z.number().int().nonnegative().default(0),
      overageTokensReported: z.number().int().nonnegative().default(0),
      metricsUsed: z.record(z.string(), z.number()).default({}),
      lastUpdatedAt: z.string().datetime()
    }),
    userRelation: { type: '1:N', userField: 'userId' },
    rbac: {
      admin: { any: ['*'] },
      user: { own: ['read'] },
      anon: {}
    }
  },
  payment_transaction: {
    schema: z.object({
      userId: entryId,
      provider: z.enum(['stripe', 'dodo']),
      externalId: z.string(),
      type: z.enum([
        'checkout.completed',
        'payment.succeeded',
        'payment.failed',
        'invoice.created',
        'invoice.paid',
        'subscription.active',
        'subscription.renewed',
        'subscription.tier_changed',
        'subscription.cancelled',
        'subscription.past_due'
      ]),
      amount: z.number().int().optional(),
      currency: z.string().optional(),
      productOrPlanId: z.string().optional(),
      rawEventType: z.string(),
      processedAt: z.string().datetime()
    }),
    userRelation: { type: '1:N', userField: 'userId' },
    sortByUpdated: true,
    rbac: {
      admin: { any: ['*'] },
      user: { own: ['read'] },
      anon: {}
    }
  }
})

const CORE_COLLECTION_NAMES = [
  'chat',
  'file',
  'user_auth_meta',
  'auth_tokens',
  'email_log',
  'email_suppression',
  'payment_customer',
  'payment_usage',
  'payment_transaction'
] as const

export const collectionRegistry = new Map<string, CollectionDefinition<any>>(
  CORE_COLLECTION_NAMES.map((name) => [name, coreCollections[name]])
)

export const registerCollections = (defs: Record<string, CollectionDefinition<any>>, reset = false) => {
  if (reset) {
    collectionRegistry.clear()
    for (const name of CORE_COLLECTION_NAMES) {
      collectionRegistry.set(name, coreCollections[name])
    }
  }
  for (const [k, def] of Object.entries(defs)) {
    const normalized = defineCollection({ ...def, name: def.name ?? k })
    collectionRegistry.set(normalized.name!, normalized)
  }
}

export const unregisterCollections = (names: string[]) => {
  for (const name of names) {
    if (!CORE_COLLECTION_NAMES.includes(name as (typeof CORE_COLLECTION_NAMES)[number])) {
      collectionRegistry.delete(name)
    }
  }
}

export const getRegisteredCollectionNames = (): string[] => [...collectionRegistry.keys()]

export const getCollectionDef = (name: string): CollectionDefinition<any> => {
  const def = collectionRegistry.get(name)
  if (!def) throw new Error(`Unregistered collection: ${name}`)
  return def
}

export const getEffectiveRbac = (collection: string): RbacConfig => {
  const def = getCollectionDef(collection)
  return {
    admin: { ...CORE_CONFIG.db.rbac.admin, ...def.rbac?.admin },
    user: { ...CORE_CONFIG.db.rbac.user, ...def.rbac?.user },
    anon: { ...CORE_CONFIG.db.rbac.anon, ...def.rbac?.anon }
  }
}

export type CoreCollections = typeof coreCollections

export interface Register {}

export type RegisteredCollections = Register extends { collections: infer C extends Record<string, CollectionDefinition<any>> }
  ? CoreCollections & C
  : CoreCollections

export type CollectionName = keyof RegisteredCollections | (string & {})

export type SelectModel<T extends CollectionName> = T extends keyof RegisteredCollections
  ? WithBaseFields<z.infer<RegisteredCollections[T]['schema']>>
  : Record<string, any> & BaseEntryFields

export type InsertData<T extends CollectionName> = Omit<SelectModel<T>, 'id' | 'deleted' | 'createdAt' | 'updatedAt'> & {
  id?: string
  deleted?: boolean
}

export type UpdateData<T extends CollectionName> = Partial<Omit<SelectModel<T>, 'id' | 'createdAt'>>
