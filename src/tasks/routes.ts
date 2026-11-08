import type { Context } from 'hono'
import type { z } from 'zod'
import { CORE_CONFIG, type AppEnv } from '../config'
import { collectionRegistry, getEffectiveRbac } from '../db'
import { core } from '../index'
import { CORE_ROUTE_DEFAULTS, type BaseRouteConfig } from '../router'
import {
  signalTaskBody,
  type RouteIntrospectionItem,
  type RouteRegistryItem,
  type RoutesIntrospectionResponse
} from './schema'
import { zodToJsonSchemaSafe } from './utils'

export {
  signalTaskBody,
  zodToJsonSchemaSafe,
  type RouteIntrospectionItem,
  type RouteRegistryItem,
  type RoutesIntrospectionResponse
}

const summarizeGuards = (g?: BaseRouteConfig['guard']): string[] => {
  if (!g) return []
  const guards: string[] = []
  if (g.checkFileRef) guards.push('checkFileRef')
  if (g.checkUserId) guards.push('checkUserId')
  if (g.checkCollectionField) {
    guards.push(`checkCollectionField:${g.checkCollectionField.collection}.${g.checkCollectionField.param}`)
  }
  if (g.requireEmailVerified) guards.push('requireEmailVerified')
  if (g.custom) guards.push('custom')
  return guards
}

export const buildRoutesIntrospection = (
  routeItems: RouteRegistryItem[],
  scope: 'all' | 'custom' | 'core' = 'all'
): RoutesIntrospectionResponse => {
  const filtered = routeItems.filter((r) => {
    const isCore = r.id in CORE_ROUTE_DEFAULTS
    if (scope === 'core') return isCore
    if (scope === 'custom') return !isCore
    return true
  })

  const routes: RouteIntrospectionItem[] = filtered.map((r) => ({
    id: r.id,
    method: r.method,
    path: `/api${r.path}`,
    mode: r.mode,
    ...(r.workflowName ? { workflowName: r.workflowName } : {}),
    auth: r.auth ?? 'user',
    description: r.description,
    mcp: Boolean(r.mcp),
    tool: r.tool !== false,
    guards: summarizeGuards(r.guard),
    inputSchema: zodToJsonSchemaSafe(r.input),
    outputSchema: zodToJsonSchemaSafe(r.output)
  }))

  const collections: NonNullable<RoutesIntrospectionResponse['collections']> = {}
  for (const [name, def] of collectionRegistry) {
    collections[name] = {
      relationType: def.userRelation?.type ?? '1:N',
      rbac: getEffectiveRbac(name) as Record<string, unknown>,
      schema: zodToJsonSchemaSafe(def.schema)
    }
  }

  return {
    appName: CORE_CONFIG.appName,
    generatedAt: new Date().toISOString(),
    routes,
    collections
  }
}

export const renderApiContractMarkdown = (meta: RoutesIntrospectionResponse): string => {
  const coreRoutes = meta.routes.filter((r) => r.id in CORE_ROUTE_DEFAULTS)
  const domainRoutes = meta.routes.filter((r) => !(r.id in CORE_ROUTE_DEFAULTS))

  const renderRouteBlock = (r: RouteIntrospectionItem) => {
    const lines: string[] = [
      `### ${r.method} ${r.path}`,
      `- **ID:** \`${r.id}\`${r.workflowName ? ` (Workflow: \`${r.workflowName}\`)` : ''}`,
      `- **Mode:** \`${r.mode}\` | **Auth:** \`${String(r.auth)}\` | **Guards:** \`${r.guards.join(', ') || 'none'}\` | **MCP:** \`${r.mcp}\` | **Tool:** \`${r.tool}\``,
      `- **Description:** ${r.description}`
    ]
    if (r.inputSchema) {
      lines.push('', '**Input JSON Schema:**', '```json', JSON.stringify(r.inputSchema, null, 2), '```')
    }
    if (r.outputSchema) {
      lines.push('', '**Output JSON Schema:**', '```json', JSON.stringify(r.outputSchema, null, 2), '```')
    }
    return lines.join('\n')
  }

  const collectionLines: string[] = []
  for (const [name, col] of Object.entries(meta.collections ?? {})) {
    collectionLines.push(
      `### Collection: \`${name}\``,
      `- **User Relation:** \`${col.relationType}\``,
      `- **RBAC Matrix:** \`${JSON.stringify(col.rbac ?? {})}\``,
      ...(col.schema ? ['', '```json', JSON.stringify(col.schema, null, 2), '```'] : [])
    )
  }

  return [
    `# API Contract & Schema Reference — ${meta.appName}`,
    '',
    `> **Generated At:** \`${meta.generatedAt}\``,
    '> **Agent Instruction:** This document is deterministically generated from runtime Zod schemas and route definitions. Treat it as the single source of truth for all HTTP endpoints, payloads, authentication levels, and Firestore collection models.',
    '',
    '## 1. Core Protocol & Architecture Conventions',
    '',
    '### 1.1. Authentication & Sessions (`auth`)',
    '- **`public` / `none` / `false`**: No authentication required.',
    '- **`user`**: Requires `Authorization: Bearer <idToken | SDK_API_KEY>` or HTTP-only `session` cookie.',
    '- **`strict`**: Requires revocation-checked session verification (`verifySessionCookie(..., true)` / `_system/auth_revocations`).',
    '- **`admin`**: Requires admin role (`SDK_API_KEY` or admin user claim).',
    '- **Social OAuth & Account Recovery**: Use `POST /api/auth/sign-in/social` (`google` | `apple`), `POST /api/auth/email/send-verification`, `POST /api/auth/email/verify`, `POST /api/auth/password/forgot`, `POST /api/auth/password/reset`, `POST /api/auth/recovery-email/set`, `POST /api/auth/recovery-email/verify`, `POST /api/auth/account-recovery/initiate`, and `POST /api/auth/account-recovery/complete`.',
    '',
    '### 1.2. Content-Addressed Files (`FileRef`)',
    '- All uploaded files use content-addressed IDs formatted as `<userId>_<sha256_24>` matching `/^[A-Za-z0-9_-]{1,128}_[a-f0-9]{24}$/`.',
    '- Upload files via `POST /api/files` (`multipart/form-data` field `file`) before passing `ref` or `refs` to downstream endpoints.',
    '',
    '### 1.3. Execution Modes (`mode: "rest"` vs `mode: "workflow"`)',
    '- **`mode: "rest"`**: Synchronous `200 OK` JSON response.',
    '- **`mode: "workflow"`**: Durable Cloud Tasks workflow. May return `200 OK` directly (if resolved via `shortCircuit` cache or within wait budget) **OR** `202 Accepted` (`{ taskId, status: "running", pollUrl: "/api/tasks/<taskId>" }`) when `Prefer: respond-async` / `?wait=false` is passed.',
    '- Poll task progress via `GET /api/tasks/:taskId`, send signals via `POST /api/tasks/:taskId/signal`, or cancel via `DELETE /api/tasks/:taskId`.',
    '',
    '### 1.4. Thin-Client AI Chat Streaming (`POST /api/chats/:chatId`)',
    '- Send `{ message: { id?, role: "user", content, parts?, attachments? }, agentId?, model? }` to stream SSE responses and cancel active streams via `POST /api/chats/:chatId/cancel`.',
    '',
    '## 2. Core Endpoints Catalog',
    '',
    ...coreRoutes.map(renderRouteBlock),
    '',
    '## 3. Domain Endpoints Catalog',
    '',
    ...(domainRoutes.length > 0 ? domainRoutes.map(renderRouteBlock) : ['_No custom domain routes registered._']),
    '',
    '## 4. Registered Firestore Collections Catalog',
    '',
    ...collectionLines
  ].join('\n')
}

export const buildHealthRoute = () => ({
  mode: 'rest' as const,
  handler: async () => ({
    ok: true,
    status: 'healthy' as const,
    service: CORE_CONFIG.appName,
    env: core.env.isDev ? ('dev' as const) : ('prod' as const),
    timestamp: new Date().toISOString()
  })
})

export const buildRoutesListRoute = (routeItems: () => RouteRegistryItem[]) => ({
  mode: 'rest' as const,
  handler: async ({ c }: { c: Context<AppEnv> }) => {
    const rawScope = c?.req.query('scope')
    const scope: 'all' | 'custom' | 'core' =
      rawScope === 'custom' || rawScope === 'core' ? rawScope : 'all'
    const format = c?.req.query('format')
    const accept = c?.req.header('accept') ?? ''
    const meta = buildRoutesIntrospection(routeItems(), scope)

    if (format === 'md' || accept.includes('text/markdown')) {
      return new Response(renderApiContractMarkdown(meta), {
        status: 200,
        headers: { 'content-type': 'text/markdown; charset=utf-8' }
      })
    }
    return meta
  }
})

export const buildTaskStatusRoute = () => ({
  mode: 'rest' as const,
  handler: async ({ c }: { c: Context<AppEnv> }) => {
    const taskId = c.req.param('taskId') ?? ''
    const status = await core.tasks.status(taskId)
    if (
      status.status === 'running' ||
      status.status === 'sleeping' ||
      status.status === 'waiting_signal' ||
      status.status === 'compensating'
    ) {
      return c.json(
        {
          taskId,
          status: status.status,
          ...(status.progress ? { progress: status.progress } : {}),
          pollUrl: `/api/tasks/${taskId}`
        },
        202
      )
    }
    if (status.status === 'errored') {
      return core.errors.httpError(502, status.error ?? 'Workflow task failed', 'WORKFLOW_ERROR')
    }
    if (status.status === 'cancelled') {
      return core.errors.httpError(409, status.error ?? 'Workflow task cancelled', 'TASK_CANCELLED')
    }
    if (c.req.query('envelope') === 'true') {
      return status
    }
    return status.response
  }
})

export const buildTaskSignalRoute = () => ({
  mode: 'rest' as const,
  input: signalTaskBody,
  handler: async ({ c, input }: { c: Context<AppEnv>; input: z.infer<typeof signalTaskBody> }) => {
    const taskId = c.req.param('taskId') ?? ''
    return core.tasks.signal(taskId, input.signal, input.payload)
  }
})

export const buildTaskCancelRoute = () => ({
  mode: 'rest' as const,
  handler: async ({ c }: { c: Context<AppEnv> }) => {
    const taskId = c.req.param('taskId') ?? ''
    return core.tasks.cancel(taskId)
  }
})
