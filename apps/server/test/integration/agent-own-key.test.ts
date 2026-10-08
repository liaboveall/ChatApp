/**
 * Members' own DeepSeek keys (M5a; docs/06 sections 3.1 and 14, D-080, SEC-26, A12, A15, AT-29, V-17). The provider is
 * never called: keys verify through the mock verifier (`sk-mock-…`) and runs use the mock model, which refuses a key
 * spelled `sk-mock-revoked-…` the way DeepSeek would refuse a key revoked after saving.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  agentContexts,
  agentRuns,
  aiUsageDaily,
  auditLogs,
  budgetAccounts,
  conversations,
  messages,
  userAiKeys,
  users,
} from '@chatapp/db'
import { runBootstrap } from '@chatapp/db/bootstrap'
import { and, eq } from 'drizzle-orm'
import { loadAiConfig } from '../../src/config/ai.ts'
import { adminRunDetail, listAdminRuns } from '../../src/domain/agent-admin.ts'
import { decideApproval } from '../../src/domain/agent-approvals.ts'
import { getAgentUsage } from '../../src/domain/agent-budget.ts'
import {
  claimAgentRun,
  createAgentRun,
  getAgentRun,
  regenerateAgentRun,
  switchAgentKeySource,
} from '../../src/domain/agent-runs.ts'
import { buildAgentContext, executeAgentTool } from '../../src/domain/agent-tools.ts'
import { deleteAiKey, getAiKey, saveAiKey } from '../../src/domain/ai-keys.ts'
import { createConversation } from '../../src/domain/conversations.ts'
import { sendMessage } from '../../src/domain/messages.ts'
import { createLogger } from '../../src/lib/logger.ts'
import { executeAgentRun } from '../../src/runtime/agent.ts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createActiveUser, makeDeps, makePrincipal } from '../support/deps.ts'

let dbs: TestDatabases
let deps: ReturnType<typeof makeDeps>
let alice: Awaited<ReturnType<typeof makePrincipal>>
let bob: typeof alice
const config = loadAiConfig({ APP_ENV: 'test' })
const KEY = 'sk-mock-alice-own-key-7f3a'
const logged: string[] = []

beforeAll(() => {
  dbs = openTestDatabases()
})
afterAll(async () => {
  await truncateAll(dbs.owner)
  await dbs.close()
})
beforeEach(async () => {
  await truncateAll(dbs.owner)
  logged.length = 0
  // The real logger with its redaction, writing every level into the collector.
  const log = createLogger({
    level: 'trace',
    destination: { write: (line: string) => void logged.push(line) },
  })
  deps = makeDeps(dbs.app.db, { log })
  const { apiKey: _apiKey, ...policy } = config
  deps.config.ai = policy
  await runBootstrap(deps.db, { ...deps.config.product, productName: deps.config.product.name })
  alice = await makePrincipal(deps, await createActiveUser(deps, { username: 'alice' }))
  bob = await makePrincipal(deps, await createActiveUser(deps, { username: 'bob' }))
})

async function chat(prompt: string, conversationId?: string) {
  const [user] = await deps.db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, alice.userId))
  return await createAgentRun(
    deps,
    alice,
    {
      trigger: 'agent_chat',
      prompt,
      mode: 'fast',
      attachmentIds: [],
      timezone: user?.timezone ?? 'Asia/Shanghai',
      ...(conversationId ? { conversationId } : {}),
    },
    crypto.randomUUID(),
  )
}
async function run(id: string) {
  await executeAgentRun({ deps, config }, id)
  return await getAgentRun(deps, alice, id)
}

describe('saving an own key (docs/06 section 14, V-17, SEC-26)', () => {
  test('a verified key is stored encrypted and only its last four characters are ever shown', async () => {
    const saved = await saveAiKey(deps, alice, { provider: 'deepseek', key: `  ${KEY}  ` })
    expect(saved).toMatchObject({ provider: 'deepseek', last4: '7f3a', status: 'active' })
    const [row] = await deps.db.select().from(userAiKeys).where(eq(userAiKeys.userId, alice.userId))
    expect(row?.keyCiphertext).toBeDefined()
    expect(JSON.stringify(row)).not.toContain(KEY)
    expect(JSON.stringify(await getAiKey(deps, alice))).not.toContain(KEY)
    const audits = await deps.db.select().from(auditLogs)
    expect(JSON.stringify(audits)).not.toContain(KEY)
    expect(logged.join('\n')).not.toContain(KEY)
    expect(await getAiKey(deps, bob)).toBeNull()
  })

  test('the provider verdicts become distinct answers and nothing is stored (V-17)', async () => {
    await expect(
      saveAiKey(deps, alice, { provider: 'deepseek', key: 'sk-mock-invalid-0000' }),
    ).rejects.toMatchObject({ code: 'AI_KEY_INVALID', details: { reason: 'invalid' } })
    await expect(
      saveAiKey(deps, alice, { provider: 'deepseek', key: 'sk-mock-broke-0000' }),
    ).rejects.toMatchObject({ code: 'AI_KEY_INVALID', details: { reason: 'insufficient_balance' } })
    await expect(
      saveAiKey(deps, alice, { provider: 'deepseek', key: 'sk-mock-limited-000' }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', headers: { 'Retry-After': '30' } })
    expect(await deps.db.select().from(userAiKeys)).toHaveLength(0)
  })
})

describe('runs on an own key (AT-29, D-080, A15)', () => {
  test('an own-key run is private, records usage separately and never touches the site allowance', async () => {
    await saveAiKey(deps, alice, { provider: 'deepseek', key: KEY })
    const started = await chat('私密问题 SENTINEL-OWN-1')
    expect(started).toMatchObject({ keySource: 'user', privacyClass: 'byok_private' })
    const done = await run(started.id)
    expect(done.run).toMatchObject({ status: 'completed', model: 'mock-byok' })
    const thread = await deps.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, started.conversationId ?? ''))
    expect(thread.map((m) => m.privacyClass)).toEqual(['byok_private', 'byok_private'])
    // The new conversation's title cannot carry the private prompt into site-readable lists.
    const [conversation] = await deps.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, started.conversationId ?? ''))
    expect(conversation?.name).toBe(deps.config.product.agentDisplayName)
    const accounts = await deps.db.select().from(budgetAccounts)
    expect(accounts.every((a) => a.settledUnits === 0 && a.reservedUnits === 0)).toBe(true)
    const [own] = await deps.db
      .select()
      .from(aiUsageDaily)
      .where(and(eq(aiUsageDaily.userId, alice.userId), eq(aiUsageDaily.keySource, 'user')))
    expect(own?.inputTokens).toBeGreaterThan(0)
    const usage = await getAgentUsage(deps, alice)
    expect(usage.keySource).toBe('user')
    expect(usage.own.inputTokens).toBeGreaterThan(0)
    expect(usage.daily.settled).toBe(0)
  })

  test('private own-key content never reaches a site run, neither as history nor through any tool', async () => {
    await saveAiKey(deps, alice, { provider: 'deepseek', key: KEY })
    const own = await chat('只给我看的计划 SENTINEL-PRIVATE-2')
    await run(own.id)
    const conversationId = own.conversationId ?? ''
    // Switching the same conversation to the site allowance opens a blank segment.
    const switched = await switchAgentKeySource(deps, alice, conversationId, 'site')
    expect(switched.keySource).toBe('site')
    expect(switched.contextEpoch).not.toBe(own.contextEpoch)
    const site = await chat('继续刚才的话题', conversationId)
    expect(site).toMatchObject({ keySource: 'site', privacyClass: 'standard' })
    const claim = await claimAgentRun(deps, site.id)
    if (!claim) throw new Error('not claimed')
    const context = await buildAgentContext(deps, claim.lease)
    expect(JSON.stringify(context.history)).not.toContain('SENTINEL-PRIVATE-2')
    // all_accessible widens what the person may read, not what a site run may use.
    for (const [tool, args] of [
      ['search_messages', { query: 'SENTINEL-PRIVATE-2' }],
      ['read_conversation', { conversationId }],
      ['list_conversations', {}],
    ] as const) {
      const result = await executeAgentTool(deps, claim.lease, tool, args)
      expect(JSON.stringify(result)).not.toContain('SENTINEL-PRIVATE-2')
    }
  })

  test('replacing the key stops runs on the old revision; the next request starts a new private segment', async () => {
    await saveAiKey(deps, alice, { provider: 'deepseek', key: KEY })
    const first = await chat('第一段')
    const conversationId = first.conversationId ?? ''
    await saveAiKey(deps, alice, { provider: 'deepseek', key: 'sk-mock-alice-second-9b2c' })
    const [stopped] = await deps.db.select().from(agentRuns).where(eq(agentRuns.id, first.id))
    expect(stopped).toMatchObject({ status: 'cancelled', errorCode: 'CONTEXT_CHANGED' })
    const second = await chat('第二段', conversationId)
    expect(second.keySource).toBe('user')
    expect(second.contextEpoch).not.toBe(first.contextEpoch)
    expect((await run(second.id)).run.status).toBe('completed')
  })

  test('without a usable key an own-key segment is refused, never moved to the site key silently', async () => {
    await saveAiKey(deps, alice, { provider: 'deepseek', key: KEY })
    const first = await chat('第一问')
    await run(first.id)
    const conversationId = first.conversationId ?? ''
    await deleteAiKey(deps, alice)
    await expect(chat('第二问', conversationId)).rejects.toMatchObject({ code: 'AI_KEY_INVALID' })
    const [context] = await deps.db
      .select()
      .from(agentContexts)
      .where(eq(agentContexts.conversationId, conversationId))
    expect(context?.keySource).toBe('user')
    // "Use the site allowance for a new request": an explicit, blank segment.
    await switchAgentKeySource(deps, alice, conversationId, 'site')
    const site = await chat('重新输入的第二问', conversationId)
    expect(site).toMatchObject({ keySource: 'site', privacyClass: 'standard' })
    await expect(switchAgentKeySource(deps, alice, conversationId, 'user')).rejects.toMatchObject({
      code: 'AI_KEY_INVALID',
    })
    await expect(switchAgentKeySource(deps, bob, conversationId, 'site')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  test('a key the provider refuses during a run ends it with AI_KEY_INVALID and marks that key', async () => {
    await saveAiKey(deps, alice, { provider: 'deepseek', key: 'sk-mock-revoked-after-save' })
    const started = await chat('会失败的请求')
    const done = await run(started.id)
    expect(done.run).toMatchObject({ status: 'failed', error: { code: 'AI_KEY_INVALID' } })
    expect(await getAiKey(deps, alice)).toMatchObject({
      status: 'invalid',
      invalidReason: 'invalid',
    })
    expect((await getAgentUsage(deps, alice)).keySource).toBe('site')
  })

  test('regenerating cannot switch the key: a changed source needs a new request', async () => {
    await saveAiKey(deps, alice, { provider: 'deepseek', key: KEY })
    const own = await chat('可以重新生成吗')
    await run(own.id)
    await switchAgentKeySource(deps, alice, own.conversationId ?? '', 'site')
    await expect(
      regenerateAgentRun(deps, alice, own.id, crypto.randomUUID()),
    ).rejects.toMatchObject({ code: 'CONTEXT_CHANGED' })
  })

  test('content the person approved for a group is published as an ordinary message; the run stays private', async () => {
    await saveAiKey(deps, alice, { provider: 'deepseek', key: KEY })
    const g = (
      await createConversation(
        deps,
        alice,
        { kind: 'group', name: '公开的群', memberIds: [bob.userId] },
        crypto.randomUUID(),
      )
    ).conversation
    const [user] = await deps.db
      .select({ timezone: users.timezone })
      .from(users)
      .where(eq(users.id, alice.userId))
    const panel = await createAgentRun(
      deps,
      alice,
      {
        trigger: 'panel',
        contextConversationId: g.id,
        prompt: '代发：这句可以公开 PUBLISHED-3',
        mode: 'fast',
        attachmentIds: [],
        timezone: user?.timezone ?? 'Asia/Shanghai',
      },
      crypto.randomUUID(),
    )
    expect(panel.privacyClass).toBe('byok_private')
    const approval = (await run(panel.id)).approvals[0]
    if (!approval) throw new Error('no approval')
    await decideApproval(deps, alice, approval.id, {
      decision: 'approve',
      expectedStateVersion: approval.stateVersion,
    })
    await run(panel.id)
    const [published] = await deps.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, g.id), eq(messages.senderId, alice.userId)))
    expect(published).toMatchObject({ body: '这句可以公开 PUBLISHED-3', privacyClass: 'standard' })
    // Bob's site assistant may read the published message like any other group message.
    await sendMessage(deps, bob, g.id, { clientId: crypto.randomUUID(), body: '收到' })
    const [bobUser] = await deps.db
      .select({ timezone: users.timezone })
      .from(users)
      .where(eq(users.id, bob.userId))
    const bobRun = await createAgentRun(
      deps,
      bob,
      {
        trigger: 'panel',
        contextConversationId: g.id,
        prompt: '总结一下',
        mode: 'fast',
        attachmentIds: [],
        timezone: bobUser?.timezone ?? 'Asia/Shanghai',
      },
      crypto.randomUUID(),
    )
    expect(bobRun.keySource).toBe('site')
    const claim = await claimAgentRun(deps, bobRun.id)
    if (!claim) throw new Error('not claimed')
    expect(JSON.stringify((await buildAgentContext(deps, claim.lease)).history)).toContain(
      'PUBLISHED-3',
    )
  })
})

describe('administrators see site-key run content only (INV-15, A7, D-034)', () => {
  test('a site run shows its content to an administrator, an own-key run only its metadata; both are audited', async () => {
    const admin = await makePrincipal(
      deps,
      await createActiveUser(deps, { username: 'root_admin', role: 'admin' }),
    )
    const site = await chat('站点请求 SITE-VISIBLE-4')
    await run(site.id)
    await saveAiKey(deps, alice, { provider: 'deepseek', key: KEY })
    const own = await chat('自带 key 的请求 OWN-HIDDEN-5')
    await run(own.id)
    await expect(adminRunDetail(deps, alice, site.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(listAdminRuns(deps, bob, { limit: 50 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    const visible = await adminRunDetail(deps, admin, site.id)
    expect(visible.content.available).toBe('site_key')
    expect(JSON.stringify(visible)).toContain('SITE-VISIBLE-4')
    const hidden = await adminRunDetail(deps, admin, own.id)
    expect(hidden.content).toEqual({ available: 'own_key' })
    expect(JSON.stringify(hidden)).not.toContain('OWN-HIDDEN-5')
    const audits = await deps.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'admin.agent_run_viewed'))
    expect(audits.map((a) => a.targetId).sort()).toEqual([site.id, own.id].sort())
    const listed = await listAdminRuns(deps, admin, { keySource: 'user', limit: 50 })
    expect(listed.runs.map((r) => r.id)).toEqual([own.id])
    expect(JSON.stringify(listed)).not.toContain('OWN-HIDDEN-5')
  })
})
