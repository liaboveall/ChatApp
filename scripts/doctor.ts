/**
 * Checks that the local development environment works end to end, using Bun's
 * native clients (SQL, Redis, S3). Never prints secret values.
 *   bun run doctor          all local checks
 *   bun run doctor --ai     also calls the DeepSeek models endpoint (needs DEEPSEEK_API_KEY)
 */
import { $, RedisClient, S3Client, SQL } from 'bun'
import packageJson from '../package.json'
import { getEnv, isUnset, readEnvFile } from './lib/env-file.ts'

type Check = { name: string; ok: boolean; detail: string; optional?: boolean }
const results: Check[] = []

async function check(name: string, run: () => Promise<string>, optional = false): Promise<void> {
  try {
    results.push({ name, ok: true, detail: await run(), optional })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    results.push({ name, ok: false, detail: detail.split('\n')[0] ?? 'failed', optional })
  }
}

const env = await readEnvFile('.env.local')
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
  'DEEPSEEK_API_KEY',
  async () => {
    value('DEEPSEEK_API_KEY')
    return 'set'
  },
  true,
)

// Containers
await check('containers', async () => {
  const raw =
    await $`docker compose -f infra/compose.dev.yml --env-file .env.local ps --format json`
      .quiet()
      .text()
  const rows = raw
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line) as { Service: string; State: string; Health: string })
  const expected = ['postgres', 'valkey', 'garage', 'mailpit']
  const unhealthy = expected.filter(
    (service) => !rows.some((row) => row.Service === service && row.Health === 'healthy'),
  )
  if (unhealthy.length > 0) throw new Error(`not healthy: ${unhealthy.join(', ')}`)
  return 'postgres, valkey, garage, mailpit healthy'
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

// Optional: DeepSeek connectivity (free models endpoint; the key is never printed)
if (process.argv.includes('--ai')) {
  await check('deepseek api', async () => {
    const response = await fetch('https://api.deepseek.com/models', {
      headers: { Authorization: `Bearer ${value('DEEPSEEK_API_KEY')}` },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = (await response.json()) as { data: { id: string }[] }
    return `models: ${body.data.map((model) => model.id).join(', ')}`
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
