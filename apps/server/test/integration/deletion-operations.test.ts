import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { DeletionOperation, MessageEnvelope, Upload } from '@chatapp/contracts'
import {
  agentMemories,
  attachmentObjects,
  attachments,
  backupRuns,
  deletionJournalState,
  deletionOperations,
  messages,
  sessions,
  users,
} from '@chatapp/db'
import { createDatabase } from '@chatapp/db/client'
import { eq, sql } from 'drizzle-orm'
import { loadAiConfig } from '../../src/config/ai.ts'
import { createAgentRun } from '../../src/domain/agent-runs.ts'
import { cleanupAttachments, processAttachment } from '../../src/domain/attachment-processing.ts'
import { withPhysicalDeletion } from '../../src/domain/backups.ts'
import { applyDeletion } from '../../src/domain/deletion-apply.ts'
import { JOURNAL_GENESIS } from '../../src/domain/deletion-journal.ts'
import { dispatchDeletions, prepareDeletion } from '../../src/domain/deletion-operations.ts'
import { claimReadyWork } from '../../src/domain/work-queue.ts'
import { createBlobStore } from '../../src/storage/s3.ts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { makePrincipal } from '../support/deps.ts'
import { testConfig } from '../support/env.ts'
import { createTestApp, type TestApp } from '../support/http.ts'
import { testJournal } from '../support/journal.ts'
import { createConversation, person } from '../support/people.ts'

let dbs: TestDatabases
let app: TestApp
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
})
afterEach(async () => {
  for (const object of await dbs.owner.db.select().from(attachmentObjects))
    await app.services.deps.blobs?.delete(object.storageKey)
  await app.close()
})

async function setupMessage() {
  const alice = await person(app, 'alice')
  const bob = await person(app, 'bob')
  const group = await createConversation(alice, {
    kind: 'group',
    name: 'journal',
    memberIds: [bob.id],
  })
  const result = await alice.post<MessageEnvelope>(`/api/conversations/${group.id}/messages`, {
    clientId: crypto.randomUUID(),
    body: 'original survives until acceptance',
  })
  expect(result.status).toBe(201)
  return { alice, bob, message: result.body.message }
}

test('offsite unavailable returns 202, repeated request keeps its operation, frozen body stays visible and other users see only 404', async () => {
  const { alice, bob, message } = await setupMessage()
  offsite.store.unavailable = true
  const pending = await alice.post<DeletionOperation>(`/api/messages/${message.id}/recall`, {})
  expect(pending.status).toBe(202)
  expect(pending.body.status).toBe('pending')
  const duplicate = await alice.post<DeletionOperation>(`/api/messages/${message.id}/recall`, {})
  expect(duplicate.body.operationId).toBe(pending.body.operationId)
  expect((await bob.get<MessageEnvelope>(`/api/messages/${message.id}`)).body.message.body).toBe(
    message.body,
  )
  expect(
    (
      await alice.patch(`/api/messages/${message.id}`, {
        body: 'new body',
        expectedChangeSeq: message.changeSeq,
      })
    ).status,
  ).toBe(409)
  const denied = await bob.get(pending.body.statusUrl)
  const missing = await bob.get(`/api/deletion-operations/${crypto.randomUUID()}`)
  expect(denied.status).toBe(404)
  expect(denied.body).toMatchObject({
    error: { code: 'NOT_FOUND', message: 'Deletion operation not found' },
  })
  expect(missing.body).toMatchObject({
    error: { code: 'NOT_FOUND', message: 'Deletion operation not found' },
  })
  expect(JSON.stringify((await alice.get(pending.body.statusUrl)).body)).not.toContain(message.body)
  expect((await app.services.deps.db.select().from(deletionOperations)).length).toBe(1)
})

test('after session expiry the immutable authorized intent completes, one tombstone change and the watermark commit together', async () => {
  const { alice, bob, message } = await setupMessage()
  offsite.store.unavailable = true
  expect((await alice.post(`/api/messages/${message.id}/recall`, {})).status).toBe(202)
  await app.services.deps.db.delete(sessions).where(eq(sessions.userId, alice.id))
  offsite.store.unavailable = false
  expect(await dispatchDeletions(app.services.deps, applyDeletion)).toBe(1)
  const recalled = (await bob.get<MessageEnvelope>(`/api/messages/${message.id}`)).body.message
  expect(recalled.body).toBeNull()
  expect(recalled.recalledAt).not.toBeNull()
  expect(await dispatchDeletions(app.services.deps, applyDeletion)).toBe(0)
  const [state] = await app.services.deps.db.select().from(deletionJournalState)
  expect(state?.appliedSeq).toBe(1)
  expect(state?.appliedHash).toBe((await offsite.journal.head()).head.hash)
  expect((await offsite.journal.readSince({ seq: 0, hash: JOURNAL_GENESIS })).length).toBe(1)
})

test('lost answer after real offsite acceptance leaves prepared and retries the same operation exactly once', async () => {
  const { alice, message } = await setupMessage()
  let first = true
  app.services.deps.deletionJournal = {
    append: async (input) => {
      const accepted = await offsite.journal.append(input)
      if (first) {
        first = false
        throw new Error('crash after head accepted before local journaled')
      }
      return accepted
    },
  }
  const pending = await alice.post<DeletionOperation>(`/api/messages/${message.id}/recall`, {})
  expect(pending.status).toBe(202)
  expect((await app.services.deps.db.select().from(deletionOperations))[0]?.status).toBe('prepared')
  expect(
    (await app.services.deps.db.select().from(messages).where(eq(messages.id, message.id)))[0]
      ?.body,
  ).toBe(message.body)
  expect(await dispatchDeletions(app.services.deps, applyDeletion)).toBe(1)
  expect((await alice.get<DeletionOperation>(pending.body.statusUrl)).body.status).toBe('completed')
  expect((await offsite.journal.head()).head.seq).toBe(1)
})

test('database rejects late direct writers even when they bypass the HTTP edit helper', async () => {
  const { alice, message } = await setupMessage()
  offsite.store.unavailable = true
  await alice.post(`/api/messages/${message.id}/recall`, {})
  await expect(
    app.services.deps.db
      .update(messages)
      .set({ body: 'late asynchronous overwrite' })
      .where(eq(messages.id, message.id))
      .execute(),
  ).rejects.toThrow()
  expect(
    (await app.services.deps.db.select().from(messages).where(eq(messages.id, message.id)))[0]
      ?.body,
  ).toBe(message.body)
})

test('memory removal waits for offsite acceptance and a frozen memory cannot change consent or vectors', async () => {
  const alice = await person(app, 'alice')
  const added = await alice.post<{ memory: { id: string; contentVersion: number } }>(
    '/api/me/memories',
    { content: 'memory stays private', allowSite: false },
  )
  expect(added.status).toBe(201)
  offsite.store.unavailable = true
  const pending = await alice.del<DeletionOperation>(`/api/me/memories/${added.body.memory.id}`)
  expect(pending.status).toBe(202)
  expect(
    (
      await alice.patch(`/api/me/memories/${added.body.memory.id}`, {
        allowSite: true,
        expectedContentVersion: added.body.memory.contentVersion,
      })
    ).status,
  ).toBe(409)
  offsite.store.unavailable = false
  await dispatchDeletions(app.services.deps, applyDeletion)
  const [memory] = await app.services.deps.db
    .select()
    .from(agentMemories)
    .where(eq(agentMemories.id, added.body.memory.id))
  expect(memory?.content).toBeNull()
  expect(memory?.embedding).toBeNull()
  expect(memory?.deletedAt).not.toBeNull()
})

test('applied sequence two cannot advance a backup watermark across unfinished sequence one', async () => {
  const alice = await person(app, 'alice')
  const prepare = async (id: string) =>
    await app.services.deps.db.transaction(
      async (tx) =>
        await prepareDeletion(tx, app.services.deps, alice.id, {
          action: 'memory_delete',
          target: { id, userId: alice.id, contentVersion: 1 },
        }),
    )
  const one = await prepare(crypto.randomUUID())
  const two = await prepare(crypto.randomUUID())
  await dispatchDeletions(
    app.services.deps,
    async () => {
      throw new Error('application crash')
    },
    one.id,
  )
  expect(await dispatchDeletions(app.services.deps, applyDeletion, two.id)).toBe(1)
  expect((await app.services.deps.db.select().from(deletionJournalState))[0]?.appliedSeq).toBe(0)
  expect(await dispatchDeletions(app.services.deps, applyDeletion, one.id)).toBe(1)
  expect((await app.services.deps.db.select().from(deletionJournalState))[0]?.appliedSeq).toBe(2)
  const failedReplay = await dbs.owner.db.execute<{ count: string }>(
    sql`select count(*)::text as count from deletion_locks`,
  )
  expect(failedReplay[0]?.count).toBe('0')
})

async function readyFile() {
  const alice = await person(app, 'alice')
  const reservation = await alice.post<Upload>(
    '/api/uploads/reservations',
    { purpose: 'message', name: 'private.txt', declaredSize: 3 },
    { 'Idempotency-Key': crypto.randomUUID() },
  )
  expect(reservation.status).toBe(200)
  const attachmentId = reservation.body.attachmentId
  if (!attachmentId) throw new Error('attachment missing')
  const response = await app.request(`/api/uploads/${reservation.body.uploadId}/content`, {
    method: 'PUT',
    jar: alice.jar,
    body: new TextEncoder().encode('abc'),
    headers: { 'Content-Type': 'application/octet-stream' },
  })
  expect(response.status).toBe(200)
  const [work] = await claimReadyWork(app.services.deps, { limit: 1, kinds: ['media'] })
  if (!work) throw new Error('media work missing')
  expect(
    await processAttachment(app.services.deps, { id: work.id, leaseEpoch: work.leaseEpoch }),
  ).toBe('ready')
  return { alice, upload: reservation.body, attachmentId }
}
test('cancelling a ready upload waits for the journal, blocks rebinding, and releases quota only after acceptance', async () => {
  const { alice, upload, attachmentId } = await readyFile()
  offsite.store.unavailable = true
  const pending = await alice.del<DeletionOperation>(`/api/uploads/${upload.uploadId}`)
  expect(pending.status).toBe(202)
  expect(
    (await alice.del<DeletionOperation>(`/api/uploads/${upload.uploadId}`)).body.operationId,
  ).toBe(pending.body.operationId)
  expect(
    (
      await app.services.deps.db.select().from(attachments).where(eq(attachments.id, attachmentId))
    )[0]?.status,
  ).toBe('ready')
  expect(
    (await app.services.deps.db.select().from(users).where(eq(users.id, alice.id)))[0]
      ?.storageUsedBytes,
  ).toBe(3)
  await expect(
    dbs.owner.db
      .update(users)
      .set({ avatarAttachmentId: attachmentId })
      .where(eq(users.id, alice.id))
      .execute(),
  ).rejects.toThrow('Failed query')
  offsite.store.unavailable = false
  expect(await dispatchDeletions(app.services.deps, applyDeletion)).toBe(1)
  expect((await alice.get<DeletionOperation>(pending.body.statusUrl)).body.status).toBe('completed')
  expect(
    (
      await app.services.deps.db.select().from(attachments).where(eq(attachments.id, attachmentId))
    )[0]?.status,
  ).toBe('deleting')
  expect(
    (await app.services.deps.db.select().from(users).where(eq(users.id, alice.id)))[0]
      ?.storageUsedBytes,
  ).toBe(0)
})
test('orphan cleanup journals a system intent and cannot erase a live object during an offsite outage', async () => {
  const { alice, attachmentId } = await readyFile()
  app.clock.advance(25 * 60 * 60_000)
  offsite.store.unavailable = true
  await cleanupAttachments(app.services.deps)
  const [pending] = await app.services.deps.db.select().from(deletionOperations)
  expect(pending?.actorId).toBeNull()
  expect(pending?.status).toBe('prepared')
  const [object] = await app.services.deps.db.select().from(attachmentObjects)
  expect(object?.status).toBe('live')
  expect(object ? await app.services.deps.blobs?.stat(object.storageKey) : null).not.toBeNull()
  offsite.store.unavailable = false
  expect(await dispatchDeletions(app.services.deps, applyDeletion)).toBe(1)
  expect(
    (
      await app.services.deps.db.select().from(attachments).where(eq(attachments.id, attachmentId))
    )[0]?.status,
  ).toBe('deleting')
  expect(
    (await app.services.deps.db.select().from(users).where(eq(users.id, alice.id)))[0]
      ?.storageUsedBytes,
  ).toBe(0)
})

test('overlapping broad and source deletions cannot create a frozen dependency cycle during an offsite outage', async () => {
  const alice = await person(app, 'alice'),
    bob = await person(app, 'bob'),
    deps = app.services.deps
  const { apiKey: _, ...policy } = loadAiConfig({ APP_ENV: 'test' })
  deps.config.ai = policy
  const run = await createAgentRun(
    deps,
    await makePrincipal(deps, alice),
    {
      trigger: 'agent_chat',
      prompt: 'private context',
      mode: 'fast',
      attachmentIds: [],
      timezone: 'Asia/Shanghai',
    },
    crypto.randomUUID(),
  )
  if (!run.conversationId) throw new Error('private conversation missing')
  const memory = await alice.post<{ memory: { id: string } }>('/api/me/memories', {
    content: 'old source',
    allowSite: false,
  })
  const other = await bob.post<{ memory: { id: string } }>('/api/me/memories', {
    content: 'other source',
    allowSite: false,
  })
  offsite.store.unavailable = true
  expect((await alice.del(`/api/me/memories/${memory.body.memory.id}`)).status).toBe(202)
  const broad = await alice.del(`/api/conversations/${run.conversationId}`)
  expect(broad.status).toBe(409)
  expect(broad.body).toMatchObject({ error: { details: { reason: 'deletion_busy' } } })
  offsite.store.unavailable = false
  expect(await dispatchDeletions(deps, applyDeletion)).toBe(1)
  offsite.store.unavailable = true
  const pending = await alice.del<DeletionOperation>(`/api/conversations/${run.conversationId}`)
  expect(pending.status).toBe(202)
  expect((await bob.del(`/api/me/memories/${other.body.memory.id}`)).status).toBe(409)
  expect(
    (
      await app.request('/api/me', {
        jar: bob.jar,
        method: 'DELETE',
        json: { password: bob.password },
      })
    ).status,
  ).toBe(409)
  expect((await deps.db.select().from(deletionOperations)).length).toBe(2)
  offsite.store.unavailable = false
  expect(await dispatchDeletions(deps, applyDeletion)).toBe(1)
  expect((await bob.del(`/api/me/memories/${other.body.memory.id}`)).status).toBe(200)
})

test('physical cleanup uses a single guarded connection, defers during a live backup lease and resumes after expiry without nesting barrier transactions', async () => {
  const { alice, upload } = await readyFile()
  expect((await alice.del(`/api/uploads/${upload.uploadId}`)).status).toBe(200)
  const [object] = await app.services.deps.db.select().from(attachmentObjects)
  if (!object) throw new Error('object missing')
  await app.services.deps.db
    .update(attachmentObjects)
    .set({ deleteAfter: app.clock.now() })
    .where(eq(attachmentObjects.id, object.id))
  const backupId = crypto.randomUUID()
  await app.services.deps.db.insert(backupRuns).values({
    id: backupId,
    epoch: crypto.randomUUID(),
    status: 'copying',
    startedAt: app.clock.now(),
    leaseUntil: new Date(app.clock.now().getTime() + 60_000),
  })
  const config = testConfig(),
    small = createDatabase(config.databaseUrl, {
      max: 1,
      applicationName: 'chatapp-m7-cleanup-single-connection',
    })
  const blobs = createBlobStore(config.s3, {
    physicalDeletion: (remove) => withPhysicalDeletion({ db: small.db }, remove),
  })
  try {
    const deps = { ...app.services.deps, db: small.db, blobs }
    expect((await cleanupAttachments(deps)).deleted).toBe(0)
    expect(await blobs.stat(object.storageKey)).not.toBeNull()
    await app.services.deps.db
      .update(backupRuns)
      .set({ leaseUntil: new Date(0) })
      .where(eq(backupRuns.id, backupId))
    expect((await cleanupAttachments(deps)).deleted).toBe(1)
    expect(await blobs.stat(object.storageKey)).toBeNull()
  } finally {
    await small.close()
  }
})
