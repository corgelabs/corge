import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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

export const corgeAliasPlugin = (cwd = process.cwd()): Plugin => ({
  name: 'corge-alias',
  setup(b) {
    b.onResolve({ filter: /^(@core|@corgelabs\/corge)$/ }, () => ({
      path: resolveCorgeEntrypoint(cwd),
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

    b.onLoad({ filter: /.*/, namespace: 'corge-virtual' }, () => ({
      contents: [
        "import { core } from '@core'",
        'export const { devApp, app, functions } = core.createApp({})'
      ].join('\n'),
      loader: 'ts',
      resolveDir: cwd
    }))
  }
})

export const buildConsumerApp = async (cwd = process.cwd()): Promise<void> => {
  await build({
    absWorkingDir: cwd,
    entryPoints: ['src/index.ts'],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    packages: 'external',
    plugins: [corgeAliasPlugin(cwd)],
    footer: { js: 'module.exports = functions;' },
    outfile: 'dist/index.cjs',
    sourcemap: true
  })
}
