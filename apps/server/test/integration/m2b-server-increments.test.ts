/**
 * The three small server increments M2b needs (D-155): `me.joinedAt` for the join boundary in the timeline, and the two
 * test-only routes (`/api/test/messages/:id/age`, `/api/test/client-ip`). No business route is new, so the permission
 * matrix gains no row; the test routes do not exist outside APP_ENV=test (test/security/test-routes.test.ts).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Conversation, MessageEnvelope, UserChangesResponse } from '@chatapp/contracts'
import { LIMITS } from '@chatapp/contracts'
import { messages } from '@chatapp/db'
import { eq } from 'drizzle-orm'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createTestApp, type TestApp } from '../support/http.ts'
import { seedMessages } from '../support/messages.ts'
import {
  createConversation,
  errorCode,
  errorReason,
  key,
  type Person,
  person,
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

const send = async (
  who: Person,
  conversationId: string,
  body: string,
): Promise<MessageEnvelope> => {
  const reply = await who.post<MessageEnvelope>(
    `/api/conversations/${conversationId}/messages`,
    { body, clientId: crypto.randomUUID() },
    key(),
  )
  expect(reply.status).toBe(201)
  return reply.body
}

describe('me.joinedAt', () => {
  test('is on every projection of the conversation a member sees, and is null-safe for non-members', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const channel = await createConversation(alice, { kind: 'channel', name: 'general' })
    expect(channel.me?.joinedAt).toBeString()
    expect(Number.isNaN(Date.parse(channel.me?.joinedAt ?? ''))).toBe(false)

    // Not a member yet: the channel is discoverable, `me` is null, so there is no join time to leak.
    const asStranger = await bob.get<Conversation>(`/api/conversations/${channel.id}`)
    expect(asStranger.status).toBe(200)
    expect(asStranger.body.me).toBeNull()

    const joined = await bob.post<Conversation>(`/api/conversations/${channel.id}/join`, {})
    expect(joined.status).toBe(200)
    const listed = (await bob.get<{ conversations: Conversation[] }>('/api/conversations')).body
    const detail = (await bob.get<Conversation>(`/api/conversations/${channel.id}`)).body
    const fromList = listed.conversations.find((c) => c.id === channel.id)
    expect(joined.body.me?.joinedAt).toBeString()
    expect(fromList?.me?.joinedAt).toBe(joined.body.me?.joinedAt)
    expect(detail.me?.joinedAt).toBe(joined.body.me?.joinedAt)
  })

  test('is rewritten when somebody leaves and comes back, together with the history boundary', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const channel = await createConversation(alice, { kind: 'channel', name: 'general' })
    const first = (await bob.post<Conversation>(`/api/conversations/${channel.id}/join`, {})).body
    await send(alice, channel.id, 'before bob left')
    expect((await bob.post(`/api/conversations/${channel.id}/leave`, {})).status).toBe(200)
    await send(alice, channel.id, 'while bob was away')

    // The test app's clock only moves when told to (a real re-join happens later than the first join).
    app.clock.advance(60_000)
    const again = (await bob.post<Conversation>(`/api/conversations/${channel.id}/join`, {})).body
    expect(again.me?.membershipId).not.toBe(first.me?.membershipId)
    expect(Date.parse(again.me?.joinedAt ?? '')).toBeGreaterThan(
      Date.parse(first.me?.joinedAt ?? ''),
    )
    // Everything before the new join is invisible to the returning member.
    expect(again.me?.visibleFromSeq).toBeGreaterThan(first.me?.visibleFromSeq ?? 0)
    expect(again.me?.visibleFromSeq).toBe(again.lastSeq)
  })

  test('travels with the personal change feed and the sync baseline', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'friends',
      memberIds: [bob.id],
    })
    const feed = await bob.get<UserChangesResponse>('/api/me/changes?after=0')
    expect(feed.status).toBe(200)
    const entries = feed.body.items.flatMap((item) =>
      item.type === 'conversation' && item.conversation.id === group.id ? [item.conversation] : [],
    )
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) expect(entry.me?.joinedAt).toBeString()
  })
})

describe('POST /api/test/messages/:id/age', () => {
  const age = (id: string, ms: number) =>
    app.request(`/api/test/messages/${id}/age`, { json: { ms } })

  test('moves created_at back by exactly that much and nothing else', async () => {
    const alice = await person(app, 'alice')
    const group = await createConversation(alice, { kind: 'group', name: 'notes' })
    const sent = await send(alice, group.id, 'hello')
    const [before] = await dbs.owner.db
      .select()
      .from(messages)
      .where(eq(messages.id, sent.message.id))
    const reply = await age(sent.message.id, 180_000)
    expect(reply.status).toBe(200)
    const body = (await reply.json()) as { createdAt: string }
    const [after] = await dbs.owner.db
      .select()
      .from(messages)
      .where(eq(messages.id, sent.message.id))
    expect(before && after).toBeTruthy()
    if (!before || !after) return
    expect(before.createdAt.getTime() - after.createdAt.getTime()).toBe(180_000)
    expect(body.createdAt).toBe(after.createdAt.toISOString())
    // Only the creation time moved: same body, same sequence numbers, not recalled.
    expect({ ...after, createdAt: 0 }).toEqual({ ...before, createdAt: 0 })
  })

  test('a message aged past the recall window can no longer be recalled; a fresh one still can', async () => {
    const alice = await person(app, 'alice')
    const group = await createConversation(alice, { kind: 'group', name: 'notes' })
    const old = await send(alice, group.id, 'too late')
    const fresh = await send(alice, group.id, 'in time')
    const window = LIMITS.messageRecallWindowMs + LIMITS.messageRecallGraceMs
    expect((await age(old.message.id, window + 1_000)).status).toBe(200)

    const refused = await alice.post(`/api/messages/${old.message.id}/recall`, {})
    expect(refused.status).toBe(403)
    expect(errorCode(refused)).toBe('WINDOW_EXPIRED')
    const allowed = await alice.post(`/api/messages/${fresh.message.id}/recall`, {})
    expect(allowed.status).toBe(200)
    // Aging by less than the window leaves the message recallable.
    const middle = await send(alice, group.id, 'still fine')
    expect((await age(middle.message.id, LIMITS.messageRecallWindowMs - 10_000)).status).toBe(200)
    expect((await alice.post(`/api/messages/${middle.message.id}/recall`, {})).status).toBe(200)
  })

  test('refuses unknown messages and anything that is not a positive whole number of milliseconds', async () => {
    const alice = await person(app, 'alice')
    const group = await createConversation(alice, { kind: 'group', name: 'notes' })
    const sent = await send(alice, group.id, 'hello')
    expect((await age(crypto.randomUUID(), 1000)).status).toBe(404)
    expect((await age('not-a-uuid', 1000)).status).toBe(422)
    for (const ms of [0, -5, 1.5, 366 * 86_400_000 + 1, Number.NaN]) {
      const reply = await app.request(`/api/test/messages/${sent.message.id}/age`, { json: { ms } })
      expect([400, 422]).toContain(reply.status)
    }
    const extra = await app.request(`/api/test/messages/${sent.message.id}/age`, {
      json: { ms: 1000, createdAt: '2020-01-01T00:00:00Z' },
    })
    expect([400, 422]).toContain(extra.status)
    // The message is untouched by all the refusals.
    const [row] = await dbs.owner.db.select().from(messages).where(eq(messages.id, sent.message.id))
    expect(Date.now() - (row?.createdAt.getTime() ?? 0)).toBeLessThan(60_000)
  })

  test('does not reveal why a recall was refused beyond the documented reason', async () => {
    const alice = await person(app, 'alice')
    const group = await createConversation(alice, { kind: 'group', name: 'notes' })
    const sent = await send(alice, group.id, 'hello')
    await age(sent.message.id, 10 * 60_000)
    const refused = await alice.post(`/api/messages/${sent.message.id}/recall`, {})
    expect(errorCode(refused)).toBe('WINDOW_EXPIRED')
    expect(errorReason(refused)).toBeUndefined()
  })
})

describe('GET /api/test/client-ip', () => {
  const ipOf = async (options: { peer?: string; forwardedFor?: string } = {}) => {
    const reply = await app.request('/api/test/client-ip', options)
    expect(reply.status).toBe(200)
    return ((await reply.json()) as { ip: string }).ip
  }

  test('reports the peer address when nobody forwards anything', async () => {
    expect(await ipOf()).toBe('127.0.0.1')
    expect(await ipOf({ peer: '203.0.113.50' })).toBe('203.0.113.50')
  })

  test('a forged X-Forwarded-For from an untrusted peer does not become the client address (SEC-28)', async () => {
    expect(await ipOf({ peer: '203.0.113.50', forwardedFor: '198.51.100.7' })).toBe('203.0.113.50')
  })

  test('behind a trusted proxy the client address is what the proxy saw', async () => {
    // What Nginx does: it replaces X-Forwarded-For with the address it saw, and the loopback peer is trusted.
    expect(await ipOf({ forwardedFor: '198.51.100.7' })).toBe('198.51.100.7')
  })
})

test('the helper sends seeded messages through the same window rules', async () => {
  // seedMessages writes `created_at = now` by default; ageing works on rows the domain did not create too.
  const alice = await person(app, 'alice')
  const group = await createConversation(alice, { kind: 'group', name: 'notes' })
  const [seq] = await seedMessages(dbs.owner.db, group.id, { count: 1, senderId: alice.id })
  const [row] = await dbs.owner.db
    .select()
    .from(messages)
    .where(eq(messages.seq, seq ?? 0))
  const reply = await app.request(`/api/test/messages/${row?.id}/age`, { json: { ms: 5_000 } })
  expect(reply.status).toBe(200)
})
