import { execSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildConsumerApp, getCorgeRootDir } from './builder'

interface FirestoreIndexesFile {
  indexes?: unknown[]
  fieldOverrides?: unknown[]
}

const mergeFirestoreIndexes = (base: FirestoreIndexesFile, custom: FirestoreIndexesFile): FirestoreIndexesFile => {
  const seenIndexes = new Set<string>()
  const mergedIndexes: unknown[] = []
  for (const item of [...(base.indexes ?? []), ...(custom.indexes ?? [])]) {
    const key = JSON.stringify(item)
    if (!seenIndexes.has(key)) {
      seenIndexes.add(key)
      mergedIndexes.push(item)
    }
  }

  const seenOverrides = new Set<string>()
  const mergedOverrides: unknown[] = []
  for (const item of [...(base.fieldOverrides ?? []), ...(custom.fieldOverrides ?? [])]) {
    const key = JSON.stringify(item)
    if (!seenOverrides.has(key)) {
      seenOverrides.add(key)
      mergedOverrides.push(item)
    }
  }

  return {
    indexes: mergedIndexes,
    fieldOverrides: mergedOverrides
  }
}

export const deployConsumerApp = async (
  target: 'prod' | 'dev' | undefined,
  cwd = process.cwd()
): Promise<void> => {
  try {
    process.loadEnvFile(join(cwd, '.env'))
  } catch {}

  if (target !== 'prod' && target !== 'dev') {
    console.error('Usage: corge deploy <prod|dev>')
    process.exit(1)
  }

  const requiredBranch = target === 'prod' ? 'main' : 'dev'
  const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf8' }).trim()

  if (currentBranch !== requiredBranch) {
    console.error(
      `Deploy blocked: "deploy ${target}" can only run on branch "${requiredBranch}" (current branch: "${currentBranch}").`
    )
    process.exit(1)
  }

  const project = process.env.GCP_PROJECT
  if (!project) {
    console.error('Missing GCP_PROJECT in .env')
    process.exit(1)
  }

  await buildConsumerApp(cwd)

  const corgeRoot = getCorgeRootDir()
  const firebaseJsonPath = join(cwd, 'firebase.json')
  const pkgJsonPath = join(cwd, 'package.json')
  const firestoreRulesPath = join(cwd, 'firestore.rules')
  const firestoreIndexesPath = join(cwd, 'firestore.indexes.json')
  const storageRulesPath = join(cwd, 'storage.rules')

  const rawFirebaseJson = readFileSync(firebaseJsonPath, 'utf8')
  const rawPkgJson = readFileSync(pkgJsonPath, 'utf8')
  const hadFirestoreRules = existsSync(firestoreRulesPath)
  const rawFirestoreRules = hadFirestoreRules ? readFileSync(firestoreRulesPath, 'utf8') : null
  const hadFirestoreIndexes = existsSync(firestoreIndexesPath)
  const rawFirestoreIndexes = hadFirestoreIndexes ? readFileSync(firestoreIndexesPath, 'utf8') : null
  const hadStorageRules = existsSync(storageRulesPath)
  const rawStorageRules = hadStorageRules ? readFileSync(storageRulesPath, 'utf8') : null

  const restoreFiles = () => {
    try {
      writeFileSync(firebaseJsonPath, rawFirebaseJson, 'utf8')
    } catch {}
    try {
      writeFileSync(pkgJsonPath, rawPkgJson, 'utf8')
    } catch {}
    try {
      if (hadFirestoreRules && rawFirestoreRules !== null) {
        writeFileSync(firestoreRulesPath, rawFirestoreRules, 'utf8')
      } else if (!hadFirestoreRules && existsSync(firestoreRulesPath)) {
        unlinkSync(firestoreRulesPath)
      }
    } catch {}
    try {
      if (hadFirestoreIndexes && rawFirestoreIndexes !== null) {
        writeFileSync(firestoreIndexesPath, rawFirestoreIndexes, 'utf8')
      } else if (!hadFirestoreIndexes && existsSync(firestoreIndexesPath)) {
        unlinkSync(firestoreIndexesPath)
      }
    } catch {}
    try {
      if (hadStorageRules && rawStorageRules !== null) {
        writeFileSync(storageRulesPath, rawStorageRules, 'utf8')
      } else if (!hadStorageRules && existsSync(storageRulesPath)) {
        unlinkSync(storageRulesPath)
      }
    } catch {}
  }

  process.once('SIGINT', () => {
    restoreFiles()
    process.exit(130)
  })
  process.once('SIGTERM', () => {
    restoreFiles()
    process.exit(143)
  })

  try {
    // 1. Provision or merge base Firestore/Storage rules & composite indexes from @corgelabs/corge/infra
    const baseFirestoreRules = readFileSync(join(corgeRoot, 'infra/firestore.base.rules'), 'utf8')
    const baseStorageRules = readFileSync(join(corgeRoot, 'infra/storage.base.rules'), 'utf8')
    const baseIndexes = JSON.parse(
      readFileSync(join(corgeRoot, 'infra/firestore.base.indexes.json'), 'utf8')
    ) as FirestoreIndexesFile

    if (!hadFirestoreRules) {
      writeFileSync(firestoreRulesPath, baseFirestoreRules, 'utf8')
    }
    if (!hadStorageRules) {
      writeFileSync(storageRulesPath, baseStorageRules, 'utf8')
    }

    const customIndexes = hadFirestoreIndexes && rawFirestoreIndexes
      ? (JSON.parse(rawFirestoreIndexes) as FirestoreIndexesFile)
      : {}
    const mergedIndexes = mergeFirestoreIndexes(baseIndexes, customIndexes)
    writeFileSync(firestoreIndexesPath, JSON.stringify(mergedIndexes, null, 2) + '\n', 'utf8')

    // 2. Rewrite firebase.json for target environment
    const cfg = JSON.parse(rawFirebaseJson) as Record<string, unknown>
    const prodDb = { database: project, rules: 'firestore.rules', indexes: 'firestore.indexes.json' }
    const devDb = { database: `${project}-dev`, rules: 'firestore.rules', indexes: 'firestore.indexes.json' }
    const prodBucket = { bucket: `${project}.firebasestorage.app`, rules: 'storage.rules' }
    const devBucket = { bucket: `${project}-dev`, rules: 'storage.rules' }

    cfg.firestore = target === 'prod' ? [prodDb] : [devDb]
    cfg.storage = target === 'prod' ? [prodBucket] : [devBucket]
    writeFileSync(firebaseJsonPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8')

    // 3. Expand @corgelabs/corge runtime dependencies into consumer package.json so Cloud Build needs zero npm auth
    const corgePkg = JSON.parse(readFileSync(join(corgeRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const consumerPkg = JSON.parse(rawPkgJson) as {
      dependencies?: Record<string, string>
      [k: string]: unknown
    }
    const expandedDeps: Record<string, string> = { ...(corgePkg.dependencies ?? {}), ...(consumerPkg.dependencies ?? {}) }
    delete expandedDeps['@corgelabs/corge']
    delete expandedDeps.esbuild
    consumerPkg.dependencies = expandedDeps
    writeFileSync(pkgJsonPath, JSON.stringify(consumerPkg, null, 2) + '\n', 'utf8')

    const onlyTargets =
      target === 'prod'
        ? `functions:${project},functions:${project}-tasks,firestore:${project},storage`
        : `functions:${project}-dev,functions:${project}-tasks-dev,firestore:${project}-dev,storage`

    const deployRes = spawnSync(
      'npx',
      ['-y', 'firebase-tools@latest', 'deploy', '-P', project, '--only', onlyTargets],
      { cwd, stdio: 'inherit' }
    )
    process.exitCode = deployRes.status ?? 1
  } finally {
    restoreFiles()
  }
}
