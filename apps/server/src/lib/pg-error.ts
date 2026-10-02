/**
 * Reading PostgreSQL errors without depending on the driver's class. Drizzle wraps the driver error in an error whose
 * message embeds the failed query *and its parameter values*, so the message must never be logged or returned; the
 * SQLSTATE and constraint name live on the wrapped cause.
 */

export type PgErrorInfo = {
  /** Five-character SQLSTATE, for example 23505 (unique_violation). */
  sqlState?: string
  constraint?: string
}

const SQLSTATE = /^[0-9A-Z]{5}$/
const IDENTIFIER = /^[A-Za-z0-9_.-]{1,80}$/

export const SQLSTATE_UNIQUE_VIOLATION = '23505'
export const SQLSTATE_FOREIGN_KEY_VIOLATION = '23503'
export const SQLSTATE_CHECK_VIOLATION = '23514'
export const SQLSTATE_SERIALIZATION_FAILURE = '40001'
export const SQLSTATE_DEADLOCK = '40P01'
export const SQLSTATE_LOCK_NOT_AVAILABLE = '55P03'
export const SQLSTATE_QUERY_CANCELED = '57014'

/** Walks the `cause` chain (depth-limited) and returns the first SQLSTATE/constraint found. */
export function pgErrorInfo(error: unknown): PgErrorInfo | undefined {
  const info: PgErrorInfo = {}
  let current: unknown = error
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const record = current as Error & { code?: unknown; errno?: unknown; constraint?: unknown }
    for (const candidate of [record.errno, record.code]) {
      if (
        info.sqlState === undefined &&
        typeof candidate === 'string' &&
        SQLSTATE.test(candidate)
      ) {
        info.sqlState = candidate
      }
    }
    if (
      info.constraint === undefined &&
      typeof record.constraint === 'string' &&
      IDENTIFIER.test(record.constraint)
    ) {
      info.constraint = record.constraint
    }
    current = record.cause
  }
  return info.sqlState === undefined && info.constraint === undefined ? undefined : info
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const info = pgErrorInfo(error)
  return (
    info?.sqlState === SQLSTATE_UNIQUE_VIOLATION &&
    (constraint === undefined || info.constraint === constraint)
  )
}

/** Deadlocks and serialization failures are safe to retry the whole transaction (docs/03 section 5.1). */
export function isRetryableTransactionError(error: unknown): boolean {
  const state = pgErrorInfo(error)?.sqlState
  return state === SQLSTATE_DEADLOCK || state === SQLSTATE_SERIALIZATION_FAILURE
}
