import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { serve, type ServerType } from '@hono/node-server'
import { z } from 'zod'
import { agents } from '@config/agents'
import { routes as customRoutes } from '@config/routes'
import { Core, core, loadGcpSecrets, useCore } from '@core'
import { devApp } from '@app-entry'

type AttachmentTypesMap = core.types.AttachmentTypesMap
type RouteConfig<I = any, O = any, P = Record<string, string>, Q = Record<string, string>> =
  core.types.RouteConfig<I, O, P, Q>
type RoutesIntrospectionResponse = core.types.RoutesIntrospectionResponse
const CORE_CONFIG = core.config
const defineCollection = core.define.collection

EventEmitter.defaultMaxListeners = 100

await loadGcpSecrets()

const EXPLICIT_BASE_URL = process.env.BASE_URL
const PORT = 8791
const BASE_URL = (EXPLICIT_BASE_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, '')
const SPAWN_LOCAL = !EXPLICIT_BASE_URL

const ENV = core.env
const API_KEY = ENV.SDK_API_KEY
const WEB_API_KEY = ENV.WEB_API_KEY

const AGENT_IDS = Object.keys(agents)
const DEFAULT_AGENT_ID = AGENT_IDS[0]!
const DEFAULT_AGENT_NAME = agents[DEFAULT_AGENT_ID as keyof typeof agents]?.name ?? DEFAULT_AGENT_ID

const ACTIVE_ATTACHMENT_TYPES: AttachmentTypesMap = (() => {
  const fromAgents: AttachmentTypesMap = {}
  for (const ag of Object.values(agents)) {
    if (ag.attachmentTypes) Object.assign(fromAgents, ag.attachmentTypes)
  }
  return Object.keys(fromAgents).length ? fromAgents : core.internals.registry.getAttachmentTypes()
})()

interface GeneratedFixture {
  type: string
  filename: string
  mime: 'application/pdf' | 'image/jpeg'
  bytes: Uint8Array
  dataUrl: string
  schema?: z.ZodType
  expectedKeys: string[]
}

interface DiscoveredRouteItem {
  id: string
  mode: 'rest' | 'workflow'
  method: string
  path: string
  workflowName?: string
  description: string
  inputSchema?: {
    type?: string
    properties?: Record<string, Record<string, unknown>>
    required?: string[]
  }
}

const sanitizeAscii = (str: string): string =>
  str
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[^\x20-\x7E]/g, ' ')

const wrapText = (text: string, maxLen = 80): string[] => {
  const words = sanitizeAscii(text).split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (current && current.length + 1 + word.length > maxLen) {
      lines.push(current)
      current = word
    } else {
      current = current ? `${current} ${word}` : word
    }
  }
  if (current) lines.push(current)
  return lines
}

const sampleValueFromJsonSchema = (key: string, prop: Record<string, unknown>): unknown => {
  const desc = String(prop.description ?? '')
  if (prop.type === 'boolean') return true
  if (prop.type === 'number' || prop.type === 'integer') return 1
  if (prop.type === 'array') {
    const items = (prop.items ?? {}) as { properties?: Record<string, Record<string, unknown>>; type?: string }
    if (items.properties) {
      const item: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(items.properties)) {
        item[k] = sampleValueFromJsonSchema(k, v)
      }
      return [item]
    }
    return [`SAMPLE_${key.toUpperCase()}`]
  }
  if (prop.type === 'object') {
    const subProps = (prop.properties ?? {}) as Record<string, Record<string, unknown>>
    const obj: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(subProps)) {
      obj[k] = sampleValueFromJsonSchema(k, v)
    }
    return obj
  }
  const egMatch = /e\.g\.\s*"([^"]+)"/.exec(desc)
  if (egMatch?.[1]) return egMatch[1]
  const orMatch = /^([A-Za-z0-9_-]+)\s+or\s+([A-Za-z0-9_-]+)$/.exec(desc.trim())
  if (orMatch?.[1]) return orMatch[1]
  return `SAMPLE_${key.toUpperCase()}`
}

const formatSchemaLines = (
  properties: Record<string, Record<string, unknown>>,
  sampleObj: Record<string, unknown>
): string[] => {
  const lines: string[] = []
  for (const [key, prop] of Object.entries(properties)) {
    const val = sampleObj[key]
    if (Array.isArray(val)) {
      lines.push(`${key}:`)
      for (const item of val) {
        if (typeof item === 'object' && item !== null) {
          const pairs = Object.entries(item as Record<string, unknown>)
            .map(([k, v]) => `${k}: ${String(v)}`)
            .join(', ')
          lines.push(`  - ${pairs}`)
        } else {
          lines.push(`  - ${String(item)}`)
        }
      }
    } else if (typeof val === 'object' && val !== null) {
      const entries = Object.entries(val as Record<string, unknown>)
      const summary = entries.map(([k, v]) => `${k}: ${String(v)} (granted / authorized)`).join(', ')
      lines.push(`${key}: ${summary}`)
      if (typeof prop.description === 'string') {
        lines.push(...wrapText(`  (${prop.description})`, 78))
      }
    } else {
      lines.push(`${key}: ${String(val)}`)
    }
  }
  return lines
}

const escapePdfLiteral = (s: string): string =>
  sanitizeAscii(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')

const buildSimplePdf = (lines: { text: string; bold?: boolean; size?: number }[]): Uint8Array => {
  let y = 790
  const ops: string[] = ['BT']
  for (const line of lines) {
    const size = line.size ?? 11
    if (y < 40) break
    ops.push(`1 0 0 1 45 ${y} Tm /F${line.bold ? 2 : 1} ${size} Tf (${escapePdfLiteral(line.text)}) Tj`)
    y -= size + 6
  }
  ops.push('ET')
  const streamContent = ops.join('\n')

  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n',
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n',
    `6 0 obj\n<< /Length ${Buffer.byteLength(streamContent, 'ascii')} >>\nstream\n${streamContent}\nendstream\nendobj\n`
  ]

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = [0]
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'ascii'))
    pdf += obj
  }
  const xrefStart = Buffer.byteLength(pdf, 'ascii')
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]!).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
  return new Uint8Array(Buffer.from(pdf, 'ascii'))
}

const buildSimpleJpeg = (quantVal = 16): Uint8Array => {
  const soi = [0xff, 0xd8]
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]
  const dqt = [0xff, 0xdb, 0x00, 0x43, 0x00, ...Array(64).fill(quantVal)]
  const sof0 = [0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x40, 0x00, 0x40, 0x01, 0x01, 0x11, 0x00]
  const dhtDc = [0xff, 0xc4, 0x00, 0x14, 0x00, 0x01, ...Array(15).fill(0), 0x00]
  const dhtAc = [0xff, 0xc4, 0x00, 0x14, 0x10, 0x01, ...Array(15).fill(0), 0x00]
  const sos = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]
  const scanData = Array(16).fill(0x00)
  const eoi = [0xff, 0xd9]
  return new Uint8Array([...soi, ...app0, ...dqt, ...sof0, ...dhtDc, ...dhtAc, ...sos, ...scanData, ...eoi])
}

const generatePdfForAttachmentType = async (
  type: string,
  cfg: { description: string; schema: z.ZodType },
  outDir: string
): Promise<GeneratedFixture> => {
  const jsonSchema = z.toJSONSchema(cfg.schema, { io: 'output' }) as {
    properties?: Record<string, Record<string, unknown>>
  }
  const properties = jsonSchema.properties ?? {}
  const sampleObj: Record<string, unknown> = {}
  for (const [k, prop] of Object.entries(properties)) {
    sampleObj[k] = sampleValueFromJsonSchema(k, prop)
  }
  cfg.schema.parse(sampleObj)

  const pdfLines: { text: string; bold?: boolean; size?: number }[] = [
    { text: `OFFICIAL DOCUMENT - ${type.toUpperCase().replaceAll('_', ' ')}`, bold: true, size: 15 },
    { text: `Document Classification Type: ${type}`, bold: true, size: 12 },
    ...wrapText(`Document Description: ${cfg.description}`, 80).map((t) => ({ text: t, bold: false, size: 10 })),
    { text: 'EXTRACTED DOCUMENT FIELDS:', bold: true, size: 12 },
    ...formatSchemaLines(properties, sampleObj).flatMap((fieldLine) =>
      wrapText(fieldLine, 82).map((t) => ({ text: t, bold: false, size: 11 }))
    )
  ]

  const bytes = buildSimplePdf(pdfLines)
  const filename = `${type}.pdf`
  writeFileSync(join(outDir, filename), bytes)
  return {
    type,
    filename,
    mime: 'application/pdf',
    bytes,
    dataUrl: `data:application/pdf;base64,${Buffer.from(bytes).toString('base64')}`,
    schema: cfg.schema,
    expectedKeys: Object.keys(properties).sort()
  }
}

const generateOtherJpeg = async (outDir: string): Promise<GeneratedFixture> => {
  const bytes = buildSimpleJpeg(16)
  const filename = 'other.jpeg'
  writeFileSync(join(outDir, filename), bytes)
  return {
    type: 'other',
    filename,
    mime: 'image/jpeg',
    bytes,
    dataUrl: `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`,
    expectedKeys: []
  }
}

let tempDir = ''
let localServer: ServerType | null = null
const fixtures: GeneratedFixture[] = []
const uploadedRefs = new Map<string, string>()
let discoveredDomainRoutes: DiscoveredRouteItem[] = []
let testAuthUserId = ''
let testAuthCookie = ''
let initialEmailCookie = ''
let asyncTaskId = ''
let chatId1 = ''
let userErased = false

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const bearerHeaders = (extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${API_KEY}`,
  ...extra
})

const userHeaders = (extra: Record<string, string> = {}) => ({
  cookie: testAuthCookie,
  origin: BASE_URL,
  ...extra
})

const apiFetch = async (path: string, init: RequestInit = {}, label?: string): Promise<Response> => {
  const method = (init.method ?? 'GET').toUpperCase()
  const t0 = performance.now()
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(240_000)
  })
  const rttMs = performance.now() - t0
  const authHeader = res.headers.get('x-auth-time-ms')
  const authSuffix = authHeader !== null ? ` | auth: ${Number(authHeader).toFixed(3)}ms` : ''
  const tag = label ? `${method} ${path} (${label})` : `${method} ${path}`
  console.log(`[http] ${tag.padEnd(54)} -> ${res.status} | ${rttMs.toFixed(1).padStart(7)}ms${authSuffix}`)
  return res
}

const apiJson = async <T = unknown>(
  path: string,
  init: RequestInit = {},
  useBearer = false,
  label?: string
): Promise<{ status: number; data: T; headers: Headers }> => {
  const baseHeaders = useBearer ? bearerHeaders() : userHeaders()
  const res = await apiFetch(
    path,
    {
      ...init,
      headers: {
        ...baseHeaders,
        ...(init.headers as Record<string, string> | undefined)
      }
    },
    label
  )
  const text = await res.text()
  const data = (text ? JSON.parse(text) : null) as T
  return { status: res.status, data, headers: res.headers }
}

const mcpCall = async <T = unknown>(method: string, params: Record<string, unknown> = {}, id = 1): Promise<T> => {
  const label = params.name ? `mcp:${method}:${String(params.name)}` : `mcp:${method}`
  const res = await apiFetch(
    '/api/mcp',
    {
      method: 'POST',
      headers: userHeaders({
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      }),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
    },
    label
  )
  assert.equal(res.status, 200)
  const raw = await res.text()
  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.includes('text/event-stream')) {
    const dataLine = raw
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('data: '))
    if (!dataLine) throw new Error(`No SSE data line in MCP response: ${raw}`)
    const parsed = JSON.parse(dataLine.slice(6)) as { result?: T; error?: unknown }
    if (parsed.error) throw new Error(`MCP error: ${JSON.stringify(parsed.error)}`)
    return parsed.result as T
  }
  const parsed = JSON.parse(raw) as { result?: T; error?: unknown }
  if (parsed.error) throw new Error(`MCP error: ${JSON.stringify(parsed.error)}`)
  return parsed.result as T
}

const synthesizeDomainInput = (route: DiscoveredRouteItem): Record<string, unknown> => {
  const props = route.inputSchema?.properties ?? {}
  const payload: Record<string, unknown> = {}
  const sampleRefs = [
    uploadedRefs.get('title_deed') ?? [...uploadedRefs.values()][0]!,
    uploadedRefs.get('passport') ?? [...uploadedRefs.values()][1] ?? [...uploadedRefs.values()][0]!
  ]
  for (const [k, prop] of Object.entries(props)) {
    if (k === 'refs') {
      payload[k] = sampleRefs
    } else if (k === 'ref') {
      payload[k] = sampleRefs[0]
    } else {
      payload[k] = sampleValueFromJsonSchema(k, prop)
    }
  }
  return payload
}

before(async () => {
  if (!API_KEY || !WEB_API_KEY) {
    throw new Error('SDK_API_KEY and WEB_API_KEY are required from GCP Secret Manager')
  }

  tempDir = mkdtempSync(join(tmpdir(), 'ai-sdk-e2e-'))
  const pdfEntries = await Promise.all(
    Object.entries(ACTIVE_ATTACHMENT_TYPES).map(([type, cfg]) => generatePdfForAttachmentType(type, cfg, tempDir))
  )
  const otherJpeg = await generateOtherJpeg(tempDir)
  fixtures.push(...pdfEntries, otherJpeg)

  if (SPAWN_LOCAL) {
    localServer = serve({ fetch: devApp.fetch, port: PORT })
    let ready = false
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`${BASE_URL}/api/routes`, { headers: bearerHeaders() })
        if (res.ok) {
          ready = true
          break
        }
      } catch {}
      await sleep(250)
    }
    if (!ready) throw new Error('Local server failed to become ready in time')
  }

  const existingUsers = await core.auth.listUsers(true).catch(() => [])
  for (const u of existingUsers) {
    if (u.email?.endsWith('@test.local')) {
      await fetch(`${BASE_URL}/api/erase-user`, {
        method: 'POST',
        headers: bearerHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ userId: u.id, backupBeforeErase: false })
      }).catch(() => {})
    }
  }
})

after(async () => {
  if (!userErased && testAuthUserId) {
    await fetch(`${BASE_URL}/api/erase-user`, {
      method: 'POST',
      headers: bearerHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ userId: testAuthUserId, backupBeforeErase: false })
    }).catch(() => {})
  }
  if (localServer) {
    localServer.close()
  }
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

describe('1. Auth & RBAC (/api/auth/*, /api/routes)', () => {
  const testEmail = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`
  const testPassword = 'TestPassword123!'

  test('GET /api/health, GET /api/routes & GET /api/auth/session — health check (200) & reject unauthenticated (401)', async () => {
    const healthRes = await apiFetch('/api/health', {}, 'health')
    assert.equal(healthRes.status, 200)
    const healthData = (await healthRes.json()) as { ok: boolean; status: string; service: string }
    assert.equal(healthData.ok, true)
    assert.equal(healthData.status, 'healthy')
    assert.equal(healthData.service, CORE_CONFIG.appName)

    const unauthRoutesRes = await apiFetch('/api/routes', {}, 'unauth')
    assert.equal(unauthRoutesRes.status, 401)

    const badBearerRes = await apiFetch(
      '/api/routes',
      { headers: { authorization: 'Bearer invalid-token' } },
      'invalid-bearer'
    )
    assert.equal(badBearerRes.status, 401)

    const unauthSessionRes = await apiFetch('/api/auth/session', {}, 'unauth')
    assert.equal(unauthSessionRes.status, 401)
  })

  test('GET /api/auth/session & GET /api/routes — Admin Bearer cold & warm cache', async () => {
    const adminSessionRes = await apiFetch('/api/auth/session', { headers: bearerHeaders() }, 'admin-cold')
    assert.equal(adminSessionRes.status, 200)
    assert.notEqual(adminSessionRes.headers.get('x-auth-time-ms'), null)
    assert.ok((adminSessionRes.headers.get('server-timing') ?? '').includes('auth;dur='))
    assert.deepEqual(await adminSessionRes.json(), { userId: CORE_CONFIG.auth.adminUserId })

    const adminWarmRes = await apiFetch('/api/routes', { headers: bearerHeaders() }, 'admin-warm')
    assert.equal(adminWarmRes.status, 200)
    assert.ok(Number(adminWarmRes.headers.get('x-auth-time-ms')) < 5)
  })

  test('POST /api/auth/sign-up/email — create test user', async () => {
    const signUpRes = await apiFetch('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL },
      body: JSON.stringify({ email: testEmail, password: testPassword, name: 'E2E User' })
    })
    assert.equal(signUpRes.status, 200)
    const signedUpUser = (await signUpRes.json()) as { id: string; email: string; name: string }
    assert.equal(signedUpUser.email, testEmail)
    assert.equal(signedUpUser.name, 'E2E User')
    testAuthUserId = signedUpUser.id
  })

  test('POST /api/auth/sign-in/email — sign in with email & password', async () => {
    const signInRes = await apiFetch('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL },
      body: JSON.stringify({ email: testEmail, password: testPassword })
    })
    assert.equal(signInRes.status, 200)
    const signedInUser = (await signInRes.json()) as { id: string }
    assert.equal(signedInUser.id, testAuthUserId)
    const signInCookies = signInRes.headers.getSetCookie?.() ?? [signInRes.headers.get('set-cookie') ?? '']
    initialEmailCookie = signInCookies.map((c) => c.split(';')[0]).filter(Boolean).join('; ')
    assert.ok(initialEmailCookie.includes(`${core.internals.auth.sessionCookie}=`))
  })

  test('POST /api/auth/users/block — block user, verify 401 on session, then unblock', async () => {
    const blockRes = await apiJson<{ userId: string; blocked: boolean; deleted: boolean }>(
      '/api/auth/users/block',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: testAuthUserId, blocked: true })
      },
      true,
      'block'
    )
    assert.equal(blockRes.status, 200)
    assert.deepEqual(blockRes.data, { userId: testAuthUserId, blocked: true, deleted: true })

    const blockedSessionRes = await apiFetch(
      '/api/auth/session',
      { headers: { cookie: initialEmailCookie, origin: BASE_URL } },
      'blocked-cookie'
    )
    assert.equal(blockedSessionRes.status, 401)

    const unblockRes = await apiJson<{ userId: string; blocked: boolean; deleted: boolean }>(
      '/api/auth/users/block',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: testAuthUserId, blocked: false })
      },
      true,
      'unblock'
    )
    assert.equal(unblockRes.status, 200)
    assert.deepEqual(unblockRes.data, { userId: testAuthUserId, blocked: false, deleted: false })
  })

  test('POST /api/auth/custom-token, POST /api/auth/session & GET /api/auth/session — custom token RBAC, ID token & session cookie', async () => {
    const unauthCustomTokenRes = await apiFetch(
      '/api/auth/custom-token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ uid: testAuthUserId })
      },
      'unauth-custom-token'
    )
    assert.equal(unauthCustomTokenRes.status, 401)

    const nonAdminCustomTokenRes = await apiFetch(
      '/api/auth/custom-token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: initialEmailCookie, origin: BASE_URL },
        body: JSON.stringify({ uid: testAuthUserId })
      },
      'user-custom-token-403'
    )
    assert.equal(nonAdminCustomTokenRes.status, 403)

    const customTokenRes = await apiFetch('/api/auth/custom-token', {
      method: 'POST',
      headers: bearerHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ uid: testAuthUserId })
    })
    assert.equal(customTokenRes.status, 200)
    const { uid, customToken } = (await customTokenRes.json()) as { uid: string; customToken: string }
    assert.equal(uid, testAuthUserId)
    assert.ok(customToken.length > 20)

    const exchangeRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${WEB_API_KEY}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: customToken, returnSecureToken: true })
      }
    )
    assert.equal(exchangeRes.status, 200)
    const { idToken } = (await exchangeRes.json()) as { idToken: string }
    assert.ok(idToken.length > 20)

    const idTokenColdRes = await apiFetch(
      '/api/auth/session',
      { headers: { authorization: `Bearer ${idToken}` } },
      'id-token-cold'
    )
    assert.equal(idTokenColdRes.status, 200)
    assert.deepEqual(await idTokenColdRes.json(), { userId: testAuthUserId })

    const idTokenWarmRes = await apiFetch(
      '/api/files',
      { headers: { authorization: `Bearer ${idToken}` } },
      'id-token-warm'
    )
    assert.equal(idTokenWarmRes.status, 200)
    assert.ok(Number(idTokenWarmRes.headers.get('x-auth-time-ms')) < 5)

    const badSessionRes = await apiFetch(
      '/api/auth/session',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idToken: 'invalid-id-token' })
      },
      'invalid-id-token'
    )
    assert.equal(badSessionRes.status, 401)

    const sessionRes = await apiFetch(
      '/api/auth/session',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE_URL },
        body: JSON.stringify({ idToken })
      },
      'mint-cookie'
    )
    assert.equal(sessionRes.status, 200)
    const sessionUser = (await sessionRes.json()) as { id: string }
    assert.equal(sessionUser.id, testAuthUserId)

    const setCookies = sessionRes.headers.getSetCookie?.() ?? [sessionRes.headers.get('set-cookie') ?? '']
    testAuthCookie = setCookies.map((c) => c.split(';')[0]).filter(Boolean).join('; ')
    assert.ok(testAuthCookie.includes(`${core.internals.auth.sessionCookie}=`))

    const getSessionRes = await apiFetch('/api/auth/session', { headers: userHeaders() }, 'cookie-strict')
    assert.equal(getSessionRes.status, 200)
    assert.deepEqual(await getSessionRes.json(), { userId: testAuthUserId })
    assert.ok(Number(getSessionRes.headers.get('x-auth-time-ms')) < 5)

    const cookieWarmRes = await apiFetch('/api/files', { headers: userHeaders() }, 'cookie-warm')
    assert.equal(cookieWarmRes.status, 200)
    assert.ok(Number(cookieWarmRes.headers.get('x-auth-time-ms')) < 5)
  })

  test('GET /api/auth/users — enforce admin RBAC (403 for user, 200 for admin)', async () => {
    const nonAdminUsersRes = await apiFetch('/api/auth/users', { headers: userHeaders() }, 'user-rbac')
    assert.equal(nonAdminUsersRes.status, 403)

    const adminUsersRes = await apiFetch('/api/auth/users', { headers: bearerHeaders() }, 'admin-rbac')
    assert.equal(adminUsersRes.status, 200)
    const usersList = (await adminUsersRes.json()) as { id: string }[]
    assert.ok(usersList.some((u) => u.id === testAuthUserId))
  })

  test('Better-Auth Suite — Email Verification (SHA-256 OTP + 5-attempt limit), Social OAuth (Google/Apple), Recovery Email, Password Reset & Full Account Recovery', async () => {
    // 1. Send email verification & verify SHA-256 hash storage + 5-attempt brute-force invalidation
    const sendVerifyRes = await apiJson<{ sent: boolean; expiresInMinutes: number }>(
      '/api/auth/email/send-verification',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      },
      false,
      'send-verify-1'
    )
    assert.equal(sendVerifyRes.status, 200)
    assert.equal(sendVerifyRes.data.sent, true)

    const verifyPayload1 = core.internals.auth.getLastDevEmail(testEmail, 'verify_email')
    assert.ok(verifyPayload1, 'Expected dev email outbox to capture verify_email payload')
    assert.match(verifyPayload1.code, /^\d{6}$/)

    const rawTokenSnap = await core.db.firestore(true).collection('auth_tokens').doc(`${testAuthUserId}_verify_email`).get()
    assert.equal(rawTokenSnap.exists, true)
    const rawTokenData = rawTokenSnap.data()!
    assert.equal(rawTokenData.tokenHash, core.internals.auth.hashToken(verifyPayload1.code))
    assert.notEqual(rawTokenData.tokenHash, verifyPayload1.code)
    assert.equal('code' in rawTokenData, false)

    for (let attempt = 1; attempt <= 5; attempt++) {
      const badVerifyRes = await apiJson<{ code?: string }>(
        '/api/auth/email/verify',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: testEmail, codeOrToken: '000000' })
        },
        false,
        `bad-verify-${attempt}`
      )
      assert.equal(badVerifyRes.status, 400)
      if (attempt === 5) {
        assert.equal(badVerifyRes.data.code, 'TOKEN_MAX_ATTEMPTS_EXCEEDED')
      }
    }

    // Even the right code must now be rejected after 5 failed attempts
    const exhaustedRes = await apiFetch(
      '/api/auth/email/verify',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: testEmail, codeOrToken: verifyPayload1.code })
      },
      'exhausted-verify'
    )
    assert.equal(exhaustedRes.status, 400)

    // Re-issue verification OTP and verify with valid 6-digit code
    const resendVerifyRes = await apiJson<{ sent: boolean }>(
      '/api/auth/email/send-verification',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      },
      false,
      'send-verify-2'
    )
    assert.equal(resendVerifyRes.status, 200)
    const verifyPayload2 = core.internals.auth.getLastDevEmail(testEmail, 'verify_email')!

    const okVerifyRes = await apiJson<{ verified: boolean; userId: string }>(
      '/api/auth/email/verify',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: testEmail, codeOrToken: verifyPayload2.code })
      },
      false,
      'ok-verify'
    )
    assert.equal(okVerifyRes.status, 200)
    assert.equal(okVerifyRes.data.verified, true)
    assert.equal(okVerifyRes.data.userId, testAuthUserId)

    const verifiedUser = await core.auth.getUser(testAuthUserId)
    assert.equal(verifiedUser?.emailVerified, true)

    // 2. Social OAuth (Google & Apple) — OIDC signature verification, nonce check, account linking & Apple first-time name
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const pubJwk = { ...(publicKey.export({ format: 'jwk' }) as JsonWebKey), kid: 'test-oidc-key' }
    core.internals.auth.registerTestOidcPublicKey(pubJwk)

    const signTestJwt = (claims: Record<string, unknown>) => {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-oidc-key' })).toString(
        'base64url'
      )
      const payload = Buffer.from(
        JSON.stringify({
          iat: Math.floor(Date.now() / 1000) - 10,
          exp: Math.floor(Date.now() / 1000) + 3600,
          ...claims
        })
      ).toString('base64url')
      const sig = cryptoSign('RSA-SHA256', Buffer.from(`${header}.${payload}`, 'utf8'), privateKey).toString(
        'base64url'
      )
      return `${header}.${payload}.${sig}`
    }

    let appleCreatedUserId = ''
    try {
      // 2a. Google OAuth linking to existing verified email user
      const googleSub = `google_sub_${Date.now()}`
      const googleIdToken = signTestJwt({
        iss: 'https://accounts.google.com',
        sub: googleSub,
        aud: 'test-google-client',
        email: testEmail,
        email_verified: true,
        name: 'E2E User',
        picture: 'https://example.com/avatar.png'
      })

      const googleSignInRes = await apiFetch(
        '/api/auth/sign-in/social',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: BASE_URL },
          body: JSON.stringify({ provider: 'google', idToken: googleIdToken })
        },
        'social-google-link'
      )
      assert.equal(googleSignInRes.status, 200)
      const googleUser = (await googleSignInRes.json()) as {
        id: string
        email: string
        emailVerified: boolean
        linkedProviders?: { provider: string; providerUserId: string }[]
      }
      assert.equal(googleUser.id, testAuthUserId)
      assert.equal(googleUser.emailVerified, true)
      assert.ok(googleUser.linkedProviders?.some((p) => p.provider === 'google' && p.providerUserId === googleSub))

      // 2b. Apple OAuth with raw nonce + first-time Capacitor profile.name persistence
      const rawNonce = `nonce_${Date.now()}`
      const nonceSha256 = createHash('sha256').update(rawNonce).digest('hex')
      const appleSub = `apple_sub_${Date.now()}`
      const appleEmail = `apple-${Date.now()}@test.local`
      const appleIdToken = signTestJwt({
        iss: 'https://appleid.apple.com',
        sub: appleSub,
        aud: 'com.example.capacitor',
        email: appleEmail,
        email_verified: 'true',
        nonce: nonceSha256
      })

      // Nonce mismatch must fail with 401
      const badNonceRes = await apiFetch(
        '/api/auth/sign-in/social',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: BASE_URL },
          body: JSON.stringify({
            provider: 'apple',
            idToken: appleIdToken,
            nonce: 'wrong-nonce'
          })
        },
        'social-apple-bad-nonce'
      )
      assert.equal(badNonceRes.status, 401)

      const appleSignInRes = await apiFetch(
        '/api/auth/sign-in/social',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: BASE_URL },
          body: JSON.stringify({
            provider: 'apple',
            idToken: appleIdToken,
            nonce: rawNonce,
            profile: { name: 'Apple First-Auth Name' }
          })
        },
        'social-apple-first-auth'
      )
      assert.equal(appleSignInRes.status, 200)
      const appleUser = (await appleSignInRes.json()) as { id: string; name: string; email: string }
      appleCreatedUserId = appleUser.id
      assert.equal(appleUser.name, 'Apple First-Auth Name')
      assert.equal(appleUser.email, appleEmail)

      // Subsequent Apple sign-in (without profile.name or email in token) resolves by (provider, sub) and keeps name
      const appleSubsequentToken = signTestJwt({
        iss: 'https://appleid.apple.com',
        sub: appleSub,
        aud: 'com.example.capacitor'
      })
      const appleSubsequentRes = await apiFetch(
        '/api/auth/sign-in/social',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: BASE_URL },
          body: JSON.stringify({ provider: 'apple', idToken: appleSubsequentToken })
        },
        'social-apple-subsequent'
      )
      assert.equal(appleSubsequentRes.status, 200)
      const appleUser2 = (await appleSubsequentRes.json()) as { id: string; name: string }
      assert.equal(appleUser2.id, appleCreatedUserId)
      assert.equal(appleUser2.name, 'Apple First-Auth Name')
    } finally {
      core.internals.auth.registerTestOidcPublicKey(null)
      if (appleCreatedUserId) {
        await apiFetch(
          '/api/erase-user',
          {
            method: 'POST',
            headers: bearerHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ userId: appleCreatedUserId, backupBeforeErase: false })
          },
          'cleanup-apple-user'
        ).catch(() => {})
      }
    }

    // 3. Secondary Recovery Email Binding
    const recoveryEmail = `recovery-${Date.now()}@test.local`
    const sameEmailRes = await apiFetch(
      '/api/auth/recovery-email/set',
      {
        method: 'POST',
        headers: userHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ recoveryEmail: testEmail })
      },
      'recovery-same-as-primary'
    )
    assert.equal(sameEmailRes.status, 400)

    const setRecoveryRes = await apiJson<{
      recoveryEmail: string
      recoveryEmailVerified: boolean
      sent: boolean
    }>(
      '/api/auth/recovery-email/set',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recoveryEmail })
      },
      false,
      'set-recovery-email'
    )
    assert.equal(setRecoveryRes.status, 200)
    assert.equal(setRecoveryRes.data.recoveryEmail, recoveryEmail)
    assert.equal(setRecoveryRes.data.recoveryEmailVerified, false)

    const recoveryVerifyPayload = core.internals.auth.getLastDevEmail(recoveryEmail, 'verify_recovery_email')
    assert.ok(recoveryVerifyPayload)

    const verifyRecoveryRes = await apiJson<{
      recoveryEmail: string
      recoveryEmailVerified: boolean
      verified: boolean
    }>(
      '/api/auth/recovery-email/verify',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ codeOrToken: recoveryVerifyPayload.code })
      },
      false,
      'verify-recovery-email'
    )
    assert.equal(verifyRecoveryRes.status, 200)
    assert.equal(verifyRecoveryRes.data.recoveryEmailVerified, true)

    // 4. Password Forgot & Reset (with anti-enumeration & global session revocation)
    const unknownForgotRes = await apiJson<{ sent: boolean }>(
      '/api/auth/password/forgot',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'nonexistent-user@test.local' })
      },
      false,
      'forgot-nonexistent'
    )
    assert.equal(unknownForgotRes.status, 200)
    assert.equal(unknownForgotRes.data.sent, true)

    const forgotRes = await apiJson<{ sent: boolean }>(
      '/api/auth/password/forgot',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: testEmail })
      },
      false,
      'forgot-password'
    )
    assert.equal(forgotRes.status, 200)
    const resetPayload = core.internals.auth.getLastDevEmail(testEmail, 'reset_password')
    assert.ok(resetPayload)

    const resetPasswordVal = 'ResetPassword456!'
    const resetRes = await apiJson<{ reset: boolean }>(
      '/api/auth/password/reset',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: testEmail,
          codeOrToken: resetPayload.token,
          newPassword: resetPasswordVal
        })
      },
      false,
      'reset-password'
    )
    assert.equal(resetRes.status, 200)
    assert.equal(resetRes.data.reset, true)

    // Previous session cookie must be revoked after password reset
    const revokedAfterResetRes = await apiFetch(
      '/api/auth/session',
      { headers: { cookie: testAuthCookie, origin: BASE_URL } },
      'session-revoked-after-reset'
    )
    assert.equal(revokedAfterResetRes.status, 401)

    // 5. Full Account Recovery via Verified Secondary Recovery Email
    const initiateRecoveryRes = await apiJson<{ initiated: boolean }>(
      '/api/auth/account-recovery/initiate',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ primaryEmail: testEmail, recoveryEmail })
      },
      false,
      'initiate-account-recovery'
    )
    assert.equal(initiateRecoveryRes.status, 200)
    assert.equal(initiateRecoveryRes.data.initiated, true)

    const accountRecoveryPayload = core.internals.auth.getLastDevEmail(recoveryEmail, 'account_recovery')
    assert.ok(accountRecoveryPayload)

    const recoveredPrimaryEmail = `recovered-${Date.now()}@test.local`
    const completeRecoveryRes = await apiFetch(
      '/api/auth/account-recovery/complete',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE_URL },
        body: JSON.stringify({
          primaryEmail: testEmail,
          recoveryEmail,
          codeOrToken: accountRecoveryPayload.code,
          newPrimaryEmail: recoveredPrimaryEmail,
          newPassword: testPassword
        })
      },
      'complete-account-recovery'
    )
    assert.equal(completeRecoveryRes.status, 200)
    const recoveredUser = (await completeRecoveryRes.json()) as {
      id: string
      email: string
      emailVerified: boolean
    }
    assert.equal(recoveredUser.id, testAuthUserId)
    assert.equal(recoveredUser.email, recoveredPrimaryEmail)
    assert.equal(recoveredUser.emailVerified, true)

    const recoveryCookies =
      completeRecoveryRes.headers.getSetCookie?.() ?? [completeRecoveryRes.headers.get('set-cookie') ?? '']
    testAuthCookie = recoveryCookies.map((c) => c.split(';')[0]).filter(Boolean).join('; ')
    assert.ok(testAuthCookie.includes(`${core.internals.auth.sessionCookie}=`))

    const postRecoverySessionRes = await apiFetch(
      '/api/auth/session',
      { headers: userHeaders() },
      'post-recovery-session'
    )
    assert.equal(postRecoverySessionRes.status, 200)
  })
})

describe('2. Files CRUD (/api/files, /api/files/:ref)', () => {
  test('POST /api/files & GET /api/files/:ref — validation (400), missing (404) & cross-tenant guard (403)', async () => {
    const badForm = new FormData()
    badForm.append('other', 'not-a-file')
    const badRes = await apiFetch('/api/files', { method: 'POST', headers: userHeaders(), body: badForm }, 'missing-file')
    assert.equal(badRes.status, 400)

    const badMimeForm = new FormData()
    badMimeForm.append('file', new File([new TextEncoder().encode('hello')], 'note.txt', { type: 'text/plain' }))
    const badMimeRes = await apiFetch(
      '/api/files',
      { method: 'POST', headers: userHeaders(), body: badMimeForm },
      'bad-mime'
    )
    assert.equal(badMimeRes.status, 400)

    const missingFileRes = await apiFetch(
      `/api/files/${testAuthUserId}_000000000000000000000000`,
      { headers: userHeaders() },
      'missing-ref'
    )
    assert.equal(missingFileRes.status, 404)

    const crossTenantRes = await apiFetch(
      '/api/files/otheruser_000000000000000000000000',
      { headers: userHeaders() },
      'cross-tenant'
    )
    assert.equal(crossTenantRes.status, 403)
  })

  test('POST /api/files, GET /api/files/:ref & GET /api/files/:ref?meta=true — upload, download & metadata across all fixtures', async () => {
    await Promise.all(
      fixtures.map(async (fixture) => {
        const form = new FormData()
        form.append('file', new File([Buffer.from(fixture.bytes)], fixture.filename, { type: fixture.mime }))
        const res = await apiFetch(
          '/api/files',
          { method: 'POST', headers: userHeaders(), body: form },
          fixture.filename
        )
        assert.equal(res.status, 200)
        const { ref } = (await res.json()) as { ref: string }
        assert.match(ref, new RegExp(`^${testAuthUserId}_[a-f0-9]{24}$`))
        uploadedRefs.set(fixture.type, ref)

        const getRes = await apiFetch(`/api/files/${ref}`, { headers: userHeaders() }, fixture.type)
        assert.equal(getRes.status, 200)
        assert.equal(getRes.headers.get('content-type'), fixture.mime)
        assert.ok((getRes.headers.get('cache-control') ?? '').includes('immutable'))
        const downloaded = new Uint8Array(await getRes.arrayBuffer())
        assert.equal(downloaded.byteLength, fixture.bytes.byteLength)

        const metaRes = await apiFetch(`/api/files/${ref}?meta=true`, { headers: userHeaders() }, `${fixture.type}:meta`)
        assert.equal(metaRes.status, 200)
        const meta = (await metaRes.json()) as { id: string; fileName: string; deleted: boolean; userId: string }
        assert.equal(meta.id, ref)
        assert.equal(meta.userId, testAuthUserId)
        assert.equal(meta.deleted, false)
      })
    )

    const sampleRef = uploadedRefs.get(fixtures[0]!.type)!
    const signedRes = await apiFetch(`/api/files/${sampleRef}?signed=true`, { headers: userHeaders() }, 'signed-download')
    assert.equal(signedRes.status, 200)
    const signedData = (await signedRes.json()) as { ref: string; url: string; expiresAt: string }
    assert.equal(signedData.ref, sampleRef)
    assert.ok(signedData.url.startsWith('https://storage.googleapis.com/'))
    assert.ok(Date.parse(signedData.expiresAt) > Date.now())

    const userCore = new Core({ env: ENV, userId: testAuthUserId, role: 'user' })
    const signedUp = await userCore.files.getSignedUploadUrl({
      name: 'direct-upload.pdf',
      type: 'application/pdf',
      sha256: 'a'.repeat(64)
    })
    assert.equal(signedUp.ref, `${testAuthUserId}_${'a'.repeat(24)}`)
    assert.equal(signedUp.deduplicated, false)
    assert.ok(signedUp.url.startsWith('https://storage.googleapis.com/'))
    assert.ok(Date.parse(signedUp.expiresAt) > Date.now())
  })

  test('GET /api/files & POST /api/files — list files & verify SHA-256 deduplication', async () => {
    const listFilesRes = await apiFetch('/api/files', { headers: userHeaders() })
    assert.equal(listFilesRes.status, 200)
    const listedFiles = (await listFilesRes.json()) as { id: string }[]
    assert.ok(listedFiles.length >= fixtures.length)

    const firstFixture = fixtures[0]!
    const dupForm = new FormData()
    dupForm.append('file', new File([Buffer.from(firstFixture.bytes)], firstFixture.filename, { type: firstFixture.mime }))
    const dupRes = await apiFetch('/api/files', { method: 'POST', headers: userHeaders(), body: dupForm }, 'dedupe')
    assert.equal(dupRes.status, 200)
    const { ref: dupRef } = (await dupRes.json()) as { ref: string }
    assert.equal(dupRef, uploadedRefs.get(firstFixture.type)!)
  })

  test('DELETE /api/files/:ref & POST /api/files — soft-delete file, verify 404 & restore on re-upload', async () => {
    const tempBytes = buildSimpleJpeg(24)
    const tempForm = new FormData()
    tempForm.append('file', new File([Buffer.from(tempBytes)], 'disposable.jpeg', { type: 'image/jpeg' }))
    const tempUp = await apiFetch('/api/files', { method: 'POST', headers: userHeaders(), body: tempForm }, 'disposable')
    assert.equal(tempUp.status, 200)
    const { ref: disposableRef } = (await tempUp.json()) as { ref: string }

    const delRes = await apiFetch(`/api/files/${disposableRef}`, { method: 'DELETE', headers: userHeaders() }, 'soft-del')
    assert.equal(delRes.status, 200)
    assert.deepEqual(await delRes.json(), { ref: disposableRef, deleted: true })

    const afterDelRes = await apiFetch(`/api/files/${disposableRef}`, { headers: userHeaders() }, 'after-del')
    assert.equal(afterDelRes.status, 404)

    const restoreForm = new FormData()
    restoreForm.append('file', new File([Buffer.from(tempBytes)], 'disposable.jpeg', { type: 'image/jpeg' }))
    const restoreRes = await apiFetch(
      '/api/files',
      { method: 'POST', headers: userHeaders(), body: restoreForm },
      'restore'
    )
    assert.equal(restoreRes.status, 200)
    const afterRestoreRes = await apiFetch(`/api/files/${disposableRef}`, { headers: userHeaders() }, 'after-restore')
    assert.equal(afterRestoreRes.status, 200)
    await apiFetch(`/api/files/${disposableRef}`, { method: 'DELETE', headers: userHeaders() }, 'cleanup-disposable')
  })
})

describe('3. Route Catalog & Attachment Scanning (/api/routes, /api/scan-attachment)', () => {
  test('GET /api/routes & GET /api/routes?format=md — verify all core/domain routes & deterministic API_CONTRACT.md introspection', async () => {
    const catalogRes = await apiJson<RoutesIntrospectionResponse | DiscoveredRouteItem[]>('/api/routes', {}, true)
    assert.equal(catalogRes.status, 200)

    const routeList: DiscoveredRouteItem[] = Array.isArray(catalogRes.data)
      ? catalogRes.data
      : (catalogRes.data.routes as DiscoveredRouteItem[])
    if (!Array.isArray(catalogRes.data)) {
      assert.equal(catalogRes.data.appName, CORE_CONFIG.appName)
      assert.ok(catalogRes.data.collections && 'chat' in catalogRes.data.collections)
      assert.ok('user_auth_meta' in catalogRes.data.collections!)
      assert.ok('auth_tokens' in catalogRes.data.collections!)
      assert.ok('email_log' in catalogRes.data.collections!)
      assert.ok('email_suppression' in catalogRes.data.collections!)
    }

    const registeredIds = new Set(routeList.map((r) => r.id))
    for (const coreId of Object.keys(core.internals.context.routeDefaults)) {
      assert.ok(registeredIds.has(coreId), `Expected core route ${coreId} in GET /api/routes`)
    }

    discoveredDomainRoutes = routeList.filter((r) => !(r.id in core.internals.context.routeDefaults))
    assert.equal(discoveredDomainRoutes.length, Object.keys(customRoutes).length)

    // Verify deterministic Markdown rendering (GET /api/routes?format=md)
    const mdRes = await apiFetch('/api/routes?format=md', { headers: bearerHeaders() }, 'routes-md')
    assert.equal(mdRes.status, 200)
    assert.ok((mdRes.headers.get('content-type') ?? '').includes('text/markdown'))
    const mdText = await mdRes.text()
    assert.ok(mdText.includes(`# API Contract & Schema Reference — ${CORE_CONFIG.appName}`))
    assert.ok(mdText.includes('POST /api/auth/sign-in/social'))
    assert.ok(mdText.includes('POST /api/auth/email/send-verification'))
    assert.ok(mdText.includes('POST /api/auth/email/verify'))
    assert.ok(mdText.includes('POST /api/auth/password/forgot'))
    assert.ok(mdText.includes('POST /api/auth/password/reset'))
    assert.ok(mdText.includes('POST /api/auth/recovery-email/set'))
    assert.ok(mdText.includes('POST /api/auth/recovery-email/verify'))
    assert.ok(mdText.includes('POST /api/auth/account-recovery/initiate'))
    assert.ok(mdText.includes('POST /api/auth/account-recovery/complete'))
    assert.ok(mdText.includes('POST /api/emails/send'))
    assert.ok(mdText.includes('POST /api/emails/batch'))
    assert.ok(mdText.includes('GET /api/emails/logs'))
    assert.ok(mdText.includes('POST /api/emails/webhooks/:provider'))
  })

  test('POST /api/scan-attachment — OCR, classify & extract structured fields for 1 single attachment', async () => {
    const singleFixture = fixtures[0]!
    const ref = uploadedRefs.get(singleFixture.type)!
    const { status, data: scan } = await apiJson<{
      type: string
      confidence: number
      fields: Record<string, unknown>
      markdown: string
    }>(
      '/api/scan-attachment',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ref })
      },
      false,
      singleFixture.type
    )
    assert.equal(status, 200)
    assert.equal(scan.type, singleFixture.type)
    assert.ok(scan.confidence > 0)
    assert.ok(scan.markdown.length > 0)
    assert.deepEqual(Object.keys(scan.fields).sort(), singleFixture.expectedKeys)
    if (singleFixture.schema) {
      assert.equal(singleFixture.schema.safeParse(scan.fields).success, true)
    }
  })

  test('POST /api/scan-attachment — verify Firestore scan cache short-circuit & negative caching (scanError)', async () => {
    const sampleFixture = fixtures[0]!
    const sampleRef = uploadedRefs.get(sampleFixture.type)!
    const cachedRes = await apiJson<{ type: string; fields: Record<string, unknown>; markdown: string }>(
      '/api/scan-attachment',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ref: sampleRef })
      },
      false,
      'cached'
    )
    assert.equal(cachedRes.status, 200)
    assert.equal(cachedRes.data.type, sampleFixture.type)
    assert.deepEqual(Object.keys(cachedRes.data.fields).sort(), sampleFixture.expectedKeys)

    const corruptedBytes = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\n%%EOF-CORRUPTED')
    const badForm = new FormData()
    badForm.append('file', new File([Buffer.from(corruptedBytes)], 'corrupted.pdf', { type: 'application/pdf' }))
    const upBadRes = await apiFetch('/api/files', { method: 'POST', headers: userHeaders(), body: badForm }, 'corrupted-pdf')
    assert.equal(upBadRes.status, 200)
    const { ref: corruptedRef } = (await upBadRes.json()) as { ref: string }

    const scanBadRes = await apiJson<{ error: string; code: string }>(
      '/api/scan-attachment',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ref: corruptedRef })
      },
      false,
      'scan-corrupted'
    )
    assert.equal(scanBadRes.status, 400)
    assert.ok(scanBadRes.data.error.length > 10)

    const badMetaRes = await apiJson<{
      id: string
      scanError?: { status: string; reason: string; agentHint: string }
    }>(`/api/files/${corruptedRef}?meta=true`, {}, false, 'corrupted-meta')
    assert.equal(badMetaRes.status, 200)
    assert.equal(badMetaRes.data.scanError?.status, 'unparseable')
    assert.ok((badMetaRes.data.scanError?.agentHint ?? '').length > 10)

    const t0 = performance.now()
    const shortCircuitBatch = await apiJson<{
      attachments: { ref: string; scan?: { type: string }; error?: string }[]
    }>(
      '/api/process-attachments',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refs: [sampleRef, corruptedRef] })
      },
      false,
      'negative-cache-short-circuit'
    )
    const elapsedMs = performance.now() - t0
    assert.equal(shortCircuitBatch.status, 200)
    assert.equal(shortCircuitBatch.data.attachments[0]?.scan?.type, sampleFixture.type)
    assert.equal(shortCircuitBatch.data.attachments[1]?.error, badMetaRes.data.scanError?.agentHint)
    assert.ok(elapsedMs < 1500)

    await apiFetch(`/api/files/${corruptedRef}`, { method: 'DELETE', headers: userHeaders() }, 'cleanup-corrupted')
  })
})

describe('4. Batch Attachment Processing & Async Task Lifecycle (/api/process-attachments, /api/tasks/:taskId)', () => {
  test('POST /api/process-attachments — 20-shard parallel fan-out across all attachment types + other.jpeg', async () => {
    const allRefs = fixtures.map((f) => uploadedRefs.get(f.type)!)
    assert.equal(allRefs.length, Object.keys(ACTIVE_ATTACHMENT_TYPES).length + 1)

    const procRes = await apiJson<{
      attachments: {
        ref: string
        scan?: { type: string; confidence: number; fields: Record<string, unknown>; markdown: string }
        error?: string
      }[]
    }>(
      '/api/process-attachments',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refs: allRefs })
      },
      false,
      `all-${allRefs.length}-attachments`
    )
    assert.equal(procRes.status, 200)
    assert.equal(procRes.data.attachments.length, allRefs.length)
    procRes.data.attachments.forEach((item, idx) => {
      const fixture = fixtures[idx]!
      assert.equal(item.ref, allRefs[idx]!)
      assert.equal(item.error, undefined)
      assert.ok(item.scan)
      assert.equal(item.scan.type, fixture.type)
      assert.ok(item.scan.confidence > 0)
      assert.ok(item.scan.markdown.length > 0)
      assert.deepEqual(Object.keys(item.scan.fields).sort(), fixture.expectedKeys)
      if (fixture.schema) {
        assert.equal(fixture.schema.safeParse(item.scan.fields).success, true)
      }
    })
  })

  test('POST /api/process-attachments — partial error isolation with missing ref', async () => {
    const firstRef = uploadedRefs.get(fixtures[0]!.type)!
    const missingRef = `${testAuthUserId}_000000000000000000000000`
    const partialErrRes = await apiJson<{
      attachments: { ref: string; scan?: { type: string }; error?: string }[]
    }>(
      '/api/process-attachments',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refs: [firstRef, missingRef] })
      },
      false,
      'partial-error'
    )
    assert.equal(partialErrRes.status, 200)
    assert.equal(partialErrRes.data.attachments[0]?.scan?.type, fixtures[0]!.type)
    assert.equal(typeof partialErrRes.data.attachments[1]?.error, 'string')
  })

  test('POST /api/process-attachments?async=true — async dispatch (202 Accepted)', async () => {
    const allRefs = fixtures.map((f) => uploadedRefs.get(f.type)!)
    const asyncRes = await apiJson<{ taskId: string; status: string; pollUrl: string }>(
      '/api/process-attachments?async=true',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', prefer: 'respond-async' },
        body: JSON.stringify({ refs: allRefs.slice(0, 2) })
      },
      false,
      'respond-async'
    )
    assert.equal(asyncRes.status, 202)
    assert.equal(asyncRes.headers.get('preference-applied'), 'respond-async')
    assert.ok(asyncRes.data.taskId.length > 5)
    assert.equal(asyncRes.data.pollUrl, `/api/tasks/${asyncRes.data.taskId}`)
    asyncTaskId = asyncRes.data.taskId
  })

  test('POST /api/tasks/:taskId/signal — send signal to task', async () => {
    const sigRes = await apiJson<{ taskId: string; signaled: boolean }>(
      `/api/tasks/${asyncTaskId}/signal`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ signal: 'ping', payload: { ok: true } })
      },
      false,
      'signal'
    )
    assert.equal(sigRes.status, 200)
    assert.deepEqual(sigRes.data, { taskId: asyncTaskId, signaled: true })
  })

  test('GET /api/tasks/:taskId?envelope=true — poll task status until completed', async () => {
    let taskCompleted = false
    for (let i = 0; i < 40; i++) {
      const pollRes = await apiJson<{ status?: string; response?: { attachments: unknown[] } }>(
        `/api/tasks/${asyncTaskId}?envelope=true`,
        {},
        false,
        `poll-${i + 1}`
      )
      if (pollRes.status === 200 && pollRes.data.status === 'completed') {
        assert.equal(pollRes.data.response?.attachments.length, 2)
        taskCompleted = true
        break
      }
      await sleep(100)
    }
    assert.equal(taskCompleted, true)
  })

  test('DELETE /api/tasks/:taskId — cancel task endpoint', async () => {
    const cancelRes = await apiJson<{ taskId: string; status: string }>(
      `/api/tasks/${asyncTaskId}`,
      { method: 'DELETE' },
      false,
      'cancel'
    )
    assert.equal(cancelRes.status, 200)
    assert.deepEqual(cancelRes.data, { taskId: asyncTaskId, status: 'cancelled' })
  })
})

describe('5. Dynamic Custom Domain Endpoints (/api/*)', () => {
  test('Verify & execute all dynamically discovered custom domain routes (401 auth, 403 guard & 200 schema-validated execution)', async () => {
    assert.ok(discoveredDomainRoutes.length > 0, 'Expected at least 1 custom domain route from GET /api/routes')

    for (const route of discoveredDomainRoutes) {
      const localCfg = (customRoutes as Record<string, RouteConfig>)[route.id]
      assert.ok(localCfg, `Discovered route ${route.id} should exist in @config/routes`)
      assert.ok(route.path.startsWith('/api/'))

      if (localCfg.auth !== 'public' && localCfg.auth !== 'none' && localCfg.auth !== false) {
        const unauthRes = await apiFetch(route.path, { method: route.method }, `${route.id}:unauth`)
        assert.equal(unauthRes.status, 401)
      }

      const props = route.inputSchema?.properties ?? {}
      if ('refs' in props || 'ref' in props) {
        const badPayload =
          'refs' in props
            ? { refs: ['otheruser_000000000000000000000000'] }
            : { ref: 'otheruser_000000000000000000000000' }
        const guardRes = await apiJson<{ error: string; code: string; status: number }>(
          route.path,
          {
            method: route.method,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(badPayload)
          },
          false,
          `${route.id}:guard`
        )
        assert.equal(guardRes.status, 403)
        assert.equal(guardRes.data.code, 'FORBIDDEN')
      }

      const validPayload = synthesizeDomainInput(route)
      const execRes = await apiJson<unknown>(
        route.path,
        {
          method: route.method,
          headers: { 'content-type': 'application/json' },
          ...(route.method !== 'GET' ? { body: JSON.stringify(validPayload) } : {})
        },
        false,
        `${route.id}:exec`
      )
      assert.equal(execRes.status, 200, `Custom domain route ${route.method} ${route.path} failed`)
      if (localCfg.output) {
        const parsed = localCfg.output.safeParse(execRes.data)
        assert.equal(parsed.success, true, `Output validation failed for ${route.id}`)
      }
    }
  })
})

describe('6. MCP Server (/api/mcp Streamable HTTP JSON-RPC)', () => {
  let toolNames = new Set<string>()

  test('POST /api/mcp (initialize & tools/list) — handshake & tool discovery', async () => {
    const initResult = await mcpCall<{
      serverInfo: { name: string; version: string }
      capabilities: { tools?: Record<string, unknown> }
    }>('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'ai-sdk-e2e', version: '1.0.0' }
    })
    assert.equal(initResult.serverInfo.name, CORE_CONFIG.appName)
    assert.notEqual(initResult.capabilities.tools, undefined)

    const toolsList = await mcpCall<{ tools: { name: string; description: string; inputSchema: unknown }[] }>(
      'tools/list'
    )
    toolNames = new Set(toolsList.tools.map((t) => t.name))
    assert.ok(toolNames.has('scan-attachment'))
    assert.ok(toolNames.has('process-attachments'))
  })

  test('POST /api/mcp (tools/call) — execute scan-attachment & process-attachments', async () => {
    const targetFixture = fixtures[0]!
    const targetRef = uploadedRefs.get(targetFixture.type)!
    const mcpScan = await mcpCall<{ content: { type: string; text: string }[]; isError?: boolean }>('tools/call', {
      name: 'scan-attachment',
      arguments: { ref: targetRef }
    })
    assert.equal(mcpScan.isError, undefined)
    const mcpScanOut = JSON.parse(mcpScan.content[0]!.text) as { type: string }
    assert.equal(mcpScanOut.type, targetFixture.type)

    const mcpProc = await mcpCall<{ content: { type: string; text: string }[]; isError?: boolean }>('tools/call', {
      name: 'process-attachments',
      arguments: { refs: [targetRef, uploadedRefs.get('other')!] }
    })
    assert.equal(mcpProc.isError, undefined)
    const mcpProcOut = JSON.parse(mcpProc.content[0]!.text) as { attachments: { ref: string }[] }
    assert.equal(mcpProcOut.attachments.length, 2)
  })

  test('POST /api/mcp (tools/call) — dynamically execute all custom domain MCP tools', async () => {
    for (const route of discoveredDomainRoutes) {
      const localCfg = (customRoutes as Record<string, RouteConfig>)[route.id]
      if (!localCfg?.mcp) continue
      const toolName = route.workflowName ?? route.id
      assert.ok(toolNames.has(toolName), `Expected custom domain MCP tool ${toolName} in tools/list`)

      const mcpDomainRes = await mcpCall<{ content: { type: string; text: string }[]; isError?: boolean }>(
        'tools/call',
        {
          name: toolName,
          arguments: synthesizeDomainInput(route)
        }
      )
      assert.equal(mcpDomainRes.isError, undefined)
      const parsedOut = JSON.parse(mcpDomainRes.content[0]!.text)
      if (localCfg.output) {
        assert.equal(localCfg.output.safeParse(parsedOut).success, true)
      }
    }
  })
})

describe('7. Chat Streaming & Chat CRUD (/api/chats/:chatId, /api/chats)', () => {
  test('POST /api/chats/:chatId & validation — reject unknown agent (404), legacy messages array (400), empty message (400) & bad data URL (400)', async () => {
    const tempChatId = `chat_${Date.now().toString(36)}`
    const unknownRes = await apiFetch(`/api/chats/${tempChatId}`, {
      method: 'POST',
      headers: userHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        agentId: 'unknown-agent',
        message: { role: 'user', content: 'Hello' }
      })
    })
    assert.equal(unknownRes.status, 404)

    const legacyArrayRes = await apiFetch(`/api/chats/${tempChatId}`, {
      method: 'POST',
      headers: userHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Legacy history array must be rejected' }]
      })
    })
    assert.equal(legacyArrayRes.status, 400)

    const emptyMsgRes = await apiFetch(`/api/chats/${tempChatId}`, {
      method: 'POST',
      headers: userHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        message: { role: 'user', content: '   ' }
      })
    })
    assert.equal(emptyMsgRes.status, 400)

    const badDataUrlRes = await apiFetch(`/api/chats/${tempChatId}`, {
      method: 'POST',
      headers: userHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        message: {
          role: 'user',
          parts: [
            { type: 'text', text: 'Check this file' },
            {
              type: 'file',
              mediaType: 'text/plain',
              filename: 'bad.txt',
              url: 'data:text/plain;base64,SGVsbG8='
            }
          ]
        }
      })
    })
    assert.equal(badDataUrlRes.status, 400)
  })

  test('POST /api/chats/:chatId — stream single-attachment chat & auto-persist to subcollection', async () => {
    const pdfFixture = fixtures[0]!
    const targetChatId = `chat_${Date.now().toString(36)}_1`
    const singleChatRes = await apiFetch(
      `/api/chats/${targetChatId}`,
      {
        method: 'POST',
        headers: userHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          agentId: DEFAULT_AGENT_ID,
          message: {
            role: 'user',
            parts: [
              { type: 'text', text: 'What type of document is attached? Reply briefly in one sentence.' },
              {
                type: 'file',
                mediaType: pdfFixture.mime,
                filename: pdfFixture.filename,
                url: pdfFixture.dataUrl
              }
            ]
          }
        }),
        signal: AbortSignal.timeout(180_000)
      },
      'single-attachment'
    )
    assert.equal(singleChatRes.status, 200)
    assert.ok((singleChatRes.headers.get('content-type') ?? '').includes('text/event-stream'))
    chatId1 = singleChatRes.headers.get('x-chat-id') ?? ''
    assert.equal(chatId1, targetChatId)
    const singleStreamText = await singleChatRes.text()
    assert.ok(singleStreamText.includes('data: '))
    assert.ok(singleStreamText.length > 20)
    await sleep(600)
  })

  test('GET /api/chats/:chatId, GET /api/chats/:chatId/messages & GET /api/chats — read metadata & subcollection messages', async () => {
    const getChat1 = await apiJson<{
      id: string
      title: string
      agentId: string
      model: string
      messageCount: number
      activeGenerationId: string | null
      messages?: unknown
      deleted: boolean
      userId: string
    }>(`/api/chats/${chatId1}`)
    assert.equal(getChat1.status, 200)
    assert.equal(getChat1.data.id, chatId1)
    assert.equal(getChat1.data.userId, testAuthUserId)
    assert.equal(getChat1.data.deleted, false)
    assert.equal(getChat1.data.messages, undefined)
    assert.equal(getChat1.data.messageCount, 2)
    assert.equal(getChat1.data.activeGenerationId, null)

    const getMessages1 = await apiJson<
      {
        id: string
        chatId: string
        userId: string
        role: string
        content: string
        parts: unknown[]
        embedding?: unknown
      }[]
    >(`/api/chats/${chatId1}/messages`)
    assert.equal(getMessages1.status, 200)
    assert.equal(getMessages1.data.length, 2)
    assert.equal(getMessages1.data[0]?.role, 'user')
    assert.equal(getMessages1.data[1]?.role, 'assistant')
    assert.equal(getMessages1.data[0]?.embedding, undefined)
    assert.equal(getMessages1.data[1]?.embedding, undefined)
    assert.ok((getMessages1.data[1]?.content ?? '').length > 0)

    const listChatsRes = await apiJson<{ id: string; messageCount: number }[]>('/api/chats')
    assert.equal(listChatsRes.status, 200)
    assert.ok(listChatsRes.data.some((c) => c.id === chatId1 && c.messageCount === 2))
  })

  test('POST /api/chats & POST /api/chats/:chatId/cancel — rename chat metadata & cancel endpoint', async () => {
    const updateChatRes = await apiJson<{ id: string; title: string }>('/api/chats', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: chatId1, title: 'Renamed E2E Chat' })
    })
    assert.equal(updateChatRes.status, 200)
    assert.equal(updateChatRes.data.title, 'Renamed E2E Chat')

    const cancelChatRes = await apiJson<{ chatId: string; cancelled: boolean }>(
      `/api/chats/${chatId1}/cancel`,
      { method: 'POST' },
      false,
      'cancel-chat'
    )
    assert.equal(cancelChatRes.status, 200)
    assert.deepEqual(cancelChatRes.data, { chatId: chatId1, cancelled: true })
  })

  test('DELETE /api/chats/:chatId — soft-delete chat & verify 404', async () => {
    const delChatRes = await apiJson<{ id: string; deleted: boolean }>(`/api/chats/${chatId1}`, {
      method: 'DELETE'
    })
    assert.equal(delChatRes.status, 200)
    assert.deepEqual(delChatRes.data, { id: chatId1, deleted: true })

    const getDeletedChat = await apiFetch(`/api/chats/${chatId1}`, { headers: userHeaders() }, 'deleted-chat')
    assert.equal(getDeletedChat.status, 404)
  })

  test('POST /api/chats/:chatId — stream multi-attachment chat (inline dataUrl + /api/files/:ref)', async () => {
    const secondPdf = fixtures[1]!
    const otherFixture = fixtures.find((f) => f.type === 'other')!
    const existingRef = uploadedRefs.get(otherFixture.type)!
    const multiChatId = `chat_${Date.now().toString(36)}_2`
    const multiChatRes = await apiFetch(
      `/api/chats/${multiChatId}`,
      {
        method: 'POST',
        headers: userHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          agentId: DEFAULT_AGENT_ID,
          message: {
            role: 'user',
            parts: [
              { type: 'text', text: 'How many attachments did I include? Reply in one short sentence.' },
              {
                type: 'file',
                mediaType: secondPdf.mime,
                filename: secondPdf.filename,
                url: secondPdf.dataUrl
              },
              {
                type: 'file',
                mediaType: otherFixture.mime,
                filename: otherFixture.filename,
                url: `/api/files/${existingRef}`
              }
            ]
          }
        }),
        signal: AbortSignal.timeout(180_000)
      },
      'multi-attachment'
    )
    assert.equal(multiChatRes.status, 200)
    assert.ok((multiChatRes.headers.get('content-type') ?? '').includes('text/event-stream'))
    const multiStreamText = await multiChatRes.text()
    assert.ok(multiStreamText.includes('data: '))
    assert.ok(multiStreamText.length > 20)
    await sleep(600)
  })
})

describe('8. OpenAI-Compatible Endpoints (/api/v1/models, /api/v1/chat/completions)', () => {
  test('GET /api/v1/models — list registered agent models', async () => {
    const modelsRes = await apiJson<{ object: string; data: { id: string; object: string; owned_by: string }[] }>(
      '/api/v1/models'
    )
    assert.equal(modelsRes.status, 200)
    assert.equal(modelsRes.data.object, 'list')
    for (const agentId of AGENT_IDS) {
      assert.ok(modelsRes.data.data.some((m) => m.id === agentId && m.object === 'model'))
    }

    const badCompletionRes = await apiFetch('/api/v1/chat/completions', {
      method: 'POST',
      headers: userHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ model: DEFAULT_AGENT_ID, messages: [] })
    })
    assert.equal(badCompletionRes.status, 400)
  })

  test('POST /api/v1/chat/completions (stream: false) — non-streaming completion with attached PDF', async () => {
    const pdfFixture = fixtures[0]!
    const completionRes = await apiJson<{
      id: string
      object: string
      model: string
      choices: { index: number; message: { role: string; content: string }; finish_reason: string }[]
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
    }>(
      '/api/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: DEFAULT_AGENT_ID,
          stream: false,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'What document type is attached? Answer in a few words.' },
                {
                  type: 'file',
                  file: {
                    file_data: pdfFixture.dataUrl,
                    filename: pdfFixture.filename
                  }
                }
              ]
            }
          ]
        })
      },
      false,
      'json'
    )
    assert.equal(completionRes.status, 200)
    assert.ok(completionRes.data.id.startsWith('chatcmpl-'))
    assert.equal(completionRes.data.object, 'chat.completion')
    assert.equal(completionRes.data.model, DEFAULT_AGENT_NAME)
    assert.equal(completionRes.data.choices[0]?.message.role, 'assistant')
    assert.ok((completionRes.data.choices[0]?.message.content ?? '').length > 0)
    assert.equal(completionRes.data.choices[0]?.finish_reason, 'stop')
    assert.equal(typeof completionRes.data.usage.total_tokens, 'number')
  })

  test('POST /api/v1/chat/completions (stream: true) — streaming SSE completion with PDF + JPEG attachments', async () => {
    const pdfFixture = fixtures[0]!
    const otherFixture = fixtures.find((f) => f.type === 'other')!
    const streamRes = await apiFetch(
      '/api/v1/chat/completions',
      {
        method: 'POST',
        headers: userHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          model: DEFAULT_AGENT_ID,
          stream: true,
          stream_options: { include_usage: true },
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'How many attachments did I include? Reply in one short sentence.' },
                {
                  type: 'file',
                  file: {
                    file_data: pdfFixture.dataUrl,
                    filename: pdfFixture.filename
                  }
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: otherFixture.dataUrl
                  }
                }
              ]
            }
          ]
        }),
        signal: AbortSignal.timeout(180_000)
      },
      'sse'
    )
    assert.equal(streamRes.status, 200)
    assert.ok((streamRes.headers.get('content-type') ?? '').startsWith('text/event-stream'))
    const rawSse = await streamRes.text()
    const frames = rawSse
      .split('\n\n')
      .map((f) => f.trim())
      .filter(Boolean)
    assert.equal(frames.at(-1), 'data: [DONE]')

    const chunks = frames.slice(0, -1).map(
      (f) =>
        JSON.parse(f.replace(/^data:\s*/, '')) as {
          object?: string
          choices?: { index: number; delta: { role?: string; content?: string }; finish_reason: string | null }[]
          usage?: { total_tokens: number }
        }
    )
    assert.equal(chunks[0]?.object, 'chat.completion.chunk')
    assert.equal(chunks[0]?.choices?.[0]?.delta.role, 'assistant')
    const streamedContent = chunks.map((c) => c.choices?.[0]?.delta.content ?? '').join('')
    assert.ok(streamedContent.length > 0)
    assert.ok(chunks.some((c) => c.choices?.[0]?.finish_reason === 'stop'))
    assert.ok(chunks.some((c) => c.usage !== undefined))
  })
})

describe('9. Core SDK Primitives, Sign-Out, GDPR Erase & Zero-Leftover Verification', () => {
  test('Step runner durable replay checkpointing & per-step rollback', async () => {
    const steps: Record<string, unknown> = {}
    let ocrRuns = 0
    let classifyRuns = 0
    let extractRuns = 0
    let rolledBackStep = ''
    const runPipeline = async (failExtract: boolean) => {
      const step = core.internals.workflows.createStepRunner('rest', undefined, steps)
      try {
        const ocr = await step('ocr', async () => (++ocrRuns, 'OCR_TEXT'))
        const classify = await step('classify', async () => (++classifyRuns, { type: 'passport', ocr }))
        await step('temp-write', {
          fn: async () => 'temp-val',
          rollback: async (v) => {
            rolledBackStep = v
          }
        })
        return await step('extract', async () => {
          ++extractRuns
          if (failExtract) throw new Error('Transient extract failure')
          return { passportNumber: 'P123', classifyType: classify.type }
        })
      } catch (e) {
        await step.onError()
        throw e
      }
    }
    await assert.rejects(() => runPipeline(true), /Transient extract failure/)
    assert.equal(ocrRuns, 1)
    assert.equal(classifyRuns, 1)
    assert.equal(extractRuns, 1)
    assert.equal(rolledBackStep, 'temp-val')
    assert.equal('temp-write' in steps, false)

    const replayOut = await runPipeline(false)
    assert.deepEqual(replayOut, { passportNumber: 'P123', classifyType: 'passport' })
    assert.equal(ocrRuns, 1)
    assert.equal(classifyRuns, 1)
    assert.equal(extractRuns, 2)
  })

  test('allWithRollback parallel sibling compensation', async () => {
    let rolledBackLegA = ''
    let rolledBackLegB = ''
    await assert.rejects(
      () =>
        core.internals.workflows.allWithRollback([
          {
            fn: async () => 'legA-committed',
            rollback: async (val) => {
              rolledBackLegA = val
            }
          },
          {
            fn: async () => 'legB-committed',
            rollback: async (val) => {
              rolledBackLegB = val
            }
          },
          {
            fn: async () => {
              throw new Error('legC-failed')
            }
          }
        ]),
      /legC-failed/
    )
    assert.equal(rolledBackLegA, 'legA-committed')
    assert.equal(rolledBackLegB, 'legB-committed')
  })

  test('Universal Auth-User Collection Connector (1:1 & M:N), updateEntry validation, cursor pagination & cascadeEraseUserCollections', async () => {
    core.internals.registry.registerCollections({
      test_profile: defineCollection({
        name: 'test_profile',
        schema: z.object({
          bio: z.string(),
          age: z.number().optional()
        }),
        userRelation: { type: '1:1' }
      }),
      test_shared_org: defineCollection({
        name: 'test_shared_org',
        schema: z.object({
          name: z.string(),
          userIds: z.array(z.string())
        }),
        userRelation: { type: 'M:N', userIdsField: 'userIds', deleteWhenEmpty: true }
      })
    })
    const connectorUid = `conn_${Date.now().toString(36).padEnd(15, 'x').slice(0, 15)}`
    try {
      const profileDoc = await core.db.create('test_profile', { id: connectorUid, bio: 'E2E Profile', age: 30 })

      // Verify core.db.update validates against def.schema.partial() and strips immutable fields (id, createdAt)
      await assert.rejects(
        () => core.db.update('test_profile', connectorUid, { age: 'not-a-number' as unknown as number }),
        /ZodError|expected number/i
      )
      const originalCreatedAt = profileDoc.createdAt
      await core.db.update('test_profile', connectorUid, {
        id: 'hacked_id',
        createdAt: new Date(0),
        bio: 'Updated Bio'
      } as Record<string, unknown>)
      const updatedProfile = await core.db.read('test_profile', connectorUid)
      assert.equal(updatedProfile?.id, connectorUid)
      assert.equal(updatedProfile?.bio, 'Updated Bio')
      assert.equal(updatedProfile?.age, 30)
      assert.equal(updatedProfile?.createdAt.getTime(), originalCreatedAt.getTime())

      const sharedOrg = await core.db.create('test_shared_org', {
        name: 'Shared Org 1',
        userIds: [connectorUid]
      })
      const sharedOrg2 = await core.db.create('test_shared_org', {
        name: 'Shared Org 2',
        userIds: [connectorUid]
      })
      const deletedOrg = await core.db.create('test_shared_org', {
        name: 'Deleted Org',
        userIds: [connectorUid]
      })
      await core.db.delete('test_shared_org', deletedOrg.id)

      assert.equal(await core.db.canAccess('test_profile', profileDoc, connectorUid), true)
      assert.equal(await core.db.canAccess('test_shared_org', sharedOrg, connectorUid), true)

      // Verify cursor pagination (core.db.list & core.db.listPage) and soft-delete exclusion
      const page1 = await core.db.listPage('test_shared_org', { userId: connectorUid, limit: 1 })
      assert.equal(page1.items.length, 1)
      assert.ok(page1.nextCursor)
      const page2 = await core.db.list('test_shared_org', {
        userId: connectorUid,
        limit: 1,
        cursor: page1.nextCursor
      })
      assert.equal(page2.length, 1)
      assert.notEqual(page1.items[0]?.id, page2[0]?.id)

      const allActiveOrgs = await core.db.list('test_shared_org', { userId: connectorUid })
      assert.equal(allActiveOrgs.length, 2)

      const cascadeRes = await core.internals.registry.cascadeEraseUserCollections(
        connectorUid,
        core.internals.workflows.createStepRunner('rest')
      )
      assert.equal(cascadeRes.erasedCollections.test_profile, 1)
      assert.equal(cascadeRes.erasedCollections.test_shared_org, 3)
      assert.equal(await core.db.read('test_profile', connectorUid, true), undefined)
      assert.equal(await core.db.read('test_shared_org', sharedOrg.id, true), undefined)
      assert.equal(await core.db.read('test_shared_org', sharedOrg2.id, true), undefined)
      assert.equal(await core.db.read('test_shared_org', deletedOrg.id, true), undefined)
    } finally {
      await core.internals.registry
        .cascadeEraseUserCollections(connectorUid, core.internals.workflows.createStepRunner('rest'))
        .catch(() => {})
      core.internals.registry.unregisterCollections(['test_profile', 'test_shared_org'])
    }
  })

  test('Workflow NOT_FOUND error propagation & child workflow context inheritance', async () => {
    const prevRuntime = core.internals.workflows.getRuntime()
    const tempRegistry = {
      ...prevRuntime.registry,
      'child-echo-context': {
        mode: 'workflow' as const,
        deadlineSeconds: 60,
        runTask: async (_input: unknown) => {
          const active = useCore()
          return {
            userId: active.userId,
            userRole: active.role,
            isDev: active.env.isDev
          }
        }
      },
      'fail-not-found-doc': {
        mode: 'workflow' as const,
        deadlineSeconds: 60,
        runTask: async () => {
          throw new Error('5 NOT_FOUND: Document projects/test/databases/default/documents/missing/123 does not exist')
        }
      }
    }
    core.internals.workflows.registerRuntime(tempRegistry)

    try {
      const parentStep = core.internals.workflows.createStepRunner('rest')
      const childResult = await core.internals.context.run(
        { env: ENV, userId: testAuthUserId, role: 'user', step: parentStep },
        () =>
          parentStep.invoke<{ ping: string }, { userId: string; userRole: string; isDev: boolean }>(
            'call-child',
            'child-echo-context',
            { ping: 'ok' }
          )
      )
      assert.equal(childResult.userId, testAuthUserId)
      assert.equal(childResult.userRole, 'user')
      assert.equal(childResult.isDev, true)

      const nfDocRef = core.db.firestore(true).collection('_tasks').doc()
      const nfTaskId = nfDocRef.id
      await nfDocRef.set({
        taskId: nfTaskId,
        workflowName: 'fail-not-found-doc',
        status: 'running',
        params: {},
        steps: {},
        userId: testAuthUserId,
        userRole: 'user',
        keepAlive: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })
      await core.internals.workflows.execute(
        {
          taskId: nfTaskId,
          workflowName: 'fail-not-found-doc',
          params: {},
          isDev: true
        },
        tempRegistry
      )
      const nfTaskDoc = await nfDocRef.get()
      assert.equal(nfTaskDoc.data()?.status, 'errored')
      assert.ok(String(nfTaskDoc.data()?.error ?? '').includes('NOT_FOUND'))
      await nfDocRef.delete()
    } finally {
      core.internals.workflows.registerRuntime(prevRuntime.registry)
    }
  })

  test('singleflight tenant-scoped isolation, global coalescing & acquireHttpLimit (429 Retry-After)', async () => {
    let sfRuns = 0
    const sfResults = await Promise.all(
      Array.from({ length: 5 }, () =>
        core.internals.resilience.singleflight('test-sf-key', async () => {
          ++sfRuns
          await sleep(20)
          return 'coalesced-value'
        })
      )
    )
    assert.equal(sfRuns, 1)
    assert.deepEqual(sfResults, Array(5).fill('coalesced-value'))

    let tenantRuns = 0
    const [tenantA, tenantB] = await Promise.all([
      core.internals.context.run({ env: ENV, userId: 'tenant_user_a', role: 'user' }, () =>
        useCore().internals.resilience.singleflight('shared-op', async () => {
          ++tenantRuns
          await sleep(20)
          return useCore().userId
        })
      ),
      core.internals.context.run({ env: ENV, userId: 'tenant_user_b', role: 'user' }, () =>
        useCore().internals.resilience.singleflight('shared-op', async () => {
          ++tenantRuns
          await sleep(20)
          return useCore().userId
        })
      )
    ])
    assert.equal(tenantRuns, 2)
    assert.equal(tenantA, 'tenant_user_a')
    assert.equal(tenantB, 'tenant_user_b')

    let globalRuns = 0
    const [globalA, globalB] = await Promise.all([
      core.internals.context.run({ env: ENV, userId: 'tenant_user_a', role: 'user' }, () =>
        useCore().internals.resilience.singleflight(
          'global-op',
          async () => {
            ++globalRuns
            await sleep(20)
            return useCore().userId
          },
          { scope: 'global' }
        )
      ),
      core.internals.context.run({ env: ENV, userId: 'tenant_user_b', role: 'user' }, () =>
        useCore().internals.resilience.singleflight(
          'global-op',
          async () => {
            ++globalRuns
            await sleep(20)
            return useCore().userId
          },
          { scope: 'global' }
        )
      )
    ])
    assert.equal(globalRuns, 1)
    assert.equal(globalA, CORE_CONFIG.auth.adminUserId)
    assert.equal(globalB, CORE_CONFIG.auth.adminUserId)

    const rateKey = `test-limit-${Date.now()}`
    core.internals.resilience.acquireHttpLimit(rateKey, 2, 60_000)
    core.internals.resilience.acquireHttpLimit(rateKey, 2, 60_000)
    try {
      core.internals.resilience.acquireHttpLimit(rateKey, 2, 60_000)
      assert.fail('Should have thrown 429')
    } catch (err: any) {
      const res = err.getResponse() as Response
      assert.equal(res.status, 429)
      assert.ok(Number(res.headers.get('retry-after')) > 0)
      const body = (await res.json()) as { code: string; retryAfterMs: number }
      assert.equal(body.code, 'RATE_LIMITED')
      assert.ok(body.retryAfterMs > 0)
    }

    const coreBarrel = (await import('@core')) as Record<string, unknown>
    for (const internalSymbol of [
      'decideService',
      'visionService',
      'processAttachments',
      'createEntry',
      'readEntry',
      'listEntries',
      'withCircuitBreaker',
      'getDb',
      'getBucket',
      'runWithCore'
    ]) {
      assert.equal(internalSymbol in coreBarrel, false, `@core must not leak internal symbol ${internalSymbol}`)
    }
    assert.equal(Object.keys(core).includes('internals'), false, 'core.internals must be non-enumerable')
    assert.deepEqual(
      Object.keys(core.internals).sort(),
      ['auth', 'context', 'emails', 'payments', 'registry', 'resilience', 'workflows']
    )
  })

  test('POST /api/emails/send, POST /api/emails/batch, GET /api/emails/logs & POST /api/emails/webhooks/:provider — E2E email routes, templates, attachments & suppression', async () => {
    core.internals.registry.registerEmailTemplates(
      core.define.emailTemplates({
        e2e_summary: {
          description: 'E2E summary notification',
          variables: z.object({ title: z.string(), count: z.number() }),
          subject: ({ title }) => `[E2E] ${title}`,
          html: ({ title, count }) => `<p>${title}: ${count} items processed.</p>`
        }
      })
    )

    const firstRef = uploadedRefs.get(fixtures[0]!.type)!
    const idemKey = `e2e_email_${Date.now()}`
    const sendRes1 = await apiJson<{
      emailId: string
      status: string
      provider: string
      deduplicated?: boolean
    }>(
      '/api/emails/send',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          to: 'e2e-recipient@test.local',
          template: 'e2e_summary',
          variables: { title: 'Batch Scan', count: fixtures.length },
          attachments: [{ filename: 'fixture.pdf', fileRef: firstRef }],
          idempotencyKey: idemKey
        })
      },
      true,
      'emails-send-1'
    )
    assert.equal(sendRes1.status, 200)
    assert.equal(sendRes1.data.status, 'sent')
    assert.equal(sendRes1.data.deduplicated, undefined)

    // Verify core.emails.send idempotency deduplication in email_log
    const directDedup = await core.emails.send(
      {
        to: 'e2e-recipient@test.local',
        template: 'e2e_summary',
        variables: { title: 'Batch Scan', count: fixtures.length },
        idempotencyKey: idemKey
      },
      { userId: testAuthUserId }
    )
    assert.equal(directDedup.emailId, sendRes1.data.emailId)
    assert.equal(directDedup.deduplicated, true)

    // Clean up admin-owned sendRes1 log so only testAuthUserId logs remain
    await core.db.hardDelete('email_log', sendRes1.data.emailId, { bypassRbac: true })

    // Create a user-scoped email log for testAuthUserId to verify GET /api/emails/logs & cascadeEraseUserCollections
    const userScopedSend = await core.emails.send(
      {
        to: 'user-scoped@test.local',
        template: 'e2e_summary',
        variables: { title: 'User Scoped', count: 1 }
      },
      { userId: testAuthUserId }
    )

    // Verify POST /api/emails/batch
    const batchRes = await apiJson<{
      total: number
      sent: number
      failed: number
      results: { emailId: string; status: string }[]
    }>(
      '/api/emails/batch',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          emails: [
            { to: 'batch-a@test.local', subject: 'Batch A', text: 'Hello A' },
            { to: 'batch-b@test.local', subject: 'Batch B', text: 'Hello B' }
          ]
        })
      },
      true,
      'emails-batch'
    )
    assert.equal(batchRes.status, 200)
    assert.equal(batchRes.data.total, 2)
    assert.equal(batchRes.data.sent, 2)
    await Promise.all(
      batchRes.data.results.map((r) => core.db.hardDelete('email_log', r.emailId, { bypassRbac: true }))
    )

    // Verify GET /api/emails/logs filtered by userId
    const logsRes = await apiJson<{ id: string; to: string; userId: string }[]>(
      `/api/emails/logs?userId=${testAuthUserId}&limit=20`,
      {},
      true,
      'emails-logs'
    )
    assert.equal(logsRes.status, 200)
    assert.ok(logsRes.data.some((l) => l.id === userScopedSend.emailId))

    // Verify POST /api/emails/webhooks/resend rejects unsigned/invalid signature with 401
    const badWebhookRes = await apiFetch(
      '/api/emails/webhooks/resend',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'svix-id': 'msg_bad',
          'svix-timestamp': String(Math.floor(Date.now() / 1000)),
          'svix-signature': 'v1,bad_sig'
        },
        body: JSON.stringify({ type: 'email.delivered', data: { email_id: 'dev_123' } })
      },
      'emails-webhook-invalid'
    )
    assert.equal(badWebhookRes.status, 401)
  })

  test('GET /api/payments/status, POST /api/payments/subscribe, POST /api/payments/checkout, POST /api/payments/charge & POST /api/payments/webhooks/:provider — E2E payment routes & usage metering', async () => {
    core.internals.registry.registerPlans(
      core.define.plans({
        free: {
          name: 'Free Plan',
          interval: 'free',
          amount: 0,
          quotas: { aiTokens: 100_000 }
        },
        pro: {
          name: 'Pro Plan',
          interval: 'month',
          amount: 2_900,
          currency: 'usd',
          quotas: { aiTokens: 1_000_000, overage: { enabled: true } }
        }
      })
    )
    core.internals.registry.registerProducts(
      core.define.products({
        e2e_token_pack: {
          name: 'E2E 5,000 Token Pack',
          amount: 500,
          currency: 'usd',
          grants: { aiTokens: 5_000, credits: 5 }
        }
      })
    )

    const subRes = await apiJson<{ subscriptionId: string; planId: string; status: string }>(
      '/api/payments/subscribe',
      {
        method: 'POST',
        headers: userHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ plan: 'free' })
      },
      false,
      'payments-subscribe'
    )
    assert.equal(subRes.status, 200)
    assert.equal(subRes.data.planId, 'free')
    assert.equal(subRes.data.status, 'active')

    const chkRes = await apiJson<{ checkoutId: string; url: string; provider: string }>(
      '/api/payments/checkout',
      {
        method: 'POST',
        headers: userHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ custom: { name: 'E2E Custom Add-on', amount: 1_500, currency: 'usd' } })
      },
      false,
      'payments-checkout'
    )
    assert.equal(chkRes.status, 200)
    assert.ok(chkRes.data.checkoutId)
    assert.ok(chkRes.data.url.startsWith('http'))

    const chargeRes = await apiJson<{ chargeId: string; status: string; amount: number }>(
      '/api/payments/charge',
      {
        method: 'POST',
        headers: userHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ product: 'e2e_token_pack', idempotencyKey: 'e2e-charge-idem-1' })
      },
      false,
      'payments-charge'
    )
    assert.equal(chargeRes.status, 200)
    assert.equal(chargeRes.data.amount, 500)

    const retryChargeRes = await apiJson<{ chargeId: string; status: string; amount: number }>(
      '/api/payments/charge',
      {
        method: 'POST',
        headers: userHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ product: 'e2e_token_pack', idempotencyKey: 'e2e-charge-idem-1' })
      },
      false,
      'payments-charge-retry'
    )
    assert.equal(retryChargeRes.status, 200)
    assert.equal(retryChargeRes.data.chargeId, chargeRes.data.chargeId)

    await core.payments.recordUsage(
      { metric: 'ai_tokens', amount: 250, model: 'e2e-test-model' },
      { userId: testAuthUserId }
    )

    const statusRes = await apiJson<{
      subscription: { userId: string; planId: string; status: string; bonusAiTokens: number; credits: number }
      usage: { userId: string; aiTokensUsed: number; aiTokensLimit: number | null }
    }>('/api/payments/status', { headers: userHeaders() }, false, 'payments-status')
    assert.equal(statusRes.status, 200)
    assert.equal(statusRes.data.subscription.userId, testAuthUserId)
    assert.equal(statusRes.data.subscription.planId, 'free')
    assert.equal(statusRes.data.subscription.credits, 5, 'Expected idempotent charge retry to grant credits only once')
    assert.ok(statusRes.data.usage.aiTokensUsed >= 0)

    const badPayWhRes = await apiFetch(
      '/api/payments/webhooks/stripe',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': `t=${Math.floor(Date.now() / 1000)},v1=invalid`
        },
        body: JSON.stringify({ id: 'evt_bad_e2e', type: 'checkout.session.completed' })
      },
      'payments-webhook-invalid'
    )
    assert.equal(badPayWhRes.status, 401)
  })

  test('DELETE /api/files/:ref & POST /api/auth/sign-out — soft-delete all files & revoke session', async () => {
    await Promise.all(
      [...uploadedRefs.values()].map(async (ref) => {
        const delRes = await apiFetch(`/api/files/${ref}`, { method: 'DELETE', headers: userHeaders() }, 'soft-del')
        assert.equal(delRes.status, 200)
      })
    )

    const firstRef = uploadedRefs.get(fixtures[0]!.type)!
    const afterDelRes = await apiFetch(`/api/files/${firstRef}`, { headers: bearerHeaders() }, 'verify-404')
    assert.equal(afterDelRes.status, 404)

    const signOutRes = await apiFetch('/api/auth/sign-out', {
      method: 'POST',
      headers: userHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ deleteUser: true })
    })
    assert.equal(signOutRes.status, 200)

    const revokedCookieRes = await apiFetch('/api/auth/session', { headers: userHeaders() }, 'revoked-cookie')
    assert.equal(revokedCookieRes.status, 401)
  })

  test('POST /api/erase-user & Final Zero-Leftover Verification (Auth, Firestore file/chat/_tasks & Cloud Storage)', async () => {
    const eraseRes = await apiJson<{
      userId: string
      erasedFiles: number
      erasedChats: number
      erasedUser: boolean
    }>(
      '/api/erase-user',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: testAuthUserId, backupBeforeErase: false })
      },
      true
    )
    assert.equal(eraseRes.status, 200)
    assert.equal(eraseRes.data.userId, testAuthUserId)
    assert.ok(eraseRes.data.erasedFiles >= fixtures.length)
    assert.ok(eraseRes.data.erasedChats >= 2)
    assert.equal(eraseRes.data.erasedUser, true)
    userErased = true

    const db = core.db.firestore(true)
    const [
      leftoverAuthUser,
      leftoverAuthMetaDoc,
      leftoverAuthTokenDocs,
      leftoverFileDocs,
      leftoverChatDocs,
      leftoverChatMsgDocs,
      leftoverTaskDocs,
      leftoverEmailLogDocs,
      leftoverPaymentCustomerDoc,
      leftoverPaymentUsageDocs,
      leftoverPaymentTxDocs,
      [leftoverStorageBlobs]
    ] = await Promise.all([
      core.auth.getUser(testAuthUserId),
      db.collection('user_auth_meta').doc(testAuthUserId).get(),
      db.collection('auth_tokens').where('userId', '==', testAuthUserId).get(),
      db.collection('file').where('userId', '==', testAuthUserId).get(),
      db.collection('chat').where('userId', '==', testAuthUserId).get(),
      db.collectionGroup('messages').where('userId', '==', testAuthUserId).get(),
      db.collection('_tasks').where('userId', '==', testAuthUserId).get(),
      db.collection('email_log').where('userId', '==', testAuthUserId).get(),
      db.collection('payment_customer').doc(testAuthUserId).get(),
      db.collection('payment_usage').where('userId', '==', testAuthUserId).get(),
      db.collection('payment_transaction').where('userId', '==', testAuthUserId).get(),
      core.files.bucket(true).getFiles({ prefix: `${testAuthUserId}_` })
    ])
    assert.equal(leftoverAuthUser, undefined, 'Expected user to be completely deleted from Firebase Auth')
    assert.equal(leftoverAuthMetaDoc.exists, false, 'Expected 0 leftover user_auth_meta doc in Firestore')
    assert.equal(leftoverAuthTokenDocs.size, 0, 'Expected 0 leftover auth_tokens docs in Firestore')
    assert.equal(leftoverFileDocs.size, 0, 'Expected 0 leftover file docs in Firestore')
    assert.equal(leftoverChatDocs.size, 0, 'Expected 0 leftover chat docs in Firestore')
    assert.equal(leftoverChatMsgDocs.size, 0, 'Expected 0 leftover chat message subcollection docs in Firestore')
    assert.equal(leftoverTaskDocs.size, 0, 'Expected 0 leftover _tasks docs in Firestore')
    assert.equal(leftoverEmailLogDocs.size, 0, 'Expected 0 leftover email_log docs in Firestore')
    assert.equal(leftoverPaymentCustomerDoc.exists, false, 'Expected 0 leftover payment_customer doc in Firestore')
    assert.equal(leftoverPaymentUsageDocs.size, 0, 'Expected 0 leftover payment_usage docs in Firestore')
    assert.equal(leftoverPaymentTxDocs.size, 0, 'Expected 0 leftover payment_transaction docs in Firestore')
    assert.equal(leftoverStorageBlobs.length, 0, 'Expected 0 leftover blobs in Cloud Storage')
  })
})
