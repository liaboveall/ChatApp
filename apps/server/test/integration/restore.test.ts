import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { BackupManifest } from '@chatapp/contracts'
import {
  accounts,
  agentMemories,
  appSettings,
  deletionJournalState,
  deletionOperations,
  sessions,
  users,
} from '@chatapp/db'
import { eq } from 'drizzle-orm'
import { JOURNAL_GENESIS } from '../../src/domain/deletion-journal.ts'
import { prepareDeletion } from '../../src/domain/deletion-operations.ts'
import {
  assertRestoreUnlocked,
  isolateRestoredDatabase,
  replayDeletionJournal,
} from '../../src/domain/restore.ts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createTestApp, type TestApp } from '../support/http.ts'
import { testJournal } from '../support/journal.ts'
import { person } from '../support/people.ts'

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
  app = await createTestApp(dbs)
})
afterEach(async () => {
  await app.close()
})
const manifest = (): BackupManifest => ({
  format: 1,
  runId: crypto.randomUUID(),
  epoch: crypto.randomUUID(),
  applicationSha: 'a'.repeat(40),
  schemaHash: 'b'.repeat(64),
  snapshotAt: new Date().toISOString(),
  journal: { seq: 0, hash: JOURNAL_GENESIS },
  database: { size: 1, sha256: 'c'.repeat(64) },
  objects: [],
  keyVersions: [1],
  recoveryFiles: [{ name: 'keys.json', sha256: 'd'.repeat(64) }],
})
async function fixture() {
  const alice = await person(app, 'alice')
  const ids: string[] = []
  for (const content of ['first private memory', 'second private memory']) {
    const created = await alice.post<{ memory: { id: string } }>('/api/me/memories', {
      content,
      allowSite: false,
    })
    ids.push(created.body.memory.id)
    await offsite.journal.append({
      operationId: crypto.randomUUID(),
      actorId: alice.id,
      acceptedAt: new Date().toISOString(),
      intent: {
        action: 'memory_delete',
        target: { id: created.body.memory.id, userId: alice.id, contentVersion: 1 },
      },
    })
  }
  const epoch = crypto.randomUUID()
  await isolateRestoredDatabase(app.services.deps, epoch)
  return { ids, epoch, backup: manifest() }
}

test('an apply transaction crash resumes from the pinned manifest without reapplying earlier deletions or unlocking', async () => {
  const { ids, epoch, backup } = await fixture()
  let appliedTransactions = 0
  const actualDb = app.services.deps.db
  const faultDb = new Proxy(actualDb, {
    get(target, property, receiver) {
      if (property !== 'transaction') return Reflect.get(target, property, receiver)
      return async (
        callback: Parameters<typeof actualDb.transaction>[0],
        options?: Parameters<typeof actualDb.transaction>[1],
      ) =>
        await actualDb.transaction(async (tx) => {
          const result = await callback(tx)
          // Crash after the second apply has changed rows, before COMMIT. The database must roll back that whole intent.
          if (result === true && ++appliedTransactions === 2)
            throw new Error('synthetic apply commit crash')
          return result
        }, options)
    },
  })
  await expect(
    replayDeletionJournal({ ...app.services.deps, db: faultDb }, offsite.journal, backup, epoch),
  ).rejects.toThrow('synthetic apply commit crash')
  expect((await actualDb.select().from(deletionJournalState))[0]?.appliedSeq).toBe(1)
  expect(
    (
      await actualDb
        .select()
        .from(agentMemories)
        .where(eq(agentMemories.id, ids[1] ?? ''))
    )[0]?.content,
  ).toBe('second private memory')
  await expect(
    replayDeletionJournal(
      app.services.deps,
      offsite.journal,
      { ...backup, runId: crypto.randomUUID() },
      epoch,
    ),
  ).rejects.toThrow('resume manifest changed')
  const resumed = await replayDeletionJournal(app.services.deps, offsite.journal, backup, epoch)
  expect(resumed.replayed).toBe(1)
  expect(resumed.seq).toBe(2)
  expect(
    (await actualDb.select().from(agentMemories)).every(
      (row) => row.content === null && row.embedding === null,
    ),
  ).toBe(true)
  expect((await actualDb.select().from(deletionOperations)).length).toBe(2)
  expect(
    (await replayDeletionJournal(app.services.deps, offsite.journal, backup, epoch)).replayed,
  ).toBe(0)
  await expect(assertRestoreUnlocked(actualDb)).rejects.toThrow('remains isolated')
})

test('a corrupt suffix is rejected before any earlier valid deletion is applied', async () => {
  const { epoch, backup } = await fixture()
  const head = (await offsite.journal.head()).head
  if (!head.recordKey) throw new Error('head missing')
  offsite.store.objects.delete(head.recordKey)
  await expect(
    replayDeletionJournal(app.services.deps, offsite.journal, backup, epoch),
  ).rejects.toThrow('journal_integrity')
  expect(
    (await app.services.deps.db.select().from(agentMemories)).every((row) => row.content !== null),
  ).toBe(true)
  expect((await app.services.deps.db.select().from(deletionOperations)).length).toBe(0)
  await expect(assertRestoreUnlocked(app.services.deps.db)).rejects.toThrow('remains isolated')
})

test('a snapshot containing a frozen accepted account still revokes old credentials before replay, and isolation cannot be reset to erase resume evidence', async () => {
  const alice = await person(app, 'alice'),
    deps = app.services.deps
  const [user] = await deps.db.select().from(users).where(eq(users.id, alice.id))
  if (!user) throw new Error('account fixture missing')
  const pending = await deps.db.transaction((tx) =>
    prepareDeletion(tx, deps, alice.id, {
      action: 'account_delete',
      target: { id: alice.id, authEpoch: user.authEpoch },
    }),
  )
  const [originalSession] = await deps.db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, alice.id))
  if (!originalSession) throw new Error('session fixture missing')
  // Expiry/sign-out may reduce authority, but even a direct late writer cannot create a fresh login.
  await expect(
    deps.db
      .insert(sessions)
      .values({
        userId: alice.id,
        token: `late-${crypto.randomUUID()}`,
        authEpoch: user.authEpoch,
        authorizationOriginId: originalSession.authorizationOriginId,
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .execute(),
  ).rejects.toThrow()
  await offsite.journal.append({
    operationId: pending.id,
    actorId: alice.id,
    intent: pending.intent,
    acceptedAt: new Date().toISOString(),
  })
  const epoch = crypto.randomUUID(),
    backup = manifest()
  await isolateRestoredDatabase(deps, epoch)
  expect(await deps.db.select().from(sessions)).toEqual([])
  expect((await deps.db.select().from(accounts))[0]?.password).toBeNull()
  expect((await replayDeletionJournal(deps, offsite.journal, backup, epoch)).replayed).toBe(1)
  const [before] = await deps.db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, 'restore_state'))
  await isolateRestoredDatabase(deps, epoch)
  await expect(isolateRestoredDatabase(deps, crypto.randomUUID())).rejects.toThrow('epoch changed')
  expect(
    (await deps.db.select().from(appSettings).where(eq(appSettings.key, 'restore_state')))[0]
      ?.value,
  ).toEqual(before?.value)
  expect(
    (await deps.db.select().from(users).where(eq(users.id, alice.id)))[0]?.deletedAt,
  ).not.toBeNull()
  await expect(assertRestoreUnlocked(deps.db)).rejects.toThrow('remains isolated')
})
