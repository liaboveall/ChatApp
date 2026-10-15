import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { attachmentObjects, attachments, backupRuns, deletionJournalState } from '@chatapp/db'
import { eq, sql } from 'drizzle-orm'
import {
  type BackupIO,
  createConsistentBackup,
  withPhysicalDeletion,
} from '../../src/domain/backups.ts'
import { applyDeletion } from '../../src/domain/deletion-apply.ts'
import { checkpointDeletionJournal } from '../../src/domain/deletion-checkpoint.ts'
import { dispatchDeletions } from '../../src/domain/deletion-operations.ts'
import { assertRestoreUnlocked, isolateRestoredDatabase } from '../../src/domain/restore.ts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createTestApp, type TestApp } from '../support/http.ts'
import { testJournal } from '../support/journal.ts'
import { person } from '../support/people.ts'

let dbs: TestDatabases, app: TestApp
beforeAll(() => {
  dbs = openTestDatabases()
})
afterAll(async () => {
  await truncateAll(dbs.owner)
  await dbs.close()
})
beforeEach(async () => {
  await truncateAll(dbs.owner)
  app = await createTestApp(dbs, { deps: { deletionJournal: (await testJournal()).journal } })
})
afterEach(async () => {
  await app.close()
})
function io(overrides: Partial<BackupIO> = {}): BackupIO {
  return {
    applicationSha: 'a'.repeat(40),
    keyVersions: [1],
    recoveryFiles: [{ name: 'keys.json', sha256: 'b'.repeat(64) }],
    exportDatabase: async () => ({ size: 100, sha256: 'c'.repeat(64) }),
    copyObject: async () => {},
    uploadAndVerify: async () => ({
      manifestKey: 'verified/manifest',
      manifestHash: 'd'.repeat(64),
    }),
    ...overrides,
  }
}
const backupDeps = () => ({ ...app.services.deps, db: dbs.owner.db })

test('snapshot watermark excludes a deletion committed after export; the importing connection sees the identical snapshot', async () => {
  const alice = await person(app, 'alice')
  const added = await alice.post<{ memory: { id: string } }>('/api/me/memories', {
    content: 'snapshot copy',
    allowSite: false,
  })
  const offsite = app.services.deps.deletionJournal
  app.services.deps.deletionJournal = {
    append: async () => {
      throw new Error('offsite temporarily unavailable')
    },
  }
  const pending = await alice.del(`/api/me/memories/${added.body.memory.id}`)
  expect(pending.status).toBe(202)
  app.services.deps.deletionJournal = offsite
  const manifest = await createConsistentBackup(
    backupDeps(),
    io({
      exportDatabase: async (snapshot) => {
        expect(await dispatchDeletions(app.services.deps, applyDeletion)).toBe(1)
        const result = await dbs.owner.client.begin(
          'ISOLATION LEVEL REPEATABLE READ',
          async (tx) => {
            await tx.unsafe(`set transaction snapshot '${snapshot}'`)
            return await tx`select content from agent_memories where id = ${added.body.memory.id}`
          },
        )
        expect(result[0].content).toBe('snapshot copy')
        return { size: 100, sha256: 'c'.repeat(64) }
      },
    }),
  )
  expect(manifest.journal.seq).toBe(0)
  expect((await app.services.deps.db.select().from(deletionJournalState))[0]?.appliedSeq).toBe(1)
  expect((await app.services.deps.db.select().from(backupRuns))[0]?.status).toBe('succeeded')
})

test('backup waits for an in-flight physical deletion, and new physical deletions are blocked until all copies finish', async () => {
  let release!: () => void, entered!: () => void
  const entering = new Promise<void>((resolve) => {
    entered = resolve
  })
  const deleting = withPhysicalDeletion(app.services.deps, async () => {
    entered()
    await new Promise<void>((resolve) => {
      release = resolve
    })
  })
  await entering
  let exported = false
  const backup = createConsistentBackup(
    backupDeps(),
    io({
      exportDatabase: async () => {
        exported = true
        let attempted = false
        expect(
          await withPhysicalDeletion(app.services.deps, async () => {
            attempted = true
          }),
        ).toBe(false)
        expect(attempted).toBe(false)
        return { size: 100, sha256: 'c'.repeat(64) }
      },
    }),
  )
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(exported).toBe(false)
  release()
  expect(await deleting).toBe(true)
  await backup
  expect(exported).toBe(true)
  expect(await withPhysicalDeletion(app.services.deps, async () => {})).toBe(true)
})

test('expired copy lease and a failed offsite verifier cannot declare success or hold physical deletion indefinitely', async () => {
  await expect(
    createConsistentBackup(
      backupDeps(),
      io({
        exportDatabase: async () => {
          await dbs.owner.db
            .update(backupRuns)
            .set({ leaseUntil: new Date(0) })
            .where(eq(backupRuns.status, 'copying'))
          return { size: 100, sha256: 'c'.repeat(64) }
        },
      }),
    ),
  ).rejects.toThrow('consistent backup failed')
  await expect(
    createConsistentBackup(
      backupDeps(),
      io({
        uploadAndVerify: async () => {
          throw new Error('bad restored hash')
        },
      }),
    ),
  ).rejects.toThrow('consistent backup failed')
  expect(
    (await app.services.deps.db.select().from(backupRuns)).every((run) => run.status === 'failed'),
  ).toBe(true)
  expect(await withPhysicalDeletion(app.services.deps, async () => {})).toBe(true)
})

test('a live object without a recorded checksum aborts the backup', async () => {
  const alice = await person(app, 'alice')
  const [attachment] = await app.services.deps.db
    .insert(attachments)
    .values({ uploaderId: alice.id, purpose: 'message', originalName: 'fixture' })
    .returning()
  if (!attachment) throw new Error('fixture unavailable')
  await app.services.deps.db.insert(attachmentObjects).values({
    attachmentId: attachment.id,
    generation: 1,
    variant: 'original',
    storageKey: 'att/fixture/main',
    status: 'live',
    sizeBytes: 1,
    sha256: null,
  })
  await expect(createConsistentBackup(backupDeps(), io())).rejects.toThrow(
    'consistent backup failed',
  )
})

test('restored credentials and outward work remain disabled by a durable fence even if RESTORE_MODE is omitted', async () => {
  await person(app, 'alice')
  await isolateRestoredDatabase(app.services.deps, crypto.randomUUID())
  await expect(assertRestoreUnlocked(app.services.deps.db)).rejects.toThrow('remains isolated')
  const [counts] = await dbs.owner.db.execute<{ sessions: string; usablePasswords: string }>(
    sql`select (select count(*)::text from sessions) as sessions, (select count(*)::text from accounts where password is not null) as "usablePasswords"`,
  )
  expect(counts?.sessions).toBe('0')
  expect(counts?.usablePasswords).toBe('0')
})

test('remote inventory verification excludes new backups but does not block live deletion acceptance, and a failed catalog cannot truncate the journal', async () => {
  const offsite = await testJournal()
  app.services.deps.deletionJournal = offsite.journal
  const alice = await person(app, 'alice')
  const added = await alice.post<{ memory: { id: string } }>('/api/me/memories', {
    content: 'private source',
    allowSite: false,
  })
  const manifest = await createConsistentBackup(backupDeps(), io())
  await expect(
    checkpointDeletionJournal(backupDeps(), offsite.journal, async () => {
      await expect(createConsistentBackup(backupDeps(), io())).rejects.toThrow(
        'consistent backup failed',
      )
      expect((await alice.del(`/api/me/memories/${added.body.memory.id}`)).status).toBe(200)
      throw new Error('remote catalog could not be verified')
    }),
  ).rejects.toThrow('remote catalog could not be verified')
  expect((await offsite.journal.head()).head.seq).toBe(1)
  expect((await offsite.journal.head()).head.checkpoint).toBeUndefined()
  const outcome = await checkpointDeletionJournal(backupDeps(), offsite.journal, async () => [
    { snapshotId: 'a'.repeat(64), manifest },
  ])
  expect(outcome.floor.seq).toBe(0)
  expect(outcome.deleted).toBe(0)
})
