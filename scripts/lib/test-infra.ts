/**
 * Lifecycle of the isolated fault-test instance (D-085). `startInstance` creates a brand-new compose project with random
 * secrets and ports, bootstraps it and writes a manifest; `stopInstance` removes exactly that project after verifying the
 * manifest, and refuses to touch anything it cannot prove belongs to the run. There is no prune, no name matching.
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { $, RedisClient, S3Client } from 'bun'
import {
  DEV_PORTS,
  expectedProject,
  FAULT_SERVICES,
  type FaultManifest,
  type FaultService,
  loadManifest,
  verifyFaultTarget,
} from '../../apps/server/test/support/fault/manifest.ts'
import { runBootstrap } from '../../packages/db/src/bootstrap.ts'
import { createDatabase } from '../../packages/db/src/client.ts'
import { runMigrations } from '../../packages/db/src/migrate.ts'

export const RUNS_DIR = resolve('.test-runs')
const COMPOSE_FILE = 'infra/compose.test.yml'
const GARAGE_TEMPLATE = 'infra/garage/garage.toml.template'

const hex = (bytes: number) => randomBytes(bytes).toString('hex')
const token = (bytes: number) => randomBytes(bytes).toString('base64url')

type Ports = { postgres: number; valkey: number; garage: number; smtp: number; mailpitUi: number }

function composeEnv(runId: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    TEST_RUN_ID: runId,
    TEST_PG_PASSWORD: 'unused-by-down',
    TEST_VALKEY_PASSWORD: 'unused-by-down',
    TEST_GARAGE_CONFIG: join(RUNS_DIR, runId, 'garage.toml'),
    // Ports are only interpolated (never bound) by `down`, `ps` and `exec`.
    TEST_PG_PORT: '1',
    TEST_VALKEY_PORT: '1',
    TEST_GARAGE_PORT: '1',
    TEST_SMTP_PORT: '1',
    TEST_MAILPIT_UI_PORT: '1',
    ...extra,
  }
}

/** Free loopback ports, picked once per run and fixed afterwards, so a restarted container keeps its endpoint. */
function freePorts(count: number): number[] {
  const listeners = Array.from({ length: count }, () =>
    Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } }),
  )
  const ports = listeners.map((listener) => listener.port)
  for (const listener of listeners) listener.stop(true)
  if (new Set(ports).size !== count || ports.some((port) => DEV_PORTS.includes(port))) {
    return freePorts(count)
  }
  return ports
}

async function compose(
  runId: string,
  args: string[],
  env: Record<string, string>,
): Promise<string> {
  const project = expectedProject(runId)
  const result = await $`docker compose -p ${project} -f ${COMPOSE_FILE} ${args}`
    .env(env)
    .quiet()
    .nothrow()
  if (result.exitCode !== 0)
    throw new Error(
      `docker compose ${args[0]} failed: ${result.stderr.toString().split('\n').slice(-3).join(' ').trim()}`,
    )
  return result.stdout.toString()
}

async function garage(runId: string, env: Record<string, string>, args: string[]): Promise<string> {
  return await compose(runId, ['exec', '-T', 'garage', '/garage', ...args], env)
}

export async function startInstance(): Promise<{ manifestPath: string; manifest: FaultManifest }> {
  const runId = hex(4)
  const project = expectedProject(runId)
  const dir = join(RUNS_DIR, runId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })

  const secrets = {
    pg: hex(16),
    appDb: hex(16),
    valkey: hex(16),
    s3KeyId: `GK${hex(12)}`,
    s3Secret: hex(32),
    bucket: 'chatapp-test',
  }
  const markers = { postgres: hex(12), valkey: hex(12), garage: hex(12) }

  // Per-run Garage config from the same template the dev instance uses, with fresh secrets.
  const template = await Bun.file(GARAGE_TEMPLATE).text()
  const garageConfig = join(dir, 'garage.toml')
  writeFileSync(
    garageConfig,
    template
      .replaceAll('{{GARAGE_RPC_SECRET}}', hex(32))
      .replaceAll('{{GARAGE_ADMIN_TOKEN}}', token(32))
      .replaceAll('{{GARAGE_METRICS_TOKEN}}', token(32)),
    { mode: 0o600 },
  )
  const envFor = (chosen: Ports) =>
    composeEnv(runId, {
      TEST_PG_PASSWORD: secrets.pg,
      TEST_VALKEY_PASSWORD: secrets.valkey,
      TEST_GARAGE_CONFIG: garageConfig,
      TEST_PG_PORT: String(chosen.postgres),
      TEST_VALKEY_PORT: String(chosen.valkey),
      TEST_GARAGE_PORT: String(chosen.garage),
      TEST_SMTP_PORT: String(chosen.smtp),
      TEST_MAILPIT_UI_PORT: String(chosen.mailpitUi),
    })
  let ports: Ports = { postgres: 0, valkey: 0, garage: 0, smtp: 0, mailpitUi: 0 }
  let env = composeEnv(runId)

  try {
    // A port that looked free inside WSL can still be taken or reserved on the Windows side that publishes it: retry.
    for (let attempt = 1; ; attempt += 1) {
      const [postgres, valkey, garage, smtp, mailpitUi] = freePorts(5) as [
        number,
        number,
        number,
        number,
        number,
      ]
      ports = { postgres, valkey, garage, smtp, mailpitUi }
      env = envFor(ports)
      try {
        await compose(runId, ['up', '-d', '--wait'], env)
        break
      } catch (error) {
        if (attempt >= 3) throw error
        await compose(runId, ['down', '-v', '--remove-orphans'], env).catch(() => undefined)
      }
    }

    const containerIds = {} as Record<FaultService, string>
    for (const service of FAULT_SERVICES) {
      const id = (await compose(runId, ['ps', '-q', service], env)).trim()
      if (!/^[0-9a-f]{64}$/.test(id)) throw new Error(`no container id for ${service}`)
      containerIds[service] = id
    }
    const volumes = (
      await $`docker volume ls -q --filter label=com.docker.compose.project=${project}`
        .quiet()
        .text()
    )
      .split('\n')
      .filter(Boolean)
    const networks = (
      await $`docker network ls -q --no-trunc --filter label=com.docker.compose.project=${project}`
        .quiet()
        .text()
    )
      .split('\n')
      .filter(Boolean)

    // Garage: single-node layout, the run's key and bucket (same steps as scripts/bootstrap-garage.ts).
    const nodeId = (await garage(runId, env, ['node', 'id', '-q'])).trim().split('@')[0] ?? ''
    await garage(runId, env, ['layout', 'assign', '-z', 'dc1', '-c', '1G', nodeId])
    await garage(runId, env, ['layout', 'apply', '--version', '1'])
    await garage(runId, env, [
      'key',
      'import',
      '--yes',
      '-n',
      `chatapp-test-${runId}`,
      secrets.s3KeyId,
      secrets.s3Secret,
    ])
    await garage(runId, env, ['bucket', 'create', secrets.bucket])
    await garage(runId, env, [
      'bucket',
      'allow',
      '--read',
      '--write',
      '--owner',
      secrets.bucket,
      '--key',
      secrets.s3KeyId,
    ])

    const ownerUrl = `postgres://chatapp:${secrets.pg}@127.0.0.1:${ports.postgres}/chatapp_test`
    const appUrl = `postgres://chatapp_app:${secrets.appDb}@127.0.0.1:${ports.postgres}/chatapp_test`
    const valkeyUrl = `redis://:${secrets.valkey}@127.0.0.1:${ports.valkey}/1`
    const s3Endpoint = `http://127.0.0.1:${ports.garage}`

    await runMigrations({ ownerUrl, appRole: { role: 'chatapp_app', password: secrets.appDb } })
    const owner = createDatabase(ownerUrl, { max: 1, applicationName: 'chatapp-test-infra' })
    try {
      await runBootstrap(owner.db, {
        agentUsername: 'assistant',
        agentDisplayName: '助手',
        productName: 'ChatApp',
      })
      await owner.client.unsafe(
        `alter database chatapp_test set "chatapp.instance_marker" = '${markers.postgres}'`,
      )
    } finally {
      await owner.close()
    }
    const valkey = new RedisClient(valkeyUrl)
    await valkey.set('chatapp:instance-marker', markers.valkey)
    valkey.close()
    await new S3Client({
      endpoint: s3Endpoint,
      region: 'garage',
      bucket: secrets.bucket,
      accessKeyId: secrets.s3KeyId,
      secretAccessKey: secrets.s3Secret,
    }).write('.instance-marker', markers.garage)

    const manifest: FaultManifest = {
      runId,
      project,
      createdAt: new Date().toISOString(),
      services: {
        postgres: { containerId: containerIds.postgres, port: ports.postgres },
        valkey: { containerId: containerIds.valkey, port: ports.valkey },
        garage: { containerId: containerIds.garage, port: ports.garage },
        mailpit: { containerId: containerIds.mailpit, port: ports.smtp },
      },
      volumes,
      networks,
      endpoints: {
        databaseOwnerUrl: ownerUrl,
        databaseUrl: appUrl,
        valkeyUrl,
        s3Endpoint,
        s3Bucket: secrets.bucket,
        s3AccessKeyId: secrets.s3KeyId,
        s3SecretAccessKey: secrets.s3Secret,
        smtpPort: ports.smtp,
      },
      markers,
    }
    const manifestPath = join(dir, 'manifest.json')
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 })
    chmodSync(manifestPath, 0o600)
    // Self-check: the new instance must pass the very verification the fault suite will apply.
    process.env.APP_ENV = 'test'
    await verifyFaultTarget(manifest)
    return { manifestPath, manifest }
  } catch (error) {
    // A half-started instance is removed by its own project name; nothing else is touched.
    await compose(runId, ['down', '-v', '--remove-orphans'], env).catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
}

/**
 * Removes the instance of one run. The manifest must verify (labels, ids, ports, volumes, networks); otherwise nothing
 * is deleted. Containers are never matched by name or prefix; the compose project of the run is the only scope.
 */
export async function stopInstance(runId: string): Promise<'removed' | 'already-gone'> {
  if (!/^[0-9a-f]{8}$/.test(runId)) throw new Error('invalid run id')
  const dir = join(RUNS_DIR, runId)
  const project = expectedProject(runId)
  const present = (
    await $`docker ps -aq --filter label=com.docker.compose.project=${project}`.quiet().text()
  ).trim()
  if (present === '') {
    // Nothing of this run exists any more (removed by hand): clean up the directory only.
    rmSync(dir, { recursive: true, force: true })
    return 'already-gone'
  }
  process.env.APP_ENV = 'test'
  await verifyFaultTarget(loadManifest(join(dir, 'manifest.json')), {
    skipMarkers: true,
    allowStopped: true,
  })
  await compose(runId, ['down', '-v', '--remove-orphans'], composeEnv(runId))
  rmSync(dir, { recursive: true, force: true })
  return 'removed'
}

export function listRuns(): string[] {
  return existsSync(RUNS_DIR)
    ? readdirSync(RUNS_DIR).filter((name) => /^[0-9a-f]{8}$/.test(name))
    : []
}
