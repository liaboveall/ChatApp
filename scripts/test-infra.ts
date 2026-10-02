/**
 * bun run test:infra:up      start an isolated fault-test instance (random ports and secrets) and print its run id
 * bun run test:infra:down    remove one run:  bun run test:infra:down <runId>   (or --latest)
 * Never touches the development instance. See docs/09 "故障测试环境".
 */
import { listRuns, startInstance, stopInstance } from './lib/test-infra.ts'

const [command, argument] = process.argv.slice(2)

if (command === 'up') {
  const { manifestPath, manifest } = await startInstance()
  console.log(`run ${manifest.runId} is up (project ${manifest.project})`)
  console.log(`manifest: ${manifestPath}`)
  console.log(
    `run the fault suite with: CHATAPP_FAULT_MANIFEST=${manifestPath} APP_ENV=test bun --env-file=.env.local test ./apps/server/test/fault`,
  )
} else if (command === 'down') {
  const runs = listRuns()
  const runId = argument === '--latest' ? runs.at(-1) : argument
  if (!runId) {
    console.error(
      `usage: test:infra:down <runId>|--latest   (runs present: ${runs.join(', ') || 'none'})`,
    )
    process.exit(1)
  }
  console.log(`run ${runId}: ${await stopInstance(runId)}`)
} else if (command === 'list') {
  console.log(listRuns().join('\n') || 'no runs')
} else {
  console.error('usage: test-infra.ts up | down <runId>|--latest | list')
  process.exit(1)
}
