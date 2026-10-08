import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  agentConversationState,
  agentMemories,
  appSettings,
  attachments,
  auditLogs,
  conversations,
  messages,
  users,
  workItems,
} from '@chatapp/db'
import { runBootstrap } from '@chatapp/db/bootstrap'
import { eq, sql } from 'drizzle-orm'
import { loadAiConfig } from '../../src/config/ai.ts'
import { decideApproval } from '../../src/domain/agent-approvals.ts'
import { createAgentRun, getAgentRun } from '../../src/domain/agent-runs.ts'
import { writeAudit } from '../../src/domain/audit.ts'
import { createConversation } from '../../src/domain/conversations.ts'
import { addMemory } from '../../src/domain/memories.ts'
import { enqueueWork } from '../../src/domain/work.ts'
import { executeAgentRun } from '../../src/runtime/agent.ts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createActiveUser, makeDeps, makePrincipal } from '../support/deps.ts'

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
  'agent_approvals.args',
  'agent_approvals.edited_args',
  'agent_approvals.final_args',
  'agent_conversation_state.source_manifest',
  'agent_effects.result',
  'agent_memories.source_manifest',
  'agent_run_states.messages',
  'agent_runs.context_manifest',
  'agent_steps.payload',
  'app_settings.value',
  'attachments.variants',
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

  test('Agent manifests, resumable state and actual tool steps retain arrays and nested objects in SQL', async () => {
    const deps = makeDeps(dbs.app.db)
    await runBootstrap(deps.db, { ...deps.config.product, productName: deps.config.product.name })
    const user = await createActiveUser(deps, { username: 'jsonbagent' })
    const principal = await makePrincipal(deps, user)
    const [profile] = await deps.db.select().from(users).where(eq(users.id, user.id))
    const run = await createAgentRun(
      deps,
      principal,
      {
        trigger: 'agent_chat',
        prompt: '读取可见消息',
        mode: 'fast',
        attachmentIds: [],
        timezone: profile?.timezone ?? 'Asia/Singapore',
      },
      deps.newId(),
    )
    await executeAgentRun({ deps, config: loadAiConfig({ APP_ENV: 'test' }) }, run.id)
    const manifest = await deps.db.execute(sql`select jsonb_typeof(context_manifest) as root,
      jsonb_typeof(context_manifest->0) as item, context_manifest->0->>'type' as type from agent_runs`)
    expect(manifest).toEqual([{ root: 'array', item: 'object', type: 'conversation' }])
    const state = await deps.db.execute(sql`select jsonb_typeof(messages) as root,
      jsonb_typeof(messages->0) as item, messages->0->>'role' as role from agent_run_states`)
    expect(state).toEqual([{ root: 'array', item: 'object', role: 'user' }])
    const steps = await deps.db.execute(sql`select jsonb_typeof(payload) as root,
      jsonb_typeof(payload->'arguments') as args from agent_steps where type = 'tool_call'`)
    expect(steps).toEqual([{ root: 'object', args: 'object' }])
  })

  test('approval arguments, frozen arguments and effect results are objects, and appended history stays an array', async () => {
    const deps = makeDeps(dbs.app.db)
    await runBootstrap(deps.db, { ...deps.config.product, productName: deps.config.product.name })
    const owner = await makePrincipal(
      deps,
      await createActiveUser(deps, { username: 'jsonbowner' }),
    )
    const peer = await createActiveUser(deps, { username: 'jsonbpeer' })
    const [profile] = await deps.db.select().from(users).where(eq(users.id, owner.userId))
    const { conversation } = await createConversation(
      deps,
      owner,
      { kind: 'group', name: 'jsonb', memberIds: [peer.id] },
      deps.newId(),
    )
    const run = await createAgentRun(
      deps,
      owner,
      {
        trigger: 'panel',
        contextConversationId: conversation.id,
        prompt: '代发：jsonb 原文',
        mode: 'fast',
        attachmentIds: [],
        timezone: profile?.timezone ?? 'Asia/Shanghai',
      },
      deps.newId(),
    )
    const config = loadAiConfig({ APP_ENV: 'test' })
    await executeAgentRun({ deps, config }, run.id)
    const [approval] = (await getAgentRun(deps, owner, run.id)).approvals
    if (!approval) throw new Error('no approval')
    await decideApproval(deps, owner, approval.id, {
      decision: 'approve',
      editedArgs: { body: 'jsonb 修改' },
      expectedStateVersion: approval.stateVersion,
    })
    await executeAgentRun({ deps, config }, run.id)
    const approvals = await deps.db.execute(sql`select jsonb_typeof(args) as args,
      jsonb_typeof(edited_args) as edited, jsonb_typeof(final_args) as final, final_args->>'body' as body
      from agent_approvals`)
    expect(approvals).toEqual([
      { args: 'object', edited: 'object', final: 'object', body: 'jsonb 修改' },
    ])
    const effects = await deps.db.execute(
      sql`select jsonb_typeof(result) as type, result->>'status' as status from agent_effects`,
    )
    expect(effects).toEqual([{ type: 'object', status: 'sent' }])
    const state = await deps.db.execute(sql`select jsonb_typeof(messages) as root,
      jsonb_typeof(messages->-1) as last from agent_run_states where run_id = ${run.id}`)
    expect(state).toEqual([{ root: 'array', last: 'object' }])
  })
  test('memory and summary provenance are JSON arrays with queryable source objects', async () => {
    const deps = makeDeps(dbs.app.db)
    await runBootstrap(deps.db, { ...deps.config.product, productName: deps.config.product.name })
    const owner = await makePrincipal(
      deps,
      await createActiveUser(deps, { username: 'jsonbmemory' }),
    )
    const run = await createAgentRun(
      deps,
      owner,
      {
        trigger: 'agent_chat',
        prompt: '记住：我的偏好',
        mode: 'fast',
        attachmentIds: [],
        timezone: 'Asia/Shanghai',
      },
      deps.newId(),
    )
    await executeAgentRun({ deps, config: loadAiConfig({ APP_ENV: 'test' }) }, run.id)
    const manifest = await deps.db.execute(sql`select jsonb_typeof(source_manifest) as root,
      jsonb_typeof(source_manifest->0) as item, source_manifest->0->>'type' as type from agent_memories`)
    expect(manifest).toEqual([{ root: 'array', item: 'object', type: 'conversation' }])
    const manual = await addMemory(deps, owner, { content: '手动偏好', allowSite: false })
    expect(
      await deps.db.execute(
        sql`select jsonb_typeof(source_manifest) as root from agent_memories where id=${manual.id}`,
      ),
    ).toEqual([{ root: 'array' }])
    const [saved] = await deps.db
      .select()
      .from(agentMemories)
      .where(eq(agentMemories.createdByRunId, run.id))
    if (!saved || !run.conversationId) throw new Error('missing memory')
    await deps.db.insert(agentConversationState).values({
      conversationId: run.conversationId,
      contextEpoch: run.contextEpoch,
      keySource: 'site',
      privacyClass: 'standard',
      summary: '摘要',
      sourceManifest: saved.sourceManifest,
      summarizedThroughSeq: 1,
      expiresAt: new Date(deps.clock.now().getTime() + 1000),
      updatedAt: deps.clock.now(),
    })
    expect(
      await deps.db.execute(sql`select jsonb_typeof(source_manifest) as root,
      jsonb_typeof(source_manifest->0) as item, source_manifest->0->>'type' as type from agent_conversation_state`),
    ).toEqual([{ root: 'array', item: 'object', type: 'conversation' }])
  })

  test('attachment variant maps are JSON objects with nested numeric dimensions', async () => {
    const user = await createActiveUser(makeDeps(dbs.owner.db), { username: 'jsonbmedia' })
    await dbs.owner.db.insert(attachments).values({
      id: crypto.randomUUID(),
      uploaderId: user.id,
      purpose: 'message',
      originalName: 'file',
      storageKey: crypto.randomUUID(),
      variants: { thumb: { key: 't', w: 30, h: 20, mime: 'image/webp' } },
    })
    const result = await dbs.owner.db.execute(
      sql`select jsonb_typeof(variants) as type, jsonb_typeof(variants->'thumb'->'w') as width from attachments`,
    )
    expect(result).toEqual([{ type: 'object', width: 'number' }])
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
