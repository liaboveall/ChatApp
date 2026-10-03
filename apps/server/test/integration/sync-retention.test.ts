/**
 * Retention of the sync logs (docs/04 section 10, D-126): entries older than seven days go, the cut is recorded in the
 * same statement, and a client that was behind it is told to rebuild instead of silently missing changes. Tombstones of
 * left conversations outlive every cursor and are then removed too.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { ConversationChangesResponse, UserChangesResponse } from '@chatapp/contracts'
import {
  conversationChanges,
  conversations,
  sessions,
  userChanges,
  userConversationStates,
  users,
} from '@chatapp/db'
import { eq } from 'drizzle-orm'
import { purgeSyncLogs } from '../../src/domain/maintenance.ts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createTestApp, type TestApp } from '../support/http.ts'
import { createConversation, person } from '../support/people.ts'

let dbs: TestDatabases
let app: TestApp

beforeAll(() => {
  dbs = openTestDatabases()
})
afterAll(async () => {
  await truncateAll(dbs.owner)
  await dbs.close()
})
beforeEach(async () => {
  await truncateAll(dbs.owner)
  app = await createTestApp(dbs)
})
afterEach(async () => {
  await app.close()
})

const DAY = 86_400_000
const say = (who: Awaited<ReturnType<typeof person>>, id: string, text: string) =>
  who.post(`/api/conversations/${id}/messages`, { clientId: crypto.randomUUID(), body: text })

describe('purging the logs', () => {
  test('entries past seven days go, the floor records the cut, recent entries stay and clients behind the floor reset', async () => {
    const alice = await person(app, 'alice')
    const group = await createConversation(alice, { kind: 'group', name: 'retention' })
    for (let i = 0; i < 4; i += 1) await say(alice, group.id, `old ${i}`)
    app.clock.advance(8 * DAY)
    await dbs.owner.db.update(sessions).set({ expiresAt: new Date(Date.now() + 90 * DAY) })
    await say(alice, group.id, 'recent 1')
    await say(alice, group.id, 'recent 2')

    const result = await purgeSyncLogs(app.services.deps)
    expect(result.conversationsTrimmed).toBe(1)
    const [row] = await dbs.owner.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, group.id))
    expect(row?.changeLogFloor).toBe(4)
    const remaining = await dbs.owner.db
      .select()
      .from(conversationChanges)
      .where(eq(conversationChanges.conversationId, group.id))
    expect(remaining.map((r) => r.changeSeq).sort((a, b) => a - b)).toEqual([5, 6])

    // A client at the floor continues from there; one behind it, or at zero, rebuilds.
    const caughtUp = await alice.get<ConversationChangesResponse>(
      `/api/conversations/${group.id}/changes?after=4`,
    )
    expect(caughtUp.body.resetRequired).toBe(false)
    expect(caughtUp.body.items.map((m) => m.seq)).toEqual([5, 6])
    for (const after of [0, 3]) {
      const behind = await alice.get<ConversationChangesResponse>(
        `/api/conversations/${group.id}/changes?after=${after}`,
      )
      expect(behind.body.resetRequired).toBe(true)
      expect(behind.body.baseline?.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6])
    }
    // Purging again changes nothing; the floor never moves back.
    expect((await purgeSyncLogs(app.services.deps)).conversationsTrimmed).toBe(0)
    expect(
      (await dbs.owner.db.select().from(conversations).where(eq(conversations.id, group.id)))[0]
        ?.changeLogFloor,
    ).toBe(4)
  })

  test('a person’s own log is trimmed the same way, and an old cursor can no longer be replayed', async () => {
    const alice = await person(app, 'alice')
    const group = await createConversation(alice, { kind: 'group', name: 'mine' })
    const before = (await alice.get<UserChangesResponse>('/api/me/changes?after=0')).body
    expect(before.through).toBeGreaterThan(0)
    app.clock.advance(8 * DAY)
    await dbs.owner.db.update(sessions).set({ expiresAt: new Date(Date.now() + 90 * DAY) })
    const view = (await alice.get<{ viewerVersion: number }>(`/api/conversations/${group.id}`)).body
    await alice.patch(`/api/conversations/${group.id}/me`, {
      expectedViewerVersion: view.viewerVersion,
      pinned: true,
    })

    expect((await purgeSyncLogs(app.services.deps)).usersTrimmed).toBe(1)
    const [user] = await dbs.owner.db.select().from(users).where(eq(users.id, alice.id))
    expect(user?.changeLogFloor).toBe(before.through)
    expect(
      await dbs.owner.db.select().from(userChanges).where(eq(userChanges.userId, alice.id)),
    ).toHaveLength(1)
    const stale = await alice.get<UserChangesResponse>('/api/me/changes?after=0')
    expect(stale.body.resetRequired).toBe(true)
    expect(stale.body.baseline?.conversations.map((c) => c.id)).toEqual([group.id])
    const fresh = await alice.get<UserChangesResponse>(`/api/me/changes?after=${before.through}`)
    expect(fresh.body.resetRequired).toBe(false)
    expect(fresh.body.items.map((i) => i.type)).toEqual(['conversation'])
  })

  test('the tombstone of a left conversation stays seven days and then goes; a recent one is never touched', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const old = await createConversation(alice, { kind: 'group', name: 'old', memberIds: [bob.id] })
    await bob.post(`/api/conversations/${old.id}/leave`)
    app.clock.advance(6 * DAY)
    await dbs.owner.db.update(sessions).set({ expiresAt: new Date(Date.now() + 90 * DAY) })
    const recent = await createConversation(alice, {
      kind: 'group',
      name: 'recent',
      memberIds: [bob.id],
    })
    await bob.post(`/api/conversations/${recent.id}/leave`)
    app.clock.advance(2 * DAY) // the first is now eight days old, the second two
    const result = await purgeSyncLogs(app.services.deps)
    expect(result.removedTombstones).toBe(1)
    const states = await dbs.owner.db
      .select()
      .from(userConversationStates)
      .where(eq(userConversationStates.userId, bob.id))
    expect(states.map((s) => s.conversationId)).toEqual([recent.id])
    expect(states[0]?.state).toBe('removed')
  })
})
