/**
 * bun run test:fault   start a fresh isolated instance, run the fault suite against it, always remove the instance.
 * The suite (apps/server/test/fault) refuses to run against anything but a verified instance (D-085, AT-34).
 */
import { $ } from 'bun'
import { startInstance, stopInstance } from './lib/test-infra.ts'

const { manifestPath, manifest } = await startInstance()
console.log(`fault run ${manifest.runId} up; running the suite`)
let code = 1
try {
  const result = await $`bun --env-file=.env.local test ./apps/server/test/fault`
    .env({
      ...(process.env as Record<string, string>),
      APP_ENV: 'test',
      CHATAPP_FAULT_MANIFEST: manifestPath,
    })
    .nothrow()
  code = result.exitCode
} finally {
  console.log(
    `fault run ${manifest.runId}: ${await stopInstance(manifest.runId).catch((error) => `cleanup failed (${(error as Error).message})`)}`,
  )
}
process.exit(code)
