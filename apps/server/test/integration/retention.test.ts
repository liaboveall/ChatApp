import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import {
  agentConversationState,
  agentRunStates,
  agentRuns,
  agentSteps,
  attachmentObjects,
  attachments,
  deletionOperations,
  reminders,
  siteStorage,
  uploadReservations,
  users,
} from '@chatapp/db'
import { eq } from 'drizzle-orm'
import { loadAiConfig } from '../../src/config/ai.ts'
import { createAgentRun } from '../../src/domain/agent-runs.ts'
import { applyDeletion } from '../../src/domain/deletion-apply.ts'
import { JOURNAL_GENESIS } from '../../src/domain/deletion-journal.ts'
import { dispatchDeletions } from '../../src/domain/deletion-operations.ts'
import { isolateRestoredDatabase, replayDeletionJournal } from '../../src/domain/restore.ts'
import { prepareRetention } from '../../src/domain/retention.ts'
import { adminSettings, updateAdminSettings } from '../../src/domain/site-admin.ts'
import { sha256Hex } from '../../src/lib/crypto.ts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { makePrincipal } from '../support/deps.ts'
import { createTestApp, type TestApp } from '../support/http.ts'
import { testJournal } from '../support/journal.ts'
import { person } from '../support/people.ts'

let dbs: TestDatabases, app: TestApp
let offsite: Awaited<ReturnType<typeof testJournal>>
let fixtureKeys: string[] = []
beforeAll(() => {
  dbs = openTestDatabases()
})
afterAll(async () => {
  await truncateAll(dbs.owner)
  await dbs.close()
})
beforeEach(async () => {
  fixtureKeys = []
  await truncateAll(dbs.owner)
  offsite = await testJournal()
  app = await createTestApp(dbs, { deps: { deletionJournal: offsite.journal } })
  const { apiKey: _, ...policy } = loadAiConfig({ APP_ENV: 'test' })
  app.services.deps.config.ai = policy
})
afterEach(async () => {
  for (const key of fixtureKeys) await app.services.deps.blobs?.delete(key)
  await app.close()
})

test('shortening policy within one cleanup interval creates a distinct frozen journal intent and does not rewrite the old rule', async () => {
  const admin = await person(app, 'policyadmin', { role: 'admin' }),
    deps = app.services.deps
  const principal = await makePrincipal(deps, admin, { role: 'admin' })
  await prepareRetention(deps)
  await dispatchDeletions(deps, applyDeletion)
  const before = await deps.db.select().from(deletionOperations)
  expect(before).toHaveLength(1)
  const policy = await adminSettings(deps, principal)
  await updateAdminSettings(
    deps,
    principal,
    { expectedVersion: policy.version, policy: { ...policy.policy, runContentDays: 1 } },
    crypto.randomUUID(),
  )
  await prepareRetention(deps)
  const after = await deps.db.select().from(deletionOperations)
  expect(after).toHaveLength(2)
  expect(after.find((row) => row.id === before[0]?.id)?.intent).toEqual(before[0]?.intent)
  const next = after.find((row) => row.id !== before[0]?.id)
  const original = before[0]?.intent
  if (original?.action !== 'retention' || original.target.ruleVersion !== 2)
    throw new Error('expected frozen v2 retention')
  expect(next?.intent).toEqual({
    action: 'retention',
    target: { ...original.target, runContentDays: 1 },
  })
  await dispatchDeletions(deps, applyDeletion)
  await prepareRetention(deps)
  expect(await deps.db.select().from(deletionOperations)).toHaveLength(2)
  expect((await offsite.journal.head()).head.seq).toBe(2)
})

test('isolated recovery applies current attachment expiry without emitting a new journal record, refunds only the expired orphan and keeps live/avatar references', async () => {
  const alice = await person(app, 'alice'),
    deps = app.services.deps,
    now = deps.clock.now()
  const created: string[] = []
  for (const [index, age] of [2 * 86_400_000, 0, 2 * 86_400_000].entries()) {
    const bytes = new TextEncoder().encode('abc'),
      key = `att/${crypto.randomUUID()}/main`
    fixtureKeys.push(key)
    await deps.blobs?.put(key, new Blob([bytes]).stream())
    const [file] = await deps.db
      .insert(attachments)
      .values({
        uploaderId: alice.id,
        originalName: 'expiry.txt',
        purpose: index === 2 ? 'avatar' : 'message',
        status: 'processing',
        storageKey: key,
        sha256: sha256Hex(bytes),
        sizeBytes: 3,
        chargedBytes: 3,
        createdAt: new Date(now.getTime() - age),
      })
      .returning()
    if (!file) throw new Error('attachment missing')
    await deps.db.insert(uploadReservations).values({
      attachmentId: file.id,
      userId: alice.id,
      idempotencyKey: crypto.randomUUID(),
      requestHash: 'a'.repeat(64),
      maxBytes: 3,
      status: 'settled',
      expiresAt: new Date(now.getTime() + 86_400_000),
    })
    await deps.db.insert(attachmentObjects).values({
      attachmentId: file.id,
      generation: 1,
      variant: 'original',
      storageKey: key,
      sizeBytes: 3,
      sha256: sha256Hex(bytes),
      status: 'live',
      accounted: true,
    })
    await deps.db.update(attachments).set({ status: 'ready' }).where(eq(attachments.id, file.id))
    created.push(file.id)
  }
  const [expired, live, avatar] = created
  if (!expired || !live || !avatar) throw new Error('fixture missing')
  await deps.db
    .update(users)
    .set({ storageUsedBytes: 9, avatarAttachmentId: avatar })
    .where(eq(users.id, alice.id))
  await deps.db
    .insert(siteStorage)
    .values({ id: 1, usedBytes: 9 })
    .onConflictDoUpdate({ target: siteStorage.id, set: { usedBytes: 9 } })
  const epoch = crypto.randomUUID()
  await isolateRestoredDatabase(deps, epoch)
  // Recovery has no producer or outgoing worker. Current rule evaluation is local and remains behind the durable fence.
  const isolatedDeps = { ...deps, deletionJournal: undefined }
  await replayDeletionJournal(
    isolatedDeps,
    offsite.journal,
    {
      format: 1,
      runId: crypto.randomUUID(),
      epoch: crypto.randomUUID(),
      applicationSha: 'a'.repeat(40),
      schemaHash: 'b'.repeat(64),
      snapshotAt: now.toISOString(),
      journal: { seq: 0, hash: JOURNAL_GENESIS },
      database: { size: 1, sha256: 'c'.repeat(64) },
      objects: [],
      keyVersions: [1],
      recoveryFiles: [{ name: 'keys.json', sha256: 'd'.repeat(64) }],
    },
    epoch,
  )
  expect(
    (await deps.db.select().from(attachments).where(eq(attachments.id, expired)))[0]?.status,
  ).toBe('deleting')
  expect(
    (await deps.db.select().from(attachments).where(eq(attachments.id, live)))[0]?.status,
  ).toBe('ready')
  expect(
    (await deps.db.select().from(attachments).where(eq(attachments.id, avatar)))[0]?.status,
  ).toBe('ready')
  expect(
    (await deps.db.select().from(users).where(eq(users.id, alice.id)))[0]?.storageUsedBytes,
  ).toBe(6)
  expect((await offsite.journal.head()).head.seq).toBe(0)
  expect(await deps.db.select().from(deletionOperations)).toEqual([])
})

test('expiry retains private run and task content during an offsite outage, then clears only expired content and fences active old runs', async () => {
  const alice = await person(app, 'alice'),
    deps = app.services.deps
  const now = deps.clock.now(),
    old = new Date(now.getTime() - 31 * 86_400_000)
  const principal = await makePrincipal(deps, alice)
  const run = await createAgentRun(
    deps,
    principal,
    {
      trigger: 'agent_chat',
      prompt: 'old private request',
      mode: 'fast',
      attachmentIds: [],
      timezone: 'Asia/Shanghai',
    },
    crypto.randomUUID(),
  )
  const fresh = await createAgentRun(
    deps,
    principal,
    {
      trigger: 'agent_chat',
      prompt: 'fresh private request',
      mode: 'fast',
      attachmentIds: [],
      timezone: 'Asia/Shanghai',
    },
    crypto.randomUUID(),
  )
  if (!run.conversationId) throw new Error('private conversation missing')
  await deps.db.update(agentRuns).set({ createdAt: old }).where(eq(agentRuns.id, run.id))
  await deps.db
    .update(agentRunStates)
    .set({ messages: ['old private model state'] })
    .where(eq(agentRunStates.runId, run.id))
  await deps.db
    .update(agentRunStates)
    .set({ messages: ['fresh private model state'] })
    .where(eq(agentRunStates.runId, fresh.id))
  await deps.db.insert(agentSteps).values({
    id: crypto.randomUUID(),
    runId: run.id,
    index: 1,
    type: 'model',
    payload: 'old private step',
    createdAt: old,
  })
  await deps.db.insert(agentConversationState).values({
    conversationId: run.conversationId,
    contextEpoch: run.contextEpoch,
    keySource: 'site',
    privacyClass: 'standard',
    summary: 'old private summary',
    sourceManifest: [],
    summarizedThroughSeq: 0,
    expiresAt: old,
    updatedAt: old,
  })
  const oldTask = crypto.randomUUID(),
    liveTask = crypto.randomUUID()
  await deps.db.insert(reminders).values([
    {
      id: oldTask,
      userId: alice.id,
      text: 'expired delivered reminder',
      status: 'sent',
      remindAt: old,
      scheduledTimezone: 'Asia/Shanghai',
      scheduledLocalTime: '2026-09-01T12:00',
      scheduledOffsetMinutes: 480,
      createdAt: old,
      finishedAt: old,
    },
    {
      id: liveTask,
      userId: alice.id,
      text: 'keep the authorized future task',
      remindAt: new Date(now.getTime() + 86_400_000),
      scheduledTimezone: 'Asia/Shanghai',
      scheduledLocalTime: '2026-10-20T12:00',
      scheduledOffsetMinutes: 480,
      createdAt: now,
    },
  ])
  offsite.store.unavailable = true
  await prepareRetention(deps)
  await prepareRetention(deps)
  expect((await deps.db.select().from(deletionOperations)).length).toBe(1)
  expect(await dispatchDeletions(deps, applyDeletion)).toBe(0)
  expect(
    (await deps.db.select().from(agentRunStates).where(eq(agentRunStates.runId, run.id)))[0]
      ?.messages,
  ).toEqual(['old private model state'])
  expect(
    (await deps.db.select().from(reminders).where(eq(reminders.id, oldTask)))[0]?.text,
  ).not.toBeNull()
  offsite.store.unavailable = false
  expect(await dispatchDeletions(deps, applyDeletion)).toBe(1)
  expect((await deps.db.select().from(agentRuns).where(eq(agentRuns.id, run.id)))[0]).toMatchObject(
    { status: 'failed', errorCode: 'CONTENT_EXPIRED', contextManifest: [], leaseUntil: null },
  )
  expect(
    (await deps.db.select().from(agentRunStates).where(eq(agentRunStates.runId, run.id)))[0]
      ?.messages,
  ).toEqual([])
  expect((await deps.db.select().from(agentSteps))[0]?.payload).toBeNull()
  expect(await deps.db.select().from(agentConversationState)).toEqual([])
  expect(
    (await deps.db.select().from(reminders).where(eq(reminders.id, oldTask)))[0]?.text,
  ).toBeNull()
  expect(
    (await deps.db.select().from(reminders).where(eq(reminders.id, liveTask)))[0],
  ).toMatchObject({ status: 'scheduled', text: 'keep the authorized future task' })
  expect(
    (await deps.db.select().from(agentRunStates).where(eq(agentRunStates.runId, fresh.id)))[0]
      ?.messages,
  ).toEqual(['fresh private model state'])
  expect(await dispatchDeletions(deps, applyDeletion)).toBe(0)
})
