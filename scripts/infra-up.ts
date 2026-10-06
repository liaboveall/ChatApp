#!/usr/bin/env bun
/**
 * `bun run infra:up [service…]`: starts the development containers and waits until they are healthy (what
 * `docker compose up -d --wait` did), and then checks what that command cannot: that every host port the services
 * publish is really there and answers.
 *
 * Docker Desktop publishes container ports on the Windows host, and a port inside a range that Windows has reserved is
 * dropped without an error (D-172): the container is healthy and nothing can reach it. So before it starts anything, a
 * configured port that Windows has reserved is refused, with the port to take instead; and after it started, a port that
 * is not published or does not answer fails the command with the same advice. INFRA_SKIP_PORT_CHECK=1 turns the checks off.
 */
import { $ } from 'bun'
import { getEnv, isUnset, readEnvFile } from './lib/env-file.ts'
import {
  infraPorts,
  parseComposePs,
  publishedProblems,
  reservedProblems,
  urlProblems,
  waitReachable,
  windowsPorts,
} from './lib/ports.ts'

const services = process.argv.slice(2).filter((argument) => argument !== '--')
const checks = process.env.INFRA_SKIP_PORT_CHECK !== '1'

const env = await readEnvFile('.env.local')
const read = (key: string): string | undefined => {
  const value = getEnv(env, key)
  return value === undefined || isUnset(value) ? undefined : value
}
const plan = infraPorts(read).filter(
  (entry) => services.length === 0 || services.includes(entry.service),
)

function refuse(headline: string, problems: string[]): never {
  console.error(`\ninfra:up: ${headline}`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

if (checks) {
  const reserved = reservedProblems(plan, await windowsPorts())
  if (reserved.length > 0) refuse('not started, a host port is reserved by Windows:', reserved)
}

const started = Bun.spawn(
  [
    'docker',
    'compose',
    '-f',
    'infra/compose.dev.yml',
    '--env-file',
    '.env.local',
    'up',
    '-d',
    '--wait',
    ...services,
  ],
  { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
)
const code = await started.exited
if (code !== 0) process.exit(code)
if (!checks) process.exit(0)

const rows = parseComposePs(
  await $`docker compose -f infra/compose.dev.yml --env-file .env.local ps --format json`
    .quiet()
    .text(),
)
const unpublished = publishedProblems(rows, plan)
if (unpublished.length > 0)
  refuse('the containers are healthy, but a host port is not published:', unpublished)

const silent: string[] = []
for (const entry of plan) {
  if (!(await waitReachable(entry.port))) {
    silent.push(
      `nothing answers on 127.0.0.1:${entry.port} (${entry.name}) although ${entry.service} publishes it. Docker Desktop may still be starting its forwarder: run \`bun run doctor\` in a moment; if it stays, a range Windows reserved (\`netsh interface ipv4 show excludedportrange protocol=tcp\`) is the usual cause.`,
    )
  }
}
if (silent.length > 0) refuse('the host ports are published, but not answering:', silent)

for (const warning of urlProblems(read, plan)) console.warn(`infra:up: warning: ${warning}`)
console.log(
  `infra:up: ${plan.length} host ports published and answering (${plan.map((entry) => `${entry.service} :${entry.port}`).join(', ')})`,
)
