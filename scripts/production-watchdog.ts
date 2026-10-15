/** Host-only watchdog. There is no Docker socket in an application container. Never prune or restart dependencies. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  type ContainerObservation,
  containerObservationSchema,
  deploymentIdentitySchema,
  type WatchdogEntry,
  watchdogStateSchema,
} from '../packages/contracts/src/operations.ts'
import { readRawEnvironment } from './production.ts'

type Observed = ContainerObservation
export type WatchdogState = WatchdogEntry
export function watchdogDecision(
  state: WatchdogState | undefined,
  current: Observed,
  now: number,
  dependenciesHealthy: boolean,
) {
  const same =
    state !== undefined &&
    state.id === current.id &&
    now - state.observedAt >= 20_000 &&
    now - state.observedAt <= 90_000
  const restarts = (state?.restarts ?? []).filter((time) => time > now - 15 * 60_000)
  const bad = !current.running || current.health === 'unhealthy'
  const failures = bad ? (same ? (state?.failures ?? 0) + 1 : 1) : 0
  return {
    state: { id: current.id, failures, restarts, observedAt: now },
    restart: bad && failures >= 3 && restarts.length < 3 && dependenciesHealthy,
    alert: bad && (failures >= 3 || !dependenciesHealthy),
  }
}
async function capture(args: string[]) {
  const child = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
  const [out] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if ((await child.exited) !== 0) throw new Error('watchdog engine query failed')
  return out
}
async function inspect(id: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('full container identity required')
  const value = await capture([
    'docker',
    'inspect',
    id,
    '--format',
    '{"id":{{json .Id}},"running":{{json .State.Running}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}"missing"{{end}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"owner":{{json (index .Config.Labels "chatapp.production.owner")}},"release":{{json (index .Config.Labels "chatapp.production.release")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}}}',
  ])
  return containerObservationSchema.parse(JSON.parse(value))
}
async function main() {
  const directory = resolve(process.argv[2] ?? '')
  const env = readRawEnvironment(await readFile(join(directory, 'compose.env'), 'utf8'))
  const identity = deploymentIdentitySchema.parse(env)
  const owner = identity.CHATAPP_OWNER,
    project = identity.CHATAPP_PROJECT,
    release = identity.APPLICATION_SOURCE_HASH
  const belongs = (item: Observed) =>
    item.owner === owner && item.project === project && item.release === release
  const stateDirectory = join(directory, 'watchdog')
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 })
  // Atomic host lock: a stuck/crashed watchdog cannot silently overlap another restart controller.
  const lock = join(stateDirectory, 'lock')
  await mkdir(lock, { mode: 0o700 })
  try {
    const ids = (
      await capture([
        'docker',
        'ps',
        '--all',
        '--no-trunc',
        '--quiet',
        '--filter',
        `label=com.docker.compose.project=${project}`,
        '--filter',
        `label=chatapp.production.owner=${owner}`,
      ])
    )
      .trim()
      .split('\n')
      .filter(Boolean)
    const observed = await Promise.all(ids.map(inspect))
    if (observed.some((item) => !belongs(item)))
      throw new Error('container ownership or release changed')
    const dependenciesHealthy = ['postgres', 'valkey', 'garage'].every((service) =>
      observed.some(
        (item) => item.service === service && item.running && item.health === 'healthy',
      ),
    )
    const path = join(stateDirectory, 'state.json')
    let state: Record<string, WatchdogState> = {}
    try {
      state = watchdogStateSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
        throw error
    }
    let alerts = 0,
      restarted = 0
    for (const service of ['api', 'worker', 'media']) {
      const matching = observed.filter((item) => item.service === service)
      if (matching.length !== 1) {
        alerts++
        continue
      }
      const item = matching[0]
      if (!item) continue
      const decision = watchdogDecision(state[service], item, Date.now(), dependenciesHealthy)
      state[service] = decision.state
      if (decision.alert) alerts++
      if (decision.restart) {
        const dependencies = await Promise.all(
          observed
            .filter((item) => ['postgres', 'valkey', 'garage'].includes(item.service))
            .map((item) => inspect(item.id)),
        )
        if (
          !['postgres', 'valkey', 'garage'].every(
            (service) =>
              dependencies.filter((item) => item.service === service).length === 1 &&
              dependencies.some(
                (item) =>
                  item.service === service &&
                  belongs(item) &&
                  item.running &&
                  item.health === 'healthy',
              ),
          )
        )
          continue
        const fresh = await inspect(item.id)
        if (
          !belongs(fresh) ||
          fresh.service !== service ||
          (fresh.running && fresh.health !== 'unhealthy')
        )
          continue
        // Persist the budget before the restart. Losing the response must not grant an unbounded retry budget.
        decision.state.restarts.push(Date.now())
        decision.state.failures = 0
        await writeFile(`${path}.tmp`, JSON.stringify(state) + '\n', { mode: 0o600 })
        await rename(`${path}.tmp`, path)
        await capture(['docker', 'restart', '--time', '20', item.id])
        restarted++
      }
    }
    await writeFile(`${path}.tmp`, JSON.stringify(state) + '\n', { mode: 0o600 })
    await rename(`${path}.tmp`, path)
    console.log(
      JSON.stringify({ event: 'watchdog.observation', alerts, restarted, dependenciesHealthy }),
    )
    if (alerts) process.exitCode = 1
  } finally {
    const { rmdir } = await import('node:fs/promises')
    await rmdir(lock)
  }
}
if (import.meta.main)
  main().catch(() => {
    console.error('watchdog failed; no unverified container is approved for restart')
    process.exitCode = 1
  })
