import { AsyncLocalStorage } from 'node:async_hooks'
import { AiService } from './ai'
import {
  AttachmentsService,
  defineAttachmentTypes,
  getRegisteredAttachmentTypes,
  processAttachmentsInput,
  processAttachmentsOutput,
  processedAttachment,
  registerAttachmentTypes,
  scanAttachmentInput,
  scanAttachmentOutput
} from './attachments'
import { AuthService } from './auth'
import {
  ChatService,
  defineAgent,
  defineAgents,
  defineContext,
  openaiCompletionsBody,
  streamChatBody
} from './chat'
import {
  CORGE_CONFIG,
  defineConfig,
  type AppBindings,
  type DbRole
} from './config'
import {
  DbService,
  defineCollection,
  defineCollections,
  entryId,
  fileRef,
  fileScan,
  fileScanError,
  registerCollections,
  unregisterCollections,
  type EntryId
} from './db'
import {
  EmailsService,
  clearEmailTemplates,
  defineEmailTemplates,
  emailAttachmentInputSchema,
  emailLogStatusSchema,
  emailLogsQuerySchema,
  emailWebhookParamsSchema,
  getEmailTemplate,
  getRegisteredEmailTemplates,
  registerEmailTemplates,
  sendBatchEmailInputSchema,
  sendBatchEmailResultSchema,
  sendEmailInputSchema,
  sendEmailResultSchema
} from './emails'
import { FilesService, fileBody, fileType, signedUploadInput } from './files'
import {
  PaymentsService, cancelSubscriptionInput, changeTierInput, chargeResultSchema, checkoutSessionResultSchema,
  clearPaymentDefinitions, createCheckoutInput, createInvoiceInput, createPaymentLinkInput,
  customerBillingSummarySchema, definePlans, defineProducts, directChargeInput, getPlanDefinition,
  getProductDefinition, getRegisteredPlans, getRegisteredProducts, invoiceResultSchema, paymentLinkResultSchema,
  paymentWebhookParamsSchema, quotaCheckResultSchema, recordUsageInput, registerPlans, registerProducts,
  subscribeInput, subscribeResultSchema, subscriptionRecordSchema, usageStatusResultSchema, usageSummarySchema
} from './payments'
import {
  CORGE_ROUTE_DEFAULTS, RouterService, defineRoute, defineRouteOverrides, defineRoutes, type CorgeAppInit
} from './router'
import { TasksService, type StepRunner } from './tasks'
import { ErrorsService, ResilienceService, errorBodySchema } from './utils'

export interface CorgeRuntimeState {
  env: AppBindings
  userId: EntryId
  role: DbRole
  step?: StepRunner
}

const corgeStorage = new AsyncLocalStorage<CorgeRuntimeState>()

const runWithCorge = <T>(state: CorgeRuntimeState, fn: () => Promise<T>): Promise<T> =>
  corgeStorage.run(state, fn)

const getActiveCorgeState = (): CorgeRuntimeState | undefined => corgeStorage.getStore()

const buildDefaultEnvBindings = (isDev = false): AppBindings => ({
  SDK_API_KEY: process.env.SDK_API_KEY ?? '',
  MISTRAL_API_KEY: process.env.MISTRAL_API_KEY ?? '',
  TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY ?? '',
  JINA_API_KEY: process.env.JINA_API_KEY ?? '',
  WEB_API_KEY: process.env.WEB_API_KEY ?? '',
  RESEND_API_KEY: process.env.RESEND_API_KEY ?? '',
  SENDGRID_API_KEY: process.env.SENDGRID_API_KEY ?? '',
  EMAIL_WEBHOOK_SECRET: process.env.EMAIL_WEBHOOK_SECRET ?? '',
  EMAIL_SANDBOX_WEBHOOK_SECRET: process.env.EMAIL_SANDBOX_WEBHOOK_SECRET ?? '',
  STRIPE_API_KEY: process.env.STRIPE_API_KEY ?? '',
  STRIPE_SANDBOX_API_KEY: process.env.STRIPE_SANDBOX_API_KEY ?? '',
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET ?? '',
  STRIPE_SANDBOX_WEBHOOK_SECRET: process.env.STRIPE_SANDBOX_WEBHOOK_SECRET ?? '',
  DODO_API_KEY: process.env.DODO_API_KEY ?? '',
  DODO_SANDBOX_API_KEY: process.env.DODO_SANDBOX_API_KEY ?? '',
  DODO_WEBHOOK_SECRET: process.env.DODO_WEBHOOK_SECRET ?? '',
  DODO_SANDBOX_WEBHOOK_SECRET: process.env.DODO_SANDBOX_WEBHOOK_SECRET ?? '',
  isDev
})

export class Corge {
  readonly #explicitState?: CorgeRuntimeState
  readonly #resilience: ResilienceService
  readonly #router: RouterService
  readonly #db: DbService
  readonly #attachments: AttachmentsService
  readonly #auth: AuthService
  readonly #chat: ChatService
  readonly #tasks: TasksService
  readonly #emails: EmailsService
  readonly #payments: PaymentsService

  readonly errors: ErrorsService
  readonly db: Omit<DbService, 'internals'>
  readonly files: FilesService
  readonly ai: AiService
  readonly attachments: Omit<AttachmentsService, 'internals'>
  readonly auth: Omit<AuthService, 'internals'>
  readonly chat: Omit<ChatService, 'internals'>
  readonly tasks: Omit<TasksService, 'internals'>
  readonly emails: Omit<EmailsService, 'internals'>
  readonly payments: Omit<PaymentsService, 'internals'>

  constructor(state?: CorgeRuntimeState) {
    this.#explicitState = state
    this.errors = new ErrorsService()
    this.#resilience = new ResilienceService(this)
    this.#db = new DbService(this)
    this.db = this.#db
    this.files = new FilesService(this)
    this.ai = new AiService(this)
    this.#attachments = new AttachmentsService(this)
    this.attachments = this.#attachments
    this.#auth = new AuthService(this)
    this.auth = this.#auth
    this.#chat = new ChatService(this)
    this.chat = this.#chat
    this.#tasks = new TasksService(this)
    this.tasks = this.#tasks
    this.#emails = new EmailsService(this)
    this.emails = this.#emails
    this.#payments = new PaymentsService(this)
    this.payments = this.#payments
    this.#router = new RouterService(this)
  }

  get #state(): CorgeRuntimeState {
    if (this.#explicitState) return this.#explicitState
    const active = corgeStorage.getStore()
    if (active) return active
    const wfStore = this.#tasks.internals.getActiveWorkflowStore()
    const isDevDefault =
      !process.env.K_SERVICE ||
      process.env.K_SERVICE.endsWith('-dev') ||
      process.env.NODE_ENV === 'development' ||
      process.env.NODE_ENV === 'test'
    return {
      env: wfStore?.env ?? buildDefaultEnvBindings(isDevDefault),
      userId: CORGE_CONFIG.auth.adminUserId,
      role: 'admin',
      ...(wfStore?.step ? { step: wfStore.step } : {})
    }
  }

  get env(): AppBindings {
    return this.#state.env
  }
  get userId(): EntryId {
    return this.#state.userId
  }
  get role(): DbRole {
    return this.#state.role
  }
  get caller(): { userId: EntryId; role: DbRole } {
    return { userId: this.userId, role: this.role }
  }
  get step(): StepRunner {
    return this.#state.step ?? this.#tasks.internals.useStep()
  }

  readonly config = CORGE_CONFIG
  readonly createApp = (opts?: CorgeAppInit) => this.#router.createApp(opts)

  readonly define = {
    config: defineConfig,
    route: defineRoute,
    routes: defineRoutes,
    routeOverrides: defineRouteOverrides,
    collection: defineCollection,
    collections: defineCollections,
    agent: defineAgent,
    agents: defineAgents,
    context: defineContext,
    attachmentTypes: defineAttachmentTypes,
    emailTemplates: defineEmailTemplates,
    plans: definePlans,
    products: defineProducts
  }

  readonly schemas = {
    entryId,
    fileRef,
    fileScan,
    fileScanError,
    fileBody,
    fileType,
    signedUploadInput,
    processedAttachment,
    scanAttachmentInput,
    scanAttachmentOutput,
    processAttachmentsInput,
    processAttachmentsOutput,
    streamChatBody,
    openaiCompletionsBody,
    errorBodySchema,
    emailLogStatusSchema,
    emailAttachmentInputSchema,
    sendEmailInputSchema,
    sendBatchEmailInputSchema,
    emailLogsQuerySchema,
    emailWebhookParamsSchema,
    sendEmailResultSchema,
    sendBatchEmailResultSchema,
    createCheckoutInput,
    createPaymentLinkInput,
    createInvoiceInput,
    directChargeInput,
    subscribeInput,
    changeTierInput,
    cancelSubscriptionInput,
    recordUsageInput,
    paymentWebhookParamsSchema,
    checkoutSessionResultSchema,
    paymentLinkResultSchema,
    invoiceResultSchema,
    chargeResultSchema,
    subscribeResultSchema,
    subscriptionRecordSchema,
    customerBillingSummarySchema,
    usageStatusResultSchema,
    usageSummarySchema,
    quotaCheckResultSchema
  }

  get internals() {
    return {
      resilience: this.#resilience,
      context: {
        run: runWithCorge,
        getState: getActiveCorgeState,
        routeDefaults: CORGE_ROUTE_DEFAULTS,
        getMcpTools: this.#chat.internals.getMcpTools,
        authenticateRequest: this.#router.authenticateRequest,
        applyRateLimit: this.#router.applyRateLimit,
        enforceAgentAccess: this.#chat.internals.enforceAgentAccess,
        stageAndScanAttachments: this.#chat.internals.stageAndScanAttachments,
        startChatStreamTurn: this.#chat.internals.startChatStreamTurn,
        saveChat: this.#chat.internals.saveChat,
        streamChatSse: this.#chat.internals.streamChatSse,
        scanShortCircuit: this.#attachments.internals.scanShortCircuit
      },
      registry: {
        registerCollections,
        unregisterCollections,
        ensureFirebaseApp: this.#db.internals.ensureFirebaseApp,
        getGcpAccessToken: this.#db.internals.getGcpAccessToken,
        cascadeEraseUserCollections: this.#db.internals.cascadeEraseUserCollections,
        getAttachmentTypes: getRegisteredAttachmentTypes,
        registerAttachmentTypes,
        registerEmailTemplates,
        clearEmailTemplates,
        getEmailTemplate,
        getRegisteredEmailTemplates,
        registerPlans,
        registerProducts,
        clearPaymentDefinitions,
        getPlanDefinition,
        getProductDefinition,
        getRegisteredPlans,
        getRegisteredProducts,
        registerAgents: this.#chat.internals.registerAgents,
        getRegisteredAgents: this.#chat.internals.getRegisteredAgents,
        getAgentRegistry: this.#chat.internals.getAgentRegistry,
        registerWorkflowTool: this.#chat.internals.registerWorkflowTool,
        clearWorkflowTools: this.#chat.internals.clearWorkflowTools,
        registerContextCatalog: this.#chat.internals.registerContextCatalog
      },
      workflows: this.#tasks.internals,
      auth: this.#auth.internals,
      emails: this.#emails.internals,
      payments: this.#payments.internals
    }
  }
}

export type CorgeInternals = Corge['internals']

export const corge = new Corge()

export namespace corge {
  export namespace types {
    export type AppBindings = import('./config').AppBindings
    export type DbAction = import('./config').DbAction
    export type DbRole = import('./config').DbRole
    export type CorgeAppInit = import('./router').CorgeAppInit
    export type CorgeInternals = import('./index').CorgeInternals
    export type CorgeRuntimeState = import('./index').CorgeRuntimeState
    export type CorgeRouteOverrides = import('./router').CorgeRouteOverrides
    export type RouteConfig<I = any, O = any, P = Record<string, string>, Q = Record<string, string>> =
      import('./router').RouteConfig<I, O, P, Q>
    export type RouteExecutionContext<I = unknown, P = Record<string, string>, Q = Record<string, string>> =
      import('./router').RouteExecutionContext<I, P, Q>
    export type RouteMode = import('./router').RouteMode
    export type RoutesIntrospectionResponse = import('./tasks').RoutesIntrospectionResponse
    export type CollectionDefinition<S extends import('zod').ZodObject<any> = import('zod').ZodObject<any>> =
      import('./db').CollectionDefinition<S>
    export type CollectionName = import('./db').CollectionName
    export type DbListOptions<T = Record<string, unknown>> = import('./db').DbListOptions<T>
    export type DbListPage<T> = import('./db').DbListPage<T>
    export type EntryId = import('./db').EntryId
    export type FileRef = import('./db').FileRef
    export type FileScan = import('./db').FileScan
    export type InsertData<N extends import('./db').CollectionName> = import('./db').InsertData<N>
    export type PaginatedList<T> = import('./db').PaginatedList<T>
    export type SelectModel<N extends import('./db').CollectionName> =
      import('./db').SelectModel<N>
    export type UpdateData<N extends import('./db').CollectionName> = import('./db').UpdateData<N>
    export type AttachmentTypesMap = import('./attachments').AttachmentTypesMap
    export type ProcessAttachmentsInput = import('./attachments').ProcessAttachmentsInput
    export type ProcessAttachmentsOutput = import('./attachments').ProcessAttachmentsOutput
    export type ProcessedAttachment = import('./attachments').ProcessedAttachment
    export type ScanAttachmentInput = import('./attachments').ScanAttachmentInput
    export type ScanAttachmentOutput = import('./attachments').ScanAttachmentOutput
    export type FileBody = import('./files').FileBody
    export type FileType = import('./files').FileType
    export type SignedDownloadUrlResult = import('./files').SignedDownloadUrlResult
    export type SignedUploadInput = import('./files').SignedUploadInput
    export type SignedUploadUrlResult = import('./files').SignedUploadUrlResult
    export type AuthUser = import('./auth').AuthUser
    export type AgentConfig = import('./chat').AgentConfig
    export type AskAgentOptions = import('./chat').AskAgentOptions
    export type RunAgentOptions = import('./chat').RunAgentOptions
    export type GetContextOptions = import('./chat').GetContextOptions
    export type HybridRetrievalOptions = import('./chat').HybridRetrievalOptions
    export type HybridRetrievalResult = import('./chat').HybridRetrievalResult
    export type ChatMessagePublic = import('./chat').ChatMessagePublic
    export type ContextEntry = import('./chat').ContextEntry
    export type ContextItemSpec = import('./chat').ContextItemSpec
    export type UserContext = import('./chat').UserContext
    export type UserContextResolver = import('./chat').UserContextResolver
    export type StepRunner = import('./tasks').StepRunner
    export type TaskStatus = import('./tasks').TaskStatus
    export type TaskStatusRecord<O = unknown> = import('./tasks').TaskStatusRecord<O>
    export type WorkflowContext = import('./tasks').WorkflowContext
    export type WorkflowRuntimeEntry = import('./tasks').WorkflowRuntimeEntry
    export type AiUsageSummary = import('./ai').AiUsageSummary
    export type DecideResult = import('./ai').DecideResult
    export type JevQuestion = import('./ai').JevQuestion
    export type AiGenerateOptions<O = string> = import('./ai').AiGenerateOptions<O>
    export type AiGenerateResult<O = string> = import('./ai').AiGenerateResult<O>
    export type VisionOptions = import('./ai').VisionOptions
    export type VisionResult = import('./ai').VisionResult
    export type ErrorBody = import('./utils').ErrorBody
    export type CircuitBreakerKey = import('./utils').CircuitBreakerKey
    export type CircuitBreakerRecord = import('./utils').CircuitBreakerRecord
    export type CircuitBreakerStateName = import('./utils').CircuitBreakerStateName
    export type SingleflightOptions = import('./utils').SingleflightOptions
    export type EmailProvider = import('./config').EmailProvider
    export type AuthEmailPurpose = import('./config').AuthEmailPurpose
    export type AuthEmailVariables = import('./config').AuthEmailVariables
    export type AuthFlowEmailHook = import('./config').AuthFlowEmailHook
    export type AuthFlowConfigSpec = import('./config').AuthFlowConfigSpec
    export type EmailsConfig = import('./config').EmailsConfig
    export type EmailTemplateDefinition<S extends import('zod').ZodObject<any> = import('zod').ZodObject<any>> =
      import('./emails').EmailTemplateDefinition<S>
    export type EmailTemplatesMap = import('./emails').EmailTemplatesMap
    export type EmailAttachmentInput = import('./emails').EmailAttachmentInput
    export type EmailCallOptions = import('./emails').EmailCallOptions
    export type SendEmailInput = import('./emails').SendEmailInput
    export type SendBatchEmailInput = import('./emails').SendBatchEmailInput
    export type SendEmailResult = import('./emails').SendEmailResult
    export type SendBatchEmailResult = import('./emails').SendBatchEmailResult
    export type EmailLogStatus = import('./emails').EmailLogStatus
    export type EmailLogsQuery = import('./emails').EmailLogsQuery
    export type PaymentProvider = import('./payments').PaymentProvider
    export type PaymentsConfig = import('./config').PaymentsConfig
    export type PlanDefinition = import('./payments').PlanDefinition
    export type PlansMap = import('./payments').PlansMap
    export type ProductDefinition = import('./payments').ProductDefinition
    export type ProductsMap = import('./payments').ProductsMap
    export type PaymentCallOptions = import('./payments').PaymentCallOptions
    export type CreateCheckoutInput = import('./payments').CreateCheckoutInput
    export type CheckoutSessionResult = import('./payments').CheckoutSessionResult
    export type CreatePaymentLinkInput = import('./payments').CreatePaymentLinkInput
    export type PaymentLinkResult = import('./payments').PaymentLinkResult
    export type CreateInvoiceInput = import('./payments').CreateInvoiceInput
    export type InvoiceResult = import('./payments').InvoiceResult
    export type DirectChargeInput = import('./payments').DirectChargeInput
    export type ChargeResult = import('./payments').ChargeResult
    export type SubscribeInput = import('./payments').SubscribeInput
    export type SubscribeResult = import('./payments').SubscribeResult
    export type ChangeTierInput = import('./payments').ChangeTierInput
    export type CancelSubscriptionInput = import('./payments').CancelSubscriptionInput
    export type SubscriptionRecord = import('./payments').SubscriptionRecord
    export type CustomerBillingSummary = import('./payments').CustomerBillingSummary
    export type UsageStatusResult = import('./payments').UsageStatusResult
    export type UsageSummary = import('./payments').UsageSummary
    export type QuotaCheckResult = import('./payments').QuotaCheckResult
    export type RecordUsageInput = import('./payments').RecordUsageInput
  }
}

export const useCorge = (): Corge => {
  const active = corgeStorage.getStore()
  return active ? new Corge(active) : corge
}

export { CORGE_CONFIG }
export { getSecrets, loadGcpSecrets } from './cli/env'
