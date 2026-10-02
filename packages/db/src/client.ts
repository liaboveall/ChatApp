/**
 * Database client factory. This is the only module in packages/db that touches Bun directly (D-090): it wraps
 * Bun.SQL in Drizzle's bun-sql driver. Everything else receives a `Db` or `Tx`.
 */
import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import * as schema from './schema/index.ts'

export type Db = ReturnType<typeof drizzle<typeof schema, SQL>>
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
/** Query-building methods are shared, so most domain functions accept either. */
export type DbOrTx = Db | Tx

export type DatabaseOptions = {
  /** Pool size. */
  max?: number
  /** Shown in pg_stat_activity, so a stuck connection can be traced to a process. */
  applicationName?: string
  /** Server-side guards against runaway queries and forgotten transactions (milliseconds). */
  statementTimeoutMs?: number
  lockTimeoutMs?: number
  idleInTransactionTimeoutMs?: number
}

export type Database = {
  db: Db
  client: SQL
  close: () => Promise<void>
}

export function createDatabase(url: string, options: DatabaseOptions = {}): Database {
  const client = new SQL({
    url,
    max: options.max ?? 10,
    idleTimeout: 30,
    connectionTimeout: 10,
    connection: {
      application_name: options.applicationName ?? 'chatapp',
      statement_timeout: options.statementTimeoutMs ?? 15_000,
      lock_timeout: options.lockTimeoutMs ?? 5_000,
      idle_in_transaction_session_timeout: options.idleInTransactionTimeoutMs ?? 30_000,
      timezone: 'UTC',
    },
  })
  const db = drizzle({ client, schema, casing: 'snake_case' })
  return { db, client, close: () => client.close() }
}
