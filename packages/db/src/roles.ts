/**
 * Owner/application role split (docs/04 conventions). Migrations and bootstrap run as the owner; the running
 * application connects as an unprivileged role that can read and write rows but cannot change the schema,
 * truncate tables or create roles. Statements are rendered by PostgreSQL's own `format()` so identifiers and the
 * password literal are quoted by the server.
 */
import { sql } from 'drizzle-orm'
import type { Db } from './client.ts'

export type AppRoleOptions = {
  role: string
  password: string
}

async function render(db: Db, template: string, ...args: string[]): Promise<string> {
  const placeholders = args.map((arg) => sql`${arg}::text`)
  const rows = await db.execute<{ stmt: string }>(
    sql`select format(${template}, ${sql.join(placeholders, sql`, `)}) as stmt`,
  )
  const stmt = rows[0]?.stmt
  if (!stmt) throw new Error('format() returned nothing')
  return stmt
}

async function run(db: Db, template: string, ...args: string[]): Promise<void> {
  await db.execute(sql.raw(await render(db, template, ...args)))
}

/** Creates the application role, or resets its password. Safe to repeat. */
export async function ensureAppRole(db: Db, options: AppRoleOptions): Promise<void> {
  const { role, password } = options
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) throw new Error(`invalid role name: ${role}`)
  const exists = await db.execute<{ present: boolean }>(
    sql`select exists(select 1 from pg_roles where rolname = ${role}) as present`,
  )
  const template = exists[0]?.present
    ? 'alter role %I with login nosuperuser nocreatedb nocreaterole noreplication nobypassrls password %L'
    : 'create role %I with login nosuperuser nocreatedb nocreaterole noreplication nobypassrls password %L'
  await run(db, template, role, password)
}

/**
 * Grants the application role data access to every current and future table and sequence of the owner.
 * Run after each migration batch; default privileges also cover tables created by later migrations.
 */
export async function applyAppGrants(db: Db, options: { role: string }): Promise<void> {
  const { role } = options
  await run(db, 'grant connect on database %I to %I', await currentDatabase(db), role)
  await run(db, 'grant usage on schema public to %I', role)
  await run(db, 'grant select, insert, update, delete on all tables in schema public to %I', role)
  await run(db, 'grant usage, select on all sequences in schema public to %I', role)
  const owner = await currentUser(db)
  await run(
    db,
    'alter default privileges for role %I in schema public grant select, insert, update, delete on tables to %I',
    owner,
    role,
  )
  await run(
    db,
    'alter default privileges for role %I in schema public grant usage, select on sequences to %I',
    owner,
    role,
  )
}

async function currentDatabase(db: Db): Promise<string> {
  const rows = await db.execute<{ name: string }>(sql`select current_database() as name`)
  const name = rows[0]?.name
  if (!name) throw new Error('current_database() returned nothing')
  return name
}

async function currentUser(db: Db): Promise<string> {
  const rows = await db.execute<{ name: string }>(sql`select current_user as name`)
  const name = rows[0]?.name
  if (!name) throw new Error('current_user returned nothing')
  return name
}
