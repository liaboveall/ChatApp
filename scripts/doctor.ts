/**
 * Checks that the local development environment works end to end, using Bun's
 * native clients (SQL, Redis, S3). Never prints secret values.
 *   bun run doctor          all local checks
 *   bun run doctor --ai     also checks the selected provider's models endpoint (no generation)
 */
import { $, RedisClient, S3Client, SQL } from 'bun'
import { loadAiConfig } from '../apps/server/src/config/ai.ts'
import { ConfigError } from '../apps/server/src/config/env.ts'
import { AI_ENDPOINTS } from '../apps/server/src/runtime/ai.ts'
import packageJson from '../package.json'
import { getEnv, isUnset, readEnvFile } from './lib/env-file.ts'
import {
  infraPorts,
  parseComposePs,
  publishedProblems,
  reservedProblems,
  urlProblems,
  windowsPorts,
} from './lib/ports.ts'

type Check = { name: string; ok: boolean; detail: string; optional?: boolean }
const results: Check[] = []

/** Several things wrong at once, each said in full (a failed check otherwise keeps the first line of its message). */
class Problems extends Error {
  constructor(readonly lines: string[]) {
    super(lines.join('\n'))
  }
}

async function check(name: string, run: () => Promise<string>, optional = false): Promise<void> {
  try {
    results.push({ name, ok: true, detail: await run(), optional })
  } catch (error) {
    const detail =
      error instanceof Problems || error instanceof ConfigError
        ? (error instanceof Problems ? error.lines : error.problems).join('\n    ')
        : (error instanceof Error ? error.message : String(error)).split('\n')[0]
    results.push({ name, ok: false, detail: detail ?? 'failed', optional })
  }
}

const env = await readEnvFile('.env.local')
const aiSource: Record<string, string | undefined> = {}
for (const line of env.lines) {
  const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1]
  if (key) aiSource[key] = getEnv(env, key)
}
const value = (key: string): string => {
  const found = getEnv(env, key)
  if (found === undefined || isUnset(found)) throw new Error(`${key} is not set in .env.local`)
  return found
}

// Toolchain
await check('bun', async () => {
  const wanted = packageJson.packageManager.replace('bun@', '')
  if (Bun.version !== wanted) throw new Error(`running ${Bun.version}, package.json pins ${wanted}`)
  return Bun.version
})
await check('docker engine', async () => {
  return `server ${(await $`docker info --format {{.ServerVersion}}`.quiet().text()).trim()}`
})

// Configuration
await check('.env.local', async () => {
  const keys = [
    'DATABASE_OWNER_URL',
    'DATABASE_OWNER_URL_TEST',
    'DATABASE_URL',
    'DATABASE_URL_TEST',
    'VALKEY_URL',
    'S3_ENDPOINT',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
    'BETTER_AUTH_SECRET',
    'AUTH_TOKEN_ENCRYPTION_KEY',
    'RESTORE_EPOCH',
    'SEED_DEMO_PASSWORD',
  ]
  for (const key of keys) value(key)
  return `${keys.length} required values present`
})
await check(
  'AI configuration',
  async () => {
    const config = loadAiConfig(aiSource)
    return `${config.provider}; ${config.provider === 'mock' ? 'no key needed' : 'key set'}`
  },
  true,
)

// Host ports (D-172): set by variables, and reserved by Windows at random. A reserved port is not an error for Docker: the
// container is healthy and the port is not there, so the connection checks below would only say "refused".
const optionalValue = (key: string): string | undefined => {
  const found = getEnv(env, key)
  return found === undefined || isUnset(found) ? undefined : found
}
const ports = infraPorts(optionalValue)
const windows = await windowsPorts()
await check('host ports', async () => {
  const problems = [...urlProblems(optionalValue, ports), ...reservedProblems(ports, windows)]
  if (problems.length > 0) throw new Problems(problems)
  const where =
    windows === null ? 'Windows reservations not checked (not WSL)' : 'none reserved by Windows'
  return `${ports.map((entry) => `${entry.service} ${entry.port}`).join(', ')}; ${where}`
})

// Containers
await check('containers', async () => {
  const raw =
    await $`docker compose -f infra/compose.dev.yml --env-file .env.local ps --format json`
      .quiet()
      .text()
  const rows = parseComposePs(raw)
  const expected = ['postgres', 'valkey', 'garage', 'mailpit']
  const unhealthy = expected.filter(
    (service) => !rows.some((row) => row.Service === service && row.Health === 'healthy'),
  )
  if (unhealthy.length > 0) throw new Error(`not healthy: ${unhealthy.join(', ')}`)
  const unpublished = publishedProblems(rows, ports)
  if (unpublished.length > 0) throw new Problems(unpublished)
  return 'postgres, valkey, garage, mailpit healthy, every host port published'
})

// PostgreSQL 18 + extensions (dev and test databases)
for (const [label, key] of [
  ['postgres (dev)', 'DATABASE_OWNER_URL'],
  ['postgres (test)', 'DATABASE_OWNER_URL_TEST'],
] as const) {
  await check(label, async () => {
    const sql = new SQL(value(key))
    try {
      const [row] = await sql`select current_setting('server_version') as version, uuidv7() as id`
      const extensions = await sql`
        select extname, extversion from pg_extension
        where extname in ('vector', 'pg_trgm') order by extname`
      const names = extensions.map((ext: { extname: string; extversion: string }) => {
        return `${ext.extname} ${ext.extversion}`
      })
      if (names.length !== 2) throw new Error(`missing extensions (found: ${names.join(', ')})`)
      return `PostgreSQL ${row.version}, ${names.join(', ')}, uuidv7() ok`
    } finally {
      await sql.close()
    }
  })
}

// The unprivileged application role exists only after `bun run db:migrate`, hence optional.
for (const [label, key] of [
  ['postgres app role (dev)', 'DATABASE_URL'],
  ['postgres app role (test)', 'DATABASE_URL_TEST'],
] as const) {
  await check(
    label,
    async () => {
      const sql = new SQL(value(key))
      try {
        const [row] = await sql`
          select current_user as role, rolsuper, rolcreatedb, rolcreaterole
          from pg_roles where rolname = current_user`
        if (row.rolsuper || row.rolcreatedb || row.rolcreaterole)
          throw new Error('role is privileged')
        return `connects as ${row.role}, unprivileged`
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`${message.split('\n')[0]} (run: bun run db:migrate)`)
      } finally {
        await sql.close()
      }
    },
    true,
  )
}

// Valkey
await check('valkey', async () => {
  const client = new RedisClient(value('VALKEY_URL'))
  // CONFIG GET replies with a map under RESP3 and a flat [key, value] array under RESP2.
  const configValue = async (key: string): Promise<unknown> => {
    const reply: unknown = await client.send('CONFIG', ['GET', key])
    if (Array.isArray(reply)) return reply[1]
    if (reply !== null && typeof reply === 'object') return (reply as Record<string, unknown>)[key]
    return undefined
  }
  try {
    const pong = await client.send('PING', [])
    const policy = await configValue('maxmemory-policy')
    const appendOnly = await configValue('appendonly')
    if (policy !== 'noeviction') throw new Error(`maxmemory-policy is ${String(policy)}`)
    if (appendOnly !== 'yes') throw new Error('appendonly is off')
    return `${pong}, maxmemory-policy=noeviction, appendonly=yes`
  } finally {
    client.close()
  }
})

// Garage (S3): write, read back and delete a probe object in each bucket
for (const bucketKey of ['S3_BUCKET', 'S3_BUCKET_TEST']) {
  await check(`garage s3 (${bucketKey === 'S3_BUCKET' ? 'dev' : 'test'})`, async () => {
    const bucket = value(bucketKey)
    const s3 = new S3Client({
      endpoint: value('S3_ENDPOINT'),
      region: value('S3_REGION'),
      bucket,
      accessKeyId: value('S3_ACCESS_KEY_ID'),
      secretAccessKey: value('S3_SECRET_ACCESS_KEY'),
    })
    const key = `doctor/probe-${Date.now()}.txt`
    await s3.write(key, 'ok')
    const text = await s3.file(key).text()
    await s3.delete(key)
    if (text !== 'ok') throw new Error('read-back mismatch')
    return `bucket ${bucket}: write/read/delete ok`
  })
}

// Mailpit: web API and SMTP banner
await check('mailpit', async () => {
  const response = await fetch('http://localhost:8025/api/v1/info')
  if (!response.ok) throw new Error(`web UI returned ${response.status}`)
  const info = (await response.json()) as { Version: string }
  const smtpPort = Number(value('SMTP_PORT'))
  const banner = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SMTP banner timeout')), 3000)
    Bun.connect({
      hostname: '127.0.0.1',
      port: smtpPort,
      socket: {
        data(socket, data) {
          clearTimeout(timer)
          socket.end()
          resolve(data.toString().trim())
        },
        error(_socket, error) {
          clearTimeout(timer)
          reject(error)
        },
      },
    }).catch(reject)
  })
  if (!banner.startsWith('220')) throw new Error(`unexpected SMTP banner: ${banner}`)
  return `${info.Version}, SMTP on :${smtpPort} ready`
})

// Optional connectivity: only the selected fixed host, no generation or paid fallback.
if (process.argv.includes('--ai')) {
  await check('AI models', async () => {
    const config = loadAiConfig(aiSource)
    if (config.provider === 'mock') return 'mock; external requests disabled'
    let response: Response
    try {
      response = await fetch(`${AI_ENDPOINTS[config.provider]}/models`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      })
    } catch {
      throw new Error(`${config.provider}: connection failed or timed out`)
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body: unknown = await response.json().catch(() => null)
    const data = body !== null && typeof body === 'object' && 'data' in body ? body.data : null
    if (!Array.isArray(data)) throw new Error('invalid models response')
    const ids = new Set(
      data.flatMap((model: unknown) =>
        model !== null && typeof model === 'object' && 'id' in model && typeof model.id === 'string'
          ? [model.id]
          : [],
      ),
    )
    for (const model of Object.values(config.models))
      if (!ids.has(model)) throw new Error(`configured model unavailable: ${model}`)
    return `${config.provider}; configured fast/deep models available`
  })
}

for (const result of results) {
  const mark = result.ok ? '✓' : result.optional ? '·' : '✗'
  console.log(`${mark} ${result.name.padEnd(18)} ${result.detail}`)
}
const failed = results.filter((result) => !result.ok && !result.optional)
if (failed.length > 0) {
  console.error(`\n${failed.length} check(s) failed`)
  process.exit(1)
}
console.log('\nenvironment ok')
