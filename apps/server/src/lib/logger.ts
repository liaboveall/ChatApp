/**
 * Logging with an allowlist (D-077, SEC-19, docs/03 section 9). pino writes the records, but application code can
 * only hand it the fields listed in ALLOWED, with primitive values: request/response objects, headers, URLs, error
 * messages and bodies have no way in. Error details come from `describeError`, which never reads `message`.
 */
import pino, { type DestinationStream } from 'pino'
import { pgErrorInfo } from './pg-error.ts'

const ALLOWED = [
  'requestId',
  'route',
  'method',
  'status',
  'durationMs',
  'ip',
  'userId',
  'conversationId',
  'runId',
  'workId',
  'kind',
  'queue',
  'jobId',
  'attempt',
  'count',
  'reason',
  'errorName',
  'errorCode',
  'constraint',
  'stackFrames',
  'connectionId',
  'closeCode',
] as const

export type AllowedField = (typeof ALLOWED)[number]
export type LogFields = { [K in AllowedField]?: string | number | boolean | null }

const ALLOWED_SET: ReadonlySet<string> = new Set(ALLOWED)
const EVENT = /^[a-z0-9][a-z0-9_.:-]{0,63}$/i
const MAX_VALUE_LENGTH = 300
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the purpose.
const CONTROL = /[\u0000-\u001f\u007f]/g

export interface Logger {
  debug(event: string, fields?: LogFields): void
  info(event: string, fields?: LogFields): void
  warn(event: string, fields?: LogFields): void
  error(event: string, fields?: LogFields): void
  child(fields: LogFields): Logger
}

function clean(fields: LogFields | undefined): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {}
  if (!fields) return out
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_SET.has(key) || value === undefined) continue
    if (typeof value === 'string') out[key] = value.replace(CONTROL, ' ').slice(0, MAX_VALUE_LENGTH)
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null)
      out[key] = value
  }
  return out
}

function wrap(base: pino.Logger): Logger {
  const emit =
    (level: 'debug' | 'info' | 'warn' | 'error') => (event: string, fields?: LogFields) => {
      base[level](clean(fields), EVENT.test(event) ? event : 'invalid_event')
    }
  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    child: (fields) => wrap(base.child(clean(fields))),
  }
}

export type LoggerOptions = {
  level: pino.LevelWithSilent
  service?: string
  /** Defaults to stdout; tests pass a collector. */
  destination?: DestinationStream
}

export function createLogger(options: LoggerOptions): Logger {
  const base = pino(
    {
      level: options.level,
      base: { service: options.service ?? 'api' },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
    },
    options.destination,
  )
  return wrap(base)
}

export const silentLogger: Logger = createLogger({ level: 'silent' })

const IDENTIFIER = /^[A-Za-z0-9_.-]{1,64}$/

/**
 * Safe description of an unknown error: its class, a short machine code (AppError code, SQLSTATE, SDK code), the
 * violated constraint name, and the stack frames. The message is deliberately not read, because messages from the
 * database and from parsers can contain submitted values (for example `Key (email)=(…) already exists`, or Drizzle's
 * "Failed query … params: …").
 */
export function describeError(error: unknown): LogFields {
  if (!(error instanceof Error)) return { errorName: typeof error }
  // Name: the first class in the cause chain that is more specific than a plain Error.
  let name = 'Error'
  let code: string | undefined
  for (let current: unknown = error, depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (name === 'Error' && IDENTIFIER.test(current.name)) name = current.name
    const candidate = (current as { code?: unknown }).code
    if (code === undefined && typeof candidate === 'string' && IDENTIFIER.test(candidate))
      code = candidate
    current = (current as { cause?: unknown }).cause
  }
  const pg = pgErrorInfo(error)
  const fields: LogFields = { errorName: name }
  const errorCode = pg?.sqlState ?? code
  if (errorCode !== undefined) fields.errorCode = errorCode
  if (pg?.constraint !== undefined) fields.constraint = pg.constraint
  const frames = (error.stack ?? '')
    .split('\n')
    .filter((line) => /^\s*at /.test(line))
    .slice(0, 8)
    .map((line) => line.trim())
  if (frames.length > 0) fields.stackFrames = frames.join(' | ')
  return fields
}
