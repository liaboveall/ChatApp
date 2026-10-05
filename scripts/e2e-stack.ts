#!/usr/bin/env bun
/**
 * The backend for browser tests, in the TEST environment (docs/08 section 4, APP_ENV=test): resets the test database,
 * bootstraps it, creates an administrator, clears the rate-limit counters, then runs the API and the worker. Playwright
 * starts this file as a web server and waits for the API's readiness URL (apps/web/playwright.config.ts).
 *
 *   bun --env-file=.env.local scripts/e2e-stack.ts
 *
 * It owns the test database while it runs: do not run the integration tests at the same time. The administrator's
 * credentials go to `.test-runs/e2e/admin.json` (mode 600, git-ignored); nothing secret is printed.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createValkey } from '../apps/server/src/lib/valkey.ts'
import { openTestDatabases, truncateAll } from '../apps/server/test/support/db.ts'
import { makeDeps } from '../apps/server/test/support/deps.ts'
import { testConfig } from '../apps/server/test/support/env.ts'
import { buildPerfFixture, PERF } from '../apps/server/test/support/perf-fixture.ts'

/** Repository root: Playwright starts this file from apps/web, so every path is anchored here. */
const ROOT = fileURLToPath(new URL('..', import.meta.url))

process.env.APP_ENV = 'test'
const API_PORT = process.env.E2E_API_PORT ?? '3102' // gitleaks:allow (a port number, not a credential)
const ORIGIN = process.env.E2E_APP_ORIGIN ?? 'http://localhost:4173'
const env = {
  ...process.env,
  APP_ENV: 'test',
  API_PORT,
  APP_ORIGIN: ORIGIN,
  LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? 'warn',
}
process.env.API_PORT = API_PORT
process.env.APP_ORIGIN = ORIGIN

const cli = (...args: string[]) =>
  Bun.spawn(['bun', 'apps/server/src/cli.ts', ...args], {
    cwd: ROOT,
    env,
    stdin: 'pipe',
    stdout: 'inherit',
    stderr: 'inherit',
  })

async function run(...args: string[]): Promise<void> {
  const child = cli(...args)
  child.stdin.end()
  if ((await child.exited) !== 0) throw new Error(`cli ${args[0]} failed`)
}

// 1. Schema and a clean slate.
await run('migrate')
const dbs = openTestDatabases()
await truncateAll(dbs.owner)
await dbs.close()
await run('db:bootstrap')

// 2. No leftovers from an earlier run in the limiters.
const config = testConfig()
const valkey = await createValkey(config.valkeyUrl, 'e2e-stack')
const keys = await valkey.keys('rl:test:*')
if (keys.length > 0) await valkey.del(...keys)
valkey.disconnect()

// 3. An administrator for the invitation flow.
const adminEmail = 'e2e-admin@example.test'
const adminPassword = `Zq9-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}-lantern`
const create = cli(
  'admin:create',
  '--email',
  adminEmail,
  '--username',
  'e2eadmin',
  '--name',
  'E2E Admin',
)
create.stdin.write(`${adminPassword}\n`)
create.stdin.end()
if ((await create.exited) !== 0) throw new Error('admin:create failed')
const dir = join(ROOT, '.test-runs', 'e2e')
mkdirSync(dir, { recursive: true, mode: 0o700 })
const file = join(dir, 'admin.json')
writeFileSync(
  file,
  JSON.stringify({ email: adminEmail, username: 'e2eadmin', password: adminPassword }),
)
chmodSync(file, 0o600)

// 3b. The conversation of ten thousand messages for the performance tests (docs/12 D-149), made before the API starts.
//     Its three people and their credentials go to `.test-runs/e2e/perf.json`, mode 600, like the administrator's.
{
  const perfDbs = openTestDatabases()
  const started = performance.now()
  const fixture = await buildPerfFixture(makeDeps(perfDbs.owner.db))
  await perfDbs.close()
  const perfFile = join(dir, 'perf.json')
  writeFileSync(
    perfFile,
    JSON.stringify({
      conversationId: fixture.conversationId,
      groupName: PERF.groupName,
      firstSeq: fixture.firstSeq,
      people: fixture.people,
    }),
  )
  chmodSync(perfFile, 0o600)
  console.log(`perf fixture ready in ${Math.round(performance.now() - started)} ms`)
}

// 4. The processes under test. With E2E_LOG_FILE the API's output goes to that file (path relative to this repository's
//    apps/web, where Playwright starts it) so that a suite can read what was logged; otherwise it goes to the console.
const logFile =
  process.env.E2E_LOG_FILE === undefined
    ? undefined
    : join(ROOT, 'apps', 'web', process.env.E2E_LOG_FILE)
if (logFile !== undefined) {
  mkdirSync(join(logFile, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(logFile, '', { mode: 0o600 })
}
const apiOutput = logFile === undefined ? 'inherit' : Bun.file(logFile)
const children = [
  Bun.spawn(['bun', 'apps/server/src/api.ts'], {
    cwd: ROOT,
    env,
    stdout: apiOutput,
    stderr: apiOutput,
  }),
  Bun.spawn(['bun', 'apps/server/src/worker.ts'], {
    cwd: ROOT,
    env,
    stdout: 'inherit',
    stderr: 'inherit',
  }),
]
const stop = (): void => {
  for (const child of children) child.kill('SIGTERM')
}
process.on('SIGTERM', () => {
  stop()
  setTimeout(() => process.exit(0), 500)
})
process.on('SIGINT', () => {
  stop()
  setTimeout(() => process.exit(0), 500)
})
// If either process dies, the whole stack is gone: let Playwright see it.
await Promise.race(children.map((child) => child.exited))
stop()
process.exit(1)
