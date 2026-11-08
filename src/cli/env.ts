import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { applicationDefault } from 'firebase-admin/app'

const hasValue = (value: string | undefined): value is string => value != null && value.length > 0

const readDotEnv = (cwd = process.cwd()): Record<string, string> => {
  const envPath = join(cwd, '.env')
  return existsSync(envPath) ? (parseEnv(readFileSync(envPath, 'utf8')) as Record<string, string>) : {}
}

const getSecretText = async (projectId: string, accessToken: string, secretName: string): Promise<string> => {
  const url = `https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets/${secretName}/versions/latest:access`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  const data = (await res.json()) as { payload?: { data?: string }; error?: { message?: string } }
  if (!res.ok || !data.payload?.data) {
    throw new Error(`Secret is empty or not defined: ${secretName} (${data.error?.message ?? res.status})`)
  }
  return Buffer.from(data.payload.data, 'base64').toString('utf8')
}

export const getSecrets = async (
  secretNames?: readonly string[],
  cwd = process.cwd()
): Promise<Record<string, string>> => {
  const dotEnv = readDotEnv(cwd)
  const merged: Record<string, string> = {}

  for (const [key, value] of Object.entries(dotEnv)) {
    if (hasValue(process.env[key])) {
      merged[key] = process.env[key]!
    } else if (hasValue(value)) {
      merged[key] = value
    }
  }

  const projectId = (merged.GCP_PROJECT || process.env.GCP_PROJECT)!
  const keysToResolve =
    secretNames && secretNames.length > 0
      ? secretNames.filter((name) => !hasValue(merged[name]) && !hasValue(process.env[name]))
      : Object.entries(dotEnv)
          .filter(([key, value]) => !hasValue(value) && !hasValue(process.env[key]))
          .map(([key]) => key)

  if (keysToResolve.length > 0 && projectId) {
    const { access_token } = await applicationDefault().getAccessToken()
    if (!access_token) throw new Error('Failed to obtain GCP Application Default Credentials access token')
    const resolved = await Promise.all(
      keysToResolve.map(
        async (secretName) => [secretName, await getSecretText(projectId, access_token, secretName)] as const
      )
    )
    for (const [key, value] of resolved) {
      merged[key] = value
    }
  }

  return merged
}

export const loadGcpSecrets = async (
  secretNames?: readonly string[],
  cwd = process.cwd()
): Promise<Record<string, string>> => {
  const env = await getSecrets(secretNames, cwd)
  for (const [k, v] of Object.entries(env)) {
    if (!hasValue(process.env[k])) process.env[k] = v
  }
  return env
}

export const runWithGcpEnv = async (
  cmd: string[],
  secretNames?: readonly string[],
  cwd = process.cwd()
): Promise<number> => {
  const env = await getSecrets(secretNames, cwd)
  return new Promise<number>((resolve, reject) => {
    const child = spawn(cmd[0]!, cmd.slice(1), {
      cwd,
      env: { ...process.env, ...env },
      stdio: 'inherit'
    })
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
}
