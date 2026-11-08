import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { context, type Plugin } from 'esbuild'
import { corgeAliasPlugin } from './builder'
import { loadGcpSecrets } from './env'

const devBootstrapPlugin = (cwd: string): Plugin => ({
  name: 'corge-dev-bootstrap',
  setup(b) {
    b.onResolve({ filter: /^virtual:corge-dev-entry$/ }, () => ({
      path: 'virtual:corge-dev-entry',
      namespace: 'corge-dev'
    }))

    b.onLoad({ filter: /^virtual:corge-dev-entry$/, namespace: 'corge-dev' }, () => ({
      contents: [
        "import { EventEmitter } from 'node:events'",
        "import { serve } from '@hono/node-server'",
        "import { devApp } from './src/index'",
        'EventEmitter.defaultMaxListeners = 100',
        'const port = Number(process.env.PORT ?? 8080)',
        'serve({ fetch: devApp.fetch, port })'
      ].join('\n'),
      loader: 'ts',
      resolveDir: cwd
    }))
  }
})

export const runDevServer = async (cwd = process.cwd()): Promise<void> => {
  await loadGcpSecrets(undefined, cwd)
  const outDir = join(cwd, '.corge')
  mkdirSync(outDir, { recursive: true })
  const outFile = join(outDir, 'dev.js')

  const ctx = await context({
    absWorkingDir: cwd,
    entryPoints: ['virtual:corge-dev-entry'],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    packages: 'external',
    plugins: [devBootstrapPlugin(cwd), corgeAliasPlugin(cwd)],
    outfile: outFile,
    sourcemap: true
  })

  await ctx.watch()

  const child = spawn(process.execPath, ['--watch', outFile], {
    cwd,
    env: process.env,
    stdio: 'inherit'
  })

  const cleanup = async (code: number) => {
    try {
      child.kill('SIGTERM')
      await ctx.dispose()
    } catch {}
    process.exit(code)
  }

  process.once('SIGINT', () => void cleanup(130))
  process.once('SIGTERM', () => void cleanup(143))

  await new Promise<void>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', async (code) => {
      await ctx.dispose()
      process.exitCode = code ?? 0
      resolve()
    })
  })
}
