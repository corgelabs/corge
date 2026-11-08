import { createHash, timingSafeEqual } from 'node:crypto'
import { Timestamp } from 'firebase-admin/firestore'
import type { Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { CORE_CONFIG, type AppEnv, type DbRole, type RateLimitConfig } from '../config'
import type { EntryId } from '../db'
import type { Core } from '../index'
import {
  CORE_ROUTE_DEFAULTS,
  type AuthLevel,
  type BaseRouteConfig,
  type CoreRouteId,
  type CoreRouteOverrides,
  type RouteConfig
} from './schema'

const HTTP_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000

export const getClientIp = (c: Context<AppEnv>): string => {
  const xff = c.req
    .header('x-forwarded-for')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (xff && xff.length > 0) {
    return (xff.length >= 2 ? xff.at(-2) : xff.at(-1))!
  }
  return c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || 'anon'
}

export const isMasterKey = (bearer?: string, expected?: string): boolean => {
  if (!bearer || !expected) return false
  const a = createHash('sha256').update(bearer).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

export const isBaseRouteConfig = (v: unknown): v is BaseRouteConfig =>
  Boolean(v && typeof v === 'object' && ('path' in v || 'mode' in v || 'auth' in v || 'handler' in v))

export const isRespondAsyncPreferred = (c: Context<AppEnv>): boolean =>
  c.req.query('async') === 'true' ||
  c.req.query('wait') === 'false' ||
  /\brespond-async\b/i.test(c.req.header('prefer') ?? '')

export class RouterGuardEngine {
  readonly #core: Core

  constructor(coreClient: Core) {
    this.#core = coreClient
  }

  applyRateLimit = (
    c: Context<AppEnv>,
    cfgOrLimit: BaseRouteConfig | RateLimitConfig,
    userIdOrScope?: EntryId
  ): void => {
    const rl: RateLimitConfig = isBaseRouteConfig(cfgOrLimit)
      ? cfgOrLimit.rateLimit !== undefined
        ? cfgOrLimit.rateLimit
        : cfgOrLimit.auth === 'public' || cfgOrLimit.auth === 'none' || cfgOrLimit.auth === false
          ? CORE_CONFIG.limits.httpIp
          : CORE_CONFIG.limits.httpUser
      : cfgOrLimit
    if (!rl) return
    const userId = c.get('userId') || userIdOrScope
    const routePrefix = isBaseRouteConfig(cfgOrLimit) && cfgOrLimit.path ? `${cfgOrLimit.method ?? c.req.method}:${cfgOrLimit.path}:` : ''
    const key =
      typeof rl.keyBy === 'function'
        ? rl.keyBy(c)
        : rl.keyBy === 'ip' || !userId
          ? `${routePrefix}ip:${getClientIp(c)}`
          : `${routePrefix}user:${userId}`
    this.#core.internals.resilience.acquireHttpLimit(key, rl.max, rl.windowMs)
  }

  authenticateRequest = async (
    c: Context<AppEnv>,
    cfgOrAuth: BaseRouteConfig | AuthLevel = 'user'
  ): Promise<EntryId> => {
    const rawAuth: AuthLevel = isBaseRouteConfig(cfgOrAuth) ? (cfgOrAuth.auth ?? 'user') : cfgOrAuth
    const authLevel =
      rawAuth === 'none' || rawAuth === false
        ? 'public'
        : rawAuth === 'authenticated'
          ? 'user'
          : rawAuth === 'api-key'
            ? 'admin'
            : rawAuth

    if (authLevel === 'public') {
      c.set('userId', '')
      c.set('userRole', 'anon')
      if (isBaseRouteConfig(cfgOrAuth)) this.applyRateLimit(c, cfgOrAuth)
      return ''
    }

    const t0 = performance.now()
    const finishAuth = (uid: EntryId, role: DbRole): EntryId => {
      if (authLevel === 'admin' && role !== 'admin' && uid !== CORE_CONFIG.auth.adminUserId) {
        return this.#core.errors.httpError(403, 'Forbidden', 'FORBIDDEN')
      }
      c.set('userId', uid)
      c.set('userRole', role)
      if (isBaseRouteConfig(cfgOrAuth)) this.applyRateLimit(c, cfgOrAuth, uid)
      const dur = (performance.now() - t0).toFixed(3)
      c.header('x-auth-time-ms', dur)
      c.header('Server-Timing', `auth;dur=${dur}`)
      return uid
    }

    const bearer = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
    const cookie = !bearer ? getCookie(c, CORE_CONFIG.auth.sessionCookie) : undefined
    if (!bearer && !cookie) return this.#core.errors.httpError(401, 'Unauthorized', 'UNAUTHORIZED')
    const expectedKey = c.env?.SDK_API_KEY ?? this.#core.env.SDK_API_KEY
    if (isMasterKey(bearer, expectedKey)) {
      await this.#core.internals.auth.authWarm
      return finishAuth(CORE_CONFIG.auth.adminUserId, 'admin')
    }
    if (rawAuth === 'api-key') {
      return this.#core.errors.httpError(401, 'Valid API key required', 'UNAUTHORIZED')
    }

    let verified: { uid: EntryId; role: DbRole }
    try {
      verified = await this.#core.internals.auth.verifyToken(
        (bearer ?? cookie)!,
        !bearer,
        authLevel === 'strict',
        c.env?.isDev ?? this.#core.env.isDev
      )
    } catch {
      return this.#core.errors.httpError(401, 'Unauthorized', 'UNAUTHORIZED')
    }
    return finishAuth(verified.uid, verified.role)
  }

  #enforceFileRefCheck = (
    checkFileRef: NonNullable<BaseRouteConfig['guard']>['checkFileRef'],
    c: Context<AppEnv> | undefined,
    userId: EntryId,
    input: unknown,
    obj: Record<string, unknown>,
    role: DbRole
  ): void => {
    if (!checkFileRef) return
    let refs: string[] = []
    if (typeof checkFileRef === 'function') {
      const extracted = checkFileRef(input, c)
      if (typeof extracted === 'string') refs = [extracted]
      else if (Array.isArray(extracted)) refs = extracted
    } else {
      const paramRef = c?.req.param('ref')
      refs = [
        ...(paramRef ? [paramRef] : []),
        ...(typeof obj.ref === 'string' ? [obj.ref] : []),
        ...(Array.isArray(obj.refs)
          ? obj.refs.map((r) =>
              typeof r === 'string'
                ? r
                : r && typeof r === 'object' && 'ref' in r && typeof (r as { ref: unknown }).ref === 'string'
                  ? (r as { ref: string }).ref
                  : ''
            )
          : [])
      ]
    }
    if (refs.some((r) => !this.#core.files.canAccess(r, userId, role))) {
      this.#core.errors.httpError(403, 'Forbidden', 'FORBIDDEN')
    }
  }

  enforceGuard = async (
    c: Context<AppEnv> | undefined,
    cfg: BaseRouteConfig,
    userId: EntryId,
    input: unknown,
    role: DbRole = this.#core.internals.auth.resolveUserRole(userId)
  ): Promise<void> => {
    const g = cfg.guard
    if (!g || !userId) return
    const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>

    this.#enforceFileRefCheck(g.checkFileRef, c, userId, input, obj, role)

    if (g.checkCollectionField) {
      const { collection, param } = g.checkCollectionField
      const docId = c?.req.param(param) ?? (typeof obj[param] === 'string' ? (obj[param] as string) : '')
      const doc = await this.#core.db.read(collection, docId, false, { bypassRbac: true })
      if (!doc) {
        return this.#core.errors.httpError(
          404,
          `${collection === 'chat' ? 'Chat' : 'Document'} not found`,
          'NOT_FOUND'
        )
      }
      if (!(await this.#core.db.canAccess(collection, doc, userId, 'read', role))) {
        return this.#core.errors.httpError(403, 'Forbidden', 'FORBIDDEN')
      }
    }

    if (g.checkUserId) {
      const targetUserId =
        typeof g.checkUserId === 'function'
          ? g.checkUserId(input, c)
          : typeof obj.userId === 'string'
            ? obj.userId
            : undefined
      if (targetUserId && role !== 'admin' && userId !== CORE_CONFIG.auth.adminUserId && targetUserId !== userId) {
        this.#core.errors.httpError(403, 'Forbidden', 'FORBIDDEN')
      }
      if (obj.backupBeforeErase && role !== 'admin' && userId !== CORE_CONFIG.auth.adminUserId) {
        this.#core.errors.httpError(403, 'Forbidden', 'FORBIDDEN')
      }
    }

    if (g.requireEmailVerified && role !== 'admin' && userId !== CORE_CONFIG.auth.adminUserId) {
      const authUser = await this.#core.auth.getUser(userId)
      if (!authUser?.emailVerified) {
        this.#core.errors.httpError(403, 'Email verification required', 'EMAIL_NOT_VERIFIED')
      }
    }

    if (g.custom) {
      const ok = await g.custom({ userId, role, input, env: this.#core.env, ...(c ? { c } : {}) })
      if (ok === false) this.#core.errors.httpError(403, 'Forbidden', 'FORBIDDEN')
    }
  }

  withHttpIdempotency = async <T>(
    routeKey: string,
    dedupeKey: string,
    userId: EntryId,
    isDev: boolean,
    fn: () => Promise<T>
  ): Promise<T> => {
    const keyHash = createHash('sha256')
      .update(`${routeKey}:${userId}:${dedupeKey}`)
      .digest('hex')
      .slice(0, 40)
    return this.#core.internals.resilience.singleflight(
      `http_idem:${isDev ? 'dev' : 'prod'}:${keyHash}`,
      async () => {
        const docRef = this.#core.db.firestore(isDev).collection('_idempotency').doc(keyHash)
        const snap = await docRef.get().catch(() => null)
        const data = snap?.exists ? (snap.data() as Record<string, unknown> | undefined) : undefined
        const now = Date.now()
        if (
          data?.status === 'completed' &&
          typeof data.expiresAtMs === 'number' &&
          data.expiresAtMs > now &&
          'response' in data
        ) {
          return data.response as T
        }
        const out = await fn()
        if (!(out instanceof Response)) {
          const expiresAtMs = Date.now() + HTTP_IDEMPOTENCY_TTL_MS
          await docRef
            .set({
              id: keyHash,
              routeKey,
              userId,
              status: 'completed',
              response: out ?? null,
              createdAt: new Date().toISOString(),
              expiresAtMs,
              expiresAt: Timestamp.fromMillis(expiresAtMs)
            })
            .catch(() => {})
        }
        return out
      },
      { scope: 'global' }
    )
  }
}

export const mergeCoreAndDomainRoutes = (
  rawCoreRoutes: Record<CoreRouteId, Partial<RouteConfig>>,
  overrides: CoreRouteOverrides,
  attachmentTypesDesc: string,
  domainRouteDefs: Record<string, RouteConfig<any, any, any, any>>
): Record<string, RouteConfig> => {
  const coreRoutes = Object.fromEntries(
    (Object.keys(CORE_ROUTE_DEFAULTS) as CoreRouteId[]).map((id) => {
      const merged = {
        mcp: false,
        ...CORE_ROUTE_DEFAULTS[id],
        ...rawCoreRoutes[id],
        ...(id === 'attachments.scan' && attachmentTypesDesc
          ? {
              description: `OCR + classify + extract structured fields for a single attachment ref. Recognised types: ${attachmentTypesDesc}; or other.`
            }
          : {}),
        ...(overrides[id] ?? {})
      } as RouteConfig
      merged.mcp = merged.mcp === true
      return [id, merged]
    })
  ) as Record<CoreRouteId, RouteConfig>

  const domainRoutes: Record<string, RouteConfig> = {}
  for (const [name, routeCfg] of Object.entries(domainRouteDefs)) {
    const normalizedPath = routeCfg.path
      ? routeCfg.path.startsWith('/')
        ? routeCfg.path
        : `/${routeCfg.path}`
      : `/${name}`
    domainRoutes[name] = {
      ...routeCfg,
      mcp: routeCfg.mcp === true,
      path: normalizedPath,
      workflowName: routeCfg.workflowName ?? (routeCfg.mode === 'workflow' ? name : undefined)
    } as RouteConfig
  }

  return { ...coreRoutes, ...domainRoutes }
}
