/**
 * Runs the committed SQL migrations with the owner account (docs/04 section 9). A session-level advisory lock on
 * a dedicated single connection serializes concurrent runs, so two deploy steps cannot apply a migration twice.
 */
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createDatabase } from './client.ts'
import { applyAppGrants, ensureAppRole } from './roles.ts'

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url))

/** Arbitrary constant shared by every migrator ("chatapp" as a number). */
const MIGRATION_LOCK_KEY = 0x63686174

export type MigrateOptions = {
  ownerUrl: string
  /** When set, the unprivileged application role is created/updated and granted access after migrating. */
  appRole?: { role: string; password: string }
}

export async function runMigrations(options: MigrateOptions): Promise<void> {
  const { db, close } = createDatabase(options.ownerUrl, {
    max: 1,
    applicationName: 'chatapp-migrate',
    statementTimeoutMs: 120_000,
    lockTimeoutMs: 30_000,
  })
  try {
    await db.execute(sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`)
    try {
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
      if (options.appRole) {
        await ensureAppRole(db, options.appRole)
        await applyAppGrants(db, { role: options.appRole.role })
      }
    } finally {
      await db.execute(sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`)
    }
  } finally {
    await close()
  }
}
