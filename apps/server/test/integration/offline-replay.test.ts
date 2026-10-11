/**
 * Messages written while the connection was down and sent later (docs/05 section 3.4, docs/01 section 4.7, AT-17, AT-32,
 * D-070, M6): the server fixes their source as `offline_replay`, which never moves the person's read position; they are
 * accepted only within 24 hours and only under the membership they were written under; repeating one is harmless.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Conversation, MessageEnvelope } from '@chatapp/contracts'
import { messages, notifications } from '@chatapp/db'
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
import { drainPush } from '../support/push.ts'

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

const HOUR = 3_600_000

async function world() {
  const alice = await person(app, 'alice')
  const bob = await person(app, 'bobby')
  const group = await createConversation(alice, {
    kind: 'group',
    name: 'crew',
    memberIds: [bob.id],
  })
  return { alice, bob, group }
}
const mine = async (who: Person, id: string) =>
  (await who.get<Conversation>(`/api/conversations/${id}`)).body
const membershipOf = async (who: Person, id: string) => (await mine(who, id)).me?.membershipId ?? ''

async function replay(
  who: Person,
  conversationId: string,
  overrides: Partial<{
    clientId: string
    body: string
    replyToId: string | null
    queuedAt: string
    membershipId: string
  }> = {},
) {
  return await who.post<MessageEnvelope>(`/api/conversations/${conversationId}/messages/replay`, {
    clientId: crypto.randomUUID(),
    body: 'written on the train',
    queuedAt: new Date(app.clock.now().getTime() - 5 * 60_000).toISOString(),
    membershipId: await membershipOf(who, conversationId),
    ...overrides,
  })
}

describe('the read position (AT-32)', () => {
  test('read 50 of 100, a message replayed afterwards leaves it at 50 and the unread at 51', async () => {
    const { alice, bob, group } = await world()
    await seedMessages(dbs.owner.db, group.id, { count: 100, senderId: alice.id })
    expect((await bob.post(`/api/conversations/${group.id}/read`, { seq: 50 })).status).toBe(200)
    expect((await mine(bob, group.id)).me?.lastReadSeq).toBe(50)

    const sent = await replay(bob, group.id)
    expect(sent.status).toBe(201)
    expect(sent.body.message.seq).toBe(101)
    const after = await mine(bob, group.id)
    expect(after.me?.lastReadSeq).toBe(50)
    expect(after.me?.unread).toBe(51)
  })

  test("only the person's own interactive send moves it, past everything before it", async () => {
    const { alice, bob, group } = await world()
    await seedMessages(dbs.owner.db, group.id, { count: 100, senderId: alice.id })
    await bob.post(`/api/conversations/${group.id}/read`, { seq: 50 })
    await replay(bob, group.id)
    const typed = await bob.post<MessageEnvelope>(`/api/conversations/${group.id}/messages`, {
      clientId: crypto.randomUUID(),
      body: 'typed just now',
    })
    expect(typed.body.message.seq).toBe(102)
    expect((await mine(bob, group.id)).me?.lastReadSeq).toBe(102)
  })

  test('the stored source is the one the server chose, and a client cannot pick another', async () => {
    const { bob, group } = await world()
    const sent = await replay(bob, group.id)
    const [row] = await dbs.owner.db
      .select()
      .from(messages)
      .where(eq(messages.id, sent.body.message.id))
    expect(row?.executionSource).toBe('offline_replay')
    const forged = await bob.post(`/api/conversations/${group.id}/messages/replay`, {
      clientId: crypto.randomUUID(),
      body: 'x',
      queuedAt: new Date().toISOString(),
      membershipId: await membershipOf(bob, group.id),
      executionSource: 'interactive',
    })
    expect(forged.status).toBe(422)
    const ordinary = await bob.post(`/api/conversations/${group.id}/messages`, {
      clientId: crypto.randomUUID(),
      body: 'y',
      executionSource: 'offline_replay',
    })
    expect(ordinary.status).toBe(422)
  })
})

describe('repeating and refusing', () => {
  test('the same clientId and message: the message that was sent (200), the other words: a conflict', async () => {
    const { bob, group } = await world()
    const clientId = crypto.randomUUID()
    const first = await replay(bob, group.id, { clientId })
    const again = await replay(bob, group.id, { clientId })
    expect(first.status).toBe(201)
    expect(again.status).toBe(200)
    expect(again.body.message.id).toBe(first.body.message.id)
    const other = await replay(bob, group.id, { clientId, body: 'other words' })
    expect(other.status).toBe(409)
    expect(errorCode(other)).toBe('IDEMPOTENCY_CONFLICT')
    const rows = await dbs.owner.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, group.id))
    expect(rows.filter((row) => row.executionSource === 'offline_replay')).toHaveLength(1)
  })

  test('a message sent by typing and then replayed under the same clientId is the same message', async () => {
    // The answer to a send was lost, so the queue sends it again: the server already has it.
    const { bob, group } = await world()
    const clientId = crypto.randomUUID()
    const typed = await bob.post<MessageEnvelope>(`/api/conversations/${group.id}/messages`, {
      clientId,
      body: 'written on the train',
    })
    const again = await replay(bob, group.id, { clientId, body: 'written on the train' })
    expect(again.status).toBe(200)
    expect(again.body.message.id).toBe(typed.body.message.id)
  })

  test('older than 24 hours is refused and nothing is written; just under it is accepted', async () => {
    const { bob, group } = await world()
    const old = await replay(bob, group.id, {
      queuedAt: new Date(app.clock.now().getTime() - 25 * HOUR).toISOString(),
    })
    expect(old.status).toBe(403)
    expect(errorCode(old)).toBe('WINDOW_EXPIRED')
    expect(errorReason(old)).toBe('queue_expired')
    expect(
      await dbs.owner.db.select().from(messages).where(eq(messages.senderId, bob.id)),
    ).toHaveLength(0)
    const fresh = await replay(bob, group.id, {
      queuedAt: new Date(app.clock.now().getTime() - 23.9 * HOUR).toISOString(),
    })
    expect(fresh.status).toBe(201)
  })

  test('a time in the future is not a queue entry; a few minutes of clock difference are forgiven', async () => {
    const { bob, group } = await world()
    const future = await replay(bob, group.id, {
      queuedAt: new Date(app.clock.now().getTime() + HOUR).toISOString(),
    })
    expect(future.status).toBe(422)
    const skewed = await replay(bob, group.id, {
      queuedAt: new Date(app.clock.now().getTime() + 2 * 60_000).toISOString(),
    })
    expect(skewed.status).toBe(201)
  })

  test('written under a membership that has ended: refused, and fine under the new one', async () => {
    const { alice, bob, group } = await world()
    const oldMembership = await membershipOf(bob, group.id)
    await bob.post(`/api/conversations/${group.id}/leave`, {})
    await alice.post(`/api/conversations/${group.id}/members`, { userIds: [bob.id] })
    const stale = await replay(bob, group.id, { membershipId: oldMembership })
    expect(stale.status).toBe(409)
    expect(errorReason(stale)).toBe('membership_changed')
    expect(
      await dbs.owner.db.select().from(messages).where(eq(messages.senderId, bob.id)),
    ).toHaveLength(0)
    expect((await replay(bob, group.id)).status).toBe(201)
  })

  test('somebody who was removed cannot replay into the conversation', async () => {
    const { alice, bob, group } = await world()
    const membership = await membershipOf(bob, group.id)
    await alice.del(`/api/conversations/${group.id}/members/${bob.id}`)
    const refused = await replay(bob, group.id, { membershipId: membership })
    expect(refused.status).toBe(404)
  })

  test('a reply to something the person can no longer see is refused like any reply', async () => {
    const { alice, bob, group } = await world()
    const target = await alice.post<MessageEnvelope>(`/api/conversations/${group.id}/messages`, {
      clientId: crypto.randomUUID(),
      body: 'to be withdrawn',
    })
    await alice.post(`/api/messages/${target.body.message.id}/recall`)
    const reply = await replay(bob, group.id, { replyToId: target.body.message.id })
    expect(reply.status).toBe(422)
    expect(errorReason(reply)).toBe('unavailable')
    const valid = await alice.post<MessageEnvelope>(`/api/conversations/${group.id}/messages`, {
      clientId: crypto.randomUUID(),
      body: 'still here',
    })
    expect((await replay(bob, group.id, { replyToId: valid.body.message.id })).status).toBe(201)
  })

  test('an empty message, a body that is too long and a missing field are refused', async () => {
    const { bob, group } = await world()
    expect((await replay(bob, group.id, { body: '' })).status).toBe(422)
    expect((await replay(bob, group.id, { body: 'x'.repeat(10_001) })).status).toBe(422)
    const missing = await bob.post(`/api/conversations/${group.id}/messages/replay`, {
      clientId: crypto.randomUUID(),
      body: 'no membership',
      queuedAt: new Date().toISOString(),
    })
    expect(missing.status).toBe(422)
  })

  test('a replayed message is an ordinary message to everybody else: it can name somebody and be answered', async () => {
    const { alice, bob, group } = await world()
    const sent = await replay(bob, group.id, { body: `ping <@user:${alice.id}>` })
    expect(sent.status).toBe(201)
    await drainPush(app.services.deps)
    const entries = await dbs.owner.db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, alice.id))
    expect(entries.map((entry) => entry.type)).toEqual(['mention'])
  })

  test("the assistant's own conversations are not fed from a queue", async () => {
    const { bob } = await world()
    const started = await bob.post<{ run: { conversationId: string } }>(
      '/api/agent/runs',
      {
        trigger: 'agent_chat',
        prompt: 'hello assistant',
        mode: 'fast',
        attachmentIds: [],
        timezone: 'Asia/Shanghai',
      },
      key(),
    )
    expect(started.status).toBe(200)
    const conversationId = started.body.run.conversationId
    const refused = await replay(bob, conversationId)
    expect(refused.status).toBe(422)
    expect(errorReason(refused)).toBe('agent_conversation')
    const rows = await dbs.owner.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
    expect(rows.every((row) => row.executionSource !== 'offline_replay')).toBe(true)
  })

  test('a conversation that does not exist answers as every other route does', async () => {
    const { bob } = await world()
    const unknown = await bob.post(`/api/conversations/${crypto.randomUUID()}/messages/replay`, {
      clientId: crypto.randomUUID(),
      body: 'x',
      queuedAt: new Date().toISOString(),
      membershipId: crypto.randomUUID(),
    })
    expect(unknown.status).toBe(404)
  })
})
