import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { DeletionOperation, MessageEnvelope } from '@chatapp/contracts'
import {
  accounts,
  agentMemories,
  agentRunStates,
  agentRuns,
  agentSteps,
  conversationMembers,
  conversations,
  deletionOperations,
  executionDelegations,
  messages,
  passkeys,
  registrationInvites,
  reminders,
  scheduledMessages,
  sessions,
  userAiKeys,
  usernameReservations,
  users,
} from '@chatapp/db'
import { and, eq } from 'drizzle-orm'
import { loadAiConfig } from '../../src/config/ai.ts'
import { createAgentRun } from '../../src/domain/agent-runs.ts'
import { applyDeletion } from '../../src/domain/deletion-apply.ts'
import { dispatchDeletions } from '../../src/domain/deletion-operations.ts'
import { ACCOUNT_DELETION_COOKIE } from '../../src/http/routes/deletions.ts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { makePrincipal } from '../support/deps.ts'
import { createTestApp, type TestApp } from '../support/http.ts'
import { testJournal } from '../support/journal.ts'
import { createConversation, openDm, type Person, person } from '../support/people.ts'

let dbs: TestDatabases, app: TestApp
let offsite: Awaited<ReturnType<typeof testJournal>>
beforeAll(() => {
  dbs = openTestDatabases()
})
afterAll(async () => {
  await truncateAll(dbs.owner)
  await dbs.close()
})
beforeEach(async () => {
  await truncateAll(dbs.owner)
  offsite = await testJournal()
  app = await createTestApp(dbs, { deps: { deletionJournal: offsite.journal } })
  const { apiKey: _, ...policy } = loadAiConfig({ APP_ENV: 'test' })
  app.services.deps.config.ai = policy
})
afterEach(async () => {
  await app.close()
})
async function remove(who: Person, password = who.password) {
  return await app.request('/api/me', { method: 'DELETE', jar: who.jar, json: { password } })
}

test('a password confirmation failure has no deletion intent or credential changes', async () => {
  const alice = await person(app, 'alice')
  expect((await remove(alice, 'wrong-password')).status).toBe(403)
  expect(await app.services.deps.db.select().from(deletionOperations)).toEqual([])
  expect((await alice.get('/api/me')).status).toBe(200)
  expect((await app.services.deps.db.select().from(accounts))[0]?.password).not.toBeNull()
})

test('pending account deletion preserves personal data, blocks late children, then atomically anonymizes and transfers groups while retaining public messages and DM membership', async () => {
  const alice = await person(app, 'alice'),
    bob = await person(app, 'bob'),
    carol = await person(app, 'carol')
  const deps = app.services.deps,
    now = deps.clock.now()
  const group = await createConversation(alice, {
    kind: 'group',
    name: 'retained group',
    memberIds: [bob.id, carol.id],
  })
  await deps.db
    .update(conversationMembers)
    .set({ role: 'admin', joinedAt: new Date(now.getTime() + 1000) })
    .where(
      and(
        eq(conversationMembers.conversationId, group.id),
        eq(conversationMembers.userId, carol.id),
      ),
    )
  const empty = await createConversation(alice, { kind: 'group', name: 'alone', memberIds: [] })
  const dm = await openDm(alice, bob)
  const sent = await alice.post<MessageEnvelope>(`/api/conversations/${group.id}/messages`, {
    clientId: crypto.randomUUID(),
    body: 'Public history remains',
  })
  expect(sent.status).toBe(201)
  expect(
    (await alice.post('/api/me/memories', { content: 'private preference', allowSite: false }))
      .status,
  ).toBe(201)
  const run = await createAgentRun(
    deps,
    await makePrincipal(deps, alice),
    {
      trigger: 'agent_chat',
      prompt: 'private request',
      mode: 'fast',
      attachmentIds: [],
      timezone: 'Asia/Shanghai',
    },
    crypto.randomUUID(),
  )
  await deps.db
    .update(agentRunStates)
    .set({ messages: [{ role: 'user', content: 'private run body' }] })
    .where(eq(agentRunStates.runId, run.id))
  await deps.db.insert(agentSteps).values({
    id: crypto.randomUUID(),
    runId: run.id,
    index: 1,
    type: 'tool_call',
    payload: { privateText: 'private step body' },
    createdAt: now,
  })
  const task = {
    userId: alice.id,
    conversationId: group.id,
    scheduledTimezone: 'Asia/Singapore',
    scheduledLocalTime: '2026-10-20T12:00',
    scheduledOffsetMinutes: 480,
    createdAt: now,
  }
  await deps.db.insert(reminders).values({
    ...task,
    id: crypto.randomUUID(),
    text: 'private reminder',
    remindAt: new Date(now.getTime() + 86_400_000),
  })
  await deps.db.insert(scheduledMessages).values({
    ...task,
    id: crypto.randomUUID(),
    body: 'private scheduled text',
    sendAt: new Date(now.getTime() + 86_400_000),
  })
  await deps.db.insert(userAiKeys).values({
    userId: alice.id,
    provider: 'deepseek',
    keyCiphertext: 'test-ciphertext',
    keyNonce: 'test-nonce',
    keyVersion: 1,
    revision: 1,
    keyLast4: 'TEST',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  })
  await deps.db.insert(passkeys).values({
    userId: alice.id,
    publicKey: 'test-public-key',
    credentialID: crypto.randomUUID(),
    counter: 0,
    deviceType: 'singleDevice',
    backedUp: false,
  })
  await deps.db.insert(registrationInvites).values({
    createdBy: alice.id,
    codeHash: 'a'.repeat(64),
    note: 'private invite note',
    maxUses: 1,
    expiresAt: new Date(now.getTime() + 86_400_000),
  })
  offsite.store.unavailable = true
  const response = await remove(alice)
  expect(response.status).toBe(202)
  const pending = (await response.json()) as DeletionOperation
  expect(((await (await remove(alice)).json()) as DeletionOperation).operationId).toBe(
    pending.operationId,
  )
  expect((await deps.db.select().from(agentMemories))[0]?.content).toBe('private preference')
  expect((await deps.db.select().from(sessions)).length).toBeGreaterThan(0)
  await expect(
    deps.db
      .insert(agentMemories)
      .values({
        id: crypto.randomUUID(),
        userId: alice.id,
        content: 'late private memory',
        source: 'user',
        createdAt: now,
      })
      .execute(),
  ).rejects.toThrow()
  await expect(
    deps.db
      .update(agentRunStates)
      .set({ messages: ['late model output'] })
      .where(eq(agentRunStates.runId, run.id))
      .execute(),
  ).rejects.toThrow()
  expect((await bob.get(pending.statusUrl)).status).toBe(404)
  offsite.store.unavailable = false
  expect(await dispatchDeletions(deps, applyDeletion)).toBe(1)
  const [deleted] = await deps.db.select().from(users).where(eq(users.id, alice.id))
  expect(deleted).toMatchObject({
    name: '已注销用户',
    bio: null,
    avatarAttachmentId: null,
    settings: {},
  })
  expect(deleted?.deletedAt).not.toBeNull()
  expect(deleted?.email).not.toBe(alice.email)
  expect(deleted?.username).toMatch(/^deleted_/)
  expect((await deps.db.select().from(usernameReservations))[0]?.username).toBe('alice')
  expect(await deps.db.select().from(accounts).where(eq(accounts.userId, alice.id))).toEqual([])
  expect(await deps.db.select().from(sessions).where(eq(sessions.userId, alice.id))).toEqual([])
  expect(await deps.db.select().from(passkeys)).toEqual([])
  expect(await deps.db.select().from(userAiKeys)).toEqual([])
  expect(await deps.db.select().from(agentMemories)).toEqual([])
  if (!run.conversationId) throw new Error('private conversation missing')
  expect(
    await deps.db.select().from(conversations).where(eq(conversations.id, run.conversationId)),
  ).toEqual([])
  expect((await deps.db.select().from(agentRuns))[0]).toMatchObject({
    status: 'cancelled',
    contextManifest: [],
  })
  expect((await deps.db.select().from(agentRunStates))[0]?.messages).toEqual([])
  expect((await deps.db.select().from(agentSteps))[0]?.payload).toBeNull()
  expect((await deps.db.select().from(reminders))[0]).toMatchObject({
    status: 'cancelled',
    text: null,
  })
  expect((await deps.db.select().from(scheduledMessages))[0]).toMatchObject({
    status: 'cancelled',
    body: null,
  })
  expect(
    (await deps.db.select().from(executionDelegations)).every((row) => row.status !== 'active'),
  ).toBe(true)
  expect((await deps.db.select().from(registrationInvites))[0]?.revokedAt).not.toBeNull()
  expect((await deps.db.select().from(registrationInvites))[0]?.note).toBeNull()
  expect(
    (await deps.db.select().from(conversations).where(eq(conversations.id, group.id)))[0]?.ownerId,
  ).toBe(carol.id)
  expect(
    (await deps.db.select().from(conversations).where(eq(conversations.id, empty.id)))[0],
  ).toMatchObject({ ownerId: null, memberCount: 0 })
  expect(
    (await deps.db.select().from(conversations).where(eq(conversations.id, empty.id)))[0]
      ?.archivedAt,
  ).not.toBeNull()
  expect(
    (
      await deps.db
        .select()
        .from(conversationMembers)
        .where(eq(conversationMembers.conversationId, dm.id))
    ).length,
  ).toBe(2)
  expect(
    (
      await bob.post(`/api/conversations/${dm.id}/messages`, {
        clientId: crypto.randomUUID(),
        body: 'cannot deliver',
      })
    ).status,
  ).toBe(403)
  expect(
    (await deps.db.select().from(messages).where(eq(messages.id, sent.body.message.id)))[0]?.body,
  ).toBe('Public history remains')
  expect((await alice.get<DeletionOperation>(pending.statusUrl)).body.status).toBe('completed')
})

test('the post-revocation receipt is scoped to one operation and restore epoch, expires, and never bypasses a different active account', async () => {
  const alice = await person(app, 'alice'),
    bob = await person(app, 'bob')
  offsite.store.unavailable = true
  const response = await remove(alice),
    pending = (await response.json()) as DeletionOperation
  const cookie = response.headers
    .getSetCookie()
    .find((line) => line.startsWith(`${ACCOUNT_DELETION_COOKIE}=`))
  expect(cookie).toContain(`Path=${pending.statusUrl}`)
  expect(cookie).toContain('HttpOnly')
  expect(cookie).toContain('SameSite=Strict')
  const receipt = alice.jar.get(ACCOUNT_DELETION_COOKIE)
  if (!receipt) throw new Error('receipt missing')
  bob.jar.set(ACCOUNT_DELETION_COOKIE, receipt)
  expect((await bob.get(pending.statusUrl)).status).toBe(404)
  offsite.store.unavailable = false
  expect(await dispatchDeletions(app.services.deps, applyDeletion)).toBe(1)
  const read = await alice.get<DeletionOperation>(pending.statusUrl)
  expect(read.status).toBe(200)
  expect(read.body.status).toBe('completed')
  expect(read.headers.getSetCookie()).toEqual([])
  expect((await alice.get(`/api/deletion-operations/${crypto.randomUUID()}`)).status).toBe(404)
  const oldEpoch = app.services.deps.config.auth.restoreEpoch
  app.services.deps.config.auth.restoreEpoch = crypto.randomUUID()
  expect((await alice.get(pending.statusUrl)).status).toBe(404)
  app.services.deps.config.auth.restoreEpoch = oldEpoch
  app.clock.advance(10 * 60_000 + 1)
  expect((await alice.get(pending.statusUrl)).status).toBe(404)
  const anonymous = await app.request(pending.statusUrl)
  expect(anonymous.status).toBe(401)
})

test('session expiry and ordinary sign-out remain possible while account content is frozen, and the receipt can still query only that pending deletion', async () => {
  const alice = await person(app, 'alice')
  await app.services.deps.db
    .update(sessions)
    .set({ expiresAt: new Date(Date.now() + 1000) })
    .where(eq(sessions.userId, alice.id))
  offsite.store.unavailable = true
  const response = await remove(alice)
  expect(response.status).toBe(202)
  const pending = (await response.json()) as DeletionOperation
  await new Promise((resolve) => setTimeout(resolve, 1100))
  expect((await alice.get<DeletionOperation>(pending.statusUrl)).body.status).toBe('pending')
  expect(
    (await app.request('/api/auth/sign-out', { jar: alice.jar, method: 'POST', json: {} })).status,
  ).toBe(200)
  expect((await alice.get<DeletionOperation>(pending.statusUrl)).body.status).toBe('pending')
  expect((await app.services.deps.db.select().from(agentMemories)).length).toBe(0)
  expect(
    (await app.services.deps.db.select().from(users).where(eq(users.id, alice.id)))[0]?.deletedAt,
  ).toBeNull()
})
