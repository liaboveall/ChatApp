/** Static D-081 / V-18 guardrails. No Docker, services, real credentials, or fault injection. */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { YAML } from 'bun'
import { mediaEnvironment } from '../apps/media/src/runtime/environment.ts'
import {
  composeEnvironment,
  configCheckWorker,
  DEV_NETWORK,
  type DockerRunner,
  dockerEnvironment,
  MEDIA_PROJECT,
  MEDIA_SOCKET_PATH,
  type MediaLease,
  REPOSITORY,
  ROOT,
  startOwnedContainers,
  stopOwnedContainers,
  verifyComposeConfiguration,
  verifyOwnership,
  verifyRuntime,
  verifySocketVolume,
  workerEnvironment,
} from './media.ts'

const OWNER = '00000000-0000-4000-8000-000000000001'
const OTHER_OWNER = '00000000-0000-4000-8000-000000000002'
const MEDIA_ID = 'a'.repeat(64)
const WORKER_ID = 'b'.repeat(64)
const OTHER_ID = 'c'.repeat(64)
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')
const dict = (value: unknown): Record<string, unknown> => {
  expect(value !== null && typeof value === 'object' && !Array.isArray(value)).toBe(true)
  return value as Record<string, unknown>
}
const list = (value: unknown): unknown[] => {
  expect(Array.isArray(value)).toBe(true)
  return value as unknown[]
}
const raw = dict(YAML.parse(read('infra/compose.media.yml')))
const rawServices = dict(raw.services)
const worker = configCheckWorker()
const imageEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', TMPDIR: '/tmp' }

function source(): Record<string, string> {
  return {
    ...worker,
    DATABASE_URL: 'postgres://chatapp_app:fixture-password@localhost:25434/chatapp',
    VALKEY_URL: 'redis://localhost:26379/0',
    S3_ENDPOINT: 'http://localhost:3900',
    SMTP_HOST: 'localhost',
    SMTP_PORT: '12525',
  }
}
function normalized(): Record<string, unknown> {
  const config = structuredClone(raw)
  const services = dict(config.services)
  for (const name of ['media', 'worker']) {
    const service = dict(services[name])
    dict(service.build).context = ROOT
    service.mem_limit = String((name === 'media' ? 512 : 1536) * 1024 * 1024)
    service.memswap_limit = service.mem_limit
    service.entrypoint = null
    for (const value of list(service.volumes)) {
      const mount = dict(value)
      if (mount.type === 'bind') mount.source = resolve(ROOT, 'infra', String(mount.source))
    }
    if (name === 'worker') {
      service.networks = { dev: null }
      service.environment = { ...worker }
    }
  }
  config.volumes = {
    'media-socket': {
      name: `${MEDIA_PROJECT}_media-socket`,
      labels: { 'chatapp.media.policy': '1', 'chatapp.media.repository': REPOSITORY },
    },
    'embedding-socket': {
      name: `${MEDIA_PROJECT}_embedding-socket`,
      labels: { 'chatapp.media.policy': '1', 'chatapp.media.repository': REPOSITORY },
    },
    'embedding-models': {
      name: `${MEDIA_PROJECT}_embedding-models`,
      labels: { 'chatapp.media.policy': '1', 'chatapp.media.repository': REPOSITORY },
    },
  }
  return config
}
function container(service: 'media' | 'worker'): Record<string, unknown> {
  const media = service === 'media'
  const labels: Record<string, string> = {
    'com.docker.compose.project': MEDIA_PROJECT,
    'com.docker.compose.service': service,
    'com.docker.compose.project.config_files': join(ROOT, 'infra', 'compose.media.yml'),
    'com.docker.compose.project.working_dir': join(ROOT, 'infra'),
    'chatapp.media.policy': '1',
    'chatapp.media.repository': REPOSITORY,
    'chatapp.media.owner': OWNER,
    'chatapp.media.mode': 'detached',
  }
  if (media) labels['chatapp.media.image'] = 'runtime'
  return {
    Id: media ? MEDIA_ID : WORKER_ID,
    Config: {
      Labels: labels,
      User: '10001:10001',
      WorkingDir: '/app',
      Image: media ? 'chatapp-media:dev' : 'chatapp-worker:dev',
      ...(media
        ? { Healthcheck: { Test: ['CMD', '/usr/bin/test', '-S', '/run/chatapp-media/media.sock'] } }
        : {}),
      Cmd: media
        ? ['bun', '--no-env-file', '/app/apps/media/src/server.ts']
        : ['bun', '--no-env-file', '--watch', '/app/apps/server/src/worker.ts'],
      Env: Object.entries(media ? mediaEnvironment('/tmp') : { ...imageEnv, ...worker }).map(
        ([key, value]) => `${key}=${value}`,
      ),
    },
    State: { Running: true, Restarting: false, Health: { Status: 'healthy' } },
    HostConfig: {
      ReadonlyRootfs: true,
      Privileged: false,
      Init: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      IpcMode: 'private',
      PidMode: '',
      Memory: (media ? 512 : 1536) * 1024 * 1024,
      MemorySwap: (media ? 512 : 1536) * 1024 * 1024,
      PidsLimit: media ? 64 : 256,
      NetworkMode: media ? 'none' : DEV_NETWORK,
      PortBindings: {},
      Devices: [],
      DeviceRequests: null,
      Tmpfs: { '/tmp': 'size=268435456,mode=1777,nosuid,nodev,noexec' },
    },
    NetworkSettings: { Networks: media ? { none: {} } : { [DEV_NETWORK]: {} } },
    Mounts: [
      {
        Type: 'volume',
        Name: `${MEDIA_PROJECT}_media-socket`,
        Destination: '/run/chatapp-media',
        RW: media,
      },
      ...(media
        ? []
        : [
            {
              Type: 'volume',
              Name: `${MEDIA_PROJECT}_embedding-socket`,
              Destination: '/run/chatapp-embedding',
              RW: true,
            },
            {
              Type: 'volume',
              Name: `${MEDIA_PROJECT}_embedding-models`,
              Destination: '/var/lib/chatapp/models',
              RW: false,
            },
            ...['apps/server/src', 'packages/contracts/src', 'packages/db/src'].map((path) => ({
              Type: 'bind',
              Source: join(ROOT, path),
              Destination: `/app/${path}`,
              RW: false,
            })),
          ]),
    ],
  }
}
function receipt(owned = true): MediaLease {
  const targets = [verifyOwnership(container('media')), verifyOwnership(container('worker'))]
  return {
    version: 1,
    project: MEDIA_PROJECT,
    repository: REPOSITORY,
    owner: OWNER,
    mode: 'detached',
    containers: targets,
    owned: owned ? targets : [],
  }
}

describe('fixed media topology', () => {
  test('only manages worker/media; dependencies and one named socket volume are separate', () => {
    expect(raw.name).toBe(MEDIA_PROJECT)
    expect(Object.keys(rawServices).sort()).toEqual(['media', 'worker'])
    expect(Object.keys(dict(raw.volumes)).sort()).toEqual([
      'embedding-models',
      'embedding-socket',
      'media-socket',
    ])
    expect(dict(dict(raw.networks).dev)).toEqual({ external: true, name: DEV_NETWORK })
    expect(read('infra/compose.media.yml')).not.toMatch(
      /container_name|\/var\/run\/docker\.sock|seccomp:unconfined/,
    )
  })

  test('media has no environment, TCP ports, network, host/object mounts or extra writable storage', () => {
    const media = dict(rawServices.media)
    expect(media.network_mode).toBe('none')
    for (const key of [
      'environment',
      'env_file',
      'networks',
      'ports',
      'expose',
      'secrets',
      'configs',
      'devices',
    ])
      expect(media[key]).toBeUndefined()
    expect(media.volumes).toEqual([
      { type: 'volume', source: 'media-socket', target: '/run/chatapp-media' },
    ])
    expect(media.tmpfs).toEqual(['/tmp:size=268435456,mode=1777,nosuid,nodev,noexec'])
    expect(media.user).toBe('10001:10001')
    expect(media.read_only).toBe(true)
    expect(media.cap_drop).toEqual(['ALL'])
    expect(media.security_opt).toEqual(['no-new-privileges:true'])
    expect(media.pids_limit).toBe(64)
    expect(media.mem_limit).toBe('512m')
    expect(media.memswap_limit).toBe(media.mem_limit)
    expect(dict(media.healthcheck).test).toEqual([
      'CMD',
      '/usr/bin/test',
      '-S',
      '/run/chatapp-media/media.sock',
    ])
  })

  test('worker stays inside the 1536 MiB budget, watches only mounted source and cannot write socket files', () => {
    const service = dict(rawServices.worker)
    expect(service.mem_limit).toBe('1536m')
    expect(service.memswap_limit).toBe(service.mem_limit)
    expect(service.user).toBe('10001:10001')
    expect(service.command).toEqual([
      'bun',
      '--no-env-file',
      '--watch',
      '/app/apps/server/src/worker.ts',
    ])
    expect(
      list(service.volumes)
        .filter((v) => dict(v).target !== '/run/chatapp-embedding')
        .every((value) => dict(value).read_only === true),
    ).toBe(true)
    expect(
      list(service.volumes)
        .filter((v) => dict(v).target === '/run/chatapp-embedding')
        .map(dict),
    ).toEqual([{ type: 'volume', source: 'embedding-socket', target: '/run/chatapp-embedding' }])
    const binds = list(service.volumes)
      .map(dict)
      .filter((mount) => mount.type === 'bind')
    expect(binds.map((mount) => mount.source)).toEqual([
      '../apps/server/src',
      '../packages/contracts/src',
      '../packages/db/src',
    ])
    for (const mount of binds) expect(dict(mount.bind).create_host_path).toBe(false)
    expect(service.env_file).toBeUndefined()
  })

  test('Compose exposes exactly the worker whitelist, using worker-prefixed interpolation', () => {
    const variables = dict(dict(rawServices.worker).environment)
    expect(Object.keys(variables).sort()).toEqual(Object.keys(worker).sort())
    const literals = [
      'APP_ENV',
      'NODE_ENV',
      'MEDIA_SOCKET_PATH',
      'SMTP_HOST',
      'SMTP_PORT',
      'GARAGE_METRICS_ENDPOINT',
    ]
    for (const [key, value] of Object.entries(variables)) {
      if (literals.includes(key)) expect(String(value)).toBe(String(worker[key]))
      else expect(String(value)).toContain(`WORKER_${key}`)
    }
    expect(variables.DATABASE_OWNER_URL).toBeUndefined()
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal Compose substitution is the expected value
    expect(variables.DEEPSEEK_API_KEY).toBe('${WORKER_DEEPSEEK_API_KEY:-}')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal Compose substitution is the expected value
    expect(variables.SOCLAAS_API_KEY).toBe('${WORKER_SOCLAAS_API_KEY:-}')
    expect(dict(rawServices.media).environment).toBeUndefined()
  })

  test('captured normalized Compose configuration passes, and isolation drift is rejected', () => {
    expect(() => verifyComposeConfiguration(normalized(), worker)).not.toThrow()
    const config = normalized()
    dict(dict(config.services).media).environment = {
      S3_SECRET_ACCESS_KEY: 'fixture-value-must-not-be-printed',
    }
    expect(() => verifyComposeConfiguration(config, worker)).toThrow(
      'no network or application environment',
    )
    dict(dict(config.services).media).environment = undefined
    dict(dict(dict(config.services).media).build).target = 'fault'
    expect(() => verifyComposeConfiguration(config, worker)).toThrow('build context or target')
  })
})

describe('images and development entry points', () => {
  test('both images use exact verified Bun/Debian indexes and a non-root socket directory', () => {
    for (const path of ['infra/Dockerfile.media', 'infra/Dockerfile.worker']) {
      const file = read(path)
      expect(file).toContain(
        'oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61',
      )
      expect(file).toContain(
        'debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f',
      )
      expect(file).toContain('install -d -m 0700 -o 10001 -g 10001 /run/chatapp-media')
      expect(file).toContain('USER 10001:10001')
      expect(file).toContain(
        'bun install --frozen-lockfile --production --ignore-scripts --filter @chatapp/',
      )
      expect(file).not.toMatch(/^COPY\s+(?:--[^\s]+\s+)*\.\s/m)
      expect(file).not.toMatch(/^COPY\s+(?!--from=).*?(?:\.env|node_modules)\s/m)
    }
  })

  test('media copies only runtime workspaces; fault fixture is not an ancestor of the default runtime target', () => {
    const file = read('infra/Dockerfile.media')
    expect(file).toContain('ffmpeg=7:7.1.5-0+deb13u1')
    expect(file).not.toMatch(/^COPY\s+(?:apps\/(?:server|web)|packages\/db)/m)
    const application =
      file.split('FROM base AS application')[1]?.split('FROM application AS fault')[0] ?? ''
    expect(application).toContain('COPY apps/media/src ./apps/media/src')
    expect(application).toContain('COPY packages/contracts/src ./packages/contracts/src')
    expect(application).not.toContain('apps/media/test')
    const fault =
      file.split('FROM application AS fault')[1]?.split('FROM application AS runtime')[0] ?? ''
    expect(fault).toContain('COPY apps/media/test ./apps/media/test')
    expect(fault).toContain('/app/apps/media/test/fault-server.ts')
    expect(file.trim().endsWith('LABEL chatapp.media.image="runtime"')).toBe(true)
    expect(dict(dict(rawServices.media).build).target).toBe('runtime')
    const workerFile = read('infra/Dockerfile.worker')
    expect(workerFile).toContain('COPY packages/db/package.json packages/db/package.json')
    expect(workerFile).not.toMatch(/^COPY\s+apps\/media/m)
  })

  test('default dev worker launches the ownership-aware Compose runner, never a host worker', () => {
    const file = read('scripts/dev.ts')
    expect(file).toContain("worker: ['bun', '--env-file=.env.local', 'scripts/media.ts', 'run']")
    expect(file).not.toContain('apps/server/src/worker.ts')
  })
})

describe('worker environment boundary', () => {
  test('the fixed development worker leaves host embedding jobs to the host consumer', () => {
    const env = workerEnvironment({
      ...source(),
      EMBEDDING_ENABLED: 'true',
      EMBEDDING_SOCKET_PATH: '/tmp/host-only/embedding.sock',
      EMBEDDING_CACHE_DIR: '/tmp/host-only/models',
    })
    expect(env.EMBEDDING_ENABLED).toBe('false')
    expect(env.EMBEDDING_SOCKET_PATH).toBe('/run/chatapp-embedding/embedding.sock')
    expect(env.EMBEDDING_CACHE_DIR).toBe('/var/lib/chatapp/models')
  })
  test('rewrites local dependency endpoints, preserves unprivileged credentials and drops every unlisted key', () => {
    const env = workerEnvironment({
      ...source(),
      DATABASE_OWNER_URL: 'never-forward-owner',
      DATABASE_URL_TEST: 'never-forward-test',
      DEEPSEEK_API_KEY: 'never-forward-model',
      UNRELATED: 'never-forward',
    })
    expect(env.DATABASE_URL).toBe('postgres://chatapp_app:fixture-password@postgres:5432/chatapp')
    expect(env.VALKEY_URL).toBe('redis://valkey:6379/0')
    expect(env.S3_ENDPOINT).toBe('http://garage:3900')
    expect(env.SMTP_HOST).toBe('mailpit')
    expect(env.SMTP_PORT).toBe('1025')
    expect(env.MEDIA_SOCKET_PATH).toBe(MEDIA_SOCKET_PATH)
    for (const key of ['DATABASE_OWNER_URL', 'DATABASE_URL_TEST', 'UNRELATED'])
      expect(env[key]).toBeUndefined()
    expect(env.DEEPSEEK_API_KEY).toBe('')
    expect(env.APP_ENV).toBe('development')
  })
  test('only the selected model key reaches the worker; the decoder receives neither provider key', () => {
    const env = workerEnvironment({
      ...source(),
      AI_PROVIDER: 'soclaas',
      SOCLAAS_API_KEY: 'fixture-selected-key',
      DEEPSEEK_API_KEY: 'fixture-unselected-key',
    })
    expect(env.SOCLAAS_API_KEY).toBe('fixture-selected-key')
    expect(env.DEEPSEEK_API_KEY).toBe('')
    const decoder = mediaEnvironment('/tmp/fixture')
    expect(decoder.SOCLAAS_API_KEY).toBeUndefined()
    expect(decoder.DEEPSEEK_API_KEY).toBeUndefined()
    expect(decoder.S3_SECRET_ACCESS_KEY).toBeUndefined()
    const paid = workerEnvironment({
      ...source(),
      AI_PROVIDER: 'deepseek',
      SOCLAAS_API_KEY: 'fixture-unselected-key',
      DEEPSEEK_API_KEY: 'fixture-selected-key',
    })
    expect(paid.DEEPSEEK_API_KEY).toBe('fixture-selected-key')
    expect(paid.SOCLAAS_API_KEY).toBe('')
  })

  test('rejects owner role, test database, remote endpoints and URL overrides without echoing values', () => {
    for (const change of [
      { DATABASE_URL: 'postgres://chatapp:fixture-password@localhost:25434/chatapp' },
      { DATABASE_URL: 'postgres://chatapp_app:fixture-password@localhost:25434/chatapp_test' },
      {
        DATABASE_URL:
          'postgres://chatapp_app:fixture-password@localhost:25434/chatapp?host=remote.example',
      },
      { S3_ENDPOINT: 'http://remote.example/fixture-private-path' },
      { VALKEY_URL: 'redis://localhost:26379/1' },
      { SMTP_HOST: 'remote.example' },
    ]) {
      let message = ''
      try {
        workerEnvironment({ ...source(), ...change })
      } catch (error) {
        message = error instanceof Error ? error.message : ''
      }
      expect(message).toStartWith('media:')
      expect(message).not.toContain('fixture-password')
      expect(message).not.toContain('remote.example')
      expect(message).not.toContain('fixture-private-path')
    }
  })

  test('Docker CLI/log followers inherit only Docker paths, and credentials are only worker-prefixed for interpolation', () => {
    const host = {
      PATH: '/usr/bin',
      HOME: '/fixture/home',
      DEEPSEEK_API_KEY: 'not-forwarded',
      DATABASE_OWNER_URL: 'not-forwarded',
      COMPOSE_FILE: 'not-forwarded',
      MEDIA_OWNER: 'not-forwarded',
    }
    expect(dockerEnvironment(host)).toEqual({
      COMPOSE_DISABLE_ENV_FILE: '1',
      PATH: '/usr/bin',
      HOME: '/fixture/home',
    })
    const env = composeEnvironment(worker, OWNER, 'dev', host)
    expect(env.WORKER_S3_SECRET_ACCESS_KEY).toBe(worker.S3_SECRET_ACCESS_KEY)
    expect(env.S3_SECRET_ACCESS_KEY).toBeUndefined()
    expect(env.DEEPSEEK_API_KEY).toBeUndefined()
    expect(env.DATABASE_OWNER_URL).toBeUndefined()
    expect(env.COMPOSE_FILE).toBeUndefined()
    expect(env.MEDIA_OWNER).toBe(OWNER)
    expect(env.MEDIA_REPOSITORY).toBe(REPOSITORY)
  })
})

describe('actual container verification', () => {
  test('accepts the two hardened containers and a created-but-not-started media container', () => {
    expect(verifyRuntime(container('media')).id).toBe(MEDIA_ID)
    expect(verifyRuntime(container('worker'), worker).id).toBe(WORKER_ID)
    const created = container('media')
    created.State = { Running: false, Restarting: false }
    expect(() => verifyRuntime(created, worker, false)).not.toThrow()
    expect(() => verifyRuntime(created)).toThrow('stopped, restarting or unhealthy')
  })

  test('rejects unconfined seccomp, host network, missing hard limits, object mounts and credentials', () => {
    const changes: ((value: Record<string, unknown>) => void)[] = [
      (value) => {
        dict(value.HostConfig).SecurityOpt = ['seccomp:unconfined']
      },
      (value) => {
        dict(value.HostConfig).NetworkMode = 'host'
      },
      (value) => {
        dict(value.HostConfig).MemorySwap = -1
      },
      (value) => {
        dict(value.HostConfig).PidsLimit = 0
      },
      (value) => {
        dict(dict(value.Config).Healthcheck).Test = ['CMD', 'bun', '-e', 'process.exit(0)']
      },
      (value) => {
        dict(value.HostConfig).Tmpfs = { '/tmp': 'size=536870912', '/other': 'size=1' }
      },
      (value) => {
        list(value.Mounts).push({
          Type: 'bind',
          Source: '/fixture/objects',
          Destination: '/objects',
          RW: true,
        })
      },
      (value) => {
        list(dict(value.Config).Env).push('S3_SECRET_ACCESS_KEY=fixture-value-must-not-be-printed')
      },
      (value) => {
        dict(dict(value.Config).Labels)['chatapp.media.image'] = 'fault'
      },
    ]
    for (const change of changes) {
      const value = container('media')
      change(value)
      expect(() => verifyRuntime(value)).toThrow()
    }
  })

  test('rejects a worker containing owner credentials and a stack whose credentials changed; values are withheld', () => {
    const value = container('worker')
    list(dict(value.Config).Env).push('DATABASE_OWNER_URL=fixture-owner-value')
    expect(() => verifyRuntime(value, worker)).toThrow('values withheld')
    const changed = { ...worker, S3_SECRET_ACCESS_KEY: 'fixture-new-key' }
    expect(() => verifyRuntime(container('worker'), changed)).toThrow('values withheld')
  })

  test('rejects another repository or invocation even when the Compose project name matches', () => {
    const value = container('worker')
    dict(dict(value.Config).Labels)['chatapp.media.repository'] = 'd'.repeat(64)
    expect(() => verifyOwnership(value)).toThrow('repository does not verify')
    expect(() => verifyOwnership(container('worker'), { owner: OTHER_OWNER })).toThrow(
      'another invocation',
    )
    expect(() => verifyOwnership(container('worker'), { id: OTHER_ID })).toThrow('replaced')
  })
})

describe('socket volume and start ownership', () => {
  test('only accepts a repository-owned default local named volume without host/object driver options', () => {
    const volume = {
      Name: `${MEDIA_PROJECT}_media-socket`,
      Driver: 'local',
      Scope: 'local',
      Options: null,
      Labels: {
        'com.docker.compose.project': MEDIA_PROJECT,
        'com.docker.compose.volume': 'media-socket',
        'chatapp.media.policy': '1',
        'chatapp.media.repository': REPOSITORY,
      },
    }
    expect(() => verifySocketVolume(volume)).not.toThrow()
    expect(() =>
      verifySocketVolume({
        ...volume,
        Options: { type: 'none', device: '/fixture/objects', o: 'bind' },
      }),
    ).toThrow('host/object-backed')
    expect(() =>
      verifySocketVolume({
        ...volume,
        Labels: { ...volume.Labels, 'chatapp.media.repository': 'other-repository' },
      }),
    ).toThrow('ownership/driver')
    const config = normalized()
    dict(dict(config.volumes)['media-socket']).driver_opts = {
      device: '/fixture/objects',
      o: 'bind',
    }
    expect(() => verifyComposeConfiguration(config, worker)).toThrow('host/object-backed')
  })

  test('verifies both ids before starting media, waits for the private socket, then starts only the exact worker id', async () => {
    const calls: string[][] = []
    const started = new Set<string>()
    const run: DockerRunner = async (args) => {
      calls.push(args)
      if (args[0] === 'start') {
        started.add(args[1] ?? '')
        return ''
      }
      const value = container(args.at(-1) === MEDIA_ID ? 'media' : 'worker')
      dict(value.State).Running = started.has(String(value.Id))
      return JSON.stringify([value])
    }
    await startOwnedContainers(receipt(), worker, run)
    expect(calls.slice(0, 2)).toEqual([
      ['inspect', '--type', 'container', MEDIA_ID],
      ['inspect', '--type', 'container', WORKER_ID],
    ])
    expect(calls.filter((args) => args[0] === 'start')).toEqual([
      ['start', MEDIA_ID],
      ['start', WORKER_ID],
    ])
    const mediaStart = calls.findIndex((args) => args[0] === 'start' && args[1] === MEDIA_ID)
    const workerStart = calls.findIndex((args) => args[0] === 'start' && args[1] === WORKER_ID)
    expect(
      calls
        .slice(mediaStart + 1, workerStart)
        .some((args) => args[0] === 'inspect' && args.at(-1) === MEDIA_ID),
    ).toBe(true)
  })

  test('a replaced owner or cancelled invocation cannot start either container', async () => {
    const calls: string[][] = []
    const run: DockerRunner = async (args) => {
      calls.push(args)
      const value = container(args.at(-1) === MEDIA_ID ? 'media' : 'worker')
      if (value.Id === WORKER_ID)
        dict(dict(value.Config).Labels)['chatapp.media.owner'] = OTHER_OWNER
      return JSON.stringify([value])
    }
    await expect(startOwnedContainers(receipt(), worker, run)).rejects.toThrow('another invocation')
    expect(calls.some((args) => args[0] === 'start')).toBe(false)
    const controller = new AbortController()
    controller.abort()
    const cancelled: DockerRunner = async (args) => {
      calls.push(args)
      return JSON.stringify([container(args.at(-1) === MEDIA_ID ? 'media' : 'worker')])
    }
    await expect(
      startOwnedContainers(receipt(), worker, cancelled, controller.signal),
    ).rejects.toThrow('cancelled')
    expect(calls.some((args) => args[0] === 'start')).toBe(false)
  })
})

describe('cleanup ownership', () => {
  test('a reused stack has no owned ids and Ctrl+C makes no Docker calls at all', async () => {
    const run: DockerRunner = async () => {
      throw new Error('must not call Docker for borrowed containers')
    }
    await expect(stopOwnedContainers(receipt(false), run)).resolves.toBeUndefined()
  })

  test('verifies every owned id before stopping, and only stops/removes those exact ids without deleting volumes', async () => {
    const calls: string[][] = []
    const run: DockerRunner = async (args) => {
      calls.push(args)
      if (args[0] === 'ps') return `${MEDIA_ID}\n${WORKER_ID}\n${OTHER_ID}\n`
      if (args[0] === 'inspect')
        return JSON.stringify([container(args.at(-1) === MEDIA_ID ? 'media' : 'worker')])
      return ''
    }
    await stopOwnedContainers(receipt(), run)
    expect(calls.filter((args) => args[0] === 'inspect').length).toBe(2)
    expect(calls.at(-2)).toEqual(['stop', '--time', '15', MEDIA_ID, WORKER_ID])
    expect(calls.at(-1)).toEqual(['rm', MEDIA_ID, WORKER_ID])
    expect(calls.flat()).not.toContain('-v')
    expect(calls.flat()).not.toContain('down')
    expect(calls.flat()).not.toContain('prune')
    expect(calls.filter((args) => args[0] !== 'ps').flat()).not.toContain(OTHER_ID)
  })

  test('owner/id/repository mismatches prevent all destructive actions, including to the first already-verified container', async () => {
    for (const key of [
      'chatapp.media.owner',
      'chatapp.media.repository',
      'com.docker.compose.project',
    ]) {
      const calls: string[][] = []
      const run: DockerRunner = async (args) => {
        calls.push(args)
        if (args[0] === 'ps') return `${MEDIA_ID}\n${WORKER_ID}\n`
        const value = container(args.at(-1) === MEDIA_ID ? 'media' : 'worker')
        if (value.Id === WORKER_ID)
          dict(dict(value.Config).Labels)[key] =
            key === 'chatapp.media.owner' ? OTHER_OWNER : 'not-our-scope'
        return JSON.stringify([value])
      }
      await expect(stopOwnedContainers(receipt(), run)).rejects.toThrow()
      expect(calls.some((args) => args[0] === 'stop' || args[0] === 'rm')).toBe(false)
    }
  })

  test('already removed ids are skipped rather than matched by service name to a replacement container', async () => {
    const calls: string[][] = []
    const run: DockerRunner = async (args) => {
      calls.push(args)
      if (args[0] === 'ps') return `${OTHER_ID}\n`
      throw new Error('must not inspect or stop a replacement')
    }
    await stopOwnedContainers(receipt(), run)
    expect(calls.length).toBe(1)
  })
})
