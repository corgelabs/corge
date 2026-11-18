import { cpSync, existsSync, realpathSync, rmSync } from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build, type Plugin } from 'esbuild'

export const getCorgeRootDir = (): string => {
  const currentFile = fileURLToPath(import.meta.url)
  const currentDir = dirname(currentFile)
  for (const candidate of [
    resolve(currentDir, '../..'),
    resolve(currentDir, '..')
  ]) {
    if (existsSync(join(candidate, 'package.json')) && existsSync(join(candidate, 'tsconfig.base.json'))) {
      return candidate
    }
  }
  return resolve(currentDir, '../..')
}

export const resolveCorgeEntrypoint = (cwd = process.cwd()): string => {
  try {
    const req = createRequire(join(cwd, 'package.json'))
    return req.resolve('@corgelabs/corge')
  } catch {
    const root = getCorgeRootDir()
    const distEntry = join(root, 'dist/index.js')
    return existsSync(distEntry) ? distEntry : join(root, 'src/index.ts')
  }
}

const resolveWithExtensions = (basePath: string): string | undefined => {
  for (const candidate of [
    basePath,
    `${basePath}.ts`,
    `${basePath}.js`,
    join(basePath, 'index.ts'),
    join(basePath, 'index.js')
  ]) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

export const corgeAliasPlugin = (cwd = process.cwd()): Plugin => {
  const builtinSet = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)])
  const cwdReq = createRequire(join(cwd, 'package.json'))
  const corgeEntry = resolveCorgeEntrypoint(cwd)
  const corgeRealDir = existsSync(corgeEntry) ? dirname(realpathSync(corgeEntry)) : getCorgeRootDir()
  const corgePkgRoot = existsSync(join(corgeRealDir, 'package.json')) ? corgeRealDir : resolve(corgeRealDir, '..')
  const corgeReq = createRequire(join(corgePkgRoot, 'package.json'))

  return {
    name: 'corge-alias',
    setup(b) {
      b.onResolve({ filter: /^@corgelabs\/corge$/ }, () => ({
        path: corgeEntry,
        external: false
      }))

      b.onResolve({ filter: /^@(config|routes|services|utils)\/(.+)$/ }, (args) => {
        const match = /^@(config|routes|services|utils)\/(.+)$/.exec(args.path)
        if (!match) return undefined
        const [, folder, rest] = match
        const target = resolveWithExtensions(join(cwd, 'src', folder!, rest!))
        if (target) return { path: target, external: false }
        return undefined
      })

      b.onResolve({ filter: /^@app-entry$/ }, () => {
        const target = resolveWithExtensions(join(cwd, 'src/index'))
        if (target) return { path: target, external: false }
        return { path: 'corge-fallback-app', namespace: 'corge-virtual' }
      })

      b.onResolve({ filter: /^[^./]/ }, (args) => {
        if (
          builtinSet.has(args.path) ||
          args.path === '@corgelabs/corge' ||
          args.path === '@app-entry' ||
          args.path.startsWith('virtual:') ||
          /^@(config|routes|services|utils)\//.test(args.path)
        ) {
          return undefined
        }
        try {
          cwdReq.resolve(args.path)
          return undefined
        } catch {
          try {
            const resolved = corgeReq.resolve(args.path)
            return {
              path: b.initialOptions.format === 'esm' ? pathToFileURL(resolved).href : resolved,
              external: true
            }
          } catch {
            return undefined
          }
        }
      })

      b.onLoad({ filter: /.*/, namespace: 'corge-virtual' }, () => ({
        contents: [
          "import { corge } from '@corgelabs/corge'",
          'export const { devApp, app, functions } = corge.createApp({})'
        ].join('\n'),
        loader: 'ts',
        resolveDir: cwd
      }))
    }
  }
}

export const buildConsumerApp = async (cwd = process.cwd(), target?: 'prod' | 'dev'): Promise<void> => {
  const distDir = join(cwd, 'dist')
  rmSync(distDir, { recursive: true, force: true })

  await build({
    absWorkingDir: cwd,
    entryPoints: ['src/index.ts'],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    packages: 'external',
    plugins: [corgeAliasPlugin(cwd)],
    ...(target ? { define: { 'process.env.CORGE_DEPLOY_TARGET': JSON.stringify(target) } } : {}),
    footer: { js: 'module.exports = functions;' },
    outfile: 'dist/index.cjs',
    sourcemap: true
  })

  const srcContext = join(cwd, 'src/context')
  if (existsSync(srcContext)) {
    cpSync(srcContext, join(distDir, 'context'), { recursive: true })
  }
}
