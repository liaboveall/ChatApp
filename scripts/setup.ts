/**
 * Local setup (safe to run repeatedly):
 * - creates .env.local from .env.example
 * - fills every missing or <generated> value with a random secret (values are never printed)
 * - renders infra/garage/garage.toml from its template
 *
 * Do not regenerate POSTGRES_PASSWORD after the database volume exists; use `bun run infra:reset --yes` instead.
 */
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync } from 'node:fs'
import { getEnv, isUnset, readEnvFile, setEnv, writeEnvFile } from './lib/env-file.ts'

const EXAMPLE = '.env.example'
const LOCAL = '.env.local'
const GARAGE_TEMPLATE = 'infra/garage/garage.toml.template'
const GARAGE_CONFIG = 'infra/garage/garage.toml'
const DB_HOST_PORT = 5434

const hex = (bytes: number) => randomBytes(bytes).toString('hex')
const token = (bytes: number) => randomBytes(bytes).toString('base64url')

if (!existsSync(LOCAL)) {
  copyFileSync(EXAMPLE, LOCAL)
  console.log(`created ${LOCAL} from ${EXAMPLE}`)
}

const env = await readEnvFile(LOCAL)
const filled: string[] = []

function ensure(key: string, make: () => string): string {
  const current = getEnv(env, key)
  if (current !== undefined && !isUnset(current)) return current
  const value = make()
  setEnv(env, key, value)
  filled.push(key)
  return value
}

const pgPassword = ensure('POSTGRES_PASSWORD', () => hex(16))
ensure('DATABASE_URL', () => `postgres://chatapp:${pgPassword}@localhost:${DB_HOST_PORT}/chatapp`)
ensure(
  'DATABASE_URL_TEST',
  () => `postgres://chatapp:${pgPassword}@localhost:${DB_HOST_PORT}/chatapp_test`,
)
ensure('S3_ACCESS_KEY_ID', () => `GK${hex(12)}`) // Garage key id: "GK" + 24 hex chars
ensure('S3_SECRET_ACCESS_KEY', () => hex(32)) // Garage secret: 64 hex chars
const rpcSecret = ensure('GARAGE_RPC_SECRET', () => hex(32))
const adminToken = ensure('GARAGE_ADMIN_TOKEN', () => token(32))
const metricsToken = ensure('GARAGE_METRICS_TOKEN', () => token(32))
ensure('BETTER_AUTH_SECRET', () => token(32))
ensure('SEED_DEMO_PASSWORD', () => token(12))

await writeEnvFile(env)

const template = await Bun.file(GARAGE_TEMPLATE).text()
await Bun.write(
  GARAGE_CONFIG,
  template
    .replaceAll('{{GARAGE_RPC_SECRET}}', rpcSecret)
    .replaceAll('{{GARAGE_ADMIN_TOKEN}}', adminToken)
    .replaceAll('{{GARAGE_METRICS_TOKEN}}', metricsToken),
)

console.log(filled.length > 0 ? `generated: ${filled.join(', ')}` : 'all secrets already present')
console.log(`rendered ${GARAGE_CONFIG}`)
console.log(
  isUnset(getEnv(env, 'DEEPSEEK_API_KEY'))
    ? 'DEEPSEEK_API_KEY is empty: add it to .env.local yourself (needed from M4)'
    : 'DEEPSEEK_API_KEY is set',
)
