import { applicationDefault } from 'firebase-admin/app'
import { CORGE_CONFIG } from '../config'

const REQUIRED_APIS = [
  'documentai.googleapis.com',
  'generativelanguage.googleapis.com',
  'apikeys.googleapis.com',
  'secretmanager.googleapis.com',
  'cloudtasks.googleapis.com'
] as const

const GEMINI_KEY_DISPLAY_NAME = 'corge-gemini-decisions-key'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

type GcpHeaders = Record<string, string>

const ensureGoogleApisEnabled = async (project: string, headers: GcpHeaders): Promise<void> => {
  const enabled = new Set<string>()
  let pageToken = ''
  do {
    const url = `https://serviceusage.googleapis.com/v1/projects/${project}/services?filter=state:ENABLED&pageSize=200${
      pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''
    }`
    const res = await fetch(url, { headers })
    if (!res.ok) break
    const data = (await res.json()) as {
      services?: { name?: string; config?: { name?: string } }[]
      nextPageToken?: string
    }
    for (const s of data.services ?? []) {
      const id = s.config?.name || s.name?.split('/').pop()
      if (id) enabled.add(id)
    }
    pageToken = data.nextPageToken ?? ''
  } while (pageToken)

  const missing = REQUIRED_APIS.filter((api) => !enabled.has(api))
  if (missing.length === 0) return

  console.log(`i  gcp: enabling required APIs (${missing.join(', ')})...`)
  const enableRes = await fetch(`https://serviceusage.googleapis.com/v1/projects/${project}/services:batchEnable`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ serviceIds: missing })
  })
  if (!enableRes.ok) {
    console.warn(`⚠  gcp: batchEnable returned ${enableRes.status}: ${await enableRes.text()}`)
    return
  }
  let op = (await enableRes.json()) as { name?: string; done?: boolean }
  for (let i = 0; i < 40 && !op.done && op.name; i++) {
    await sleep(1_500)
    const poll = await fetch(`https://serviceusage.googleapis.com/v1/${op.name}`, { headers })
    if (poll.ok) op = (await poll.json()) as { name?: string; done?: boolean }
  }
  await sleep(2_500)
  console.log('✔  gcp: required APIs enabled')
}

const ensureDocAiProcessor = async (project: string, headers: GcpHeaders): Promise<void> => {
  const loc = CORGE_CONFIG.models.docAiLocation || 'eu'
  const displayName = CORGE_CONFIG.models.docAiProcessorDisplayName || 'corge-ocr'
  if (CORGE_CONFIG.models.docAiProcessorId) return
  const parentUrl = `https://${loc}-documentai.googleapis.com/v1/projects/${project}/locations/${loc}/processors`

  let listData: { processors?: { name?: string; displayName?: string; type?: string; state?: string }[] } | undefined
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${parentUrl}?pageSize=100`, { headers })
    if (res.ok) {
      listData = (await res.json()) as typeof listData
      break
    }
    if (attempt < 3) await sleep(2_000)
    else {
      console.warn(`⚠  documentai: failed to list processors (${res.status}): ${await res.text()}`)
      return
    }
  }

  const existing = (listData?.processors ?? []).find(
    (p) => p.type === 'OCR_PROCESSOR' && p.displayName === displayName && p.state === 'ENABLED'
  )
  if (existing) return

  console.log(`i  documentai: creating OCR_PROCESSOR "${displayName}" in ${loc}...`)
  const createRes = await fetch(parentUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ displayName, type: 'OCR_PROCESSOR' })
  })
  if (!createRes.ok) {
    console.warn(`⚠  documentai: failed to create processor (${createRes.status}): ${await createRes.text()}`)
    return
  }
  const created = (await createRes.json()) as { name?: string }
  console.log(`✔  documentai: provisioned ${created.name ?? displayName}`)
}

const ensureSecretRuntimeIam = async (
  project: string,
  secretId: string,
  versionResourceName: string | undefined,
  headers: GcpHeaders
): Promise<void> => {
  const projectNumber = /^projects\/(\d+)\//.exec(versionResourceName ?? '')?.[1]
  const targetMembers = new Set<string>()
  if (projectNumber) targetMembers.add(`serviceAccount:${projectNumber}-compute@developer.gserviceaccount.com`)
  if (CORGE_CONFIG.serviceAccount) targetMembers.add(`serviceAccount:${CORGE_CONFIG.serviceAccount}`)
  if (targetMembers.size === 0) return

  const policyUrl = `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${secretId}`
  const getRes = await fetch(`${policyUrl}:getIamPolicy`, { headers })
  if (!getRes.ok) return
  const policy = (await getRes.json()) as {
    version?: number
    etag?: string
    bindings?: { role: string; members: string[] }[]
  }
  const bindings = policy.bindings ?? []
  let accessor = bindings.find((b) => b.role === 'roles/secretmanager.secretAccessor')
  if (!accessor) {
    accessor = { role: 'roles/secretmanager.secretAccessor', members: [] }
    bindings.push(accessor)
  }
  let changed = false
  for (const m of targetMembers) {
    if (!accessor.members.includes(m)) {
      accessor.members.push(m)
      changed = true
    }
  }
  if (!changed) return

  await fetch(`${policyUrl}:setIamPolicy`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ policy: { ...policy, bindings } })
  })
}

const ensureGeminiApiKeySecret = async (project: string, headers: GcpHeaders): Promise<void> => {
  const secretCheck = await fetch(
    `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/GEMINI_API_KEY/versions/latest:access`,
    { headers }
  )
  if (secretCheck.ok) {
    const existingSecret = (await secretCheck.json()) as { name?: string; payload?: { data?: string } }
    if (existingSecret.payload?.data) {
      await ensureSecretRuntimeIam(project, 'GEMINI_API_KEY', existingSecret.name, headers)
      return
    }
  }

  console.log('i  gemini: provisioning restricted GEMINI_API_KEY for Generative Language / Decisions API...')
  const keysBase = `https://apikeys.googleapis.com/v2/projects/${project}/locations/global/keys`
  let keyResourceName = ''

  const listKeysRes = await fetch(`${keysBase}?pageSize=100`, { headers })
  if (listKeysRes.ok) {
    const listKeysData = (await listKeysRes.json()) as {
      keys?: { name?: string; displayName?: string; deleteTime?: string }[]
    }
    const found = (listKeysData.keys ?? []).find(
      (k) => k.displayName === GEMINI_KEY_DISPLAY_NAME && !k.deleteTime && k.name
    )
    if (found?.name) keyResourceName = found.name
  }

  if (!keyResourceName) {
    const createKeyRes = await fetch(keysBase, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        displayName: GEMINI_KEY_DISPLAY_NAME,
        restrictions: {
          apiTargets: [{ service: 'generativelanguage.googleapis.com' }]
        }
      })
    })
    if (!createKeyRes.ok) {
      console.warn(`⚠  gemini: failed to create GCP API key (${createKeyRes.status}): ${await createKeyRes.text()}`)
      return
    }
    let op = (await createKeyRes.json()) as { name?: string; done?: boolean; response?: { name?: string } }
    for (let i = 0; i < 30 && !op.done && op.name; i++) {
      await sleep(1_000)
      const poll = await fetch(`https://apikeys.googleapis.com/v2/${op.name}`, { headers })
      if (poll.ok) op = (await poll.json()) as typeof op
    }
    keyResourceName = op.response?.name ?? ''
  }

  if (!keyResourceName) {
    console.warn('⚠  gemini: API key creation returned empty resource name')
    return
  }

  const keyStrRes = await fetch(`https://apikeys.googleapis.com/v2/${keyResourceName}/keyString`, { headers })
  if (!keyStrRes.ok) {
    console.warn(`⚠  gemini: failed to read keyString (${keyStrRes.status}): ${await keyStrRes.text()}`)
    return
  }
  const { keyString } = (await keyStrRes.json()) as { keyString?: string }
  if (!keyString) return

  const createSecretRes = await fetch(
    `https://secretmanager.googleapis.com/v1/projects/${project}/secrets?secretId=GEMINI_API_KEY`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ replication: { automatic: {} } })
    }
  )
  if (!createSecretRes.ok && createSecretRes.status !== 409) {
    console.warn(`⚠  gemini: failed to create GEMINI_API_KEY secret (${createSecretRes.status})`)
    return
  }

  const addVerRes = await fetch(
    `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/GEMINI_API_KEY:addVersion`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ payload: { data: Buffer.from(keyString, 'utf8').toString('base64') } })
    }
  )
  if (!addVerRes.ok) {
    console.warn(`⚠  gemini: failed to add GEMINI_API_KEY version (${addVerRes.status}): ${await addVerRes.text()}`)
    return
  }
  const addedVer = (await addVerRes.json()) as { name?: string }
  await ensureSecretRuntimeIam(project, 'GEMINI_API_KEY', addedVer.name, headers)
  console.log('✔  gemini: stored GEMINI_API_KEY in GCP Secret Manager')
}

const ensureCloudTasksShardQueues = async (
  project: string,
  target: 'prod' | 'dev',
  headers: GcpHeaders
): Promise<void> => {
  const shardsCount = Math.max(1, CORGE_CONFIG.tasks.defaultShardsCount)
  if (shardsCount <= 1) return
  const region = CORGE_CONFIG.region
  const baseQueueId = target === 'prod' ? `${project}-tasks` : `${project}-tasks-dev`
  const parentLoc = `projects/${project}/locations/${region}`

  const existing = new Set<string>()
  let pageToken = ''
  do {
    const url = `https://cloudtasks.googleapis.com/v2/${parentLoc}/queues?pageSize=100${
      pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''
    }`
    const res = await fetch(url, { headers })
    if (!res.ok) return
    const data = (await res.json()) as { queues?: { name?: string }[]; nextPageToken?: string }
    for (const q of data.queues ?? []) {
      if (q.name) existing.add(q.name)
    }
    pageToken = data.nextPageToken ?? ''
  } while (pageToken)

  const missing: string[] = []
  for (let idx = 1; idx < shardsCount; idx++) {
    const fullName = `${parentLoc}/queues/${baseQueueId}-${String(idx).padStart(2, '0')}`
    if (!existing.has(fullName)) missing.push(fullName)
  }
  if (missing.length === 0) return

  console.log(`i  cloudtasks: provisioning ${missing.length} shard queue(s) for ${baseQueueId} in ${region}...`)
  await Promise.all(
    missing.map(async (name) => {
      const res = await fetch(`https://cloudtasks.googleapis.com/v2/${parentLoc}/queues`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name,
          rateLimits: { maxDispatchesPerSecond: 500, maxConcurrentDispatches: 1000 },
          retryConfig: { maxAttempts: CORGE_CONFIG.tasks.maxAttempts, minBackoff: '2s', maxBackoff: '20s' }
        })
      })
      if (!res.ok && res.status !== 409) {
        console.warn(`⚠  cloudtasks: failed to create ${name} (${res.status}): ${await res.text()}`)
      }
    })
  )
}

export const provisionCorgeGcpInfra = async (project: string, target: 'prod' | 'dev'): Promise<void> => {
  const { access_token } = await applicationDefault().getAccessToken()
  if (!access_token) return
  const headers: GcpHeaders = {
    Authorization: `Bearer ${access_token}`,
    'Content-Type': 'application/json',
    'x-goog-user-project': project
  }

  await ensureGoogleApisEnabled(project, headers)
  await Promise.all([
    ensureDocAiProcessor(project, headers),
    ensureGeminiApiKeySecret(project, headers),
    ensureCloudTasksShardQueues(project, target, headers)
  ])
}
