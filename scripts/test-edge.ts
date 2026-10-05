#!/usr/bin/env bun
/**
 * The edge test suite, end to end on a developer's machine (docs/08, docs/12 D-147): builds and starts the gateway, runs
 * the suite against it (Playwright starts the test-environment API on port 3104 behind it), and stops the gateway again
 * whatever the outcome. It owns the test database while it runs and needs Docker Desktop to be running.
 *
 *   bun run test:edge [playwright arguments]
 */
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

async function run(command: string[], cwd = ROOT): Promise<number> {
  const child = Bun.spawn(command, { cwd, stdout: 'inherit', stderr: 'inherit' })
  return await child.exited
}

if ((await run(['bun', 'scripts/edge.ts', 'up'])) !== 0) {
  console.error('the gateway did not start')
  process.exit(1)
}
const code = await run(
  ['bun', 'run', 'e2e', '--config=playwright.edge.config.ts', ...process.argv.slice(2)],
  `${ROOT}/apps/web`,
)
await run(['bun', 'scripts/edge.ts', 'down'])
process.exit(code)
