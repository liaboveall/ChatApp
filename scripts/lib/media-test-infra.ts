/** Real, per-run V-18 infrastructure. No exported action accepts a container name or unverified Docker target. */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { SQL } from 'bun'
import { mediaEnvironment } from '../../apps/media/src/runtime/environment.ts'
import { enqueueWork } from '../../apps/server/src/domain/work.ts'
import type { ClientInput } from '../../apps/server/test/media/container-client.ts'
import {
  type FaultManifest,
  FaultTargetRejected,
  loadManifest,
  manifestFingerprint,
  verifyFaultTarget,
} from '../../apps/server/test/support/fault/manifest.ts'
import { createDatabase } from '../../packages/db/src/client.ts'
import { startInstance, stopInstance } from './test-infra.ts'

const MiB = 1024 * 1024
const SERVICES = ['media', 'worker', 'api'] as const
export type MediaTestService = (typeof SERVICES)[number]
export type ImageKind = 'runtime' | 'fault'
const LIMITS = { media: 512 * MiB, worker: 1536 * MiB, api: 1024 * MiB }
const BASE_ENV = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', TMPDIR: '/tmp' }
const TMPFS = 'size=268435456,mode=1777,nosuid,nodev,noexec'
const DOCKER_ENV = [
  'PATH',
  'HOME',
  'DOCKER_CONFIG',
  'DOCKER_CONTEXT',
  'DOCKER_HOST',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
  'XDG_CONFIG_HOME',
  'XDG_RUNTIME_DIR',
]
const ROOT = resolve('.')
const COMPOSE_FILE = 'infra/compose.test.yml'

type DockerContainer = {
  Id: string
  Image: string
  State: { Running: boolean; OOMKilled: boolean; StartedAt: string; ExitCode: number; Pid: number }
  Config: {
    User: string
    Env: string[]
    Cmd: string[]
    Entrypoint: string[] | null
    WorkingDir: string
    Labels: Record<string, string>
    Tty: boolean
    OpenStdin: boolean
  }
  HostConfig: {
    NetworkMode: string
    IpcMode: string
    PidMode: string
    UsernsMode: string
    CgroupnsMode: string
    ReadonlyRootfs: boolean
    Privileged: boolean
    Init: boolean
    Memory: number
    MemorySwap: number
    PidsLimit: number
    CapDrop: string[]
    CapAdd: string[] | null
    SecurityOpt: string[]
    Tmpfs: Record<string, string>
    Binds: string[] | null
    Devices: unknown[] | null
    DeviceRequests: unknown[] | null
    DeviceCgroupRules: string[] | null
    VolumesFrom: string[] | null
    PortBindings: Record<string, unknown>
    PublishAllPorts: boolean
    ExtraHosts: string[] | null
    Links: string[] | null
    Dns: string[]
    Sysctls: Record<string, string> | null
    RestartPolicy: { Name: string }
    MaskedPaths: string[]
    ReadonlyPaths: string[]
  }
  Mounts: Array<{
    Type: string
    Name?: string
    Source: string
    Destination: string
    RW: boolean
    Driver?: string
    Propagation: string
  }>
  NetworkSettings: {
    Networks: Record<string, { NetworkID: string; IPAddress: string }>
    Ports: Record<string, unknown>
  }
}
type Volume = {
  Name: string
  Mountpoint: string
  Driver: string
  Scope: string
  Labels: Record<string, string>
  Options: Record<string, string> | null
}
type ExtraTarget = { id: string; imageId: string; kind: ImageKind; service: MediaTestService }
export type CgroupSnapshot = {
  memoryMax: number
  memorySwapMax: number
  memoryCurrent: number
  memoryPeak: number
  memoryEvents: Record<string, number>
  pidsMax: number
  pidsCurrent: number
  pidsPeak: number
  pidsEvents: Record<string, number>
  tmpFreeBytes: number
  tmpTotalBytes: number
  processes: Array<{
    pid: number
    parent: number
    group: number
    state: string
    threads: number
    executable: string
  }>
}

function check(value: unknown, reason: string): asserts value {
  if (!value) throw new FaultTargetRejected(`media: ${reason}; details withheld`)
}
function empty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (Array.isArray(value)
      ? value.length === 0
      : typeof value === 'object' && Object.keys(value).length === 0)
  )
}
function sameSet(actual: string[], expected: string[]): boolean {
  return (
    actual.length === expected.length &&
    [...actual].sort().join('\n') === [...expected].sort().join('\n')
  )
}
function decode<T>(bytes: Uint8Array): T {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T
  } catch {
    throw new Error('media-test: invalid command JSON; output withheld')
  }
}
function safeEnvironment(): Record<string, string> {
  return Object.fromEntries(
    DOCKER_ENV.flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key] as string]],
    ),
  )
}

/** Never surface stderr: compose/inspect/clients can contain generated credentials or whole binary fixtures. */
async function docker(
  args: string[],
  options: {
    env?: Record<string, string>
    input?: Uint8Array
    timeoutMs?: number
    mergeOutput?: boolean
  } = {},
): Promise<Uint8Array> {
  const child = Bun.spawn(['docker', ...args], {
    cwd: ROOT,
    env: { ...safeEnvironment(), ...options.env },
    stdin: options.input ?? 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, options.timeoutMs ?? 30_000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).bytes(),
      new Response(child.stderr).bytes(),
      child.exited,
    ])
    if (timedOut) throw new Error(`media-test: docker ${args[0]} exceeded its bounded deadline`)
    if (code !== 0) {
      const failure = new TextDecoder().decode(stderr)
      const category = /not running|is restarting/i.test(failure)
        ? 'container_not_running'
        : /resource temporarily unavailable|cannot fork/i.test(failure)
          ? 'resource_limit'
          : /OCI runtime exec failed/i.test(failure)
            ? 'oci_exec_failed'
            : 'command_failed'
      throw new Error(
        `media-test: docker ${args[0]} failed (${code}, ${category}); output withheld`,
      )
    }
    return options.mergeOutput ? Buffer.concat([stdout, stderr]) : stdout
  } finally {
    clearTimeout(timer)
  }
}
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes).trim()
const first = <T>(bytes: Uint8Array): T => {
  const values = decode<T[]>(bytes)
  check(Array.isArray(values) && values.length === 1, 'inspect must return exactly one resource')
  const value = values[0]
  check(value, 'inspect resource missing')
  return value
}

const CGROUP_CODE = `
const fs = require('node:fs');
const number = f => Number(fs.readFileSync('/sys/fs/cgroup/' + f, 'utf8').trim());
const events = f => Object.fromEntries(fs.readFileSync('/sys/fs/cgroup/' + f, 'utf8').trim().split('\\n').map(l => {const [k,v] = l.split(/\\s+/); return [k,Number(v)]}));
const processes = fs.readdirSync('/proc').filter(p => /^\\d+$/.test(p)).flatMap(p => {
  try { const s = fs.readFileSync('/proc/' + p + '/stat','utf8'); const f = s.slice(s.lastIndexOf(')')+2).split(' ');
      const threads = Number(/^Threads:\\s+(\\d+)/m.exec(fs.readFileSync('/proc/' + p + '/status','utf8'))?.[1]);
      const name = fs.readlinkSync('/proc/' + p + '/exe').split('/').at(-1); const executable = ['bun','ffmpeg','ffprobe','sleep','dash','docker-init'].includes(name) ? name : 'other';
      return [{pid:Number(p),state:f[0],parent:Number(f[1]),group:Number(f[2]),threads,executable}]; } catch { return [] }
});
const tmp = fs.statfsSync('/tmp');
console.log(JSON.stringify({memoryMax:number('memory.max'),memorySwapMax:number('memory.swap.max'),memoryCurrent:number('memory.current'),memoryPeak:number('memory.peak'),memoryEvents:events('memory.events'),pidsMax:number('pids.max'),pidsCurrent:number('pids.current'),pidsPeak:number('pids.peak'),pidsEvents:events('pids.events'),tmpFreeBytes:tmp.bavail*tmp.bsize,tmpTotalBytes:tmp.blocks*tmp.bsize,processes}));`
// One shell plus short-lived native stat/dd observers, not a second Bun runtime in the 64-PID workload.
const TASK_STATE_CODE = `
set -eu
root=/tmp/chatapp-media
[ -d "$root" ] && [ ! -L "$root" ] || exit 1
policy=$(/usr/bin/stat -c '%a:%u:%g' "$root")
count=0
task=''
for path in "$root"/* "$root"/.[!.]* "$root"/..?*; do
  [ -e "$path" ] || [ -L "$path" ] || continue
  count=$((count + 1))
  task="$path"
done
printf '%s\\n%s\\n' "$count" "$policy"
if [ "$count" -eq 1 ] && [ -d "$task" ] && [ ! -L "$task" ]; then
  for report in "$task/file-thumb" "$task/file-original"; do
    [ -f "$report" ] && [ ! -L "$report" ] || continue
    size=$(/usr/bin/stat -c '%s' "$report" 2>/dev/null) || continue
    if [ "$size" -lt 8192 ]; then
      /usr/bin/dd if="$report" bs=8192 count=1 status=none 2>/dev/null || true
      break
    fi
  done
fi`
const SOCKET_STATE_CODE = `
const fs = require('node:fs'); const root = '/run/chatapp-media'; const names=fs.readdirSync(root);
const s=fs.lstatSync(root); const f=fs.lstatSync(root+'/media.sock');
console.log(JSON.stringify({entries:names.length,onlySocket:names.length===1&&names[0]==='media.sock',uid:s.uid,gid:s.gid,mode:s.mode&511,socket:f.isSocket(),socketUid:f.uid,socketGid:f.gid,socketMode:f.mode&511}));`

export class MediaTestInstance {
  readonly manifest: FaultManifest
  readonly ownerUid: number
  readonly owner: string
  readonly socketVolume: string
  readonly #env: Record<string, string>
  readonly #businessEnv: Record<string, string>
  readonly #targets = new Map<MediaTestService, ExtraTarget>()
  readonly #images = new Map<ImageKind, string>()
  readonly #database: ReturnType<typeof createDatabase>
  readonly #sql: SQL
  #socketCreated = false
  #closed = false
  #workerImage = ''
  #kind: ImageKind = 'runtime'
  readonly #browserPort?: number

  private constructor(
    manifest: FaultManifest,
    restoredOwner?: string,
    browser?: { origin: string; apiPort: number },
  ) {
    this.manifest = manifest
    if (browser) {
      check(
        Number.isInteger(browser.apiPort) && browser.apiPort >= 15000 && browser.apiPort < 65536,
        'browser API port invalid',
      )
      check(
        /^http:\/\/localhost:\d+$/.test(browser.origin) ||
          browser.origin === 'https://chat.localhost:8443',
        'browser origin invalid',
      )
      this.#browserPort = browser.apiPort
    }
    this.ownerUid = process.getuid?.() ?? -1
    check(this.ownerUid >= 0, 'host owner is unavailable')
    this.owner = restoredOwner ?? `${this.ownerUid}:${process.pid}:${randomUUID()}`
    this.socketVolume = `${manifest.project}_media-test-socket`
    const e = manifest.endpoints
    const internal = (url: string, host: string, port: number, database?: string) => {
      const parsed = new URL(url)
      parsed.hostname = host
      parsed.port = String(port)
      if (database !== undefined) parsed.pathname = database
      return parsed.toString()
    }
    const db = internal(e.databaseUrl, 'postgres', 5432)
    const redis = internal(e.valkeyUrl, 'valkey', 6379, '/0')
    const redisTest = internal(e.valkeyUrl, 'valkey', 6379, '/1')
    const auth = randomBytes(32).toString('base64url')
    const token = randomBytes(32).toString('base64url')
    const epoch = randomBytes(16).toString('hex')
    this.#env = {
      TEST_RUN_ID: manifest.runId,
      TEST_MEDIA_ORIGIN: browser?.origin ?? 'http://localhost:5173',
      TEST_PG_PASSWORD: new URL(e.databaseOwnerUrl).password,
      TEST_VALKEY_PASSWORD: new URL(e.valkeyUrl).password,
      TEST_GARAGE_CONFIG: join(ROOT, '.test-runs', manifest.runId, 'garage.toml'),
      TEST_PG_PORT: String(manifest.services.postgres.port),
      TEST_VALKEY_PORT: String(manifest.services.valkey.port),
      TEST_GARAGE_PORT: String(manifest.services.garage.port),
      TEST_SMTP_PORT: String(manifest.services.mailpit.port),
      TEST_MAILPIT_UI_PORT: String(e.mailpitUiPort),
      TEST_MEDIA_OWNER: this.owner,
      TEST_MEDIA_DATABASE_URL: db,
      TEST_MEDIA_VALKEY_URL: redis,
      TEST_MEDIA_VALKEY_URL_TEST: redisTest,
      TEST_MEDIA_S3_ACCESS_KEY_ID: e.s3AccessKeyId,
      TEST_MEDIA_S3_SECRET_ACCESS_KEY: e.s3SecretAccessKey,
      TEST_MEDIA_METRICS_TOKEN: e.garageMetricsToken ?? '',
      TEST_MEDIA_AUTH_SECRET: auth,
      TEST_MEDIA_TOKEN_KEY: token,
      TEST_MEDIA_RESTORE_EPOCH: epoch,
    }
    this.#businessEnv = {
      ...BASE_ENV,
      APP_ENV: 'test',
      NODE_ENV: 'test',
      APP_ORIGIN: browser?.origin ?? 'http://localhost:5173',
      APP_TIMEZONE: 'Asia/Shanghai',
      API_HOST: '0.0.0.0',
      API_PORT: '3100',
      DATABASE_URL: db,
      DATABASE_URL_TEST: db,
      VALKEY_URL: redis,
      VALKEY_URL_TEST: redisTest,
      S3_ENDPOINT: 'http://garage:3900',
      S3_REGION: 'garage',
      S3_BUCKET: 'chatapp-unused',
      S3_BUCKET_TEST: 'chatapp-test',
      S3_ACCESS_KEY_ID: e.s3AccessKeyId,
      S3_SECRET_ACCESS_KEY: e.s3SecretAccessKey,
      GARAGE_METRICS_TOKEN: e.garageMetricsToken ?? '',
      GARAGE_METRICS_ENDPOINT: 'http://garage:3903/metrics',
      BETTER_AUTH_SECRET: auth,
      AUTH_TOKEN_ENCRYPTION_KEY: token,
      RESTORE_EPOCH: epoch,
      SMTP_HOST: 'mailpit',
      SMTP_PORT: '1025',
      MAIL_FROM: 'ChatApp Test <media@example.test>',
      LOG_LEVEL: 'warn',
    }
    this.#database = createDatabase(e.databaseUrl, {
      max: 2,
      applicationName: 'chatapp-media-proof',
    })
    this.#sql = new SQL({ url: e.databaseUrl, max: 2, connectionTimeout: 3 })
  }

  /** Recovery after a verifier rejected startup: requires the exact previously observed owner, full IDs and image IDs. */
  static async cleanupRejectedStart(receipt: {
    runId: string
    owner: string
    targets: Record<MediaTestService, { id: string; imageId: string }>
    browser?: { origin: string; apiPort: number }
  }): Promise<void> {
    check(/^[0-9a-f]{8}$/.test(receipt.runId), 'invalid rejected-start run')
    const path = join(ROOT, '.test-runs', receipt.runId, 'manifest.json')
    const file = await stat(path)
    check(
      file.uid === process.getuid?.() && (file.mode & 0o077) === 0,
      'manifest is not private to current owner',
    )
    check(
      receipt.owner.startsWith(`${file.uid}:`) && /^\d+:\d+:[0-9a-f-]{36}$/.test(receipt.owner),
      'receipt owner mismatch',
    )
    const manifest = loadManifest(path)
    process.env.APP_ENV = 'test'
    await verifyFaultTarget(manifest)
    const instance = new MediaTestInstance(manifest, receipt.owner, receipt.browser)
    const worker = first<DockerContainer>(await docker(['inspect', receipt.targets.worker.id]))
    for (const key of ['BETTER_AUTH_SECRET', 'AUTH_TOKEN_ENCRYPTION_KEY', 'RESTORE_EPOCH']) {
      const entry = worker.Config.Env.find((value) => value.startsWith(`${key}=`))
      check(entry, 'immutable worker configuration missing')
      instance.#businessEnv[key] = entry.slice(key.length + 1)
    }
    instance.#workerImage = receipt.targets.worker.imageId
    check(receipt.targets.api.imageId === instance.#workerImage, 'API/worker pinned images differ')
    instance.#images.set('runtime', receipt.targets.media.imageId)
    for (const service of SERVICES) {
      const target = receipt.targets[service]
      check(
        /^[0-9a-f]{64}$/.test(target.id) && /^sha256:[0-9a-f]{64}$/.test(target.imageId),
        'receipt IDs must be complete',
      )
      instance.#targets.set(service, { ...target, service, kind: 'runtime' })
    }
    instance.#socketCreated = true
    await instance.verify({ allowStopped: true })
    await instance.close()
    const evidence = join(ROOT, '.test-runs', 'm3', receipt.runId)
    await mkdir(evidence, { recursive: true, mode: 0o700 })
    await writeFile(
      join(evidence, 'startup.json'),
      JSON.stringify(
        {
          runId: receipt.runId,
          status: 'harness-rejected-before-probes',
          reason: 'named volume representation in HostConfig.Binds',
          teardown: 'full-identity-owner-image-policy-and-core-markers-verified-then-removed',
        },
        null,
        2,
      ),
      { mode: 0o600 },
    )
  }

  static async start(browser?: { origin: string; apiPort: number }): Promise<MediaTestInstance> {
    const { manifest } = await startInstance()
    const instance = new MediaTestInstance(manifest, undefined, browser)
    try {
      await verifyFaultTarget(manifest)
      if (browser)
        await writeFile(
          join(ROOT, '.test-runs', manifest.runId, 'browser.compose.yml'),
          `services:\n  api:\n    ports:\n      - "127.0.0.1:${browser.apiPort}:3100"\n`,
          { mode: 0o600 },
        )
      // Build this checkout; a developer's existing tag may contain stale code or be absent in CI.
      const workerTag = `chatapp-worker-test:${manifest.runId}`
      await docker(
        [
          'build',
          '--target',
          'runtime',
          '--file',
          'infra/Dockerfile.worker',
          '--tag',
          workerTag,
          '.',
        ],
        { timeoutMs: 180_000 },
      )
      const worker = first<{ Id: string }>(await docker(['image', 'inspect', workerTag]))
      check(/^sha256:[0-9a-f]{64}$/.test(worker.Id), 'worker image ID invalid')
      instance.#workerImage = worker.Id
      for (const kind of ['runtime', 'fault'] as const) {
        const tag = `chatapp-media-test:${manifest.runId}-${kind}`
        await docker(
          ['build', '--target', kind, '--file', 'infra/Dockerfile.media', '--tag', tag, '.'],
          { timeoutMs: 180_000 },
        )
        const image = first<{ Id: string; Config: { Labels: Record<string, string> } }>(
          await docker(['image', 'inspect', tag]),
        )
        check(
          image.Config.Labels['chatapp.media.image'] === kind &&
            /^sha256:[0-9a-f]{64}$/.test(image.Id),
          'media build kind/ID invalid',
        )
        instance.#images.set(kind, image.Id)
      }
      await instance.#compose(['up', '-d', '--no-build', '--no-deps', 'media', 'worker', 'api'])
      await instance.#capture()
      await instance.verify()
      await instance.waitUntil(
        async () => {
          const state = await instance.taskState()
          return state.entries === 0 && state.privateRoot
        },
        20_000,
        'media startup',
      )
      await instance.waitUntil(
        async () => {
          await instance.apiReady()
          return true
        },
        30_000,
        'api ready',
      )
      await instance.businessAvailable()
      return instance
    } catch (error) {
      // Capture only this project's explicit services, then verify everything before touching it.
      await instance.#capture().catch(() => {})
      await instance
        .close()
        .catch(() =>
          console.error(`media run ${manifest.runId}: startup cleanup refused; resources retained`),
        )
      throw error
    }
  }

  async #compose(args: string[]): Promise<void> {
    const media = this.#images.get(this.#kind)
    check(media, 'selected image is missing')
    await docker(
      [
        'compose',
        '-p',
        this.manifest.project,
        '-f',
        COMPOSE_FILE,
        ...(this.#browserPort
          ? ['-f', join(ROOT, '.test-runs', this.manifest.runId, 'browser.compose.yml')]
          : []),
        '--profile',
        'media',
        ...args,
      ],
      {
        env: {
          ...this.#env,
          TEST_MEDIA_TARGET: this.#kind,
          TEST_MEDIA_IMAGE: media,
          TEST_WORKER_IMAGE: this.#workerImage,
        },
        timeoutMs: 60_000,
      },
    )
  }

  async #capture(): Promise<void> {
    for (const service of SERVICES) {
      const ids = text(
        await docker([
          'ps',
          '-aq',
          '--no-trunc',
          '--filter',
          `label=com.docker.compose.project=${this.manifest.project}`,
          '--filter',
          `label=com.docker.compose.service=${service}`,
        ]),
      )
        .split('\n')
        .filter(Boolean)
      check(ids.length <= 1, `${service}: more than one container`)
      const id = ids[0]
      if (!id) continue
      check(/^[0-9a-f]{64}$/.test(id), `${service}: full container ID required`)
      const imageId = service === 'media' ? this.#images.get(this.#kind) : this.#workerImage
      check(imageId, `${service}: missing pinned image`)
      this.#targets.set(service, {
        id,
        service,
        imageId,
        kind: service === 'media' ? this.#kind : 'runtime',
      })
    }
    const volumes = text(
      await docker([
        'volume',
        'ls',
        '-q',
        '--filter',
        `label=com.docker.compose.project=${this.manifest.project}`,
      ]),
    ).split('\n')
    this.#socketCreated = volumes.includes(this.socketVolume)
  }

  async #container(target: ExtraTarget, allowStopped: boolean): Promise<DockerContainer> {
    const info = first<DockerContainer>(await docker(['inspect', target.id]))
    const labels = info.Config.Labels
    check(
      info.Id === target.id && info.Image === target.imageId,
      `${target.service}: ID or pinned image mismatch`,
    )
    check(
      labels['com.docker.compose.project'] === this.manifest.project &&
        labels['com.docker.compose.service'] === target.service &&
        labels['chatapp.test.run-id'] === this.manifest.runId,
      `${target.service}: project/run/service mismatch`,
    )
    check(
      labels['chatapp.test.owner'] === this.owner &&
        labels['chatapp.test.kind'] === target.service &&
        labels['chatapp.test.image-kind'] === target.kind,
      `${target.service}: current owner/kind mismatch`,
    )
    check(info.State.Running || allowStopped, `${target.service}: stopped`)
    check(
      info.Config.User === '10001:10001' &&
        info.Config.WorkingDir === '/app' &&
        !info.Config.Tty &&
        !info.Config.OpenStdin &&
        empty(info.Config.Entrypoint),
      `${target.service}: user/entry/tty policy`,
    )
    const command = [
      'bun',
      '--no-env-file',
      target.service === 'media'
        ? target.kind === 'fault'
          ? '/app/apps/media/test/fault-server.ts'
          : '/app/apps/media/src/server.ts'
        : `/app/apps/server/src/${target.service}.ts`,
    ]
    check(
      JSON.stringify(info.Config.Cmd) === JSON.stringify(command),
      `${target.service}: command mismatch`,
    )
    const h = info.HostConfig
    check(
      h.ReadonlyRootfs &&
        !h.Privileged &&
        h.Init &&
        h.IpcMode === 'private' &&
        h.PidMode === '' &&
        h.UsernsMode === '' &&
        h.CgroupnsMode === 'private',
      `${target.service}: isolation modes`,
    )
    check(
      h.Memory === LIMITS[target.service] &&
        h.MemorySwap === h.Memory &&
        h.PidsLimit === (target.service === 'media' ? 64 : 256),
      `${target.service}: memory/swap/pids limits`,
    )
    check(
      sameSet(h.CapDrop, ['ALL']) &&
        empty(h.CapAdd) &&
        sameSet(h.SecurityOpt, ['no-new-privileges:true']),
      `${target.service}: capabilities/seccomp/NNP`,
    )
    check(
      JSON.stringify(h.Tmpfs) === JSON.stringify({ '/tmp': TMPFS }),
      `${target.service}: tmpfs policy`,
    )
    check(
      sameSet(
        h.Binds ?? [],
        target.service === 'api'
          ? []
          : [`${this.socketVolume}:/run/chatapp-media:${target.service === 'media' ? 'rw' : 'ro'}`],
      ) &&
        empty(h.Devices) &&
        empty(h.DeviceRequests) &&
        empty(h.DeviceCgroupRules) &&
        empty(h.VolumesFrom) &&
        (target.service === 'api' && this.#browserPort
          ? JSON.stringify(h.PortBindings) ===
            JSON.stringify({
              '3100/tcp': [{ HostIp: '127.0.0.1', HostPort: String(this.#browserPort) }],
            })
          : empty(h.PortBindings)) &&
        !h.PublishAllPorts &&
        empty(h.ExtraHosts) &&
        empty(h.Links) &&
        empty(h.Dns) &&
        empty(h.Sysctls),
      `${target.service}: unexpected host/device/network override`,
    )
    check(
      h.RestartPolicy.Name === 'no' &&
        h.MaskedPaths.includes('/proc/kcore') &&
        h.ReadonlyPaths.includes('/proc/sys'),
      `${target.service}: restart/proc policy`,
    )
    const expectedEnv = Object.entries(
      target.service === 'media' ? mediaEnvironment('/tmp') : this.#businessEnv,
    ).map(([key, value]) => `${key}=${value}`)
    check(
      sameSet(info.Config.Env, expectedEnv),
      `${target.service}: ambient or changed environment`,
    )
    const mounts = info.Mounts.filter((mount) => mount.Type !== 'tmpfs')
    check(
      info.Mounts.every(
        (mount) =>
          mount.Type === 'volume' || (mount.Type === 'tmpfs' && mount.Destination === '/tmp'),
      ),
      `${target.service}: forbidden mount type/path`,
    )
    if (target.service === 'api') check(mounts.length === 0, 'api: unexpected volume')
    else {
      const mount = mounts[0]
      check(
        mounts.length === 1 &&
          mount?.Type === 'volume' &&
          mount.Name === this.socketVolume &&
          mount.Destination === '/run/chatapp-media' &&
          mount.RW === (target.service === 'media') &&
          mount.Driver === 'local' &&
          mount.Propagation === '',
        `${target.service}: socket mount policy`,
      )
      const volume = first<Volume>(await docker(['volume', 'inspect', this.socketVolume]))
      check(
        typeof volume.Mountpoint === 'string' &&
          volume.Mountpoint.length > 0 &&
          mount.Source === volume.Mountpoint,
        `${target.service}: socket source is not the actual run volume`,
      )
    }
    if (target.service === 'media') {
      check(
        h.NetworkMode === 'none' && empty(info.NetworkSettings.Ports),
        'media: network must be none',
      )
      const networks = Object.entries(info.NetworkSettings.Networks)
      check(
        networks.length === 1 && networks[0]?.[0] === 'none' && networks[0]?.[1].IPAddress === '',
        'media: unexpected network attachment',
      )
      const image = first<{ Config: { Labels: Record<string, string> } }>(
        await docker(['image', 'inspect', target.imageId]),
      )
      check(
        image.Config.Labels['chatapp.media.image'] === target.kind,
        'media: actual image kind mismatch',
      )
    } else {
      const networks = Object.values(info.NetworkSettings.Networks)
      check(
        h.NetworkMode === `${this.manifest.project}_default` &&
          ((allowStopped && !info.State.Running && networks.length === 0) ||
            (networks.length === 1 &&
              this.manifest.networks.includes(networks[0]?.NetworkID ?? ''))),
        `${target.service}: network is not this instance`,
      )
      check(
        target.service === 'api' && this.#browserPort
          ? (allowStopped && !info.State.Running && empty(info.NetworkSettings.Ports)) ||
              JSON.stringify(info.NetworkSettings.Ports) ===
                JSON.stringify({
                  '3100/tcp': [{ HostIp: '127.0.0.1', HostPort: String(this.#browserPort) }],
                })
          : empty(info.NetworkSettings.Ports) ||
              Object.values(info.NetworkSettings.Ports).every((bindings) => bindings === null),
        `${target.service}: published port forbidden`,
      )
    }
    return info
  }

  /** Exact inventory as well as each resource's full identity, owner, images, mounts and cgroup/security configuration. */
  async verify(options: { allowStopped?: boolean } = {}): Promise<void> {
    check(!this.#closed && this.ownerUid === process.getuid?.(), 'current host owner changed')
    process.env.APP_ENV = 'test'
    await verifyFaultTarget(this.manifest)
    for (const target of this.#targets.values())
      await this.#container(target, options.allowStopped ?? false)
    const containers = text(
      await docker([
        'ps',
        '-aq',
        '--no-trunc',
        '--filter',
        `label=com.docker.compose.project=${this.manifest.project}`,
      ]),
    )
      .split('\n')
      .filter(Boolean)
    check(
      sameSet(containers, [
        ...Object.values(this.manifest.services).map((service) => service.containerId),
        ...[...this.#targets.values()].map((target) => target.id),
      ]),
      'unmanifested container in this project',
    )
    const volumes = text(
      await docker([
        'volume',
        'ls',
        '-q',
        '--filter',
        `label=com.docker.compose.project=${this.manifest.project}`,
      ]),
    )
      .split('\n')
      .filter(Boolean)
    check(
      sameSet(volumes, [
        ...this.manifest.volumes,
        ...(this.#socketCreated ? [this.socketVolume] : []),
      ]),
      'unmanifested volume in this project',
    )
    const networks = text(
      await docker([
        'network',
        'ls',
        '-q',
        '--no-trunc',
        '--filter',
        `label=com.docker.compose.project=${this.manifest.project}`,
      ]),
    )
      .split('\n')
      .filter(Boolean)
    check(sameSet(networks, this.manifest.networks), 'unmanifested network in this project')
    if (this.#socketCreated) {
      const volume = first<Volume>(await docker(['volume', 'inspect', this.socketVolume]))
      check(
        volume.Name === this.socketVolume &&
          volume.Driver === 'local' &&
          volume.Scope === 'local' &&
          empty(volume.Options),
        'socket volume has host driver options',
      )
      check(
        volume.Labels['com.docker.compose.project'] === this.manifest.project &&
          volume.Labels['com.docker.compose.volume'] === 'media-test-socket' &&
          volume.Labels['chatapp.test.run-id'] === this.manifest.runId &&
          volume.Labels['chatapp.test.owner'] === this.owner &&
          volume.Labels['chatapp.test.kind'] === 'media-socket',
        'socket volume owner/labels mismatch',
      )
    }
  }

  async exec(
    service: MediaTestService,
    source: string,
    input?: Uint8Array,
    timeoutMs = 15_000,
  ): Promise<Uint8Array> {
    return this.#execCommand(service, ['bun', '--no-env-file', '-e', source], input, timeoutMs)
  }

  async #execCommand(
    service: MediaTestService,
    command: string[],
    input?: Uint8Array,
    timeoutMs = 15_000,
  ): Promise<Uint8Array> {
    await this.verify({ allowStopped: true })
    const target = this.#targets.get(service)
    check(target, `${service}: not in extra manifest`)
    await this.#container(target, false)
    return docker(
      [
        'exec',
        ...(input ? ['-i'] : []),
        '--user',
        '10001:10001',
        // Observers and sample tools must not add auto-sized thread pools to the measured media workload.
        ...(service === 'media'
          ? [
              '--env',
              'UV_THREADPOOL_SIZE=1',
              '--env',
              'VIPS_CONCURRENCY=1',
              '--env',
              'OMP_NUM_THREADS=1',
              '--env',
              'MALLOC_ARENA_MAX=2',
            ]
          : []),
        '--workdir',
        service === 'media' ? '/app/apps/media' : '/app/apps/server',
        target.id,
        ...command,
      ],
      { input, timeoutMs },
    )
  }

  async client(input: ClientInput): Promise<Record<string, unknown>> {
    const source = (await readFile('apps/server/test/media/container-client.ts', 'utf8')).replace(
      "'../../src/runtime/media.ts'",
      "'/app/apps/server/src/runtime/media.ts'",
    )
    return decode(
      await this.exec(
        'worker',
        `${source}\nawait runContainerClient()`,
        Buffer.from(JSON.stringify(input)),
        Math.max(15_000, (input.timeoutMs ?? 8000) + 5000),
      ),
    )
  }

  async sample(
    mode: 'generate' | 'source' | 'output' | 'avatar',
    name: string,
    input?: Uint8Array,
  ): Promise<Uint8Array> {
    check(
      /^(jpeg|png|gif|side-bomb|pixel-bomb|frame-bomb|animated-pixel-bomb|video|ffv1|video-tight)$/.test(
        name,
      ),
      'unlisted sample',
    )
    const source = await readFile('apps/media/test/sample-tools.ts', 'utf8')
    return this.exec(
      'media',
      `${source}\nawait runSampleTool(${JSON.stringify(mode)}, ${JSON.stringify(name)})`,
      input,
      30_000,
    )
  }

  async taskState(): Promise<{
    entries: number
    privateRoot: boolean
    report: Record<string, unknown> | null
  }> {
    const bytes = Buffer.from(
      await this.#execCommand('media', ['/bin/sh', '-c', TASK_STATE_CODE], undefined, 5000),
    )
    const firstLine = bytes.indexOf(10)
    const secondLine = bytes.indexOf(10, firstLine + 1)
    check(firstLine > 0 && secondLine > firstLine, 'native task observer framing')
    const count = bytes.subarray(0, firstLine).toString()
    check(/^\d+$/.test(count), 'native task observer count')
    const reportBytes = bytes.subarray(secondLine + 1)
    let report: Record<string, unknown> | null = null
    if (this.#kind === 'fault' && reportBytes.subarray(0, 6).toString() === 'GIF89a') {
      try {
        report = decode<Record<string, unknown>>(reportBytes.subarray(13))
      } catch {
        // Files may disappear or still be in flight; a later bounded observation will retry.
      }
    }
    return {
      entries: Number(count),
      privateRoot: bytes.subarray(firstLine + 1, secondLine).toString() === '700:10001:10001',
      report,
    }
  }

  async socketPolicy(): Promise<Record<string, unknown>> {
    return decode(await this.exec('media', SOCKET_STATE_CODE))
  }

  async snapshot(service: MediaTestService): Promise<CgroupSnapshot> {
    const snapshot = decode<CgroupSnapshot>(await this.exec(service, CGROUP_CODE))
    check(
      snapshot.memoryMax === LIMITS[service] &&
        snapshot.memorySwapMax === 0 &&
        snapshot.pidsMax === (service === 'media' ? 64 : 256),
      `${service}: actual cgroup does not match policy`,
    )
    check(
      snapshot.memoryCurrent <= snapshot.memoryMax && snapshot.tmpTotalBytes === 256 * MiB,
      `${service}: actual memory/tmpfs bound`,
    )
    return snapshot
  }

  async apiReady(): Promise<void> {
    const source = `const r=await fetch('http://api:3100/api/readyz',{signal:AbortSignal.timeout(2500)});if(r.status!==200)process.exit(1);console.log('ready')`
    check(text(await this.exec('worker', source)) === 'ready', 'api is not ready')
  }

  /** A committed realtime work intent is actually leased, published and completed by the real worker. */
  async businessAvailable(): Promise<{
    apiReady: true
    workerCompleted: true
    deliverySeq: number
    startedAtMs: number
    apiReadyAtMs: number
    workFinishedAtMs: number
    elapsedMs: number
  }> {
    await this.verify({ allowStopped: true })
    const started = performance.now()
    const startedAtMs = Date.now()
    const work = await this.#database.db.transaction((tx) =>
      enqueueWork(
        tx,
        { clock: { now: () => new Date() } },
        {
          kind: 'realtime',
          dedupeKey: `media-${randomUUID()}`,
          entityId: randomUUID(),
          payload: { event: 'auth.revoked' },
        },
      ),
    )
    await this.apiReady()
    const apiReadyAtMs = Date.now()
    let deliverySeq = 0
    let workFinishedAtMs = 0
    await this.waitUntil(
      async () => {
        const rows = await this
          .#sql`select status, delivery_seq, finished_at from work_items where id=${work.id}`
        if (rows[0]?.status !== 'done') return false
        deliverySeq = Number(rows[0].delivery_seq)
        workFinishedAtMs = new Date(rows[0].finished_at).getTime()
        return deliverySeq >= 1 && Number.isSafeInteger(workFinishedAtMs)
      },
      7000,
      'real worker completing committed work',
    )
    return {
      apiReady: true,
      workerCompleted: true,
      deliverySeq,
      startedAtMs,
      apiReadyAtMs,
      workFinishedAtMs,
      elapsedMs: performance.now() - started,
    }
  }

  async action(
    service: MediaTestService,
    action: 'kill' | 'restart' | 'stop' | 'start',
  ): Promise<void> {
    await this.verify({ allowStopped: action === 'start' || action === 'restart' })
    const target = this.#targets.get(service)
    check(target, `${service}: action target missing`)
    await this.#container(target, action === 'start' || action === 'restart')
    await docker([
      action,
      ...(action === 'stop' || action === 'restart' ? ['--time', '5'] : []),
      target.id,
    ])
  }

  async switchImage(kind: ImageKind): Promise<void> {
    if (kind === this.#kind) return
    await this.action('media', 'stop')
    await this.verify({ allowStopped: true })
    const previous = this.#targets.get('media')
    check(previous, 'missing old media')
    await docker(['rm', previous.id])
    this.#targets.delete('media')
    this.#kind = kind
    await this.#compose(['up', '-d', '--no-build', '--no-deps', 'media'])
    await this.#capture()
    await this.verify()
    await this.waitUntil(
      async () => (await this.taskState()).entries === 0,
      15_000,
      'replacement media',
    )
  }

  async mediaRunning(): Promise<boolean> {
    await this.verify({ allowStopped: true })
    const target = this.#targets.get('media')
    check(target, 'media missing')
    return (await this.#container(target, true)).State.Running
  }

  async probeReport(
    kind:
      | 'pids-pressure-held'
      | 'tmpfs-pressure-held'
      | 'memory-pressure-held'
      | 'pids-failed'
      | 'tree',
    sinceMs: number,
  ): Promise<Record<string, unknown> | null> {
    check(this.#kind === 'fault', 'test-only probe observation requires fault image')
    await this.verify({ allowStopped: true })
    const target = this.#targets.get('media')
    check(target, 'media missing')
    const logs = text(await docker(['logs', '--tail', '60', target.id], { mergeOutput: true }))
    let latest: Record<string, unknown> | null = null
    for (const line of logs.split('\n')) {
      if (!line.startsWith('media_test_probe:')) continue
      try {
        const value = decode<Record<string, unknown>>(
          Buffer.from(line.slice('media_test_probe:'.length)),
        )
        if (
          value.testOnly === true &&
          typeof value.observedAtMs === 'number' &&
          value.observedAtMs >= sinceMs &&
          (kind === 'tree' ? value.tree === true : value.phase === kind)
        )
          latest = value
      } catch {
        // Non-metadata output is never surfaced or saved.
      }
    }
    return latest
  }

  async logFlag(flag: 'media_cleanup_failed' | 'media_test_startup_recovered'): Promise<boolean> {
    await this.verify({ allowStopped: true })
    const target = this.#targets.get('media')
    check(target, 'media missing')
    const logs = text(await docker(['logs', '--tail', '30', target.id], { mergeOutput: true }))
    return logs.split('\n').some((line) => line.trim() === flag)
  }

  async failedTaskExit(): Promise<Record<string, unknown> | null> {
    await this.verify({ allowStopped: true })
    const target = this.#targets.get('media')
    check(target, 'media missing')
    const logs = text(await docker(['logs', '--tail', '60', target.id], { mergeOutput: true }))
    for (const line of logs.split('\n').reverse()) {
      if (!line.startsWith('media_task_exit:')) continue
      const value = decode<Record<string, unknown>>(
        Buffer.from(line.slice('media_task_exit:'.length)),
      )
      return {
        code: typeof value.code === 'number' ? value.code : null,
        signal: ['SIGABRT', 'SIGKILL', 'SIGSEGV', 'SIGTERM'].includes(String(value.signal))
          ? value.signal
          : null,
        failedToStart: value.failedToStart === true,
      }
    }
    return null
  }

  async runtimeContainsTests(): Promise<boolean> {
    check(this.#kind === 'runtime', 'runtime image required')
    return (
      text(
        await this.exec(
          'media',
          `console.log(require('node:fs').existsSync('/app/apps/media/test')?'yes':'no')`,
        ),
      ) === 'yes'
    )
  }

  async workerCannotWriteSocketVolume(): Promise<boolean> {
    const source = `const fs=require('node:fs');try{fs.writeFileSync('/run/chatapp-media/worker-must-not-write','x',{flag:'wx'});process.exit(1)}catch(e){console.log(e.code==='EROFS'?'readonly':'unexpected')}`
    return text(await this.exec('worker', source)) === 'readonly'
  }

  async networkTargets(): Promise<Uint8Array> {
    await this.verify()
    const addresses = []
    for (const service of ['postgres', 'garage'] as const) {
      const info = first<DockerContainer>(
        await docker(['inspect', this.manifest.services[service].containerId]),
      )
      const networks = Object.values(info.NetworkSettings.Networks)
      check(
        networks.length === 1 && this.manifest.networks.includes(networks[0]?.NetworkID ?? ''),
        'probe backend IP is not this run',
      )
      const address = networks[0]?.IPAddress ?? ''
      check(/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address), 'backend IPv4 unavailable')
      addresses.push(...address.split('.').map(Number))
    }
    return Uint8Array.from(addresses)
  }

  async pidsGone(pids: number[]): Promise<boolean> {
    check(
      pids.every((pid) => Number.isSafeInteger(pid) && pid > 1),
      'invalid reported probe PID',
    )
    const current = await this.snapshot('media')
    return current.processes.every(
      (process) => !pids.includes(process.pid) && !pids.includes(process.group),
    )
  }

  async waitUntil(read: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
    const deadline = performance.now() + timeoutMs
    while (performance.now() < deadline) {
      if (await read().catch(() => false)) return
      await Bun.sleep(80)
    }
    throw new Error(`media-test: deadline waiting for ${what}`)
  }

  metadata(): Record<string, unknown> {
    return {
      runId: this.manifest.runId,
      fingerprint: manifestFingerprint(this.manifest),
      ownerUid: this.ownerUid,
      architecture: process.arch,
      platform: process.platform,
      bunVersion: Bun.version,
      mediaImageKind: this.#kind,
      mediaImageIds: Object.fromEntries(this.#images),
      mediaImageId: this.#images.get(this.#kind),
      workerImageId: this.#workerImage,
      mediaBytes: LIMITS.media,
      workerBytes: LIMITS.worker,
      apiBytes: LIMITS.api,
      backgroundBytes: LIMITS.media + LIMITS.worker,
      tmpfsBytes: 256 * MiB,
      mediaPids: 64,
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    await this.#database.close()
    await this.#sql.close()
    // Any inventory, owner, marker or safety-policy mismatch stops cleanup BEFORE the first destructive command.
    await this.verify({ allowStopped: true })
    for (const target of [...this.#targets.values()]) {
      await this.verify({ allowStopped: true })
      await this.#container(target, true)
      await docker(['rm', '--force', target.id])
      this.#targets.delete(target.service)
    }
    if (this.#socketCreated) {
      await this.verify({ allowStopped: true })
      await docker(['volume', 'rm', this.socketVolume])
      this.#socketCreated = false
    }
    await this.verify()
    await stopInstance(this.manifest.runId)
    this.#closed = true
  }
}

export async function verifyMediaTestLocation(): Promise<void> {
  const architecture = text(await docker(['info', '--format', '{{.Architecture}}']))
  check(
    process.platform === 'linux' &&
      ((process.arch === 'x64' && ['x86_64', 'amd64'].includes(architecture)) ||
        (process.arch === 'arm64' && ['aarch64', 'arm64'].includes(architecture))),
    'native Linux host/engine architecture must agree; emulation is not admission evidence',
  )
  check((await realpath(ROOT)) === ROOT, 'repository must not be a symlink')
  check(
    (await readFile(join(ROOT, '.gitignore'), 'utf8')).includes('/.test-runs/'),
    'evidence directory is not gitignored',
  )
}
