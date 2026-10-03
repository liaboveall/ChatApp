/**
 * A write racing a revocation (AT-02, docs/03 section 5.1, M2a): when somebody is removed, banned, silenced or leaves at
 * the very moment they write, the two happen in some order and only the legal outcomes are possible. A message that
 * got in did so before the revocation took effect, and one that came after it is refused and leaves no trace. The order
 * is not left to timing: the person's row is held locked by an unfinished transaction, the first operation is started
 * and seen to be waiting on it (`pg_stat_activity`), then the second, and only then is the lock released; they proceed in
 * the order they queued. Then the same with no barrier at all, many times, for whatever order chance gives.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { conversationMembers, messages } from '@chatapp/db'
import { and, desc, eq, sql } from 'drizzle-orm'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createTestApp, type TestApp } from '../support/http.ts'
import {
  createConversation,
  errorCode,
  type Person,
  person,
  type Reply,
} from '../support/people.ts'

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

/** A person's row held locked by a transaction that has not finished, until the test lets it end. */
async function holdLocked(userId: string) {
  const release = Promise.withResolvers<void>()
  const locked = Promise.withResolvers<void>()
  const holder = dbs.owner.db.transaction(async (tx) => {
    await tx.execute(sql`select id from users where id = ${userId} for update`)
    locked.resolve()
    await release.promise
  })
  await locked.promise
  return {
    release: async () => {
      release.resolve()
      await holder
    },
  }
}

/** Waits until this many of the application's own database connections are waiting for a lock (a state, not a time). */
async function waitUntilBlocked(count: number): Promise<void> {
  const until = Date.now() + 10_000
  for (;;) {
    const rows = await dbs.owner.db.execute<{ n: number }>(
      sql`select count(*)::int as n from pg_stat_activity where application_name = 'chatapp-test-app' and wait_event_type = 'Lock'`,
    )
    if ((rows[0]?.n ?? 0) >= count) return
    if (Date.now() > until)
      throw new Error(`fewer than ${count} operations are waiting on the lock`)
    await Bun.sleep(5)
  }
}

type Setup = { alice: Person; bob: Person; conversationId: string }
type Revocation = {
  name: string
  kind: 'group' | 'channel'
  /** What is done to (or by) Bob. */
  act: (s: Setup) => Promise<Reply>
  /** What a write by Bob gets once it has taken effect. */
  refused: { status: number; code: string }
  /** The end state of Bob's membership row. */
  after: (s: Setup) => Promise<void>
}

const memberRow = async (s: Setup) =>
  (
    await dbs.owner.db
      .select()
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, s.conversationId),
          eq(conversationMembers.userId, s.bob.id),
        ),
      )
  )[0]

const REVOCATIONS: Revocation[] = [
  {
    name: 'being removed',
    kind: 'group',
    act: (s) => s.alice.del(`/api/conversations/${s.conversationId}/members/${s.bob.id}`),
    refused: { status: 404, code: 'NOT_FOUND' },
    after: async (s) => expect(await memberRow(s)).toBeUndefined(),
  },
  {
    name: 'being banned from a channel',
    kind: 'channel',
    act: (s) => s.alice.post(`/api/conversations/${s.conversationId}/bans`, { userId: s.bob.id }),
    refused: { status: 403, code: 'FORBIDDEN' },
    after: async (s) => expect(await memberRow(s)).toBeUndefined(),
  },
  {
    name: 'being silenced',
    kind: 'group',
    act: (s) =>
      s.alice.patch(`/api/conversations/${s.conversationId}/members/${s.bob.id}`, {
        silencedUntil: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    refused: { status: 403, code: 'FORBIDDEN' },
    after: async (s) => expect((await memberRow(s))?.silencedUntil).not.toBeNull(),
  },
  {
    name: 'leaving',
    kind: 'group',
    act: (s) => s.bob.post(`/api/conversations/${s.conversationId}/leave`),
    refused: { status: 404, code: 'NOT_FOUND' },
    after: async (s) => expect(await memberRow(s)).toBeUndefined(),
  },
]

async function setUp(kind: 'group' | 'channel'): Promise<Setup> {
  const alice = await person(app, 'alice')
  const bob = await person(app, 'bob')
  const conversation =
    kind === 'group'
      ? await createConversation(alice, { kind: 'group', name: 'racing', memberIds: [bob.id] })
      : await createConversation(alice, {
          kind: 'channel',
          name: 'racing channel',
          memberIds: [bob.id],
        })
  return { alice, bob, conversationId: conversation.id }
}

const write = (s: Setup, text: string) =>
  s.bob.post<{ message: { id: string; seq: number } }>(
    `/api/conversations/${s.conversationId}/messages`,
    {
      clientId: crypto.randomUUID(),
      body: text,
    },
  )
const messagesBy = (s: Setup) =>
  dbs.owner.db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, s.conversationId), eq(messages.senderId, s.bob.id)))

for (const revocation of REVOCATIONS) {
  describe(`${revocation.name} while writing`, () => {
    test('a write that queued first gets in, and the revocation takes effect after it', async () => {
      const s = await setUp(revocation.kind)
      const hold = await holdLocked(s.bob.id)
      const sending = write(s, 'first in the queue')
      await waitUntilBlocked(1)
      const revoking = revocation.act(s)
      await waitUntilBlocked(2)
      await hold.release()
      const [sent, revoked] = await Promise.all([sending, revoking])
      expect(sent.status).toBe(201)
      expect(revoked.status).toBeLessThan(300)
      expect(await messagesBy(s)).toHaveLength(1)
      await revocation.after(s)
      // And from then on, writing is refused like for anybody else in that state.
      const later = await write(s, 'too late')
      expect(later.status).toBe(revocation.refused.status)
      expect(errorCode(later)).toBe(revocation.refused.code)
      expect(await messagesBy(s)).toHaveLength(1)
    })

    test('a revocation that queued first takes effect before the write, which is refused and leaves nothing', async () => {
      const s = await setUp(revocation.kind)
      const hold = await holdLocked(s.bob.id)
      const revoking = revocation.act(s)
      await waitUntilBlocked(1)
      const sending = write(s, 'second in the queue')
      await waitUntilBlocked(2)
      await hold.release()
      const [revoked, sent] = await Promise.all([revoking, sending])
      expect(revoked.status).toBeLessThan(300)
      expect(sent.status).toBe(revocation.refused.status)
      expect(errorCode(sent)).toBe(revocation.refused.code)
      expect(JSON.stringify(sent.body)).not.toContain('second in the queue')
      expect(await messagesBy(s)).toEqual([])
      await revocation.after(s)
    })
  })
}

describe('with no barrier, in whatever order chance gives', () => {
  test('every outcome is one of the two legal ones, and a message that got in came before the removal', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const outcomes = { before: 0, after: 0 }
    for (let round = 0; round < 12; round += 1) {
      const group = await createConversation(alice, {
        kind: 'group',
        name: `round ${round}`,
        memberIds: [bob.id],
      })
      const s: Setup = { alice, bob, conversationId: group.id }
      const [sent, removed] = await Promise.all([
        write(s, 'at the same moment'),
        alice.del(`/api/conversations/${group.id}/members/${bob.id}`),
      ])
      expect(removed.status).toBeLessThan(300)
      const rows = await messagesBy(s)
      const [removal] = await dbs.owner.db
        .select({ seq: messages.seq })
        .from(messages)
        .where(and(eq(messages.conversationId, group.id), eq(messages.kind, 'system')))
        .orderBy(desc(messages.seq))
        .limit(1)
      if (sent.status === 201) {
        outcomes.before += 1
        expect(rows).toHaveLength(1)
        expect(rows[0]?.seq).toBeLessThan(removal?.seq ?? 0) // in the conversation's order it came before the removal
      } else {
        outcomes.after += 1
        expect(sent.status).toBe(404)
        expect(rows).toEqual([])
      }
      expect(await memberRow(s)).toBeUndefined()
    }
    expect(outcomes.before + outcomes.after).toBe(12)
  }, 60_000)
})
