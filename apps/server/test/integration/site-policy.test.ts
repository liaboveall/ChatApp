import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import {
  clientSiteLimitsSchema,
  SITE_LIMIT_DEFAULTS,
  type SiteLimits,
  siteSettingsUpdateSchema,
} from '@chatapp/contracts'
import { appSettings, conversationInvites, siteStorage, uploadReservations } from '@chatapp/db'
import { eq } from 'drizzle-orm'
import { loadAiConfig } from '../../src/config/ai.ts'
import { createAgentLedger } from '../../src/domain/agent-budget.ts'
import { claimAgentRun, createAgentRun, heartbeatAgentRun } from '../../src/domain/agent-runs.ts'
import {
  acceptConversationInvite,
  createConversationInvite,
} from '../../src/domain/conversation-invites.ts'
import { createConversation, joinConversation } from '../../src/domain/conversations.ts'
import { addConversationMembers } from '../../src/domain/members.ts'
import { editMessage, recallMessage, sendMessage } from '../../src/domain/messages.ts'
import { adminSettings, updateAdminSettings } from '../../src/domain/site-admin.ts'
import { assertTaskCapacity } from '../../src/domain/tasks.ts'
import { reserveUpload } from '../../src/domain/uploads.ts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { makePrincipal } from '../support/deps.ts'
import { createTestApp, type TestApp } from '../support/http.ts'
import { person } from '../support/people.ts'

let dbs: TestDatabases, app: TestApp
beforeAll(() => {
  dbs = openTestDatabases()
})
beforeEach(async () => {
  await truncateAll(dbs.owner)
  app = await createTestApp(dbs)
})
afterEach(async () => {
  await app.close()
})
afterAll(async () => {
  await truncateAll(dbs.owner)
  await dbs.close()
})
const deps = () => app.services.deps
async function operator() {
  const user = await person(app, 'policymanager', { role: 'admin' })
  return await makePrincipal(deps(), user, { role: 'admin' })
}
async function change(limits: Partial<SiteLimits>) {
  const principal = await operator(),
    old = await adminSettings(deps(), principal)
  return await updateAdminSettings(
    deps(),
    principal,
    {
      expectedVersion: old.version,
      policy: { ...old.policy, limits: { ...old.policy.limits, ...limits } },
    },
    crypto.randomUUID(),
  )
}
test('old stored policies gain defaults; only authenticated users can read the bounded client policy', async () => {
  await dbs.owner.db.insert(appSettings).values({
    key: 'site.policy',
    value: { runContentDays: 7, userDailyTokens: 5, monthlyMicroUsd: 3, aiPaused: false },
  })
  const p = await operator(),
    old = await adminSettings(deps(), p)
  expect(old.policy.limits).toEqual(SITE_LIMIT_DEFAULTS)
  expect((await app.request('/api/site-limits')).status).toBe(401)
  const member = await person(app, 'policyreader')
  const response = await member.get('/api/site-limits')
  expect(response.status).toBe(200)
  expect(Object.keys(clientSiteLimitsSchema.parse(response.body)).sort()).toEqual([
    'fileBytes',
    'imageBytes',
    'messageEditWindowMs',
    'messageRecallWindowMs',
  ])
  expect((await member.get('/api/admin/settings')).status).toBe(403)
})
test('settings atomically preserve used/reserved storage and legacy updates cannot reset tighter limits', async () => {
  const p = await operator(),
    old = await adminSettings(deps(), p)
  await dbs.owner.db
    .insert(siteStorage)
    .values({ id: 1, budgetBytes: 100, usedBytes: 12, reservedBytes: 8 })
    .onConflictDoUpdate({
      target: siteStorage.id,
      set: { budgetBytes: 100, usedBytes: 12, reservedBytes: 8 },
    })
  const input = {
    expectedVersion: old.version,
    storageBudgetBytes: 5,
    policy: { ...old.policy, limits: { ...old.policy.limits, uploadsPerHour: 1 } },
  }
  const k = crypto.randomUUID(),
    saved = await updateAdminSettings(deps(), p, input, k)
  expect(await updateAdminSettings(deps(), p, input, k)).toEqual(saved)
  expect(saved.storageBudgetBytes).toBe(5)
  expect((await dbs.owner.db.select().from(siteStorage))[0]).toMatchObject({
    usedBytes: 12,
    reservedBytes: 8,
    budgetBytes: 5,
  })
  const { limits: _limits, ...legacyPolicy } = saved.policy
  const next = await updateAdminSettings(
    deps(),
    p,
    { expectedVersion: saved.version, policy: legacyPolicy },
    crypto.randomUUID(),
  )
  expect(next.policy.limits.uploadsPerHour).toBe(1)
  expect(next.storageBudgetBytes).toBe(5)
  expect(
    siteSettingsUpdateSchema.safeParse({
      ...input,
      policy: { ...input.policy, limits: { ...input.policy.limits, fileBytes: 101 * 1024 * 1024 } },
    }).success,
  ).toBe(false)
  expect(
    siteSettingsUpdateSchema.safeParse({
      ...input,
      policy: {
        ...input.policy,
        limits: { ...input.policy.limits, fileBytes: 10, imageBytes: 11 },
      },
    }).success,
  ).toBe(false)
})
test('custom edit and recall windows are enforced at mutation; the recall grace remains exactly five seconds', async () => {
  await change({ messageEditWindowMs: 1000, messageRecallWindowMs: 1000 })
  const a = await person(app, 'policywriter'),
    b = await person(app, 'policypeer'),
    p = await makePrincipal(deps(), a)
  const group = await createConversation(
    deps(),
    p,
    { kind: 'group', name: 'Policy windows', memberIds: [b.id] },
    crypto.randomUUID(),
  )
  const one = (
    await sendMessage(deps(), p, group.conversation.id, {
      clientId: crypto.randomUUID(),
      body: 'First',
    })
  ).envelope.message
  const two = (
    await sendMessage(deps(), p, group.conversation.id, {
      clientId: crypto.randomUUID(),
      body: 'Second',
    })
  ).envelope.message
  app.clock.advance(1001)
  await expect(
    editMessage(deps(), p, one.id, { body: 'Changed', expectedChangeSeq: one.changeSeq }),
  ).rejects.toMatchObject({ code: 'WINDOW_EXPIRED', details: { windowMs: 1000 } })
  expect((await recallMessage(deps(), p, one.id)).message.recalledAt).not.toBeNull()
  app.clock.advance(5000)
  await expect(recallMessage(deps(), p, two.id)).rejects.toMatchObject({
    code: 'WINDOW_EXPIRED',
    details: { windowMs: 1000 },
  })
  expect((await recallMessage(deps(), p, one.id)).message.recalledAt).not.toBeNull()
})
test('creation applies current group size and account membership bounds without partial effects', async () => {
  await change({ groupMemberLimit: 2, maxConversationsPerUser: 1 })
  const a = await person(app, 'policywriter'),
    b = await person(app, 'policypeer'),
    c = await person(app, 'policythird'),
    p = await makePrincipal(deps(), a)
  await expect(
    createConversation(
      deps(),
      p,
      { kind: 'group', name: 'Too many', memberIds: [b.id, c.id] },
      crypto.randomUUID(),
    ),
  ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED', details: { resource: 'members', limit: 2 } })
  await createConversation(
    deps(),
    p,
    { kind: 'group', name: 'One place', memberIds: [b.id] },
    crypto.randomUUID(),
  )
  await expect(
    createConversation(
      deps(),
      p,
      { kind: 'group', name: 'Another', memberIds: [c.id] },
      crypto.randomUUID(),
    ),
  ).rejects.toMatchObject({
    code: 'QUOTA_EXCEEDED',
    details: { resource: 'conversations', limit: 1 },
  })
  expect((await a.get('/api/conversations')).status).toBe(200)
})
test('reservation replay preserves its image policy; new uploads and HTTP admission follow tighter limits', async () => {
  const saved = await change({ fileBytes: 4096, imageBytes: 2048, uploadsPerHour: 1 })
  const member = await person(app, 'policyuploader'),
    p = await makePrincipal(deps(), member),
    k = crypto.randomUUID()
  const input = { purpose: 'message' as const, name: 'sample.bin', declaredSize: 4096 }
  const reserved = await reserveUpload(deps(), p, input, k)
  await expect(
    reserveUpload(deps(), p, { ...input, declaredSize: 4097 }, crypto.randomUUID()),
  ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' })
  const admin = await person(app, 'policyupdater', { role: 'admin' }),
    manager = await makePrincipal(deps(), admin, { role: 'admin' })
  await updateAdminSettings(
    deps(),
    manager,
    {
      expectedVersion: saved.version,
      policy: { ...saved.policy, limits: { ...saved.policy.limits, imageBytes: 1024 } },
    },
    crypto.randomUUID(),
  )
  expect(
    (
      await dbs.owner.db
        .select()
        .from(uploadReservations)
        .where(eq(uploadReservations.id, reserved.uploadId))
    )[0]?.imageMaxBytes,
  ).toBe(2048)
  expect((await reserveUpload(deps(), p, input, k)).uploadId).toBe(reserved.uploadId)
  const post = () =>
    member.post(
      '/api/uploads/reservations',
      { ...input, declaredSize: 1024 },
      { 'Idempotency-Key': crypto.randomUUID() },
    )
  expect((await post()).status).toBe(200)
  expect((await post()).status).toBe(429)
})
test('lower membership limits protect direct additions, channel joins and invitation consumption without evicting members', async () => {
  const a = await person(app, 'policyowner'),
    b = await person(app, 'policyexisting'),
    c = await person(app, 'policynewcomer'),
    owner = await makePrincipal(deps(), a),
    newcomer = await makePrincipal(deps(), c)
  const group = await createConversation(
    deps(),
    owner,
    { kind: 'group', name: 'Existing group', memberIds: [b.id] },
    crypto.randomUUID(),
  )
  const invite = await createConversationInvite(deps(), owner, group.conversation.id, {
    maxUses: 1,
  })
  const full = await createConversation(
    deps(),
    owner,
    { kind: 'channel', name: 'Full channel', memberIds: [b.id] },
    crypto.randomUUID(),
  )
  const first = await createConversation(
    deps(),
    owner,
    { kind: 'channel', name: 'First admission', memberIds: [] },
    crypto.randomUUID(),
  )
  const second = await createConversation(
    deps(),
    owner,
    { kind: 'channel', name: 'Second admission', memberIds: [] },
    crypto.randomUUID(),
  )
  await change({ groupMemberLimit: 2, channelMemberLimit: 2, maxConversationsPerUser: 1 })
  expect((await b.get(`/api/conversations/${group.conversation.id}`)).status).toBe(200)
  expect(
    await addConversationMembers(deps(), owner, group.conversation.id, { userIds: [c.id] }),
  ).toMatchObject({ added: [], skipped: [{ userId: c.id, reason: 'limit_reached' }] })
  await expect(acceptConversationInvite(deps(), newcomer, invite.code)).rejects.toMatchObject({
    code: 'QUOTA_EXCEEDED',
    details: { resource: 'members', limit: 2 },
  })
  expect((await dbs.owner.db.select().from(conversationInvites))[0]?.useCount).toBe(0)
  await expect(joinConversation(deps(), newcomer, full.conversation.id)).rejects.toMatchObject({
    code: 'QUOTA_EXCEEDED',
    details: { resource: 'members', limit: 2 },
  })
  expect((await joinConversation(deps(), newcomer, first.conversation.id)).id).toBe(
    first.conversation.id,
  )
  await expect(joinConversation(deps(), newcomer, second.conversation.id)).rejects.toMatchObject({
    code: 'QUOTA_EXCEEDED',
    details: { resource: 'conversations', limit: 1 },
  })
})
test('HTTP messages use both current frequency limits and a zero upload limit stops new reservations', async () => {
  await change({ messageRateConversationLimit: 1, messageRateUserLimit: 2, uploadsPerHour: 0 })
  const member = await person(app, 'policyratelimit'),
    principal = await makePrincipal(deps(), member)
  const rooms = []
  for (let i = 0; i < 3; i++)
    rooms.push(
      (
        await createConversation(
          deps(),
          principal,
          { kind: 'group', name: `Rate room ${i}`, memberIds: [] },
          crypto.randomUUID(),
        )
      ).conversation.id,
    )
  const send = (id: string) =>
    member.post(`/api/conversations/${id}/messages`, {
      clientId: crypto.randomUUID(),
      body: 'Policy limited message',
    })
  expect((await send(rooms[0] ?? '')).status).toBe(201)
  expect((await send(rooms[0] ?? '')).status).toBe(429)
  // Denied attempts also consume the account-wide window, preserving the existing abuse admission contract.
  expect((await send(rooms[1] ?? '')).status).toBe(429)
  expect((await send(rooms[2] ?? '')).status).toBe(429)
  expect(
    (
      await member.post(
        '/api/uploads/reservations',
        {
          purpose: 'message',
          name: 'blocked.bin',
          declaredSize: 1,
        },
        { 'Idempotency-Key': crypto.randomUUID() },
      )
    ).status,
  ).toBe(429)
  expect(await dbs.owner.db.select().from(uploadReservations)).toHaveLength(0)
})
test('zero future-task capacity, custom AI step count and active runtime duration reject before new effects', async () => {
  await change({ maxFutureTasksPerUser: 0, fastSteps: 1, fastDurationMs: 1000 })
  const member = await person(app, 'policyagent'),
    p = await makePrincipal(deps(), member)
  await expect(assertTaskCapacity(deps().db, deps(), member.id)).rejects.toMatchObject({
    code: 'QUOTA_EXCEEDED',
    details: { resource: 'tasks', limit: 0 },
  })
  const room = await createConversation(
    deps(),
    p,
    { kind: 'group', name: 'Agent policy', memberIds: [] },
    crypto.randomUUID(),
  )
  const run = await createAgentRun(
    deps(),
    p,
    {
      trigger: 'panel',
      contextConversationId: room.conversation.id,
      prompt: 'Explain this task',
      mode: 'fast',
      timezone: 'Asia/Shanghai',
      attachmentIds: [],
    },
    crypto.randomUUID(),
  )
  const claimed = await claimAgentRun(deps(), run.id)
  if (!claimed) throw new Error('agent lease missing')
  const ai = loadAiConfig({ APP_ENV: 'test' }),
    ledger = createAgentLedger(deps(), claimed.lease, 1, ai.prices.fast)
  await expect(
    ledger.reserve({
      id: crypto.randomUUID(),
      label: 'policy-boundary',
      model: run.model,
      price: ai.prices.fast,
      inputTokenBound: 1,
      maxOutputTokens: 1,
    }),
  ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
  app.clock.advance(1000)
  await expect(heartbeatAgentRun(deps(), claimed.lease)).rejects.toMatchObject({
    code: 'QUOTA_EXCEEDED',
  })
})
