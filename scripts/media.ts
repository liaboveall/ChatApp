#!/usr/bin/env bun
/**
 * Fixed worker/media lifecycle (D-081 / V-18). No Docker socket is given to either container.
 *
 *   bun --env-file=.env.local scripts/media.ts up   detached, with a non-secret ownership receipt
 *   bun scripts/media.ts down                      only containers in that verified receipt; never volumes
 *   bun --env-file=.env.local scripts/media.ts run  foreground; Ctrl+C leaves a reused stack alone
 *   bun --no-env-file scripts/media.ts configtest  synthetic environment, no services or secret output
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mediaEnvironment } from '../apps/media/src/runtime/environment.ts'

export const ROOT = realpathSync(fileURLToPath(new URL('..', import.meta.url)))
export const MEDIA_PROJECT = 'chatapp-media'
export const MEDIA_SOCKET_PATH = '/run/chatapp-media/media.sock'
export const DEV_NETWORK = 'chatapp-dev_default'
export const REPOSITORY = createHash('sha256').update(ROOT).digest('hex')
const COMPOSE = join(ROOT, 'infra', 'compose.media.yml')
const COMPOSE_ARGS = ['compose', '-p', MEDIA_PROJECT, '-f', COMPOSE]
const STATE = join(ROOT, '.test-runs', 'media')
const RECEIPT = join(STATE, 'lease.json')
const LOCK = join(STATE, 'start.lock')
const SERVICES = ['media', 'worker'] as const
const ID = /^[0-9a-f]{64}$/
const OWNER = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const IMAGE_ENV = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', TMPDIR: '/tmp' }
const TMPFS = 'size=268435456,mode=1777,nosuid,nodev,noexec'
const HEALTH_TEST = ['CMD', '/usr/bin/test', '-S', '/run/chatapp-media/media.sock']
const SOURCE_PATHS = ['apps/server/src', 'packages/contracts/src', 'packages/db/src']
const COMMANDS = {
  media: ['bun', '--no-env-file', '/app/apps/media/src/server.ts'],
  worker: ['bun', '--no-env-file', '--watch', '/app/apps/server/src/worker.ts'],
}
const REQUIRED = [
  'APP_ORIGIN',
  'DATABASE_URL',
  'VALKEY_URL',
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'BETTER_AUTH_SECRET',
  'AUTH_TOKEN_ENCRYPTION_KEY',
  'RESTORE_EPOCH',
  'SMTP_HOST',
  'SMTP_PORT',
  'MAIL_FROM',
]
const DEFAULTS = {
  APP_TIMEZONE: 'Asia/Shanghai',
  S3_REGION: 'garage',
  GARAGE_METRICS_TOKEN: '',
  SMTP_USER: '',
  SMTP_PASS: '',
  PRODUCT_NAME: 'ChatApp',
  AGENT_DISPLAY_NAME: '助手',
  AGENT_USERNAME: 'assistant',
  LOG_LEVEL: 'info',
  AI_PROVIDER: 'soclaas',
  SOCLAAS_API_KEY: '',
  DEEPSEEK_API_KEY: '',
  AI_MODEL_FAST: '',
  AI_MODEL_DEEP: '',
  AI_USER_DAILY_TOKENS: '500000',
  AI_MONTHLY_BUDGET_USD: '20',
  AI_EXPERIMENT_BUDGET_USD: '0',
  AI_PRICE_FAST_INPUT_CACHE_HIT: '0.006',
  AI_PRICE_FAST_INPUT: '0.3',
  AI_PRICE_FAST_OUTPUT: '1.2',
  AI_PRICE_DEEP_INPUT_CACHE_HIT: '0.006',
  AI_PRICE_DEEP_INPUT: '0.3',
  AI_PRICE_DEEP_OUTPUT: '1.2',
}
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
  'TMPDIR',
]

type Source = Record<string, string | undefined>
type Mode = 'dev' | 'detached'
export type ContainerTarget = { id: string; service: 'media' | 'worker'; owner: string; mode: Mode }
export type MediaLease = {
  version: 1
  project: string
  repository: string
  owner: string
  mode: Mode
  containers: ContainerTarget[]
  owned: ContainerTarget[]
}
export type DockerRunner = (
  args: string[],
  options?: { env?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number },
) => Promise<string>

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`media: ${message}`)
}
function object(value: unknown): Record<string, unknown> {
  requireCondition(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'invalid Docker or ownership data',
  )
  return value as Record<string, unknown>
}
function array(value: unknown): unknown[] {
  requireCondition(Array.isArray(value), 'invalid Docker or ownership array')
  return value
}
function strings(value: unknown): string[] {
  const values = array(value)
  requireCondition(
    values.every((entry) => typeof entry === 'string'),
    'invalid Docker string array',
  )
  return values as string[]
}
function decode(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('media: invalid JSON; command output withheld')
  }
}
function one(text: string): Record<string, unknown> {
  const values = array(decode(text))
  requireCondition(values.length === 1, 'expected exactly one inspected resource')
  return object(values[0])
}
function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
function localUrl(value: string, key: string, protocols: string[]): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`media: ${key} must be a local development URL`)
  }
  requireCondition(
    protocols.includes(url.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      !url.search &&
      !url.hash,
    `${key} must target the local development dependency without query or fragment`,
  )
  return url
}

/** Explicit worker allowlist. Model credentials never enter the network-isolated decoder. */
export function workerEnvironment(source: Source): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of REQUIRED) {
    const value = source[key]
    requireCondition(
      value !== undefined && value !== '' && value !== '<generated>',
      `${key} is required; run setup first`,
    )
    env[key] = value
  }
  for (const [key, fallback] of Object.entries(DEFAULTS)) env[key] = source[key] || fallback
  if (!env.AI_MODEL_FAST)
    env.AI_MODEL_FAST = env.AI_PROVIDER === 'soclaas' ? 'x-test-1' : 'deepseek-flash'
  if (!env.AI_MODEL_DEEP)
    env.AI_MODEL_DEEP = env.AI_PROVIDER === 'soclaas' ? 'x-test-1' : 'deepseek-flash'
  if (env.AI_PROVIDER === 'soclaas') env.DEEPSEEK_API_KEY = ''
  else env.SOCLAAS_API_KEY = ''
  requireCondition(
    env.APP_ORIGIN === 'http://localhost:5173',
    'APP_ORIGIN must be http://localhost:5173 for this development stack',
  )
  const database = localUrl(env.DATABASE_URL ?? '', 'DATABASE_URL', ['postgres:', 'postgresql:'])
  requireCondition(
    database.username === 'chatapp_app' && database.pathname === '/chatapp',
    'DATABASE_URL must use the unprivileged chatapp_app role and development database',
  )
  database.hostname = 'postgres'
  database.port = '5432'
  const valkey = localUrl(env.VALKEY_URL ?? '', 'VALKEY_URL', ['redis:'])
  requireCondition(
    valkey.pathname === '' || valkey.pathname === '/0',
    'VALKEY_URL must use development db 0',
  )
  valkey.hostname = 'valkey'
  valkey.port = '6379'
  const s3 = localUrl(env.S3_ENDPOINT ?? '', 'S3_ENDPOINT', ['http:'])
  requireCondition(
    !s3.username && !s3.password && s3.pathname === '/',
    'S3_ENDPOINT must be the local Garage root',
  )
  s3.hostname = 'garage'
  s3.port = '3900'
  requireCondition(
    ['localhost', '127.0.0.1', '::1'].includes(env.SMTP_HOST ?? ''),
    'SMTP_HOST must be local Mailpit',
  )
  return {
    ...env,
    APP_ENV: 'development',
    NODE_ENV: 'development',
    MEDIA_SOCKET_PATH,
    DATABASE_URL: database.toString(),
    VALKEY_URL: valkey.toString(),
    S3_ENDPOINT: s3.origin,
    GARAGE_METRICS_ENDPOINT: 'http://garage:3903/metrics',
    SMTP_HOST: 'mailpit',
    SMTP_PORT: '1025',
  }
}

/** Docker's own configuration paths only; the business environment is not inherited by CLI/log processes. */
export function dockerEnvironment(source: Source): Record<string, string> {
  const env: Record<string, string> = { COMPOSE_DISABLE_ENV_FILE: '1' }
  for (const key of DOCKER_ENV) if (source[key] !== undefined) env[key] = source[key]
  return env
}
export function composeEnvironment(
  worker: Record<string, string>,
  owner: string,
  mode: Mode,
  source: Source = process.env,
): Record<string, string> {
  requireCondition(OWNER.test(owner), 'invalid owner id')
  return {
    ...dockerEnvironment(source),
    ...Object.fromEntries(Object.entries(worker).map(([key, value]) => [`WORKER_${key}`, value])),
    MEDIA_REPOSITORY: REPOSITORY,
    MEDIA_OWNER: owner,
    MEDIA_MODE: mode,
  }
}

/** Synthetic placeholders only. configtest does not read an env file or inspect a running container. */
export function configCheckWorker(): Record<string, string> {
  return workerEnvironment({
    APP_ORIGIN: 'http://localhost:5173',
    DATABASE_URL: 'postgres://chatapp_app:config-only@localhost:25434/chatapp',
    VALKEY_URL: 'redis://localhost:26379/0',
    S3_ENDPOINT: 'http://localhost:3900',
    S3_BUCKET: 'chatapp',
    S3_ACCESS_KEY_ID: 'config-only',
    S3_SECRET_ACCESS_KEY: 'config-only',
    BETTER_AUTH_SECRET: 'config-check-only-not-a-real-secret',
    AUTH_TOKEN_ENCRYPTION_KEY: 'A'.repeat(43),
    RESTORE_EPOCH: 'config-only',
    SMTP_HOST: 'localhost',
    SMTP_PORT: '12525',
    MAIL_FROM: 'ChatApp <noreply@chatapp.localhost>',
  })
}

export function verifyOwnership(
  value: unknown,
  expected: Partial<ContainerTarget> = {},
): ContainerTarget {
  const container = object(value)
  const config = object(container.Config)
  const labels = object(config.Labels)
  requireCondition(
    typeof container.Id === 'string' &&
      ID.test(container.Id) &&
      labels['com.docker.compose.project'] === MEDIA_PROJECT &&
      labels['com.docker.compose.project.config_files'] === COMPOSE &&
      labels['com.docker.compose.project.working_dir'] === join(ROOT, 'infra') &&
      labels['chatapp.media.policy'] === '1' &&
      labels['chatapp.media.repository'] === REPOSITORY,
    'container ownership or repository does not verify; nothing changed',
  )
  const service = labels['com.docker.compose.service']
  const owner = labels['chatapp.media.owner']
  const mode = labels['chatapp.media.mode']
  requireCondition(
    (service === 'media' || service === 'worker') &&
      typeof owner === 'string' &&
      OWNER.test(owner) &&
      (mode === 'dev' || mode === 'detached'),
    'invalid container owner, mode or service; nothing changed',
  )
  const target: ContainerTarget = { id: container.Id, service, owner, mode }
  for (const key of ['id', 'service', 'owner', 'mode'] as const)
    requireCondition(
      expected[key] === undefined || target[key] === expected[key],
      'container was replaced or belongs to another invocation; nothing changed',
    )
  return target
}

function environment(values: unknown): Record<string, string> {
  const result: Record<string, string> = {}
  for (const entry of strings(values)) {
    const at = entry.indexOf('=')
    requireCondition(
      at > 0 && !(entry.slice(0, at) in result),
      'invalid or duplicate container environment entry',
    )
    result[entry.slice(0, at)] = entry.slice(at + 1)
  }
  return result
}
function exactEnvironment(actual: Record<string, unknown>, expected: Record<string, string>): void {
  requireCondition(
    same(Object.keys(actual).sort(), Object.keys(expected).sort()) &&
      Object.entries(expected).every(([key, value]) => actual[key] === value),
    'container environment does not match its whitelist; values withheld',
  )
}
function tmpfsOptions(value: unknown): void {
  requireCondition(
    typeof value === 'string' && same(value.split(',').sort(), TMPFS.split(',').sort()),
    'temporary storage must be the single bounded /tmp tmpfs',
  )
}

/** Validate actual engine settings before reuse/start, not just what the YAML intended. */
export function verifyRuntime(
  value: unknown,
  worker?: Record<string, string>,
  requireRunning = true,
): ContainerTarget {
  const container = object(value)
  const target = verifyOwnership(container)
  const config = object(container.Config)
  const host = object(container.HostConfig)
  const state = object(container.State)
  const media = target.service === 'media'
  requireCondition(
    config.User === '10001:10001' &&
      config.WorkingDir === '/app' &&
      config.Image === (media ? 'chatapp-media:dev' : 'chatapp-worker:dev') &&
      same(config.Cmd, COMMANDS[target.service]),
    'unexpected image, entry point or user',
  )
  requireCondition(
    object(config.Labels)['chatapp.media.image'] === (media ? 'runtime' : undefined),
    'media must use the runtime image, not a fault target',
  )
  if (media)
    requireCondition(
      same(object(config.Healthcheck).Test, HEALTH_TEST),
      'media health check must not create a second runtime or IPC task',
    )
  requireCondition(
    host.ReadonlyRootfs === true &&
      host.Privileged === false &&
      host.Init === true &&
      same(host.CapDrop, ['ALL']) &&
      same(host.SecurityOpt, ['no-new-privileges:true']) &&
      host.IpcMode === 'private' &&
      host.PidMode === '',
    'container hardening does not verify',
  )
  const bytes = (media ? 512 : 1536) * 1024 * 1024
  requireCondition(
    host.Memory === bytes && host.MemorySwap === bytes && host.PidsLimit === (media ? 64 : 256),
    'container memory, swap or process limits do not verify',
  )
  requireCondition(
    host.NetworkMode === (media ? 'none' : DEV_NETWORK) &&
      Object.keys(object(host.PortBindings ?? {})).length === 0 &&
      array(host.Devices ?? []).length === 0 &&
      array(host.DeviceRequests ?? []).length === 0,
    'unexpected network, port or device access',
  )
  const networks = Object.keys(object(object(container.NetworkSettings).Networks))
  requireCondition(
    media ? networks.every((name) => name === 'none') : same(networks, [DEV_NETWORK]),
    'unexpected attached network',
  )
  const tmpfs = object(host.Tmpfs)
  requireCondition(same(Object.keys(tmpfs), ['/tmp']), 'unexpected writable tmpfs')
  tmpfsOptions(tmpfs['/tmp'])
  const mounts = array(container.Mounts).map(object)
  // Docker versions differ on whether a HostConfig.Tmpfs also appears in Mounts.
  const dataMounts = mounts.filter((mount) => mount.Type !== 'tmpfs')
  requireCondition(
    mounts
      .filter((mount) => mount.Type === 'tmpfs')
      .every((mount) => mount.Destination === '/tmp') && dataMounts.length === (media ? 1 : 4),
    'unexpected data mount',
  )
  const socket = dataMounts.find((mount) => mount.Destination === '/run/chatapp-media')
  requireCondition(
    socket?.Type === 'volume' &&
      socket.Name === `${MEDIA_PROJECT}_media-socket` &&
      socket.RW === media,
    'socket volume is not private or has incorrect write access',
  )
  if (!media)
    for (const path of SOURCE_PATHS) {
      const mount = dataMounts.find((entry) => entry.Destination === `/app/${path}`)
      requireCondition(
        mount?.Type === 'bind' && mount.Source === join(ROOT, path) && mount.RW === false,
        'worker source mount does not verify',
      )
    }
  const actual = environment(config.Env)
  const expected = media
    ? mediaEnvironment('/tmp')
    : { ...IMAGE_ENV, ...(worker ?? configCheckWorker()) }
  if (!media && !worker) {
    requireCondition(
      same(Object.keys(actual).sort(), Object.keys(expected).sort()) &&
        actual.APP_ENV === 'development' &&
        actual.MEDIA_SOCKET_PATH === MEDIA_SOCKET_PATH,
      'worker environment contains unexpected credentials or configuration',
    )
  } else exactEnvironment(actual, expected)
  if (requireRunning)
    requireCondition(
      state.Running === true &&
        state.Restarting === false &&
        (!media || object(state.Health).Status === 'healthy'),
      'existing stack is stopped, restarting or unhealthy; ask its owner to stop it, not silently restart it',
    )
  return target
}

/** Compose config is captured in memory; neither its stdout nor stderr is ever printed. */
export function verifyComposeConfiguration(value: unknown, worker: Record<string, string>): void {
  const config = object(value)
  requireCondition(config.name === MEDIA_PROJECT, 'unexpected Compose project')
  const services = object(config.services)
  requireCondition(
    same(Object.keys(services).sort(), [...SERVICES].sort()),
    'Compose must manage only media and worker',
  )
  for (const name of SERVICES) {
    const service = object(services[name])
    const media = name === 'media'
    const build = object(service.build)
    requireCondition(
      build.context === ROOT &&
        build.dockerfile === `infra/Dockerfile.${name}` &&
        build.target === 'runtime',
      'unexpected build context or target',
    )
    requireCondition(
      service.user === '10001:10001' &&
        service.read_only === true &&
        service.init === true &&
        service.ipc === 'private' &&
        same(service.command, COMMANDS[name]) &&
        same(service.cap_drop, ['ALL']) &&
        same(service.security_opt, ['no-new-privileges:true']),
      'Compose hardening does not verify',
    )
    const bytes = (media ? 512 : 1536) * 1024 * 1024
    requireCondition(
      Number(service.mem_limit) === bytes &&
        Number(service.memswap_limit) === bytes &&
        service.pids_limit === (media ? 64 : 256),
      'Compose resource limits do not verify',
    )
    for (const forbidden of [
      'env_file',
      'ports',
      'expose',
      'devices',
      'device_cgroup_rules',
      'secrets',
      'configs',
      'pid',
      'privileged',
      'volumes_from',
      'extra_hosts',
      'entrypoint',
    ])
      requireCondition(
        service[forbidden] === undefined || service[forbidden] === null,
        `unexpected Compose setting: ${forbidden}`,
      )
    const tmpfs = strings(service.tmpfs)
    requireCondition(
      tmpfs.length === 1 && tmpfs[0]?.startsWith('/tmp:') === true,
      'Compose must use one /tmp tmpfs',
    )
    tmpfsOptions(tmpfs[0]?.slice('/tmp:'.length))
    const mounts = array(service.volumes).map(object)
    requireCondition(mounts.length === (media ? 1 : 4), 'unexpected Compose data mount')
    const socket = mounts.find((mount) => mount.target === '/run/chatapp-media')
    requireCondition(
      socket?.type === 'volume' &&
        socket.source === 'media-socket' &&
        (socket.read_only === true) === !media,
      'unexpected socket mount',
    )
    if (media) {
      requireCondition(
        same(object(service.healthcheck).test, HEALTH_TEST),
        'media health check must use the fixed one-PID native probe',
      )
      requireCondition(
        service.network_mode === 'none' &&
          service.networks === undefined &&
          service.environment === undefined,
        'media must have no network or application environment',
      )
    } else {
      requireCondition(
        service.network_mode === undefined && same(Object.keys(object(service.networks)), ['dev']),
        'worker must use only the existing development network',
      )
      exactEnvironment(object(service.environment), worker)
      for (const path of SOURCE_PATHS) {
        const mount = mounts.find((entry) => entry.target === `/app/${path}`)
        requireCondition(
          mount?.type === 'bind' &&
            mount.source === join(ROOT, path) &&
            mount.read_only === true &&
            object(mount.bind).create_host_path === false,
          'unexpected worker source mount',
        )
      }
    }
  }
  const volumes = object(config.volumes)
  const socketVolume = object(volumes['media-socket'])
  const volumeLabels = object(socketVolume.labels)
  requireCondition(
    same(Object.keys(volumes), ['media-socket']) &&
      socketVolume.name === `${MEDIA_PROJECT}_media-socket` &&
      socketVolume.external !== true &&
      (socketVolume.driver === undefined || socketVolume.driver === 'local') &&
      socketVolume.driver_opts === undefined &&
      volumeLabels['chatapp.media.policy'] === '1' &&
      volumeLabels['chatapp.media.repository'] === REPOSITORY,
    'unexpected shared volume or host/object-backed volume options',
  )
  const networks = object(config.networks)
  requireCondition(
    same(Object.keys(networks), ['dev']) &&
      object(networks.dev).external === true &&
      object(networks.dev).name === DEV_NETWORK,
    'unexpected dependency network',
  )
}

const docker: DockerRunner = async (args, options = {}) => {
  requireCondition(!options.signal?.aborted, 'operation cancelled')
  const child = Bun.spawn(['docker', ...args], {
    cwd: ROOT,
    env: options.env ?? dockerEnvironment(process.env),
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  })
  let timedOut = false
  const abort = () => child.kill('SIGTERM')
  options.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    abort()
  }, options.timeoutMs ?? 30_000)
  try {
    const [stdout, , code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    requireCondition(
      !options.signal?.aborted && !timedOut && code === 0,
      `docker ${args[0] ?? 'command'} ${timedOut ? 'timed out' : options.signal?.aborted ? 'cancelled' : `failed (exit ${code})`}; output withheld because it may contain credentials`,
    )
    return stdout
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}
async function locked<T>(action: () => Promise<T>): Promise<T> {
  mkdirSync(STATE, { recursive: true, mode: 0o700 })
  requireCondition(
    !existsSync(LOCK),
    'another media command holds .test-runs/media/start.lock; no containers changed',
  )
  mkdirSync(LOCK, { mode: 0o700 })
  try {
    return await action()
  } finally {
    rmdirSync(LOCK)
  }
}
async function ids(run: DockerRunner): Promise<string[]> {
  const found = (
    await run([
      'ps',
      '--all',
      '--quiet',
      '--no-trunc',
      '--filter',
      `label=com.docker.compose.project=${MEDIA_PROJECT}`,
    ])
  )
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  requireCondition(
    found.every((id) => ID.test(id)) && new Set(found).size === found.length,
    'invalid container list; nothing changed',
  )
  return found
}
async function inspect(run: DockerRunner, id: string): Promise<Record<string, unknown>> {
  requireCondition(ID.test(id), 'invalid container id')
  return one(await run(['inspect', '--type', 'container', id]))
}
export function verifySocketVolume(value: unknown): void {
  const volume = object(value)
  const labels = object(volume.Labels)
  requireCondition(
    volume.Name === `${MEDIA_PROJECT}_media-socket` &&
      volume.Driver === 'local' &&
      volume.Scope === 'local' &&
      Object.keys(object(volume.Options ?? {})).length === 0 &&
      labels['com.docker.compose.project'] === MEDIA_PROJECT &&
      labels['com.docker.compose.volume'] === 'media-socket' &&
      labels['chatapp.media.policy'] === '1' &&
      labels['chatapp.media.repository'] === REPOSITORY,
    'socket volume ownership/driver does not verify; host/object-backed volumes are forbidden',
  )
}
async function socketVolume(
  run: DockerRunner,
  targets: ContainerTarget[],
  allowMissing = false,
): Promise<void> {
  const name = `${MEDIA_PROJECT}_media-socket`
  const names = (await run(['volume', 'ls', '--quiet', '--filter', `name=^${name}$`]))
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  requireCondition(
    names.length <= 1 && names.every((entry) => entry === name),
    'ambiguous socket volume',
  )
  if (names.length === 0) {
    requireCondition(allowMissing, 'socket volume is missing')
    return
  }
  verifySocketVolume(one(await run(['volume', 'inspect', name])))
  const users = (await run(['ps', '--all', '--quiet', '--no-trunc', '--filter', `volume=${name}`]))
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  requireCondition(
    users.every((id) => ID.test(id) && targets.some((target) => target.id === id)),
    'socket volume is mounted by an unrelated container; nothing changed',
  )
}
async function dependencies(run: DockerRunner): Promise<void> {
  const network = one(await run(['network', 'inspect', DEV_NETWORK]))
  const labels = object(network.Labels)
  requireCondition(
    labels['com.docker.compose.project'] === 'chatapp-dev' &&
      labels['com.docker.compose.network'] === 'default',
    'development network does not verify; run infra:up first',
  )
  for (const service of ['postgres', 'valkey', 'garage', 'mailpit']) {
    const id = (
      await run([
        'ps',
        '--all',
        '--quiet',
        '--no-trunc',
        '--filter',
        'label=com.docker.compose.project=chatapp-dev',
        '--filter',
        `label=com.docker.compose.service=${service}`,
      ])
    ).trim()
    requireCondition(
      ID.test(id),
      `development ${service} is missing or ambiguous; run infra:up first`,
    )
    const container = await inspect(run, id)
    const scope = object(object(container.Config).Labels)
    const state = object(container.State)
    requireCondition(
      scope['com.docker.compose.project.config_files'] === join(ROOT, 'infra', 'compose.dev.yml') &&
        state.Running === true &&
        object(state.Health).Status === 'healthy' &&
        DEV_NETWORK in object(object(container.NetworkSettings).Networks),
      `development ${service} does not verify; it will not be restarted here`,
    )
  }
}
function lease(targets: ContainerTarget[], owned: boolean): MediaLease {
  const first = targets[0]
  requireCondition(
    first !== undefined &&
      targets.length === 2 &&
      new Set(targets.map((target) => target.service)).size === 2 &&
      targets.every((target) => target.owner === first.owner && target.mode === first.mode),
    'worker/media must be one complete, single-owner stack',
  )
  return {
    version: 1,
    project: MEDIA_PROJECT,
    repository: REPOSITORY,
    owner: first.owner,
    mode: first.mode,
    containers: targets,
    owned: owned ? targets : [],
  }
}

/** Compose creates the topology; starting by immutable ids cannot start a replacement found by service name. */
export async function startOwnedContainers(
  receipt: MediaLease,
  worker: Record<string, string>,
  run: DockerRunner = docker,
  signal?: AbortSignal,
): Promise<void> {
  requireCondition(
    receipt.project === MEDIA_PROJECT && receipt.repository === REPOSITORY,
    'ownership receipt does not verify',
  )
  const owned = lease(receipt.owned, true)
  requireCondition(
    owned.owner === receipt.owner && owned.mode === receipt.mode,
    'mixed ownership receipt; nothing started',
  )
  const media = owned.containers.find((target) => target.service === 'media')
  const consumer = owned.containers.find((target) => target.service === 'worker')
  requireCondition(media !== undefined && consumer !== undefined, 'incomplete owned stack')
  for (const target of owned.containers) {
    const value = await inspect(run, target.id)
    verifyOwnership(value, target)
    verifyRuntime(value, worker, false)
  }
  requireCondition(!signal?.aborted, 'operation cancelled')
  await run(['start', media.id], { signal })
  const deadline = Date.now() + 90_000
  for (;;) {
    requireCondition(!signal?.aborted, 'operation cancelled')
    const value = await inspect(run, media.id)
    verifyOwnership(value, media)
    verifyRuntime(value, worker, false)
    const state = object(value.State)
    if (
      state.Running === true &&
      state.Restarting === false &&
      object(state.Health ?? {}).Status === 'healthy'
    )
      break
    requireCondition(Date.now() < deadline, 'media socket did not become healthy within 90 seconds')
    await Bun.sleep(250)
  }
  requireCondition(!signal?.aborted, 'operation cancelled')
  await run(['start', consumer.id], { signal })
  for (const target of owned.containers) {
    const value = await inspect(run, target.id)
    verifyOwnership(value, target)
    verifyRuntime(value, worker)
  }
  requireCondition(!signal?.aborted, 'operation cancelled')
}

/** Verify every exact id before the first destructive action. Borrowed containers generate no Docker calls. */
export async function stopOwnedContainers(
  receipt: MediaLease,
  run: DockerRunner = docker,
): Promise<void> {
  if (receipt.owned.length === 0) return
  requireCondition(
    receipt.project === MEDIA_PROJECT &&
      receipt.repository === REPOSITORY &&
      OWNER.test(receipt.owner),
    'ownership receipt does not verify',
  )
  const present = await ids(run)
  const targets: ContainerTarget[] = []
  for (const target of receipt.owned) {
    requireCondition(
      target.owner === receipt.owner && target.mode === receipt.mode,
      'mixed ownership receipt; nothing changed',
    )
    if (!present.includes(target.id)) continue
    targets.push(verifyOwnership(await inspect(run, target.id), target))
  }
  if (targets.length === 0) return
  const exactIds = targets.map((target) => target.id)
  await run(['stop', '--time', '15', ...exactIds], { timeoutMs: 45_000 })
  await run(['rm', ...exactIds]) // No -v, down, prune, or name/prefix matching.
}
function readReceipt(): MediaLease {
  requireCondition(
    lstatSync(RECEIPT).isFile() && lstatSync(RECEIPT).size < 16_384,
    'invalid ownership receipt file',
  )
  const saved = object(decode(readFileSync(RECEIPT, 'utf8')))
  requireCondition(
    saved.version === 1 && saved.project === MEDIA_PROJECT && saved.repository === REPOSITORY,
    'ownership receipt belongs to another repository',
  )
  const targets = array(saved.containers).map((value) => {
    const target = object(value)
    requireCondition(
      typeof target.id === 'string' &&
        ID.test(target.id) &&
        (target.service === 'media' || target.service === 'worker') &&
        typeof target.owner === 'string' &&
        OWNER.test(target.owner) &&
        target.mode === 'detached',
      'invalid detached ownership target',
    )
    return {
      id: target.id,
      service: target.service,
      owner: target.owner,
      mode: target.mode,
    } satisfies ContainerTarget
  })
  const result = lease(targets, true)
  requireCondition(
    result.owner === saved.owner && saved.mode === 'detached' && same(saved.owned, result.owned),
    'ownership receipt was changed; nothing stopped',
  )
  return result
}
function removeReceipt(receipt: MediaLease): void {
  if (!existsSync(RECEIPT)) return
  const saved = readReceipt()
  requireCondition(
    saved.owner === receipt.owner && same(saved.owned, receipt.owned),
    'ownership receipt was replaced; not removed',
  )
  unlinkSync(RECEIPT)
}

export async function startMediaStack(options: {
  mode: Mode
  source?: Source
  signal?: AbortSignal
  run?: DockerRunner
}): Promise<MediaLease> {
  const run = options.run ?? docker
  const worker = workerEnvironment(options.source ?? process.env)
  const owner = randomUUID()
  const env = composeEnvironment(worker, owner, options.mode, options.source)
  return await locked(async () => {
    verifyComposeConfiguration(
      decode(
        await run([...COMPOSE_ARGS, 'config', '--format', 'json'], { env, signal: options.signal }),
      ),
      worker,
    )
    const present = await ids(run)
    if (present.length > 0) {
      const targets: ContainerTarget[] = []
      for (const id of present) targets.push(verifyRuntime(await inspect(run, id), worker))
      await socketVolume(run, targets)
      return lease(targets, false)
    }
    requireCondition(
      !existsSync(RECEIPT),
      'a previous ownership receipt remains; run media:down before creating a new stack',
    )
    await dependencies(run)
    await socketVolume(run, [], true)
    let created: MediaLease | undefined
    try {
      await run([...COMPOSE_ARGS, 'build', '--pull', ...SERVICES], {
        env,
        signal: options.signal,
        timeoutMs: 300_000,
      })
      // Creation cannot start/restart somebody else's container. Check ownership before the separate start command.
      await run([...COMPOSE_ARGS, 'create', '--no-recreate', ...SERVICES], {
        env,
        signal: options.signal,
        timeoutMs: 60_000,
      })
      const targets: ContainerTarget[] = []
      for (const id of await ids(run)) {
        const value = await inspect(run, id)
        const target = verifyOwnership(value, { owner, mode: options.mode })
        verifyRuntime(value, worker, false)
        targets.push(target)
      }
      created = lease(targets, true)
      await socketVolume(run, targets)
      if (options.mode === 'detached')
        writeFileSync(RECEIPT, JSON.stringify(created, null, 2), { mode: 0o600, flag: 'wx' })
      await startOwnedContainers(created, worker, run, options.signal)
      return created
    } catch (error) {
      // Even a failed create can leave one container. Only this run's verified ids are eligible for cleanup.
      try {
        if (created) await stopOwnedContainers(created, run)
        else {
          const targets: ContainerTarget[] = []
          for (const id of await ids(run)) {
            const value = await inspect(run, id)
            if (object(object(value.Config).Labels)['chatapp.media.owner'] === owner)
              targets.push(verifyOwnership(value, { owner, mode: options.mode }))
          }
          if (targets.length > 0)
            await stopOwnedContainers(
              {
                version: 1,
                project: MEDIA_PROJECT,
                repository: REPOSITORY,
                owner,
                mode: options.mode,
                containers: targets,
                owned: targets,
              },
              run,
            )
        }
        if (created && options.mode === 'detached') removeReceipt(created)
      } catch {
        console.error(
          'media: automatic cleanup could not verify/stop its containers; unrelated containers and all volumes were left untouched',
        )
      }
      throw error
    }
  })
}

async function pipe(
  stream: ReadableStream<Uint8Array>,
  name: string,
  output: NodeJS.WriteStream,
): Promise<void> {
  const decoder = new TextDecoder()
  let pending = ''
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true })
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) output.write(`[${name}] ${line}\n`)
  }
  if (pending) output.write(`[${name}] ${pending}\n`)
}
async function foreground(): Promise<number> {
  const controller = new AbortController()
  const children: Bun.Subprocess<'ignore', 'pipe', 'pipe'>[] = []
  let receipt: MediaLease | undefined
  const stop = () => {
    controller.abort()
    for (const child of children) child.kill('SIGTERM')
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    receipt = await startMediaStack({ mode: 'dev', signal: controller.signal })
    if (controller.signal.aborted) return 0
    console.log(
      receipt.owned.length
        ? 'media: worker/media started; this invocation owns their cleanup'
        : 'media: verified running stack reused; Ctrl+C will leave its containers running',
    )
    for (const target of receipt.containers) {
      const child = Bun.spawn(['docker', 'logs', '--follow', '--tail', '30', target.id], {
        cwd: ROOT,
        env: dockerEnvironment(process.env),
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
      })
      children.push(child)
      void pipe(child.stdout, target.service, process.stdout)
      void pipe(child.stderr, target.service, process.stderr)
    }
    await Promise.race(children.map((child) => child.exited))
    if (controller.signal.aborted) return 0
    console.error(
      'media: a container log stream ended unexpectedly; stopping only this invocation’s containers',
    )
    return 1
  } catch (error) {
    if (controller.signal.aborted) return 0
    throw error
  } finally {
    stop()
    await Promise.all(children.map((child) => child.exited))
    const ownedReceipt = receipt
    if (ownedReceipt?.owned.length) await locked(() => stopOwnedContainers(ownedReceipt))
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}
async function main(): Promise<number> {
  const [command, ...extra] = process.argv.slice(2)
  requireCondition(extra.length === 0, 'usage: scripts/media.ts up | down | run | configtest')
  switch (command) {
    case 'up': {
      const controller = new AbortController()
      const stop = () => controller.abort()
      process.on('SIGINT', stop)
      process.on('SIGTERM', stop)
      try {
        const receipt = await startMediaStack({ mode: 'detached', signal: controller.signal })
        console.log(
          receipt.owned.length
            ? 'media: worker/media started; media:down will stop only their verified ids'
            : 'media: verified running stack reused; ownership was not changed',
        )
      } catch (error) {
        if (!controller.signal.aborted) throw error
      } finally {
        process.off('SIGINT', stop)
        process.off('SIGTERM', stop)
      }
      return 0
    }
    case 'down':
      await locked(async () => {
        if (!existsSync(RECEIPT)) {
          requireCondition(
            (await ids(docker)).length === 0,
            'no detached ownership receipt; existing containers may belong to a dev session and will not be stopped',
          )
          return
        }
        const receipt = readReceipt()
        await stopOwnedContainers(receipt)
        removeReceipt(receipt)
      })
      console.log(
        'media: owned containers removed; development dependencies and all data volumes retained',
      )
      return 0
    case 'run':
      return await foreground()
    case 'configtest': {
      const worker = configCheckWorker()
      const env = composeEnvironment(worker, randomUUID(), 'dev')
      verifyComposeConfiguration(
        decode(await docker([...COMPOSE_ARGS, 'config', '--format', 'json'], { env })),
        worker,
      )
      console.log(
        'media: Compose topology, isolation, budgets and worker whitelist verified (synthetic environment; no services started)',
      )
      return 0
    }
    default:
      throw new Error('media: usage: scripts/media.ts up | down | run | configtest')
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main()
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'media: lifecycle failed; details withheld',
    )
    process.exitCode = 1
  }
}
