/** Local-only preparation. No implicit SSH, push, deployment, credential reuse or compose down. */
import { createHash, randomBytes } from 'node:crypto'
import { chmod, chown, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { loadAiConfig } from '../apps/server/src/config/ai.ts'
import { ConfigError, loadConfig } from '../apps/server/src/config/index.ts'
import { loadJournalSettings } from '../apps/server/src/config/journal.ts'
import { loadOffsiteTarget } from '../apps/server/src/config/offsite.ts'
import { parseTrustedProxies } from '../apps/server/src/lib/ip.ts'
import { readJournalKeys } from '../apps/server/src/runtime/deletion-journal.ts'
import { storageCredentialsSchema } from '../apps/server/src/runtime/garage-initialize.ts'
import { createMonitoring } from '../apps/server/src/runtime/monitoring.ts'
import { privateJson } from '../apps/server/src/runtime/operations-files.ts'
import { generateVapidKeys } from '../apps/server/src/runtime/web-push.ts'
import { releaseManifestSchema } from '../packages/contracts/src/operations.ts'
import { PRODUCTION_BUILD_IMAGES, PRODUCTION_DEPENDENCIES } from './production-images.ts'

const SECRET_FILE = /(^|\/)(\.env(?:\..*)?|[^/]+\.env|garage\.toml|.*(?:password|keyring).*\.json)$/
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const random = () => randomBytes(32).toString('base64url')
const COMPOSE = 'infra/compose.prod.yml'

export function readRawEnvironment(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue
    const match = /^([A-Z][A-Z0-9_]*)=([^\r\n]*)$/.exec(line)
    if (!match?.[1] || match[2] === undefined || Object.hasOwn(values, match[1]))
      throw new Error('invalid or duplicate environment field')
    values[match[1]] = match[2]
  }
  return values
}

async function privateFile(path: string): Promise<string> {
  const info = await lstat(path)
  if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size > 128000)
    throw new Error('private configuration must be a regular file with mode 600')
  return await readFile(path, 'utf8')
}

async function writePrivate(path: string, values: Record<string, string>): Promise<void> {
  if (Object.values(values).some((value) => /[\r\n]/.test(value)))
    throw new Error('multiline configuration value forbidden')
  await writeFile(
    path,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n',
    { mode: 0o600, flag: 'wx' },
  )
}

export async function prepareProduction(directory: string, origin: string) {
  const target = resolve(directory)
  const url = new URL(origin)
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password)
    throw new Error('production origin must be a bare HTTPS origin')
  // Never regenerate a deployment's identities, passwords, epoch or journal keys on repeated setup.
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  await mkdir(target, { mode: 0o700 })
  await mkdir(join(target, 'runtime'), { mode: 0o700 })
  const owner = crypto.randomUUID()
  const pgPassword = random(),
    appPassword = random(),
    valkeyPassword = random()
  const pgOwner = `postgres://chatapp_owner:${pgPassword}@postgres:5432/chatapp`
  const pgApp = `postgres://chatapp_app:${appPassword}@postgres:5432/chatapp`
  const keys = generateVapidKeys()
  await writePrivate(join(target, 'app.env'), {
    APP_ENV: 'production',
    NODE_ENV: 'production',
    APP_ORIGIN: origin,
    APP_TIMEZONE: 'Asia/Shanghai',
    API_HOST: '0.0.0.0',
    API_PORT: '3100',
    TRUSTED_PROXIES: '127.0.0.1,::1,172.29.43.1',
    DATABASE_URL: pgApp,
    VALKEY_URL: `redis://:${valkeyPassword}@valkey:6379/0`,
    S3_ENDPOINT: 'http://garage:3900',
    S3_REGION: 'garage',
    S3_BUCKET: 'chatapp',
    S3_ACCESS_KEY_ID: '',
    S3_SECRET_ACCESS_KEY: '',
    GARAGE_METRICS_ENDPOINT: 'http://garage:3903/metrics',
    GARAGE_METRICS_TOKEN: random(),
    BETTER_AUTH_SECRET: random(),
    AUTH_TOKEN_ENCRYPTION_KEY: random(),
    AI_KEY_ENCRYPTION_KEY: random(),
    RESTORE_EPOCH: crypto.randomUUID(),
    VAPID_PUBLIC_KEY: keys.publicKey,
    VAPID_PRIVATE_KEY: keys.privateKey,
    VAPID_SUBJECT: origin,
    SMTP_HOST: '',
    SMTP_PORT: '587',
    SMTP_USER: '',
    SMTP_PASS: '',
    MAIL_FROM: '',
    PRODUCT_NAME: 'ChatApp',
    AGENT_DISPLAY_NAME: '助手',
    AGENT_USERNAME: 'assistant',
    LOG_LEVEL: 'info',
    SENTRY_DSN: '',
    AI_PROVIDER: 'soclaas',
    SOCLAAS_API_KEY: '',
    AI_MODEL_FAST: 'x-test-1',
    AI_MODEL_DEEP: 'x-test-1',
    EMBEDDING_ENABLED: 'false',
    EMBEDDING_MODEL: 'bge',
    DELETION_JOURNAL_ENABLED: 'true',
    DELETION_JOURNAL_PREFIX: `chatapp/${owner}/`,
    DELETION_JOURNAL_WRITER_EPOCH: crypto.randomUUID(),
    DELETION_JOURNAL_KEYRING_FILE: '/run/chatapp-keys/journal-keyring.json',
    DELETION_JOURNAL_S3_ENDPOINT: '',
    DELETION_JOURNAL_S3_REGION: 'auto',
    DELETION_JOURNAL_S3_BUCKET: '',
    DELETION_JOURNAL_S3_ACCESS_KEY_ID: '',
    DELETION_JOURNAL_S3_SECRET_ACCESS_KEY: '',
  })
  await writePrivate(join(target, 'db.env'), {
    POSTGRES_USER: 'chatapp_owner',
    POSTGRES_DB: 'chatapp',
    POSTGRES_PASSWORD: pgPassword,
  })
  await writePrivate(join(target, 'owner.env'), { DATABASE_OWNER_URL: pgOwner })
  await writePrivate(join(target, 'valkey.env'), { REDISCLI_AUTH: valkeyPassword })
  await writePrivate(join(target, 'backup.env'), {
    BACKUP_S3_ENDPOINT: '',
    BACKUP_S3_REGION: 'auto',
    BACKUP_S3_BUCKET: '',
    BACKUP_S3_ACCESS_KEY_ID: '',
    BACKUP_S3_SECRET_ACCESS_KEY: '',
    BACKUP_REPOSITORY_PREFIX: `chatapp/${owner}`,
    RESTIC_PASSWORD_FILE: '/run/chatapp-keys/restic-password',
    BACKUP_STAGE_DIR: '/var/lib/chatapp/backup',
    RESTORE_STAGE_DIR: '/var/lib/chatapp/restore',
    GARAGE_ADMIN_TOKEN: random(),
    GARAGE_RPC_SECRET: randomBytes(32).toString('hex'),
  })
  await writePrivate(join(target, 'compose.env'), {
    CHATAPP_CONFIG_DIR: target,
    CHATAPP_PROJECT: `chatapp-${owner.slice(0, 8)}`,
    CHATAPP_OWNER: owner,
    CHATAPP_API_PORT: '3100',
    CHATAPP_NETWORK_CIDR: '172.29.43.0/24',
    APPLICATION_SOURCE_HASH: '',
    SERVER_IMAGE: '',
    MEDIA_IMAGE: '',
    OPS_IMAGE: '',
    POSTGRES_IMAGE: '',
    VALKEY_IMAGE: PRODUCTION_DEPENDENCIES.valkey,
    GARAGE_IMAGE: PRODUCTION_DEPENDENCIES.garage,
  })
  await writeFile(
    join(target, 'runtime/journal-keyring.json'),
    JSON.stringify({ format: 1, currentKeyVersion: 1, keys: { 1: random() } }) + '\n',
    { mode: 0o600, flag: 'wx' },
  )
  await writeFile(join(target, 'runtime/restic-password'), random() + '\n', {
    mode: 0o600,
    flag: 'wx',
  })
  const appFields = readRawEnvironment(await readFile(join(target, 'app.env'), 'utf8'))
  const backupFields = readRawEnvironment(await readFile(join(target, 'backup.env'), 'utf8'))
  const garageTemplate = await readFile('infra/garage/garage.toml.template', 'utf8')
  const garage = garageTemplate
    .replaceAll('{{GARAGE_RPC_SECRET}}', backupFields.GARAGE_RPC_SECRET ?? '')
    .replaceAll('{{GARAGE_ADMIN_TOKEN}}', backupFields.GARAGE_ADMIN_TOKEN ?? '')
    .replaceAll('{{GARAGE_METRICS_TOKEN}}', appFields.GARAGE_METRICS_TOKEN ?? '')
    .replace('127.0.0.1:3901', 'garage:3901')
  await writeFile(join(target, 'runtime/garage.toml'), garage, { mode: 0o600, flag: 'wx' })
  if (process.getuid?.() === 0) {
    for (const name of ['journal-keyring.json', 'restic-password', 'garage.toml'])
      await chown(join(target, 'runtime', name), 10001, 10001)
  }
  await writeFile(
    join(target, 'README.txt'),
    'Private production configuration. Fill external service fields locally; never send values in chat.\nRun configtest before starting services. Keep journal keys, restic password and recovery material outside the source host.\nOn the server, runtime files must have UID 10001 and mode 600.\nChanging the private subnet requires changing TRUSTED_PROXIES to its gateway.\n',
    { mode: 0o600, flag: 'wx' },
  )
  await renderProductionEdge(target, [])
  return { status: 'prepared', configurationComplete: false, networkRequests: 0 }
}

export function candidateSource(path: string): boolean {
  if (path.includes('..') || path.startsWith('/') || path.includes('\\') || SECRET_FILE.test(path))
    return false
  if (
    [
      'package.json',
      'bun.lock',
      'LICENSE',
      '.dockerignore',
      'tsconfig.json',
      'tsconfig.base.json',
      'infra/garage/garage.toml.template',
      'infra/runtime-libraries.py',
      'infra/media-health.c',
    ].includes(path)
  )
    return true
  if (/^apps\/(server|media)\/package\.json$/.test(path)) return true
  if (/^packages\/(db|contracts)\/(package\.json|src\/|drizzle\/)/.test(path))
    return !path.endsWith('.test.ts')
  if (/^apps\/(server|media)\/src\//.test(path)) return !path.endsWith('.test.ts')
  if (path.startsWith('apps/web/') && !SECRET_FILE.test(path)) return true
  if (/^scripts\/production/.test(path) && !path.endsWith('.test.ts')) return true
  if (path.startsWith('infra/systemd/') || path.startsWith('infra/load/')) return true
  return /^infra\/(Dockerfile\.(server|ops|media|postgres|nginx)|compose\.prod\.yml|nginx\/)/.test(
    path,
  )
}

async function capture(command: string[], cwd = process.cwd()): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [out] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if ((await child.exited) !== 0) throw new Error('preparation command failed')
  return out
}

export async function candidateInventory(root = process.cwd()) {
  const listed = (
    await capture(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], root)
  )
    .split('\0')
    .filter(Boolean)
  const source = listed.filter(candidateSource).sort()
  const hash = createHash('sha256')
  const fingerprints: { path: string; sha256: string }[] = []
  // Include browser inputs and deployment tooling in the binding, even though they are not part of the runtime source tar.
  const bound = listed
    .filter(
      (path) =>
        candidateSource(path) ||
        (path.startsWith('apps/web/') && !SECRET_FILE.test(path)) ||
        /^scripts\/(production|lib\/production)/.test(path),
    )
    .sort()
  for (const path of bound) {
    if (!(await lstat(join(root, path))).isFile())
      throw new Error('candidate symlinks and special files forbidden')
    const bytes = await readFile(join(root, path))
    hash.update(path).update('\0').update(bytes).update('\0')
    fingerprints.push({ path, sha256: digest(bytes) })
  }
  return {
    source,
    fingerprints,
    applicationSha: (await capture(['git', 'rev-parse', 'HEAD'], root)).trim(),
    applicationSourceHash: hash.digest('hex'),
    dirty: (await capture(['git', 'status', '--porcelain'], root)).length > 0,
  }
}

export async function packageCandidate(directory: string, build = true, root = process.cwd()) {
  const output = resolve(directory)
  await mkdir(dirname(output), { recursive: true, mode: 0o700 })
  await mkdir(output, { mode: 0o700 })
  const inventory = await candidateInventory(root)
  const binding = {
    APPLICATION_SHA: inventory.applicationSha,
    APPLICATION_SOURCE_HASH: inventory.applicationSourceHash,
  }
  const images: Record<string, string> = {}
  if (build) {
    for (const name of PRODUCTION_BUILD_IMAGES) {
      await capture(
        [
          'docker',
          'build',
          '--file',
          `infra/Dockerfile.${name}`,
          '--tag',
          `chatapp-${name}:${inventory.applicationSourceHash}`,
          '--build-arg',
          `APPLICATION_SHA=${binding.APPLICATION_SHA}`,
          '--build-arg',
          `APPLICATION_SOURCE_HASH=${binding.APPLICATION_SOURCE_HASH}`,
          '.',
        ],
        root,
      )
    }
    for (const [name, reference] of Object.entries(PRODUCTION_DEPENDENCIES)) {
      await capture(['docker', 'pull', reference], root)
      images[name] = (
        await capture(['docker', 'image', 'inspect', reference, '--format', '{{.Id}}'], root)
      ).trim()
    }
    for (const name of PRODUCTION_BUILD_IMAGES)
      images[name] = (
        await capture(
          [
            'docker',
            'image',
            'inspect',
            `chatapp-${name}:${inventory.applicationSourceHash}`,
            '--format',
            '{{.Id}}',
          ],
          root,
        )
      ).trim()
    await capture(['bun', '--no-env-file', 'run', 'build'], root)
    await capture(
      [
        'bun',
        '--no-env-file',
        'build',
        '--target',
        'bun',
        '--minify',
        'scripts/production-watchdog.ts',
        '--outfile',
        join(output, 'watchdog.js'),
      ],
      root,
    )
    await capture(
      [
        'bun',
        '--no-env-file',
        'build',
        '--target',
        'bun',
        '--minify',
        'scripts/production.ts',
        '--outfile',
        join(output, 'production.js'),
      ],
      root,
    )
    await capture(
      [
        'bun',
        '--no-env-file',
        'build',
        '--target',
        'bun',
        '--minify',
        'scripts/production-load.ts',
        '--outfile',
        join(output, 'load.js'),
      ],
      root,
    )
  }
  if ((await candidateInventory(root)).applicationSourceHash !== inventory.applicationSourceHash)
    throw new Error(
      'candidate source changed during build; preserve this attempt and package a new candidate',
    )
  await writeFile(join(output, 'source-files'), inventory.source.join('\0') + '\0', { mode: 0o600 })
  await capture([
    'tar',
    '--format=pax',
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    '--mtime=@0',
    '--sort=name',
    '-czf',
    join(output, 'source.tar.gz'),
    '-C',
    root,
    '--null',
    '-T',
    join(output, 'source-files'),
  ])
  if (build) {
    await capture([
      'tar',
      '-czf',
      join(output, 'web.tar.gz'),
      '-C',
      join(root, 'apps/web/dist'),
      '.',
    ])
    await capture([
      'docker',
      'save',
      '--output',
      join(output, 'images.tar'),
      ...Object.values(images),
    ])
  }
  const artifacts = []
  for (const name of [
    'source.tar.gz',
    ...(build ? ['web.tar.gz', 'images.tar', 'watchdog.js', 'production.js', 'load.js'] : []),
  ]) {
    await chmod(join(output, name), 0o600)
    const hash = createHash('sha256')
    for await (const chunk of Bun.file(join(output, name)).stream()) hash.update(chunk)
    artifacts.push({
      name,
      sha256: hash.digest('hex'),
      bytes: (await lstat(join(output, name))).size,
    })
  }
  const manifest = {
    format: 1,
    ...binding,
    dirty: inventory.dirty,
    baselineShaOnly: inventory.dirty,
    architecture: process.arch,
    images,
    artifacts,
    sourceFiles: inventory.fingerprints,
  }
  const finalSource = await candidateInventory(root)
  if (
    finalSource.applicationSourceHash !== inventory.applicationSourceHash ||
    finalSource.applicationSha !== inventory.applicationSha
  )
    throw new Error(
      'source changed while archiving; preserve this attempt and package a new candidate',
    )
  await writeFile(join(output, 'release.json'), JSON.stringify(manifest, null, 2) + '\n', {
    mode: 0o600,
  })
  await chmod(join(output, 'source.tar.gz'), 0o600)
  return {
    status: 'packaged',
    build,
    applicationSourceHash: inventory.applicationSourceHash,
    artifacts: artifacts.map(({ name, bytes }) => ({ name, bytes })),
  }
}

export async function bindProductionRelease(directory: string, file: string, recovery = false) {
  const target = resolve(directory)
  const release = await privateJson(file, releaseManifestSchema, 32 * 1024 * 1024)
  const compose = readRawEnvironment(await privateFile(join(target, 'compose.env')))
  const app = readRawEnvironment(await privateFile(join(target, 'app.env')))
  if (
    recovery &&
    (!app.RESTORE_PREVIOUS_WRITER_EPOCH ||
      compose.APPLICATION_SOURCE_HASH !== release.APPLICATION_SOURCE_HASH)
  )
    throw new Error('recovery release must match the original source')
  for (const name of ['server', 'media', 'ops', 'postgres', 'valkey', 'garage']) {
    const image = release.images[name]
    if (!image) throw new Error('complete native runtime image archive required')
    compose[`${name.toUpperCase()}_IMAGE`] = image
  }
  compose.APPLICATION_SOURCE_HASH = release.APPLICATION_SOURCE_HASH
  await writeFile(
    join(target, 'compose.env'),
    Object.entries(compose)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n',
    { mode: 0o600 },
  )
  return {
    status: 'native_release_bound',
    architecture: release.architecture,
    sourceHash: release.APPLICATION_SOURCE_HASH,
  }
}

export async function checkProduction(directory: string) {
  const target = resolve(directory)
  const parts = await Promise.all(
    ['app.env', 'db.env', 'owner.env', 'valkey.env', 'backup.env', 'compose.env'].map(
      async (name) => [name, readRawEnvironment(await privateFile(join(target, name)))] as const,
    ),
  )
  const map = new Map(parts)
  const app = map.get('app.env'),
    owner = map.get('owner.env'),
    backup = map.get('backup.env'),
    compose = map.get('compose.env')
  if (!app || !owner || !backup || !compose) throw new Error('configuration incomplete')
  if (
    Object.keys(app).some((name) =>
      /^DATABASE_OWNER|^POSTGRES_|^BACKUP_|^RESTIC_|^GARAGE_(ADMIN|RPC)/.test(name),
    )
  )
    throw new Error('privileged operator configuration leaked into application')
  if (app.APP_ENV !== 'production') throw new Error('production mode required')
  const source = { ...app, ...owner, ...backup }
  const config = loadConfig(source)
  loadAiConfig(source)
  createMonitoring(source)
  loadJournalSettings(source)
  loadOffsiteTarget(source, 'BACKUP', 'production')
  const appUrl = new URL(config.databaseUrl),
    ownerUrl = new URL(config.databaseOwnerUrl ?? '')
  if (
    appUrl.username === ownerUrl.username ||
    appUrl.pathname !== ownerUrl.pathname ||
    appUrl.host !== ownerUrl.host
  )
    throw new Error('database runtime/owner split invalid')
  if (
    !/^chatapp-[a-f0-9]{8}$/.test(compose.CHATAPP_PROJECT ?? '') ||
    !/^[a-f0-9-]{36}$/.test(compose.CHATAPP_OWNER ?? '')
  )
    throw new Error('deployment identity invalid')
  if (
    !/^[a-f0-9]{64}$/.test(compose.APPLICATION_SOURCE_HASH ?? '') ||
    compose.CHATAPP_CONFIG_DIR !== target
  )
    throw new Error('candidate source or configuration directory binding missing')
  await readJournalKeys(join(target, 'runtime/journal-keyring.json'))
  await privateFile(join(target, 'runtime/restic-password'))
  const access = await privateFile(join(target, 'runtime/access.conf'))
  if (!access.endsWith('deny all;\n') || /allow\s+all|\/0\s*;/.test(access))
    throw new Error('closed access policy required')
  // `config` output contains rendered credentials: it is captured, inspected, and never printed or archived.
  const rendered = JSON.parse(
    await capture([
      'docker',
      'compose',
      '--env-file',
      join(target, 'compose.env'),
      '-f',
      COMPOSE,
      'config',
      '--format',
      'json',
    ]),
  ) as {
    services?: Record<
      string,
      {
        network_mode?: string
        environment?: Record<string, string>
        volumes?: { target: string }[]
        ports?: { host_ip: string }[]
      }
    >
  }
  const media = rendered.services?.media
  if (
    !media ||
    media.network_mode !== 'none' ||
    (media.environment && Object.keys(media.environment).length)
  )
    throw new Error('media network/credential isolation invalid')
  if (media.volumes?.some((volume) => volume.target !== '/run/chatapp-media'))
    throw new Error('media filesystem isolation invalid')
  for (const name of ['api', 'worker']) {
    const service = rendered.services?.[name]
    if (
      !service ||
      Object.hasOwn(service.environment ?? {}, 'DATABASE_OWNER_URL') ||
      Object.hasOwn(service.environment ?? {}, 'BACKUP_S3_SECRET_ACCESS_KEY')
    )
      throw new Error('runtime operator separation invalid')
    if (service.ports?.some((port) => port.host_ip !== '127.0.0.1'))
      throw new Error('public container port forbidden')
  }
  return {
    status: 'configuration-valid',
    networkRequests: 0,
    runtimeOwnershipNeedsRootInstallation: process.getuid?.() !== 0,
  }
}

export async function renderProductionEdge(directory: string, allowed: string[]) {
  const target = resolve(directory)
  const app = readRawEnvironment(await privateFile(join(target, 'app.env')))
  const compose = readRawEnvironment(await privateFile(join(target, 'compose.env')))
  const origin = new URL(app.APP_ORIGIN ?? '')
  if (!/^[a-z0-9][a-z0-9.-]{0,252}$/.test(origin.hostname))
    throw new Error('safe DNS name required for TLS configuration')
  const checked = parseTrustedProxies(allowed.join(','))
  if (
    checked.invalid.length ||
    checked.ok.length !== allowed.length ||
    allowed.some((item) => item.includes('/0') || /[\r\n;]/.test(item))
  )
    throw new Error('explicit restricted IP/CIDR allowlist required')
  const port = Number(compose.CHATAPP_API_PORT)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error('valid private API port required')
  await writeFile(
    join(target, 'runtime/access.conf'),
    allowed.map((item) => `allow ${item};`).join('\n') +
      (allowed.length ? '\n' : '') +
      'deny all;\n',
    { mode: 0o600 },
  )
  await writeFile(
    join(target, 'runtime/env-http.conf'),
    `upstream chatapp_api { server 127.0.0.1:${port}; keepalive 32; }\n`,
    { mode: 0o600 },
  )
  await writeFile(
    join(target, 'runtime/env-server.conf'),
    `server_name ${origin.hostname};\nssl_certificate /etc/letsencrypt/live/${origin.hostname}/fullchain.pem;\nssl_certificate_key /etc/letsencrypt/live/${origin.hostname}/privkey.pem;\n`,
    { mode: 0o600 },
  )
  return { status: 'closed_edge_prepared', allowedNetworks: allowed.length }
}

export async function installStorageCredentials(directory: string, file: string) {
  const target = resolve(directory)
  const credentials = storageCredentialsSchema.parse(JSON.parse(await privateFile(file)))
  const app = readRawEnvironment(await privateFile(join(target, 'app.env')))
  const compose = readRawEnvironment(await privateFile(join(target, 'compose.env')))
  if (credentials.owner !== compose.CHATAPP_OWNER || credentials.bucket !== app.S3_BUCKET)
    throw new Error('storage ownership differs from deployment')
  if (
    (app.S3_ACCESS_KEY_ID || app.S3_SECRET_ACCESS_KEY) &&
    (app.S3_ACCESS_KEY_ID !== credentials.accessKeyId ||
      app.S3_SECRET_ACCESS_KEY !== credentials.secretAccessKey)
  )
    throw new Error('existing storage credentials are preserved; explicit rotation required')
  app.S3_ACCESS_KEY_ID = credentials.accessKeyId
  app.S3_SECRET_ACCESS_KEY = credentials.secretAccessKey
  const { rename } = await import('node:fs/promises')
  const temporary = join(target, `app-${crypto.randomUUID()}.env`)
  await writePrivate(temporary, app)
  await rename(temporary, join(target, 'app.env'))
  return { status: 'storage_credentials_installed' }
}

/** Separate recovery bundle, to be stored away from the source host. Never included in the public release package. */
export async function exportRecoveryMaterials(directory: string, output: string) {
  const target = resolve(directory),
    destination = resolve(output)
  if (destination === target || destination.startsWith(`${target}/`))
    throw new Error('recovery copy must be outside the source configuration directory')
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await mkdir(destination, { mode: 0o700 })
  await mkdir(join(destination, 'runtime'), { mode: 0o700 })
  const names = [
    'app.env',
    'db.env',
    'owner.env',
    'valkey.env',
    'backup.env',
    'compose.env',
    'runtime/journal-keyring.json',
    'runtime/restic-password',
    'runtime/garage.toml',
    'runtime/access.conf',
    'runtime/env-http.conf',
    'runtime/env-server.conf',
  ]
  for (const name of names)
    await writeFile(join(destination, name), await privateFile(join(target, name)), {
      mode: 0o600,
      flag: 'wx',
    })
  await writeFile(
    join(destination, 'README.txt'),
    'Sensitive recovery materials. Store this directory encrypted off the source host with the immutable release archive. A local copy alone is not offsite evidence. Rotate source credentials and identities before opening restored data. TLS certificates and DNS/SMTP/provider access must be available independently.\n',
    { mode: 0o600, flag: 'wx' },
  )
  return { status: 'separate_recovery_copy_prepared', files: names.length, offsiteConfirmed: false }
}

/** New destination identity/connections; recover only source-bound decryptors and offsite locations. */
export async function prepareRecovery(directory: string, materials: string, origin: string) {
  const source = resolve(materials),
    target = resolve(directory)
  if (target === source || target.startsWith(`${source}/`))
    throw new Error('recovery destination must be separate from original materials')
  const oldApp = readRawEnvironment(await privateFile(join(source, 'app.env')))
  const oldBackup = readRawEnvironment(await privateFile(join(source, 'backup.env')))
  const oldCompose = readRawEnvironment(await privateFile(join(source, 'compose.env')))
  if (
    !/^[a-f0-9]{64}$/.test(oldCompose.APPLICATION_SOURCE_HASH ?? '') ||
    !['SERVER_IMAGE', 'MEDIA_IMAGE', 'OPS_IMAGE'].every((key) =>
      /^sha256:[a-f0-9]{64}$/.test(oldCompose[key] ?? ''),
    ) ||
    !/^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(oldApp.DELETION_JOURNAL_WRITER_EPOCH ?? '') ||
    (oldApp.BETTER_AUTH_SECRET?.length ?? 0) < 32 ||
    !['AUTH_TOKEN_ENCRYPTION_KEY', 'AI_KEY_ENCRYPTION_KEY'].every((key) =>
      /^[A-Za-z0-9_-]{43}$/.test(oldApp[key] ?? ''),
    )
  )
    throw new Error('complete source-bound recovery materials required')
  const keyring = await privateFile(join(source, 'runtime/journal-keyring.json'))
  await readJournalKeys(join(source, 'runtime/journal-keyring.json'))
  const password = await privateFile(join(source, 'runtime/restic-password'))
  if (password.trim().length < 32) throw new Error('complete restic recovery password required')
  await prepareProduction(target, origin)
  const replace = async (name: string, changes: Record<string, string>) => {
    const next = { ...readRawEnvironment(await privateFile(join(target, name))), ...changes }
    await writeFile(
      join(target, name),
      Object.entries(next)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n') + '\n',
      { mode: 0o600 },
    )
  }
  const select = (values: Record<string, string>, keys: string[]) =>
    Object.fromEntries(
      keys.map((key) => {
        const value = values[key]
        if (value === undefined) throw new Error('recovery field missing')
        return [key, value]
      }),
    )
  await replace('app.env', {
    ...select(oldApp, [
      'BETTER_AUTH_SECRET',
      'AUTH_TOKEN_ENCRYPTION_KEY',
      'AI_KEY_ENCRYPTION_KEY',
      'VAPID_PUBLIC_KEY',
      'VAPID_PRIVATE_KEY',
      'VAPID_SUBJECT',
      'APP_TIMEZONE',
      'PRODUCT_NAME',
      'AGENT_DISPLAY_NAME',
      'AGENT_USERNAME',
      'DELETION_JOURNAL_PREFIX',
      'DELETION_JOURNAL_S3_ENDPOINT',
      'DELETION_JOURNAL_S3_REGION',
      'DELETION_JOURNAL_S3_BUCKET',
      'DELETION_JOURNAL_S3_ACCESS_KEY_ID',
      'DELETION_JOURNAL_S3_SECRET_ACCESS_KEY',
    ]),
    RESTORE_PREVIOUS_WRITER_EPOCH: oldApp.DELETION_JOURNAL_WRITER_EPOCH ?? '',
  })
  await replace(
    'backup.env',
    select(oldBackup, [
      'BACKUP_REPOSITORY_PREFIX',
      'BACKUP_S3_ENDPOINT',
      'BACKUP_S3_REGION',
      'BACKUP_S3_BUCKET',
      'BACKUP_S3_ACCESS_KEY_ID',
      'BACKUP_S3_SECRET_ACCESS_KEY',
    ]),
  )
  await replace(
    'compose.env',
    select(oldCompose, [
      'APPLICATION_SOURCE_HASH',
      'SERVER_IMAGE',
      'MEDIA_IMAGE',
      'OPS_IMAGE',
      'POSTGRES_IMAGE',
      'VALKEY_IMAGE',
      'GARAGE_IMAGE',
    ]),
  )
  for (const [name, bytes] of [
    ['journal-keyring.json', keyring],
    ['restic-password', password],
  ])
    if (name && bytes) await writeFile(join(target, 'runtime', name), bytes, { mode: 0o600 })
  return {
    status: 'isolated_recovery_configuration_prepared',
    networkRequests: 0,
    configurationComplete: false,
    oldOffsiteCredentialsNeedRotation: true,
  }
}

async function main() {
  const [command, directory, origin] = process.argv.slice(2)
  if (command === 'prepare' && directory && origin)
    return await prepareProduction(directory, origin)
  if (command === 'package' && directory)
    return await packageCandidate(directory, !process.argv.includes('--source-only'))
  if (command === 'configtest' && directory) return await checkProduction(directory)
  if (command === 'bind' && directory && origin)
    return await bindProductionRelease(directory, origin)
  if (command === 'bind-recovery' && directory && origin)
    return await bindProductionRelease(directory, origin, true)
  if (command === 'edge' && directory)
    return await renderProductionEdge(directory, process.argv.slice(4))
  if (command === 'storage-install' && directory && origin)
    return await installStorageCredentials(directory, origin)
  if (command === 'materials' && directory && origin)
    return await exportRecoveryMaterials(directory, origin)
  if (command === 'recovery-prepare' && directory && origin && process.argv[5])
    return await prepareRecovery(directory, origin, process.argv[5])
  if (command === 'help' || !command)
    return {
      usage:
        'production.ts prepare DIR HTTPS_ORIGIN | bind DIR PRIVATE_RELEASE_MANIFEST | bind-recovery DIR SAME_SOURCE_NATIVE_MANIFEST | configtest DIR | package EMPTY_DIR [--source-only] | edge DIR [ALLOWED_IP_OR_CIDR...] | storage-install DIR PRIVATE_FILE | materials DIR NEW_SEPARATE_DIR | recovery-prepare NEW_DIR ORIGINAL_MATERIALS HTTPS_ORIGIN',
      note: 'Local preparation only; never deploys or prints credentials.',
    }
  throw new Error('invalid production preparation command')
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await main()))
  } catch (error) {
    console.error(
      error instanceof ConfigError
        ? error.message
        : 'production preparation failed; existing configuration preserved',
    )
    process.exit(1)
  }
}
