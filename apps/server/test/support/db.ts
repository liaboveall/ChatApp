import { createDatabase, type Database } from '@chatapp/db/client'
import { sql } from 'drizzle-orm'
import { testConfig } from './env.ts'

export type TestDatabases = {
  /** The unprivileged application role: what the running server uses. */
  app: Database
  /** The owner: truncation, role checks and fixtures that need extra privileges. */
  owner: Database
  close: () => Promise<void>
}

export function openTestDatabases(): TestDatabases {
  const config = testConfig()
  if (!config.databaseOwnerUrl)
    throw new Error('DATABASE_OWNER_URL_TEST is required for integration tests')
  const app = createDatabase(config.databaseUrl, { max: 5, applicationName: 'chatapp-test-app' })
  const owner = createDatabase(config.databaseOwnerUrl, {
    max: 2,
    applicationName: 'chatapp-test-owner',
  })
  return {
    app,
    owner,
    close: async () => {
      await app.close()
      await owner.close()
    },
  }
}

/** Empties every application table (docs/08 section 4: truncate after each file). Owner connection only. */
export async function truncateAll(owner: Database): Promise<void> {
  const rows = await owner.db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  )
  if (rows.length === 0) return
  const tables = rows.map((row) => `"public"."${row.tablename}"`).join(', ')
  await owner.db.execute(sql.raw(`truncate table ${tables} restart identity cascade`))
}
