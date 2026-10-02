import { describe, expect, test } from 'bun:test'
import { ConfigError, loadConfig } from './env.ts'

// 32 random-looking bytes as base64url, and a 40-character secret; both are test fixtures, not real secrets.
const KEY = 'q83vEjS0m1xZk7UwYpHn2LcRtBdA9fGoIeJ4aVhN5Xs'
const SECRET = 'k3Jx9QvLm2ZpWn8RtYb4HcDf7GsAe1UoIiTqVyPz'

const base: Record<string, string> = {
  APP_ENV: 'development',
  APP_ORIGIN: 'http://localhost:5173',
  DATABASE_URL: 'postgres://chatapp_app:pw@localhost:5434/chatapp',
  DATABASE_URL_TEST: 'postgres://chatapp_app:pw@localhost:5434/chatapp_test',
  DATABASE_OWNER_URL: 'postgres://chatapp:pw@localhost:5434/chatapp',
  DATABASE_OWNER_URL_TEST: 'postgres://chatapp:pw@localhost:5434/chatapp_test',
  VALKEY_URL: 'redis://localhost:6379/0',
  VALKEY_URL_TEST: 'redis://localhost:6379/1',
  S3_ENDPOINT: 'http://localhost:3900',
  S3_BUCKET: 'chatapp',
  S3_BUCKET_TEST: 'chatapp-test',
  S3_ACCESS_KEY_ID: 'GKabc',
  S3_SECRET_ACCESS_KEY: 'secret-value',
  BETTER_AUTH_SECRET: SECRET,
  AUTH_TOKEN_ENCRYPTION_KEY: KEY,
  RESTORE_EPOCH: 'epoch-0001',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '12525',
  MAIL_FROM: 'ChatApp <noreply@chatapp.localhost>',
}

function problemsOf(env: Record<string, string | undefined>): readonly string[] {
  try {
    loadConfig(env)
  } catch (error) {
    if (error instanceof ConfigError) return error.problems
    throw error
  }
  return []
}

describe('loadConfig', () => {
  test('accepts a complete development environment and applies defaults', () => {
    const config = loadConfig(base)
    expect(config.env).toBe('development')
    expect(config.apiPort).toBe(3100)
    expect(config.timezone).toBe('Asia/Shanghai')
    expect(config.trustedProxies).toEqual(['127.0.0.1', '::1'])
    expect(config.eventChannel).toBe('events:development')
    expect(config.databaseUrl).toContain('/chatapp')
    expect(config.auth.tokenEncryptionKey).toHaveLength(32)
    expect(config.product.agentUsername).toBe('assistant')
  })

  test('reports missing variables by name', () => {
    const { BETTER_AUTH_SECRET: _, ...rest } = base
    const problems = problemsOf(rest)
    expect(problems.some((problem) => problem.startsWith('BETTER_AUTH_SECRET'))).toBe(true)
  })

  test('never echoes secret values in errors', () => {
    const problems = problemsOf({ ...base, AUTH_TOKEN_ENCRYPTION_KEY: 'short-but-secret-value' })
    const text = problems.join('\n')
    expect(text).toContain('AUTH_TOKEN_ENCRYPTION_KEY')
    expect(text).not.toContain('short-but-secret-value')
  })

  test('requires a 32-byte base64url token encryption key', () => {
    expect(problemsOf({ ...base, AUTH_TOKEN_ENCRYPTION_KEY: 'AAAA' })[0]).toContain(
      '32 random bytes',
    )
  })

  test('APP_ORIGIN must be a bare origin', () => {
    expect(problemsOf({ ...base, APP_ORIGIN: 'http://localhost:5173/' })[0]).toContain(
      'without path',
    )
    expect(problemsOf({ ...base, APP_ORIGIN: 'not a url' })[0]).toContain('not a valid URL')
  })

  test('rejects an invalid proxy list', () => {
    expect(problemsOf({ ...base, TRUSTED_PROXIES: '127.0.0.1,not-an-ip' })[0]).toContain(
      'TRUSTED_PROXIES',
    )
  })
})

describe('test environment targets (docs/08 section 4)', () => {
  const test_: Record<string, string> = { ...base, APP_ENV: 'test' }

  test('swaps in the test database, Valkey db and bucket', () => {
    const config = loadConfig(test_)
    expect(config.databaseUrl).toContain('/chatapp_test')
    expect(config.databaseOwnerUrl).toContain('/chatapp_test')
    expect(config.valkeyUrl).toContain('/1')
    expect(config.s3.bucket).toBe('chatapp-test')
    expect(config.eventChannel).toBe('events:test')
  })

  test('refuses a database that is not a test database', () => {
    const problems = problemsOf({
      ...test_,
      DATABASE_URL_TEST: 'postgres://chatapp_app:pw@localhost:5434/chatapp',
    })
    expect(problems.join('\n')).toContain('must end with _test')
  })

  test('refuses the development Valkey database and bucket', () => {
    expect(problemsOf({ ...test_, VALKEY_URL_TEST: 'redis://localhost:6379/0' }).join()).toContain(
      'different Valkey database',
    )
    expect(problemsOf({ ...test_, S3_BUCKET_TEST: 'chatapp' }).join()).toContain(
      'must end with -test',
    )
  })

  test('requires the test variables to exist', () => {
    const { DATABASE_URL_TEST: _, ...rest } = test_
    expect(problemsOf(rest).join()).toContain('DATABASE_URL_TEST: required')
  })
})

describe('production hardening (SEC-18)', () => {
  const production: Record<string, string> = {
    ...base,
    APP_ENV: 'production',
    APP_ORIGIN: 'https://chat.example.com',
  }

  test('accepts strong secrets over https', () => {
    expect(problemsOf(production)).toEqual([])
  })

  test('refuses http origins, placeholders, short and low-entropy secrets', () => {
    expect(problemsOf({ ...production, APP_ORIGIN: 'http://chat.example.com' }).join()).toContain(
      'https',
    )
    expect(
      problemsOf({ ...production, BETTER_AUTH_SECRET: 'changeme'.padEnd(40, 'x') }).join(),
    ).toContain('BETTER_AUTH_SECRET')
    expect(problemsOf({ ...production, BETTER_AUTH_SECRET: 'a'.repeat(40) }).join()).toContain(
      'low-entropy',
    )
    expect(problemsOf({ ...production, RESTORE_EPOCH: 'dev' }).join()).toContain('RESTORE_EPOCH')
  })

  test('the two auth secrets must differ', () => {
    expect(
      problemsOf({ ...production, BETTER_AUTH_SECRET: KEY, AUTH_TOKEN_ENCRYPTION_KEY: KEY }).join(),
    ).toContain('must differ')
  })
})
