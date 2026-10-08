/**
 * Local setup (safe to run repeatedly):
 * - creates .env.local from .env.example
 * - fills every missing or <generated> value with a random secret (values are never printed)
 * - renders infra/garage/garage.toml from its template
 *
 * Do not regenerate POSTGRES_PASSWORD after the database volume exists; use `bun run infra:reset --yes` instead.
 *
 * Database accounts: DATABASE_OWNER_URL(_TEST) is the owner (migrations, bootstrap, CLI); DATABASE_URL(_TEST) is the
 * unprivileged application role. A `.env.local` from before the split holds the owner URL in DATABASE_URL, so that
 * value is moved to DATABASE_OWNER_URL once and DATABASE_URL is pointed at the application role.
 *
 * Host ports (D-172): POSTGRES_PORT and VALKEY_PORT set what Compose publishes, and the ports inside the connection URLs
 * always follow them, so moving a port is: change the variable, run this, run `bun run infra:up`. A `.env.local` from
 * before the variables keeps the ports its URLs already use.
 */
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync } from 'node:fs'
import { getEnv, isUnset, readEnvFile, setEnv, writeEnvFile } from './lib/env-file.ts'
import { portOf, URL_PORTS, withPort } from './lib/ports.ts'

const EXAMPLE = '.env.example'
const LOCAL = '.env.local'
const GARAGE_TEMPLATE = 'infra/garage/garage.toml.template'
const GARAGE_CONFIG = 'infra/garage/garage.toml'
const OWNER_ROLE = 'chatapp'
const APP_ROLE = 'chatapp_app'

const hex = (bytes: number) => randomBytes(bytes).toString('hex')
const token = (bytes: number) => randomBytes(bytes).toString('base64url')

if (!existsSync(LOCAL)) {
  copyFileSync(EXAMPLE, LOCAL)
  console.log(`created ${LOCAL} from ${EXAMPLE}`)
}

const env = await readEnvFile(LOCAL)
const filled: string[] = []

// Keys added to .env.example after this file was created are appended with the template's value; existing
// values are never touched. The two port variables take the port the existing URLs already use, so that adding them
// does not move anything.
const added: string[] = []
for (const [key, url] of [
  ['POSTGRES_PORT', 'DATABASE_OWNER_URL'],
  ['VALKEY_PORT', 'VALKEY_URL'],
] as const) {
  const inherited = portOf(getEnv(env, url) ?? '')
  if (isUnset(getEnv(env, key)) && inherited !== undefined) {
    setEnv(env, key, String(inherited))
    added.push(key)
  }
}
for (const line of (await readEnvFile(EXAMPLE)).lines) {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line)
  const key = match?.[1]
  if (key !== undefined && getEnv(env, key) === undefined) {
    setEnv(env, key, match?.[2] ?? '')
    added.push(key)
  }
}

function ensure(key: string, make: () => string): string {
  const current = getEnv(env, key)
  if (current !== undefined && !isUnset(current)) return current
  const value = make()
  setEnv(env, key, value)
  filled.push(key)
  return value
}

/** A host port from its variable: a whole number a program may bind. */
function hostPort(key: string): number {
  const value = Number(getEnv(env, key))
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error(`${key} in ${LOCAL} must be a port between 1024 and 65535`)
  }
  return value
}
const hostPorts: Record<string, number> = {
  POSTGRES_PORT: hostPort('POSTGRES_PORT'),
  VALKEY_PORT: hostPort('VALKEY_PORT'),
}

const pgPassword = ensure('POSTGRES_PASSWORD', () => hex(16))
const appDbPassword = hex(16)

function urlUser(value: string | undefined): string | undefined {
  if (value === undefined || isUnset(value)) return undefined
  try {
    return decodeURIComponent(new URL(value).username)
  } catch {
    return undefined
  }
}

/** Fills the owner/application URL pair for one database, converting a pre-split `.env.local` once. */
function ensureDatabaseUrls(ownerKey: string, appKey: string, database: string): void {
  const port = hostPorts.POSTGRES_PORT
  const owner = `postgres://${OWNER_ROLE}:${pgPassword}@localhost:${port}/${database}`
  const app = `postgres://${APP_ROLE}:${appDbPassword}@localhost:${port}/${database}`
  const currentOwner = getEnv(env, ownerKey)
  const currentApp = getEnv(env, appKey)
  if (currentOwner === undefined || isUnset(currentOwner)) {
    const legacy = urlUser(currentApp) === OWNER_ROLE ? currentApp : undefined
    setEnv(env, ownerKey, legacy ?? owner)
    filled.push(ownerKey)
  }
  if (currentApp === undefined || isUnset(currentApp) || urlUser(currentApp) !== APP_ROLE) {
    setEnv(env, appKey, app)
    filled.push(appKey)
  }
}
ensureDatabaseUrls('DATABASE_OWNER_URL', 'DATABASE_URL', 'chatapp')
ensureDatabaseUrls('DATABASE_OWNER_URL_TEST', 'DATABASE_URL_TEST', 'chatapp_test')
ensure('S3_ACCESS_KEY_ID', () => `GK${hex(12)}`) // Garage key id: "GK" + 24 hex chars
ensure('S3_SECRET_ACCESS_KEY', () => hex(32)) // Garage secret: 64 hex chars
const rpcSecret = ensure('GARAGE_RPC_SECRET', () => hex(32))
const adminToken = ensure('GARAGE_ADMIN_TOKEN', () => token(32))
const metricsToken = ensure('GARAGE_METRICS_TOKEN', () => token(32))
ensure('BETTER_AUTH_SECRET', () => token(32))
ensure('AUTH_TOKEN_ENCRYPTION_KEY', () => token(32))
ensure('AI_KEY_ENCRYPTION_KEY', () => token(32)) // M5a: members' own AI keys, AES-256-GCM
ensure('RESTORE_EPOCH', () => token(12))
ensure('SEED_DEMO_PASSWORD', () => token(12))

// The ports inside the connection URLs follow the port variables (whichever of the two was edited by hand).
const moved: string[] = []
for (const { url, variable } of URL_PORTS) {
  const current = getEnv(env, url)
  const wanted = hostPorts[variable]
  if (current === undefined || isUnset(current) || wanted === undefined) continue
  if (portOf(current) !== wanted) {
    setEnv(env, url, withPort(current, wanted))
    moved.push(url)
  }
}

await writeEnvFile(env)

const template = await Bun.file(GARAGE_TEMPLATE).text()
await Bun.write(
  GARAGE_CONFIG,
  template
    .replaceAll('{{GARAGE_RPC_SECRET}}', rpcSecret)
    .replaceAll('{{GARAGE_ADMIN_TOKEN}}', adminToken)
    .replaceAll('{{GARAGE_METRICS_TOKEN}}', metricsToken),
)

if (added.length > 0) console.log(`added from ${EXAMPLE}: ${added.join(', ')}`)
console.log(filled.length > 0 ? `generated: ${filled.join(', ')}` : 'all secrets already present')
if (moved.length > 0) {
  console.log(
    `ports in the URLs now follow POSTGRES_PORT and VALKEY_PORT: ${moved.join(', ')}; run \`bun run infra:up\` to publish them`,
  )
}
console.log(`rendered ${GARAGE_CONFIG}`)
console.log(
  isUnset(getEnv(env, 'DEEPSEEK_API_KEY'))
    ? 'DEEPSEEK_API_KEY is empty: add it to .env.local yourself (needed from M4)'
    : 'DEEPSEEK_API_KEY is set',
)
