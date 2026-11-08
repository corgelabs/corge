import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { build } from 'esbuild'
import { corgeAliasPlugin, getCorgeRootDir } from './builder'
import { loadGcpSecrets } from './env'

export const runTypeCheck = (cwd = process.cwd()): void => {
  const res = spawnSync('npx', ['tsc', '--noEmit'], { cwd, stdio: 'inherit' })
  process.exitCode = res.status ?? 1
}

export const runTestSuite = async (testFile?: string, cwd = process.cwd()): Promise<void> => {
  await loadGcpSecrets(undefined, cwd)
  const corgeRoot = getCorgeRootDir()
  const outDir = join(cwd, '.corge')
  mkdirSync(outDir, { recursive: true })
  const outFile = join(outDir, 'test.js')

  const resolvedEntry = (() => {
    if (testFile) return resolve(cwd, testFile)
    const localTest = join(cwd, 'tests/e2e.test.ts')
    if (existsSync(localTest)) return localTest
    return join(corgeRoot, 'tests/e2e.test.ts')
  })()

  await build({
    absWorkingDir: cwd,
    entryPoints: [resolvedEntry],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    packages: 'external',
    plugins: [corgeAliasPlugin(cwd)],
    outfile: outFile,
    sourcemap: true
  })

  const res = spawnSync(process.execPath, ['--test', outFile], {
    cwd,
    env: process.env,
    stdio: 'inherit'
  })
  process.exitCode = res.status ?? 1
}

export const linkCorge = (targetPath = '/Users/nikdelvin/corgelabs/corge', cwd = process.cwd()): void => {
  const resolvedTarget = resolve(cwd, targetPath)
  const linkDest = join(cwd, 'node_modules/@corgelabs/corge')
  mkdirSync(dirname(linkDest), { recursive: true })
  rmSync(linkDest, { recursive: true, force: true })
  symlinkSync(resolvedTarget, linkDest, 'dir')
  console.log(`Linked ${linkDest} -> ${resolvedTarget}`)
}

export const unlinkCorge = (cwd = process.cwd()): void => {
  const linkDest = join(cwd, 'node_modules/@corgelabs/corge')
  rmSync(linkDest, { recursive: true, force: true })
  const res = spawnSync('npm', ['install', '@corgelabs/corge@latest'], { cwd, stdio: 'inherit' })
  process.exitCode = res.status ?? 1
}

export const initConsumerProject = (cwd = process.cwd()): void => {
  mkdirSync(join(cwd, 'src/config'), { recursive: true })
  mkdirSync(join(cwd, 'src/routes'), { recursive: true })
  mkdirSync(join(cwd, 'src/services'), { recursive: true })
  mkdirSync(join(cwd, 'src/context'), { recursive: true })

  const writeIfMissing = (relPath: string, content: string) => {
    const full = join(cwd, relPath)
    if (!existsSync(full)) {
      writeFileSync(full, content, 'utf8')
      console.log(`Created ${relPath}`)
    }
  }

  writeIfMissing(
    'tsconfig.json',
    JSON.stringify(
      {
        extends: '@corgelabs/corge/tsconfig.base.json',
        compilerOptions: {
          paths: {
            '@core': ['./node_modules/@corgelabs/corge/dist/index.d.ts'],
            '@routes/*': ['./src/routes/*'],
            '@services/*': ['./src/services/*'],
            '@utils/*': ['./src/utils/*'],
            '@config/*': ['./src/config/*']
          }
        },
        include: ['src/**/*.ts']
      },
      null,
      2
    ) + '\n'
  )

  writeIfMissing(
    'src/index.ts',
    [
      "import { core } from '@core'",
      '',
      'export const coreApp = core.createApp({})',
      '',
      'export const {',
      '  createApp,',
      '  app,',
      '  devApp,',
      '  workflowRegistry,',
      '  httpHandler,',
      '  devHttpHandler,',
      '  tasksHandler,',
      '  devTasksHandler,',
      '  functions',
      '} = coreApp',
      ''
    ].join('\n')
  )

  writeIfMissing(
    '.gitignore',
    ['node_modules/', 'dist/', '.corge/', '.env', '*.local', 'firebase-debug.log', '.DS_Store', ''].join('\n')
  )
}
