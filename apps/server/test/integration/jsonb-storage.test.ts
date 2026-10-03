import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { appSettings, auditLogs, conversations, messages, users, workItems } from '@chatapp/db'
import { eq, sql } from 'drizzle-orm'
import { writeAudit } from '../../src/domain/audit.ts'
import { enqueueWork } from '../../src/domain/work.ts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createActiveUser, makeDeps } from '../support/deps.ts'

/**
 * Drizzle's jsonb() and Bun's driver together stored every value as a jsonb string that held JSON text (D-107). These
 * tests read the stored values with SQL, because reading through Drizzle hid the problem.
 */
let dbs: TestDatabases
beforeAll(() => {
  dbs = openTestDatabases()
})
afterAll(async () => {
  await truncateAll(dbs.owner)
  await dbs.close()
})
beforeEach(async () => {
  await truncateAll(dbs.owner)
})

const COVERED = [
  'app_settings.value',
  'audit_logs.metadata',
  'conversations.settings',
  'messages.meta',
  'users.settings',
  'work_items.payload',
]

async function stored(table: string, column: string, where = 'true') {
  const rows = (await dbs.owner.db.execute(
    sql.raw(
      `select jsonb_typeof(${column}) as type, ${column}->>'b' as b, ${column}->>'role' as role from ${table} where ${where}`,
    ),
  )) as unknown as Array<{ type: string; b: string | null; role: string | null }>
  return rows
}

describe('jsonb columns hold real JSON', () => {
  test('every jsonb column of the database is covered by this file', async () => {
    const rows = (await dbs.owner.db.execute(
      sql`select table_name || '.' || column_name as name from information_schema.columns where table_schema = 'public' and data_type = 'jsonb' order by 1`,
    )) as unknown as Array<{ name: string }>
    expect(rows.map((row) => row.name)).toEqual(COVERED)
  })

  test('audit metadata written by the application is an object that SQL can read', async () => {
    await writeAudit(dbs.owner.db, {
      action: 'jsonb.test',
      metadata: { a: 1, b: 'two', role: 'admin', c: true, d: null },
    })
    expect(await stored('audit_logs', 'metadata', "action = 'jsonb.test'")).toEqual([
      { type: 'object', b: 'two', role: 'admin' },
    ])
    const [row] = await dbs.owner.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'jsonb.test'))
    expect(row?.metadata).toEqual({ a: 1, b: 'two', role: 'admin', c: true, d: null })
  })

  test('work item payloads are objects', async () => {
    const deps = makeDeps(dbs.owner.db)
    await enqueueWork(deps.db, deps, {
      kind: 'email',
      dedupeKey: 'jsonb:1',
      payload: { b: 'two', n: 3, ok: true, none: null },
    })
    expect(await stored('work_items', 'payload')).toEqual([
      { type: 'object', b: 'two', role: null },
    ])
    const [row] = await dbs.owner.db.select().from(workItems)
    expect(row?.payload).toEqual({ b: 'two', n: 3, ok: true, none: null })
  })

  test('app settings keep the type of what was written: object, string that looks like a number, number, boolean', async () => {
    const samples: Array<[string, unknown, string]> = [
      ['object', { b: 'two', version: 1, nested: { list: [1, 'x', { deep: true }] } }, 'object'],
      ['text', '123', 'string'],
      ['number', 7, 'number'],
      ['flag', true, 'boolean'],
    ]
    for (const [key, value] of samples) {
      await dbs.owner.db.insert(appSettings).values({ key, value })
    }
    for (const [key, value, type] of samples) {
      const [row] = await stored('app_settings', 'value', `key = '${key}'`)
      expect(row?.type).toBe(type)
      const [back] = await dbs.owner.db.select().from(appSettings).where(eq(appSettings.key, key))
      expect(back?.value).toEqual(value)
    }
  })

  test('updating and upserting a value keeps it a real value too', async () => {
    await dbs.owner.db.insert(appSettings).values({ key: 'k', value: { version: 1 } })
    await dbs.owner.db
      .insert(appSettings)
      .values({ key: 'k', value: { version: 2, b: 'again' } })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: { version: 2, b: 'again' } } })
    expect(await stored('app_settings', 'value', "key = 'k'")).toEqual([
      { type: 'object', b: 'again', role: null },
    ])
  })

  test('conversation settings and message meta written through Drizzle are objects SQL can read', async () => {
    const user = await createActiveUser(makeDeps(dbs.owner.db), { username: 'meta_user' })
    const [conversation] = await dbs.owner.db
      .insert(conversations)
      .values({
        // An agent conversation: the deferred owner check applies to channels and groups only.
        kind: 'agent',
        name: 'jsonb',
        ownerId: user.id,
        createdBy: user.id,
        settings: { whoCanInvite: 'admins_only', agentEnabled: false },
      })
      .returning({ id: conversations.id })
    const conversationId = conversation?.id ?? ''
    await dbs.owner.db.insert(messages).values({
      conversationId,
      seq: 1,
      changeSeq: 1,
      kind: 'system',
      executionSource: 'system',
      meta: { system: { type: 'member_left', userId: user.id } },
    })
    const settings = (await dbs.owner.db.execute(
      sql.raw(
        `select jsonb_typeof(settings) as type, settings->>'whoCanInvite' as who from conversations where id = '${conversationId}'`,
      ),
    )) as unknown as Array<{ type: string; who: string }>
    expect(settings).toEqual([{ type: 'object', who: 'admins_only' }])
    const meta = (await dbs.owner.db.execute(
      sql.raw(
        `select jsonb_typeof(meta) as type, meta->'system'->>'type' as event from messages where conversation_id = '${conversationId}'`,
      ),
    )) as unknown as Array<{ type: string; event: string }>
    expect(meta).toEqual([{ type: 'object', event: 'member_left' }])
  })

  test('user settings, whether written by the database default or by an update, are objects', async () => {
    const user = await createActiveUser(makeDeps(dbs.owner.db), { username: 'settings_user' })
    expect((await stored('users', 'settings', `id = '${user.id}'`))[0]?.type).toBe('object')
    await dbs.owner.db
      .update(users)
      .set({ settings: { b: 'dark', role: 'x' } })
      .where(eq(users.id, user.id))
    expect(await stored('users', 'settings', `id = '${user.id}'`)).toEqual([
      { type: 'object', b: 'dark', role: 'x' },
    ])
  })
})
