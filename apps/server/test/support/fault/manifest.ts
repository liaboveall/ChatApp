/**
 * The fault-test manifest and its verification (D-085, SEC-41, AT-34). A fault action may only touch resources that are
 * provably THIS run's own independent instance. Verification never trusts names or ports alone: it checks the docker
 * project and run-id labels of every container, volume and network, the loopback port bindings, that none of the ports
 * is a development port, and a random per-run marker read back through the real database, Valkey and object store.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { S3Client, SQL } from 'bun'
import { Redis } from 'ioredis'
import { dockerAction, inspectContainer, inspectNetwork, inspectVolume } from './docker.ts'

export const FAULT_SERVICES = ['postgres', 'valkey', 'garage', 'mailpit'] as const
export type FaultService = (typeof FAULT_SERVICES)[number]

/**
 * Ports of the day-to-day development instance: a fault target must never publish any of them. The defaults of both
 * generations of the setup (5434 and 6379 before the ports became variables, 25434 and 26379 after, D-172), the ports the
 * services have always had, and what `.env.local` says now when the tests were started with it.
 */
const CONFIGURED_DEV_PORTS = ['POSTGRES_PORT', 'VALKEY_PORT', 'SMTP_PORT']
  .map((key) => Number(process.env[key]))
  .filter((port) => Number.isInteger(port) && port > 0)
export const DEV_PORTS = [
  ...new Set([
    5432,
    5434,
    6379,
    25434,
    26379,
    3900,
    3903,
    8025,
    1025,
    2525,
    12525,
    ...CONFIGURED_DEV_PORTS,
  ]),
]

export type FaultManifest = {
  runId: string
  project: string
  createdAt: string
  services: Record<FaultService, { containerId: string; port: number; marker?: string }>
  volumes: string[]
  networks: string[]
  endpoints: {
    databaseOwnerUrl: string
    databaseUrl: string
    valkeyUrl: string
    s3Endpoint: string
    s3Bucket: string
    s3AccessKeyId: string
    s3SecretAccessKey: string
    smtpPort: number
    /** The instance's Mailpit web/API port, to read what the worker delivered (absent in manifests of older runs). */
    mailpitUiPort?: number
  }
  markers: { postgres: string; valkey: string; garage: string }
}

export class FaultTargetRejected extends Error {
  /** The rejection comes from how the container engine reports a fresh instance, not from the target: a new one may verify. */
  readonly transient: boolean

  constructor(reason: string, options: { transient?: boolean } = {}) {
    super(`fault target rejected: ${reason}`)
    this.name = 'FaultTargetRejected'
    this.transient = options.transient ?? false
  }
}

export function loadManifest(path: string): FaultManifest {
  const absolute = resolve(path)
  const dir = dirname(absolute)
  if (basename(absolute) !== 'manifest.json' || basename(dirname(dir)) !== '.test-runs') {
    throw new FaultTargetRejected('manifest must be .test-runs/<runId>/manifest.json')
  }
  if (!existsSync(absolute)) throw new FaultTargetRejected('manifest not found')
  // The manifest holds credentials: it must be private to the user.
  if ((statSync(absolute).mode & 0o077) !== 0)
    throw new FaultTargetRejected('manifest permissions are too open')
  return JSON.parse(readFileSync(absolute, 'utf8')) as FaultManifest
}

export function expectedProject(runId: string): string {
  return `chatapp-test-${runId}`
}

export type FaultTarget = {
  manifest: FaultManifest
  /** The only way to act on the instance: by service name, re-verified against the container's labels each time. */
  act: (
    service: FaultService,
    action: 'stop' | 'start' | 'kill' | 'restart' | 'pause' | 'unpause',
  ) => Promise<void>
}

/** Throws FaultTargetRejected unless every check passes. Has no side effects. */
export async function verifyFaultTarget(
  manifest: FaultManifest,
  options: { skipMarkers?: boolean; allowStopped?: boolean } = {},
): Promise<FaultTarget> {
  if (process.env.APP_ENV !== 'test') throw new FaultTargetRejected('APP_ENV must be test')
  if (!/^[0-9a-f]{8}$/.test(manifest.runId)) throw new FaultTargetRejected('malformed run id')
  const project = expectedProject(manifest.runId)
  if (manifest.project !== project)
    throw new FaultTargetRejected('project name does not match the run id')

  for (const service of FAULT_SERVICES) {
    const entry = manifest.services[service]
    if (!entry?.containerId) throw new FaultTargetRejected(`${service} missing from manifest`)
    const info = await inspectContainer(entry.containerId)
    if (!info) throw new FaultTargetRejected(`${service}: container does not exist`)
    if (info.id !== entry.containerId)
      throw new FaultTargetRejected(`${service}: container id must be the full id`)
    if (info.labels['com.docker.compose.project'] !== project)
      throw new FaultTargetRejected(`${service}: not part of project ${project}`)
    if (info.labels['com.docker.compose.service'] !== service)
      throw new FaultTargetRejected(`${service}: wrong compose service`)
    if (info.labels['chatapp.test.run-id'] !== manifest.runId)
      throw new FaultTargetRejected(`${service}: run-id label mismatch`)
    for (const mount of info.mounts) {
      // Volumes must belong to this project; the only bind mount allowed is this run's own rendered config.
      if (mount.type === 'volume' && !manifest.volumes.includes(mount.name)) {
        throw new FaultTargetRejected(`${service}: mounts a volume that is not part of the run`)
      }
      if (mount.type === 'bind' && !mount.source.includes(`/.test-runs/${manifest.runId}/`)) {
        // Docker Desktop (WSL) has once reported its internal bind-mount path here. The check stays strict (a false
        // rejection only costs a rerun, the instance is removed by its project name); the hint saves the diagnosis.
        const hint = mount.source.startsWith('/run/desktop/')
          ? '; Docker Desktop reported an internal path, rerun once the engine has settled'
          : ''
        throw new FaultTargetRejected(
          `${service}: bind mount outside the run directory (${mount.source})${hint}`,
          { transient: mount.source.startsWith('/run/desktop/') },
        )
      }
    }
    // A stopped container publishes nothing, so its ports cannot be checked; that is only acceptable when tearing down.
    if (!info.running && !options.allowStopped) {
      throw new FaultTargetRejected(`${service}: container is not running`)
    }
    const published = Object.values(info.ports).flat()
    for (const binding of published) {
      if (binding.hostIp !== '127.0.0.1')
        throw new FaultTargetRejected(`${service}: published on a non-loopback address`)
      if (DEV_PORTS.includes(binding.hostPort))
        throw new FaultTargetRejected(`${service}: publishes a development port`)
    }
    if (info.running && !published.some((b) => b.hostPort === entry.port)) {
      throw new FaultTargetRejected(`${service}: manifest port is not published by the container`)
    }
  }
  for (const name of manifest.volumes) {
    const volume = await inspectVolume(name)
    if (!volume || volume.labels['com.docker.compose.project'] !== project)
      throw new FaultTargetRejected('volume does not belong to the run')
  }
  for (const id of manifest.networks) {
    const network = await inspectNetwork(id)
    if (!network || network.labels['com.docker.compose.project'] !== project)
      throw new FaultTargetRejected('network does not belong to the run')
  }

  const e = manifest.endpoints
  const databaseName = new URL(e.databaseOwnerUrl).pathname.slice(1)
  if (databaseName !== 'chatapp_test')
    throw new FaultTargetRejected('database name must be chatapp_test')
  for (const url of [e.databaseOwnerUrl, e.databaseUrl, e.valkeyUrl, e.s3Endpoint]) {
    const parsed = new URL(url)
    if (parsed.hostname !== '127.0.0.1')
      throw new FaultTargetRejected('endpoints must be on 127.0.0.1')
    if (DEV_PORTS.includes(Number(parsed.port)))
      throw new FaultTargetRejected('endpoint uses a development port')
  }

  if (!options.skipMarkers) await verifyMarkers(manifest)

  return {
    manifest,
    act: async (service, action) => {
      // Re-check the labels right before acting: the id in the manifest is only trusted if it still carries this run's labels.
      const info = await inspectContainer(manifest.services[service].containerId)
      if (
        !info ||
        info.labels['com.docker.compose.project'] !== project ||
        info.labels['chatapp.test.run-id'] !== manifest.runId
      ) {
        throw new FaultTargetRejected(`${service}: labels changed or container vanished`)
      }
      await dockerAction(action, info.id)
    },
  }
}

/** A check that cannot answer in time counts as "not reachable": verification must never hang. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new FaultTargetRejected(`${what} is not reachable at the manifest endpoint`)),
      ms,
    )
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** Reads the random marker back through the real services: only the instance created for this run can answer correctly. */
async function verifyMarkers(manifest: FaultManifest): Promise<void> {
  const e = manifest.endpoints
  const sql = new SQL({ url: e.databaseOwnerUrl, max: 1, connectionTimeout: 5 })
  try {
    const [row] = await within(
      sql`select current_setting('chatapp.instance_marker', true) as marker`.then((rows) => rows),
      6000,
      'postgres',
    )
    if (row?.marker !== manifest.markers.postgres)
      throw new FaultTargetRejected('postgres instance marker mismatch')
  } catch (error) {
    if (error instanceof FaultTargetRejected) throw error
    throw new FaultTargetRejected('postgres is not reachable at the manifest endpoint')
  } finally {
    // Closing a connection that never opened can block; do not wait for it.
    void sql.close().catch(() => undefined)
  }
  const valkey = new Redis(e.valkeyUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    connectTimeout: 3000,
  })
  valkey.on('error', () => undefined)
  try {
    await within(valkey.connect(), 5000, 'valkey')
    if (
      (await within(valkey.get('chatapp:instance-marker'), 5000, 'valkey')) !==
      manifest.markers.valkey
    )
      throw new FaultTargetRejected('valkey instance marker mismatch')
  } catch (error) {
    if (error instanceof FaultTargetRejected) throw error
    throw new FaultTargetRejected('valkey is not reachable at the manifest endpoint')
  } finally {
    valkey.disconnect()
  }
  const s3 = new S3Client({
    endpoint: e.s3Endpoint,
    region: 'garage',
    bucket: e.s3Bucket,
    accessKeyId: e.s3AccessKeyId,
    secretAccessKey: e.s3SecretAccessKey,
  })
  try {
    if (
      (await within(s3.file('.instance-marker').text(), 6000, 'object store')) !==
      manifest.markers.garage
    )
      throw new FaultTargetRejected('object store instance marker mismatch')
  } catch (error) {
    if (error instanceof FaultTargetRejected) throw error
    throw new FaultTargetRejected('object store is not reachable at the manifest endpoint')
  }
}

/** A stable fingerprint of what a manifest points at, for the run log (no secrets). */
export function manifestFingerprint(manifest: FaultManifest): string {
  const ids = FAULT_SERVICES.map((s) => manifest.services[s].containerId).join(',')
  return createHash('sha256').update(`${manifest.project}:${ids}`).digest('hex').slice(0, 12)
}
