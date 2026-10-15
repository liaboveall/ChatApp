import { afterAll, beforeAll, expect, test } from 'bun:test'
import { attachmentObjects, conversationMembers, conversations, messages } from '@chatapp/db'
import { and, eq } from 'drizzle-orm'
import { createAuth } from '../../src/auth/better-auth.ts'
import { seedBenchmark } from '../../src/domain/benchmark.ts'
import { operationsHealth } from '../../src/domain/operations-health.ts'
import { sha256Hex } from '../../src/lib/crypto.ts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createTestApp, type TestApp } from '../support/http.ts'
import { testJournal } from '../support/journal.ts'

let dbs: TestDatabases, app: TestApp
const ownedKeys: string[] = []
beforeAll(async () => {
  dbs = openTestDatabases()
  await truncateAll(dbs.owner)
  app = await createTestApp(dbs)
})
afterAll(async () => {
  for (const key of ownedKeys) await app.services.deps.blobs?.delete(key)
  await app.close()
  await truncateAll(dbs.owner)
  await dbs.close()
})
test('the smoke dataset has real memberships, valid log floors and verified object bytes; repeating a run never creates duplicates', async () => {
  const deps = app.services.deps,
    runId = crypto.randomUUID()
  const port = {
    passwordHash: await deps.passwords.hash('public-benchmark-password'),
    putObject: async (key: string, size: number) => {
      const data = new Uint8Array(size).fill(37)
      ownedKeys.push(key)
      expect(await deps.blobs?.put(key, new Blob([data]).stream())).toBe(size)
      return { size, sha256: sha256Hex(data) }
    },
    progress: () => {},
  }
  const seeded = await seedBenchmark(deps, runId, 'smoke', port)
  expect(seeded.dataset).toEqual({
    users: 8,
    conversations: 3,
    messages: 120,
    objects: 3,
    objectBytes: 12_288,
  })
  expect(await dbs.owner.db.select().from(messages)).toHaveLength(120)
  const rooms = await dbs.owner.db.select().from(conversations)
  expect(rooms.every((room) => room.lastSeq === 40 && room.changeLogFloor === 40)).toBe(true)
  const member = seeded.users[0]
  if (!member) throw new Error('benchmark account missing')
  const membership = await dbs.owner.db
    .select()
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.userId, member.id),
        eq(conversationMembers.conversationId, seeded.messagingRoomId),
      ),
    )
  expect(membership).toHaveLength(1)
  expect(await dbs.owner.db.select().from(attachmentObjects)).toHaveLength(3)
  await expect(seedBenchmark(deps, runId, 'smoke', port)).rejects.toThrow()
  expect(await dbs.owner.db.select().from(messages)).toHaveLength(120)
  const auth = createAuth(deps, {
    baseOrigin: deps.config.origin,
    secret: 'public-benchmark-auth-secret-longer-than-32',
  })
  const signed = await auth.api.signInEmail({
    body: { email: member.email, password: 'public-benchmark-password' },
    headers: new Headers({ origin: deps.config.origin }),
    returnHeaders: true,
  })
  expect(signed.headers.getSetCookie().some((line) => line.includes('session_token'))).toBe(true)
  const offsite = await testJournal()
  const health = await operationsHealth(deps, offsite.journal)
  expect(health.problems).toContain('backup_missing')
  offsite.store.unavailable = true
  expect((await operationsHealth(deps, offsite.journal)).problems).toContain(
    'journal_integrity_or_availability',
  )
})
