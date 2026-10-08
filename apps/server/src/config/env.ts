/**
 * Environment configuration, validated once at startup (docs/03 section 8, SEC-18, SEC-29).
 * `loadConfig` is pure: entry points pass `process.env`, tests pass a literal. Failures list the variable names and
 * the reason, never the values.
 */
import { createHmac } from 'node:crypto'
import { timezoneSchema } from '@chatapp/contracts'
import { z } from 'zod'
import { parseTrustedProxies } from '../lib/ip.ts'

export type AppEnv = 'development' | 'test' | 'production'

export type Config = {
  env: AppEnv
  /** Exact origin of the site, for example https://chat.example.com (no path). */
  origin: string
  timezone: string
  apiPort: number
  /** Interface the API listens on; loopback by default, 0.0.0.0 only inside a container behind the gateway. */
  apiHost: string
  trustedProxies: readonly string[]
  /** Application (unprivileged) connection. */
  databaseUrl: string
  /** Owner connection for migrations, bootstrap and admin commands; absent in a running production app. */
  databaseOwnerUrl: string | undefined
  valkeyUrl: string
  /** Pub/Sub channel carrying work hints, separated per environment (D-044). */
  eventChannel: string
  s3: {
    endpoint: string
    region: string
    bucket: string
    accessKeyId: string
    secretAccessKey: string
    metricsToken?: string
    metricsEndpoint: string
  }
  auth: {
    secret: string
    /** 32 raw bytes encrypting one-time credentials awaiting delivery (D-076). */
    tokenEncryptionKey: Uint8Array
    /** 32 raw bytes signing sync cursors: HMAC of a fixed label under the auth secret, so it needs no new secret (D-126). */
    cursorKey: Uint8Array
    restoreEpoch: string
  }
  /** 32 raw bytes encrypting members' own AI keys (M5a, SEC-26); optional outside production, where keys are then off. */
  aiKeyEncryptionKey: Uint8Array | undefined
  smtp: {
    host: string
    port: number
    user: string | undefined
    pass: string | undefined
    from: string
  }
  product: { name: string; agentDisplayName: string; agentUsername: string }
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent'
}

export class ConfigError extends Error {
  readonly problems: readonly string[]
  constructor(problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`)
    this.name = 'ConfigError'
    this.problems = problems
  }
}

const optional = (schema: z.ZodType<string>) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional())

const rawSchema = z.object({
  APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ORIGIN: z.string().min(1),
  APP_TIMEZONE: timezoneSchema.default('Asia/Shanghai'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  TRUSTED_PROXIES: z.string().default('127.0.0.1,::1'),
  DATABASE_URL: z.string().min(1),
  DATABASE_URL_TEST: optional(z.string()),
  DATABASE_OWNER_URL: optional(z.string()),
  DATABASE_OWNER_URL_TEST: optional(z.string()),
  VALKEY_URL: z.string().min(1),
  VALKEY_URL_TEST: optional(z.string()),
  S3_ENDPOINT: z.string().min(1),
  GARAGE_METRICS_TOKEN: optional(z.string()),
  GARAGE_METRICS_ENDPOINT: optional(z.string().url()),
  S3_REGION: z.string().min(1).default('garage'),
  S3_BUCKET: z.string().min(1),
  S3_BUCKET_TEST: optional(z.string()),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(1),
  AUTH_TOKEN_ENCRYPTION_KEY: z.string().min(1),
  AI_KEY_ENCRYPTION_KEY: optional(z.string()),
  RESTORE_EPOCH: z.string().min(1),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535),
  SMTP_USER: optional(z.string()),
  SMTP_PASS: optional(z.string()),
  MAIL_FROM: z.string().min(3),
  PRODUCT_NAME: z.string().min(1).default('ChatApp'),
  AGENT_DISPLAY_NAME: z.string().min(1).default('助手'),
  AGENT_USERNAME: z
    .string()
    .regex(/^[a-z0-9_]{3,20}$/)
    .default('assistant'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
})

/** Values that must never reach production: the shipped placeholders and obviously weak fillers. */
const WEAK_SECRET =
  /^(changeme|change-me|secret|password|example|test|dev|development|<generated>)/i

function decodeBase64Url(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined
  try {
    return new Uint8Array(Buffer.from(value, 'base64url'))
  } catch {
    return undefined
  }
}

function databaseName(url: string): string | undefined {
  try {
    return new URL(url).pathname.replace(/^\//, '') || undefined
  } catch {
    return undefined
  }
}

function valkeyDatabase(url: string): number {
  try {
    const path = new URL(url).pathname.replace(/^\//, '')
    return path === '' ? 0 : Number(path)
  } catch {
    return Number.NaN
  }
}

/** Distinct characters: a cheap guard against secrets like "aaaaaaaa…" in production. */
function looksRandom(secret: string): boolean {
  return new Set(secret).size >= 12
}

export function loadConfig(source: Record<string, string | undefined>): Config {
  const parsed = rawSchema.safeParse(source)
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    )
  }
  const raw = parsed.data
  const problems: string[] = []
  const isProduction = raw.APP_ENV === 'production'
  const isTest = raw.APP_ENV === 'test'

  let origin = raw.APP_ORIGIN
  try {
    const url = new URL(raw.APP_ORIGIN)
    if (url.origin !== raw.APP_ORIGIN)
      problems.push('APP_ORIGIN: must be an origin without path, query or trailing slash')
    origin = url.origin
    if (isProduction && url.protocol !== 'https:')
      problems.push('APP_ORIGIN: must be https in production')
  } catch {
    problems.push('APP_ORIGIN: not a valid URL')
  }

  const proxies = parseTrustedProxies(raw.TRUSTED_PROXIES)
  if (proxies.invalid.length > 0)
    problems.push('TRUSTED_PROXIES: contains an invalid IP or CIDR entry')

  // The test environment swaps in its own database, Valkey db and bucket and refuses anything that could be real data.
  const databaseUrl = isTest ? raw.DATABASE_URL_TEST : raw.DATABASE_URL
  const databaseOwnerUrl = isTest ? raw.DATABASE_OWNER_URL_TEST : raw.DATABASE_OWNER_URL
  const valkeyUrl = isTest ? raw.VALKEY_URL_TEST : raw.VALKEY_URL
  const bucket = isTest ? raw.S3_BUCKET_TEST : raw.S3_BUCKET
  if (isTest) {
    if (!databaseUrl) problems.push('DATABASE_URL_TEST: required when APP_ENV=test')
    if (!valkeyUrl) problems.push('VALKEY_URL_TEST: required when APP_ENV=test')
    if (!bucket) problems.push('S3_BUCKET_TEST: required when APP_ENV=test')
    for (const [key, url] of [
      ['DATABASE_URL_TEST', databaseUrl],
      ['DATABASE_OWNER_URL_TEST', databaseOwnerUrl],
    ] as const) {
      if (url && !databaseName(url)?.endsWith('_test')) {
        problems.push(`${key}: database name must end with _test when APP_ENV=test`)
      }
    }
    if (valkeyUrl && valkeyDatabase(valkeyUrl) === valkeyDatabase(raw.VALKEY_URL)) {
      problems.push('VALKEY_URL_TEST: must use a different Valkey database than VALKEY_URL')
    }
    if (bucket && !bucket.endsWith('-test'))
      problems.push('S3_BUCKET_TEST: bucket name must end with -test')
  }

  const tokenKey = decodeBase64Url(raw.AUTH_TOKEN_ENCRYPTION_KEY)
  if (tokenKey?.length !== 32) {
    problems.push('AUTH_TOKEN_ENCRYPTION_KEY: must be 32 random bytes encoded as base64url')
  }

  const aiKey = raw.AI_KEY_ENCRYPTION_KEY ? decodeBase64Url(raw.AI_KEY_ENCRYPTION_KEY) : undefined
  if (raw.AI_KEY_ENCRYPTION_KEY && aiKey?.length !== 32)
    problems.push('AI_KEY_ENCRYPTION_KEY: must be 32 random bytes encoded as base64url')
  if (
    raw.AI_KEY_ENCRYPTION_KEY &&
    [raw.AUTH_TOKEN_ENCRYPTION_KEY, raw.BETTER_AUTH_SECRET].includes(raw.AI_KEY_ENCRYPTION_KEY)
  )
    problems.push('AI_KEY_ENCRYPTION_KEY: must differ from the other secrets')

  if (isProduction) {
    if (!raw.AI_KEY_ENCRYPTION_KEY) problems.push('AI_KEY_ENCRYPTION_KEY: required in production')
    for (const key of ['BETTER_AUTH_SECRET', 'AUTH_TOKEN_ENCRYPTION_KEY'] as const) {
      const secret = raw[key]
      if (secret.length < 32 || WEAK_SECRET.test(secret) || !looksRandom(secret)) {
        problems.push(
          `${key}: too short, a placeholder or low-entropy; refusing to start in production`,
        )
      }
    }
    if (raw.RESTORE_EPOCH.length < 8 || WEAK_SECRET.test(raw.RESTORE_EPOCH)) {
      problems.push('RESTORE_EPOCH: must be a random value of at least 8 characters in production')
    }
    if (raw.BETTER_AUTH_SECRET === raw.AUTH_TOKEN_ENCRYPTION_KEY) {
      problems.push('AUTH_TOKEN_ENCRYPTION_KEY: must differ from BETTER_AUTH_SECRET')
    }
  } else if (raw.BETTER_AUTH_SECRET.length < 32) {
    problems.push('BETTER_AUTH_SECRET: must be at least 32 characters')
  }

  if (problems.length > 0 || !databaseUrl || !valkeyUrl || !bucket || !tokenKey) {
    throw new ConfigError(problems.length > 0 ? problems : ['configuration is incomplete'])
  }

  return {
    env: raw.APP_ENV,
    origin,
    timezone: raw.APP_TIMEZONE,
    apiPort: raw.API_PORT,
    apiHost: raw.API_HOST,
    trustedProxies: proxies.ok,
    databaseUrl,
    databaseOwnerUrl,
    valkeyUrl,
    eventChannel: `events:${raw.APP_ENV}`,
    s3: {
      endpoint: raw.S3_ENDPOINT,
      region: raw.S3_REGION,
      bucket,
      accessKeyId: raw.S3_ACCESS_KEY_ID,
      secretAccessKey: raw.S3_SECRET_ACCESS_KEY,
      metricsToken: raw.GARAGE_METRICS_TOKEN,
      metricsEndpoint:
        raw.GARAGE_METRICS_ENDPOINT ??
        (() => {
          const url = new URL(raw.S3_ENDPOINT)
          url.port = '3903'
          return `${url.origin}/metrics`
        })(),
    },
    auth: {
      secret: raw.BETTER_AUTH_SECRET,
      tokenEncryptionKey: tokenKey,
      cursorKey: new Uint8Array(
        createHmac('sha256', raw.BETTER_AUTH_SECRET).update('chatapp:cursor:v1').digest(),
      ),
      restoreEpoch: raw.RESTORE_EPOCH,
    },
    aiKeyEncryptionKey: aiKey,
    smtp: {
      host: raw.SMTP_HOST,
      port: raw.SMTP_PORT,
      user: raw.SMTP_USER,
      pass: raw.SMTP_PASS,
      from: raw.MAIL_FROM,
    },
    product: {
      name: raw.PRODUCT_NAME,
      agentDisplayName: raw.AGENT_DISPLAY_NAME,
      agentUsername: raw.AGENT_USERNAME,
    },
    logLevel: raw.LOG_LEVEL,
  }
}
