import { getRequestListener } from '@hono/node-server'
import { defineSecret } from 'firebase-functions/params'
import { onRequest } from 'firebase-functions/v2/https'
import { onTaskDispatched } from 'firebase-functions/v2/tasks'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { z } from 'zod'
import { coreAttachmentsRoutes, getRegisteredAttachmentTypes, registerAttachmentTypes } from '../attachments'
import { coreAuthRoutes } from '../auth'
import { coreChatRoutes, mcpRoute } from '../chat'
import { CORGE_CONFIG, SECRET_NAMES, type AppBindings, type AppEnv, type DbRole } from '../config'
import { registerCollections, type EntryId } from '../db'
import { coreEmailRoutes, registerEmailTemplates } from '../emails'
import { coreFilesRoutes } from '../files'
import { Corge } from '../index'
import { corePaymentRoutes, registerPlans, registerProducts } from '../payments'
import {
  buildHealthRoute, buildRoutesListRoute, buildTaskCancelRoute, buildTaskSignalRoute, buildTaskStatusRoute,
  TaskWaitDetachedSignal, type RouteRegistryItem, type StepRunner, type WorkflowRuntimeEntry, type WorkflowTaskPayload
} from '../tasks'
import { isRespondAsyncPreferred, mergeCoreAndDomainRoutes, RouterGuardEngine } from './guard'
import {
  type CorgeAppInit, type CorgeRouteId, type RouteConfig, type RouteExecutionContext, type RouteMode, type WorkflowRegistryEntry
} from './schema'

export class RouterService {
  readonly #corge: Corge
  readonly #guard: RouterGuardEngine

  constructor(corgeClient: Corge) {
    this.#corge = corgeClient
    this.#guard = new RouterGuardEngine(corgeClient)
  }

  readonly applyRateLimit = (
    ...args: Parameters<RouterGuardEngine['applyRateLimit']>
  ): ReturnType<RouterGuardEngine['applyRateLimit']> => this.#guard.applyRateLimit(...args)

  readonly authenticateRequest = (
    ...args: Parameters<RouterGuardEngine['authenticateRequest']>
  ): ReturnType<RouterGuardEngine['authenticateRequest']> => this.#guard.authenticateRequest(...args)

  #createCloudFunctions = (
    app: Hono<AppEnv>,
    devApp: Hono<AppEnv>,
    workflowRegistry: Record<string, WorkflowRuntimeEntry>
  ) => {
    const emailProvider = CORGE_CONFIG.emails.provider
    const paymentProvider = CORGE_CONFIG.payments.provider
    const emailSecrets: string[] = [
      ...(emailProvider === 'resend' ? ['RESEND_API_KEY', 'EMAIL_WEBHOOK_SECRET'] : []),
      ...(emailProvider === 'sendgrid' ? ['SENDGRID_API_KEY', 'EMAIL_WEBHOOK_SECRET'] : [])
    ]
    const paymentSecrets: string[] = [
      ...(paymentProvider === 'stripe' ? ['STRIPE_API_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_SANDBOX_API_KEY', 'STRIPE_SANDBOX_WEBHOOK_SECRET'] : []),
      ...(paymentProvider === 'dodo' ? ['DODO_API_KEY', 'DODO_WEBHOOK_SECRET', 'DODO_SANDBOX_API_KEY', 'DODO_SANDBOX_WEBHOOK_SECRET'] : [])
    ]
    const secretNames = [...new Set<string>([...SECRET_NAMES, ...emailSecrets, ...paymentSecrets, ...CORGE_CONFIG.secrets])]
    const sharedOpts = {
      region: CORGE_CONFIG.region,
      memory: CORGE_CONFIG.cloudRun.memory,
      cpu: CORGE_CONFIG.cloudRun.cpu,
      secrets: secretNames.map((name) => defineSecret(name))
    }
    const httpOpts = { ...sharedOpts, ...CORGE_CONFIG.cloudRun.http }
    const workerOpts = { ...sharedOpts, ...CORGE_CONFIG.cloudRun.worker }

    const httpHandler = onRequest(httpOpts, getRequestListener((req) => app.fetch(req)))
    const devHttpHandler = onRequest(httpOpts, getRequestListener((req) => devApp.fetch(req)))

    const workerConfig = {
      ...workerOpts,
      invoker: [CORGE_CONFIG.serviceAccount, CORGE_CONFIG.computeAccount],
      retryConfig: { maxAttempts: CORGE_CONFIG.tasks.maxAttempts, minBackoffSeconds: 2, maxBackoffSeconds: 20 },
      rateLimits: { maxConcurrentDispatches: 1000, maxDispatchesPerSecond: 500 }
    }

    const tasksHandler = onTaskDispatched<WorkflowTaskPayload>(workerConfig, async (req) => {
      try {
        await this.#corge.internals.workflows.execute({ ...req.data, isDev: false }, workflowRegistry)
      } catch (err) {
        if (!this.#corge.errors.isStaleWorkerEpochError(err)) throw err
      }
    })
    const devTasksHandler = onTaskDispatched<WorkflowTaskPayload>(workerConfig, async (req) => {
      try {
        await this.#corge.internals.workflows.execute({ ...req.data, isDev: true }, workflowRegistry)
      } catch (err) {
        if (!this.#corge.errors.isStaleWorkerEpochError(err)) throw err
      }
    })

    const fnName = CORGE_CONFIG.gcpProject
    const functions: Record<string, unknown> = {
      [fnName]: httpHandler,
      [`${fnName}-dev`]: devHttpHandler,
      [`${fnName}-tasks`]: tasksHandler,
      [`${fnName}-tasks-dev`]: devTasksHandler
    }

    return { httpHandler, devHttpHandler, tasksHandler, devTasksHandler, functions }
  }

  #makeCtx = <I, P = Record<string, string>, Q = Record<string, string>>(
    env: AppBindings,
    userId: EntryId,
    role: DbRole,
    mode: RouteMode,
    input: I,
    step: StepRunner = this.#corge.internals.workflows.createStepRunner('rest'),
    c?: Context<AppEnv>,
    params?: P,
    query?: Q,
    rawBody?: string
  ): RouteExecutionContext<I, P, Q> => ({
    corge: new Corge({ env, userId, role, step }),
    c: c as Context<AppEnv>,
    env,
    userId,
    role,
    mode,
    step,
    allWithRollback: this.#corge.internals.workflows.allWithRollback,
    input,
    params: (params ?? (c ? c.req.param() : {})) as P,
    query: (query ?? (c ? c.req.query() : {})) as Q,
    ...(rawBody !== undefined ? { rawBody } : {})
  })

  #respondAsync202 = (c: Context<AppEnv> | undefined, taskId: string) => {
    if (c) {
      c.header('Preference-Applied', 'respond-async')
      c.header('Location', `/api/tasks/${taskId}`)
      return c.json({ taskId, status: 'running', pollUrl: `/api/tasks/${taskId}` }, 202)
    }
    return { taskId, status: 'running', pollUrl: `/api/tasks/${taskId}` }
  }

  #executeRouteCore = async (opts: {
    key: string
    wfName: string
    cfg: RouteConfig
    mode: RouteMode
    runTask: (taskInput: unknown, step: StepRunner) => Promise<unknown>
    parseOut: (out: unknown) => unknown
    env: AppBindings
    userId: EntryId
    role: DbRole
    parsed: unknown
    parsedParams: Record<string, string>
    parsedQuery: Record<string, string>
    rawBody?: string
    c?: Context<AppEnv>
    wait: boolean
  }): Promise<unknown> => {
    const { key, wfName, cfg, mode, runTask, parseOut, env, userId, role, parsed, parsedParams, parsedQuery, rawBody, c, wait } =
      opts
    await this.#guard.enforceGuard(c, cfg, userId, parsed, role)
    const dedupeKey =
      (cfg.idempotencyKey ? cfg.idempotencyKey(parsed, { userId }) : undefined) ??
      (c?.req.header('idempotency-key')?.trim() || undefined)
    const runWithStep = <T>(m: RouteMode, fn: (ctx: RouteExecutionContext) => Promise<T> | T): Promise<T> => {
      const step = this.#corge.internals.workflows.createStepRunner(m)
      return this.#corge.internals.context.run({ env, userId, role, step }, async () =>
        fn(this.#makeCtx(env, userId, role, m, parsed, step, c, parsedParams, parsedQuery, rawBody))
      )
    }

    if (mode === 'rest') {
      const executeRest = () => runWithStep('rest', cfg.handler)
      const out = dedupeKey
        ? await this.#guard.withHttpIdempotency(key, dedupeKey, userId, Boolean(env.isDev), executeRest)
        : await executeRest()
      return parseOut(out)
    }

    const cached = cfg.shortCircuit ? await runWithStep('workflow', cfg.shortCircuit) : undefined
    if (cached !== undefined && cached !== null) return parseOut(cached)

    try {
      const dispatched = await this.#corge.internals.workflows.dispatch(wfName, runTask, parsed, {
        mode: 'workflow',
        ...(cfg.timeout !== undefined ? { timeout: cfg.timeout } : {}),
        ...(dedupeKey ? { dedupeKey } : {}),
        wait,
        ...(wait && c ? { maxWaitMs: CORGE_CONFIG.limits.maxWaitMs, signal: c.req.raw?.signal } : {}),
        userId,
        userRole: role
      })
      return !wait ? this.#respondAsync202(c, (dispatched as { taskId: string }).taskId) : parseOut(dispatched)
    } catch (err) {
      if (err instanceof TaskWaitDetachedSignal) return this.#respondAsync202(c, err.taskId)
      throw err
    }
  }

  #registerRouteSpecAndTools = (
    key: string,
    wfName: string,
    mode: RouteMode,
    cfg: RouteConfig,
    description: string,
    inputSchema: z.ZodType<any>,
    runTask: (taskInput: unknown, step: StepRunner) => Promise<unknown>,
    invoke: WorkflowRegistryEntry['invoke'],
    workflowRegistry: Record<string, WorkflowRegistryEntry>,
    routeRegistryItems: RouteRegistryItem[]
  ): void => {
    const method = (cfg.method ?? 'POST').toUpperCase()
    const path = cfg.path ?? `/${key}`
    const deadlineSeconds = cfg.timeout
      ? Math.max(15, Math.ceil(this.#corge.errors.parseDuration(cfg.timeout, 540_000) / 1000))
      : undefined

    routeRegistryItems.push({
      id: key,
      mode,
      method,
      path,
      ...(mode === 'workflow' || cfg.workflowName ? { workflowName: wfName } : {}),
      auth: cfg.auth ?? 'user',
      description,
      mcp: cfg.mcp === true,
      tool: cfg.tool !== false,
      ...(cfg.input ? { input: cfg.input } : {}),
      ...(cfg.output ? { output: cfg.output } : {}),
      ...(cfg.guard ? { guard: cfg.guard } : {})
    })

    if (mode === 'workflow' || cfg.workflowName) {
      workflowRegistry[wfName] = {
        name: wfName,
        description,
        input: inputSchema,
        output: cfg.output,
        mode,
        ...(deadlineSeconds !== undefined ? { deadlineSeconds } : {}),
        guard: cfg.guard,
        runTask,
        invoke
      }
    }

    if (cfg.tool !== false || cfg.mcp === true || mode === 'workflow' || cfg.workflowName) {
      const registerToolUnder = (toolName: string, mcp: boolean, tool: boolean) =>
        this.#corge.internals.registry.registerWorkflowTool(toolName, {
          description,
          input: inputSchema,
          mcp,
          tool,
          execute: (inp, u) => invoke(inp, u)
        })
      registerToolUnder(wfName, cfg.mcp === true, cfg.tool !== false)
      if (key !== wfName && cfg.tool !== false) registerToolUnder(key, false, true)
    }
  }

  #buildRouteInvoker = (
    key: string,
    cfg: RouteConfig,
    workflowRegistry: Record<string, WorkflowRegistryEntry>,
    routeRegistryItems: RouteRegistryItem[]
  ): WorkflowRegistryEntry['invoke'] => {
    const mode: RouteMode = cfg.mode ?? 'rest'
    const wfName = cfg.workflowName ?? key
    const inputSchema = (cfg.input ?? z.object({})) as z.ZodType<any>
    const description = cfg.description ?? wfName
    const parseOut = (out: unknown) => (out instanceof Response ? out : cfg.output ? cfg.output.parse(out) : out)

    const runTask = async (taskInput: unknown, step: StepRunner) => {
      const current = new Corge()
      const uid = current.userId || CORGE_CONFIG.auth.adminUserId
      return cfg.handler(this.#makeCtx(current.env, uid, current.role, mode, taskInput, step))
    }

    const invoke = async (
      rawInput: unknown,
      userId: EntryId,
      c?: Context<AppEnv>,
      explicitRole?: DbRole,
      opts?: { wait?: boolean; rawBody?: string }
    ) => {
      const env = c?.env ?? this.#corge.env
      const authLevel = cfg.auth ?? 'user'
      const role = this.#corge.internals.auth.resolveUserRole(userId, explicitRole ?? (c?.get('userRole') as DbRole | undefined))

      if (authLevel !== 'public' && authLevel !== 'none' && authLevel !== false && !userId) {
        return this.#corge.errors.httpError(401, 'Unauthorized', 'UNAUTHORIZED')
      }
      if ((authLevel === 'admin' || authLevel === 'api-key') && role !== 'admin' && userId !== CORGE_CONFIG.auth.adminUserId) {
        return this.#corge.errors.httpError(403, 'Forbidden', 'FORBIDDEN')
      }

      const parsedParams = cfg.params && c ? cfg.params.parse(c.req.param()) : c?.req.param() ?? {}
      const parsedQuery = cfg.query && c ? cfg.query.parse(c.req.query()) : c?.req.query() ?? {}
      const parsed = cfg.input ? cfg.input.parse(rawInput ?? {}) : rawInput

      return this.#corge.internals.context.run({ env, userId, role }, () =>
        this.#executeRouteCore({ key, wfName, cfg, mode, runTask, parseOut, env, userId, role, parsed, parsedParams, parsedQuery, rawBody: opts?.rawBody, c, wait: opts?.wait !== false })
      )
    }

    this.#registerRouteSpecAndTools(key, wfName, mode, cfg, description, inputSchema, runTask, invoke, workflowRegistry, routeRegistryItems)
    return invoke
  }

  #mountRoute = (app: Hono<AppEnv>, cfg: RouteConfig, invoke: WorkflowRegistryEntry['invoke']): void => {
    const method = (cfg.method ?? 'POST').toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete' | 'all'
    const routePath = cfg.path ?? '/'

    app[method](routePath, async (c) => {
      const userId = await this.authenticateRequest(c, cfg)
      const role = this.#corge.internals.auth.resolveUserRole(userId, c.get('userRole') as DbRole | undefined)
      let rawInput: unknown
      let rawText: string | undefined
      if (cfg.rawBody && method !== 'get') {
        rawText = await c.req.text().catch(() => '')
        if (cfg.input) {
          try {
            rawInput = rawText ? JSON.parse(rawText) : {}
          } catch {
            rawInput = {}
          }
        } else {
          rawInput = rawText
        }
      } else if (cfg.input && method !== 'get') {
        rawInput = await c.req.json().catch(() => ({}))
      }
      const wait = !(cfg.mode === 'workflow' && isRespondAsyncPreferred(c))
      const out = await invoke(rawInput, userId, c, role, {
        wait,
        ...(rawText !== undefined ? { rawBody: rawText } : {})
      })
      return out instanceof Response ? out : c.json(out)
    })
  }

  #createHonoApp = (
    isDev: boolean,
    allRoutes: Record<string, RouteConfig>,
    routeInvokers: Map<RouteConfig, WorkflowRegistryEntry['invoke']>
  ): Hono<AppEnv> => {
    const app = new Hono<AppEnv>().basePath('/api')
    app.use(
      '*',
      cors({
        origin: (origin, c) => {
          if (!origin) return undefined
          if (
            CORGE_CONFIG.auth.allowedOrigins.some((p: string | RegExp) =>
              typeof p === 'string' ? p === origin : p.test(origin)
            )
          ) {
            return origin
          }
          try {
            if (origin === new URL(c.req.url).origin) return origin
          } catch {}
          return null
        },
        credentials: true
      })
    )
    app.use(
      '*',
      bodyLimit({
        maxSize: CORGE_CONFIG.limits.maxBodyBytes,
        onError: () => this.#corge.errors.httpError(413, 'Payload too large (max 25MiB)', 'PAYLOAD_TOO_LARGE')
      })
    )
    app.onError((err) => this.#corge.errors.toHttpError(err).getResponse())
    app.use('*', async (c, next) => {
      const env: AppBindings = { ...this.#corge.env, ...(c.env ?? {}), isDev }
      c.env = env
      await this.#corge.internals.context.run(
        { env, userId: CORGE_CONFIG.auth.adminUserId, role: 'admin' },
        () => next()
      )
    })

    for (const r of Object.values(allRoutes)) this.#mountRoute(app, r, routeInvokers.get(r)!)

    app.all('/mcp', async (c) => {
      const userId = await this.authenticateRequest(c, { path: '/mcp', auth: 'user' })
      return mcpRoute(c.req.raw, userId, this.#corge.internals.context.getMcpTools())
    })

    return app
  }

  createApp = (init: CorgeAppInit = {}) => {
    if (init.emailTemplates) registerEmailTemplates(init.emailTemplates, true)
    if (init.plans) registerPlans(init.plans, true)
    if (init.products) registerProducts(init.products, true)

    registerCollections(init.collections ?? {}, true)
    this.#corge.internals.registry.registerAgents(init.agents ?? {}, true)
    if (init.attachmentTypes) registerAttachmentTypes(init.attachmentTypes)
    this.#corge.internals.registry.registerContextCatalog(init.context ?? [], true)
    this.#corge.internals.registry.clearWorkflowTools()

    const overrides = init.corgeRouteOverrides ?? {}
    const workflowRegistry: Record<string, WorkflowRegistryEntry> = {}
    const routeRegistryItems: RouteRegistryItem[] = []

    const attachmentTypesDesc = Object.entries(getRegisteredAttachmentTypes())
      .map(([k, v]) => `${k} (${v.description})`)
      .join('; ')

    const rawCoreRoutes: Record<CorgeRouteId, Partial<RouteConfig>> = {
      health: buildHealthRoute(),
      ...coreAuthRoutes,
      ...coreFilesRoutes,
      ...coreChatRoutes,
      ...coreAttachmentsRoutes,
      ...coreEmailRoutes,
      ...corePaymentRoutes,
      'routes.list': buildRoutesListRoute(() => routeRegistryItems),
      'tasks.status': buildTaskStatusRoute(),
      'tasks.signal': buildTaskSignalRoute(),
      'tasks.cancel': buildTaskCancelRoute()
    }

    const allRoutes = mergeCoreAndDomainRoutes(
      rawCoreRoutes,
      overrides,
      attachmentTypesDesc,
      init.routes ?? {}
    )
    const routeInvokers = new Map<RouteConfig, WorkflowRegistryEntry['invoke']>()
    for (const [id, r] of Object.entries(allRoutes)) {
      routeInvokers.set(r, this.#buildRouteInvoker(id, r, workflowRegistry, routeRegistryItems))
    }

    this.#corge.internals.workflows.registerRuntime(workflowRegistry)

    const createApp = (isDev = false) => this.#createHonoApp(isDev, allRoutes, routeInvokers)
    const app = createApp(false)
    const devApp = createApp(true)
    const cloudFunctions = this.#createCloudFunctions(app, devApp, workflowRegistry)

    return {
      createApp,
      app,
      devApp,
      workflowRegistry,
      agents: this.#corge.internals.registry.getRegisteredAgents(),
      ...cloudFunctions
    }
  }
}
