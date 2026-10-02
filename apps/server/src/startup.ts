/** Start-up self-checks shared by the API and the worker: refuse to run against a database that is not ready or too privileged. */

import type { Db } from '@chatapp/db'
import { isBootstrapped } from '@chatapp/db/bootstrap'
import { sql } from 'drizzle-orm'
import type { Config } from './config/index.ts'
import type { Logger } from './lib/logger.ts'

export async function assertDatabaseReady(db: Db, config: Config, log: Logger): Promise<void> {
  if (!(await isBootstrapped(db))) {
    throw new Error(
      'database is not bootstrapped: run `bun run db:migrate` and `bun run db:bootstrap`',
    )
  }
  const rows = await db.execute<{ privileged: boolean }>(
    sql`select (rolsuper or rolcreatedb or rolcreaterole or rolbypassrls) as privileged from pg_roles where rolname = current_user`,
  )
  if (rows[0]?.privileged) {
    // docs/04: the running application uses an unprivileged role; migrations use the owner.
    if (config.env === 'production')
      throw new Error('DATABASE_URL must use an unprivileged role in production')
    log.warn('startup.privileged_database_role', { reason: 'DATABASE_URL role is privileged' })
  }
}

/** Debounced "work was committed" hint on the bus; losing it only delays dispatch until the next periodic scan. */
export function createWaker(publish: () => Promise<void>, delayMs = 20): () => void {
  let pending = false
  return () => {
    if (pending) return
    pending = true
    setTimeout(() => {
      pending = false
      publish().catch(() => undefined)
    }, delayMs)
  }
}
