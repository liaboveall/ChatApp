import { describe, expect, test } from 'bun:test'
import { AppError } from '@chatapp/contracts'
import { createLogger, describeError } from './logger.ts'

function collector() {
  const lines: string[] = []
  return { lines, destination: { write: (chunk: string) => void lines.push(chunk) } }
}

describe('allowlisted logger', () => {
  test('writes only allowed fields with primitive values', () => {
    const { lines, destination } = collector()
    const logger = createLogger({ level: 'info', destination })
    logger.info('http.request', {
      requestId: 'req-1',
      route: '/api/me',
      status: 200,
      // Not allowed: dropped silently, whatever the caller passes.
      ...({
        authorization: 'Bearer SENTINEL',
        body: { password: 'SENTINEL' },
        url: '/x?token=SENTINEL',
      } as object),
    })
    expect(lines).toHaveLength(1)
    const record = JSON.parse(lines[0] ?? '{}')
    expect(record).toMatchObject({
      level: 'info',
      msg: 'http.request',
      requestId: 'req-1',
      route: '/api/me',
      status: 200,
    })
    expect(lines[0]).not.toContain('SENTINEL')
    expect(Object.keys(record).sort()).toEqual([
      'level',
      'msg',
      'requestId',
      'route',
      'service',
      'status',
      'time',
    ])
  })

  test('rejects free-form event names and strips control characters', () => {
    const { lines, destination } = collector()
    const logger = createLogger({ level: 'info', destination })
    logger.info('user typed: SENTINEL password', { route: 'a\nb\u0000c' })
    const record = JSON.parse(lines[0] ?? '{}')
    expect(record.msg).toBe('invalid_event')
    expect(record.route).toBe('a b c')
    expect(lines[0]).not.toContain('SENTINEL')
  })

  test('child loggers keep the filter', () => {
    const { lines, destination } = collector()
    const child = createLogger({ level: 'info', destination }).child({ requestId: 'r1' })
    child.warn('auth.denied', {
      reason: 'bad_credentials',
      ...({ email: 'SENTINEL@example.com' } as object),
    })
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      requestId: 'r1',
      reason: 'bad_credentials',
    })
    expect(lines[0]).not.toContain('SENTINEL')
  })

  test('respects the level', () => {
    const { lines, destination } = collector()
    const logger = createLogger({ level: 'warn', destination })
    logger.info('quiet')
    logger.warn('loud')
    expect(lines).toHaveLength(1)
  })
})

describe('describeError', () => {
  test('never includes the message, even when it carries submitted values', () => {
    const error = Object.assign(
      new Error('duplicate key: Key (email)=(SENTINEL@example.com) already exists.'),
      {
        code: '23505',
        constraint: 'users_email_unique',
      },
    )
    const fields = describeError(error)
    expect(fields).toMatchObject({
      errorName: 'Error',
      errorCode: '23505',
      constraint: 'users_email_unique',
    })
    expect(JSON.stringify(fields)).not.toContain('SENTINEL')
  })

  test('reads the AppError code and handles non-errors', () => {
    expect(describeError(new AppError('NOT_FOUND', 'SENTINEL missing')).errorCode).toBe('NOT_FOUND')
    expect(describeError('SENTINEL string')).toEqual({ errorName: 'string' })
  })

  test('drops values that do not look like identifiers', () => {
    const error = Object.assign(new Error('x'), {
      code: 'has spaces and SENTINEL',
      constraint: 'bad name!',
    })
    const fields = describeError(error)
    expect(fields.errorCode).toBeUndefined()
    expect(fields.constraint).toBeUndefined()
  })
})

describe('describeError with wrapped driver errors', () => {
  test('reads SQLSTATE and constraint from the cause and ignores the query/params message', () => {
    const driver = Object.assign(new Error('duplicate key value violates unique constraint'), {
      name: 'PostgresError',
      code: 'ERR_POSTGRES_SERVER_ERROR',
      errno: '23505',
      constraint: 'users_email_unique',
    })
    // Shape of Drizzle's wrapper: the message embeds the query and its parameter values.
    const wrapped = new Error(
      'Failed query: insert into users ... params: SENTINEL@example.com,SENTINEL-hash',
      {
        cause: driver,
      },
    )
    const fields = describeError(wrapped)
    expect(fields).toMatchObject({
      errorName: 'PostgresError',
      errorCode: '23505',
      constraint: 'users_email_unique',
    })
    expect(JSON.stringify(fields)).not.toContain('SENTINEL')
  })
})
