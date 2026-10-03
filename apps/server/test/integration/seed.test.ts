/**
 * The development seed (docs/09): demo conversations written through the domain layer, so they are exactly what the
 * application would have made; running it again changes nothing; and it leaves no session behind.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { ConversationListResponse, MessagesResponse } from '@chatapp/contracts'
import { conversations, messages, sessions } from '@chatapp/db'
import { asc, eq, sql } from 'drizzle-orm'
import { seedDemoContent } from '../../src/domain/seed.ts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { makeDeps } from '../support/deps.ts'
import { createTestApp, type TestApp } from '../support/http.ts'
import { type Person, person } from '../support/people.ts'

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

const list = async (who: Person) =>
  (await who.get<ConversationListResponse>('/api/conversations')).body.conversations

describe('db:seed content', () => {
  test('makes channels, a group and a direct message with days of talk, as each demo member sees them', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const carol = await person(app, 'carol')
    const ownerDeps = makeDeps(dbs.owner.db)

    const result = await seedDemoContent(ownerDeps)
    expect(result.conversationsCreated).toBe(4)
    expect(result.conversationsPresent).toBe(0)
    expect(result.messagesSent).toBeGreaterThan(40)

    const aliceView = await list(alice)
    expect(aliceView.map((c) => c.name ?? c.dmPeer?.username).sort()).toEqual(
      ['bob', '周末爬山', '综合讨论'].sort(),
    )
    const general = aliceView.find((c) => c.name === '综合讨论')
    expect(general?.kind).toBe('channel')
    expect(general?.me?.pinnedAt).not.toBeNull() // Alice pinned it
    expect(general?.me?.unread).toBe(0) // she wrote the last lines she cares about, and read up to the end

    // Bob has something unread in each place; Alice's second channel is found by browsing, not in her list.
    const bobView = await list(bob)
    expect(bobView.map((c) => c.name ?? c.dmPeer?.username).sort()).toEqual(
      ['alice', '周末爬山', '技术闲聊', '综合讨论'].sort(),
    )
    expect(bobView.find((c) => c.name === '综合讨论')?.me?.unread).toBeGreaterThan(0)
    expect(bobView.find((c) => c.kind === 'dm')?.me?.unread).toBeGreaterThan(0)
    const carolView = await list(carol)
    expect(carolView.find((c) => c.name === '技术闲聊')?.me?.unread).toBeGreaterThan(0)
    const channels = (
      await alice.get<{ items: Array<{ name: string; me: unknown }> }>('/api/channels')
    ).body.items
    expect(channels.find((c) => c.name === '技术闲聊')?.me).toBeNull()

    // Everything is readable by those who joined before the first line, in order, with real replies and past times.
    const generalMessages = (
      await alice.get<MessagesResponse>(`/api/conversations/${general?.id}/messages?limit=100`)
    ).body
    expect(generalMessages.messages.length).toBeGreaterThan(20)
    expect(generalMessages.messages.some((m) => m.replyTo !== null)).toBe(true)
    const times = generalMessages.messages.map((m) => new Date(m.createdAt).getTime())
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(Math.max(...times)).toBeLessThan(Date.now())
    expect(Date.now() - Math.min(...times)).toBeGreaterThan(24 * 3_600_000) // days of talk, not a burst
    // Carol sees the same from where she joined: the beginning.
    const carolGeneral = (
      await carol.get<MessagesResponse>(`/api/conversations/${general?.id}/messages?limit=100`)
    ).body
    expect(carolGeneral.messages.length).toBe(generalMessages.messages.length)

    // The rows are the ones the domain writes: contiguous sequence numbers in every conversation.
    for (const conversation of await dbs.owner.db.select().from(conversations)) {
      const rows = await dbs.owner.db
        .select({ seq: messages.seq })
        .from(messages)
        .where(eq(messages.conversationId, conversation.id))
        .orderBy(asc(messages.seq))
      expect(rows.map((r) => r.seq)).toEqual(rows.map((_, index) => index + 1))
      expect(conversation.lastSeq).toBe(rows.length)
    }
  })

  test('running it again changes nothing, and it leaves no session of its own behind', async () => {
    await person(app, 'alice')
    await person(app, 'bob')
    await person(app, 'carol')
    const ownerDeps = makeDeps(dbs.owner.db)
    const sessionsBefore = (
      await dbs.owner.db.select({ n: sql<number>`count(*)::int` }).from(sessions)
    )[0]?.n

    await seedDemoContent(ownerDeps)
    const countRows = async () => ({
      conversations: (
        await dbs.owner.db.select({ n: sql<number>`count(*)::int` }).from(conversations)
      )[0]?.n,
      messages: (await dbs.owner.db.select({ n: sql<number>`count(*)::int` }).from(messages))[0]?.n,
    })
    const first = await countRows()
    expect(
      (await dbs.owner.db.select({ n: sql<number>`count(*)::int` }).from(sessions))[0]?.n,
    ).toBe(sessionsBefore)

    const again = await seedDemoContent(ownerDeps)
    expect(again).toEqual({ conversationsCreated: 0, conversationsPresent: 4, messagesSent: 0 })
    expect(await countRows()).toEqual(first)
  })

  test('the demo members’ own sessions survive: only the rows the seed made are removed', async () => {
    const alice = await person(app, 'alice')
    await person(app, 'bob')
    await person(app, 'carol')
    await seedDemoContent(makeDeps(dbs.owner.db))
    expect((await alice.get('/api/me')).status).toBe(200)
  })
})
