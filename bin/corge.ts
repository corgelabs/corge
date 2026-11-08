import { buildConsumerApp } from '../src/cli/builder'
import { deployConsumerApp } from '../src/cli/deployer'
import { runDevServer } from '../src/cli/dev-server'
import { runWithGcpEnv } from '../src/cli/env'
import { initConsumerProject, linkCorge, runTestSuite, runTypeCheck, unlinkCorge } from '../src/cli/init'

const [command, ...rest] = process.argv.slice(2)

switch (command) {
  case 'dev':
    await runDevServer()
    break
  case 'build':
    await buildConsumerApp()
    break
  case 'deploy':
    await deployConsumerApp(rest[0] as 'prod' | 'dev' | undefined)
    break
  case 'test':
  case 'test:chaos':
    await runTestSuite(rest[0])
    break
  case 'check':
    runTypeCheck()
    break
  case 'init':
    initConsumerProject()
    break
  case 'link':
    linkCorge(rest[0])
    break
  case 'unlink':
    unlinkCorge()
    break
  case 'env': {
    const sep = rest.indexOf('--')
    const secrets = sep === -1 ? [] : rest.slice(0, sep)
    const cmd = sep === -1 ? rest : rest.slice(sep + 1)
    if (cmd.length === 0) {
      console.error('Usage: corge env [SECRET_NAMES...] -- <command...>')
      process.exit(1)
    }
    process.exit(await runWithGcpEnv(cmd, secrets))
    break
  }
  default:
    console.log(
      [
        'Corge CLI (@corgelabs/corge)',
        '',
        'Commands:',
        '  corge dev                  Start local Hono dev server with GCP Secret Manager + watch mode',
        '  corge build                Bundle src/index.ts + @corgelabs/corge into dist/index.cjs',
        '  corge deploy <prod|dev>    Build, merge base rules/indexes, and deploy to Firebase',
        '  corge test [file]          Bundle and execute E2E contract test suite',
        '  corge check                Run tsc --noEmit in workspace',
        '  corge init                 Scaffold consumer project structure',
        '  corge link [path]          Link local corgelabs/corge checkout into node_modules',
        '  corge unlink               Restore published @corgelabs/corge from npm'
      ].join('\n')
    )
    if (command && command !== '--help' && command !== '-h') {
      process.exit(1)
    }
}
