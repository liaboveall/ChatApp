/**
 * Retrying a send after the membership changed (AT-13, D-035, INV-09). A retry with the same `clientId` is answered with
 * the stored message, but only while that message is still the sender's to see: somebody who left (or was removed, or
 * was banned) and came back has a new history boundary, and what was said before it is gone for them, their own words
 * included. A retry in the same membership stays idempotent, and nothing leaks while it is refused. The refusal sits in two
 * places: the retry's own check, and the projection of stored rows, which leaves out whatever predates the viewer's
 * boundary however the row was found (what a future caller that looks messages up by some other key relies on). Over
 * HTTP either one alone gives the same answers, so the requests below pin what the two do together and the last test
 * pins the projection by itself; the retry's own check is the second line behind it and has no separate behaviour to
 * observe.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type {
  ConversationChangesResponse,
  CreatedConversationInvite,
  MessageEnvelope,
  MessagesResponse,
} from '@chatapp/contracts'
import { messages } from '@chatapp/db'
import { eq } from 'drizzle-orm'
import { projectMessages } from '../../src/domain/messages.ts'
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

const SAID = 'what Bob said before he went'
const send = (who: Person, conversationId: string, request: { clientId: string; body: string }) =>
  who.post<MessageEnvelope>(`/api/conversations/${conversationId}/messages`, request)
const add = (who: Person, conversationId: string, other: Person) =>
  who.post(`/api/conversations/${conversationId}/members`, { userIds: [other.id] })

/** A refusal that gives away nothing of the message: not its text, not its id. */
function expectNothingLeaked(reply: Reply, messageId: string): void {
  const text = JSON.stringify(reply.body)
  expect(text).not.toContain(SAID)
  expect(text).not.toContain(messageId)
}

/** Everything a person could still do with the message they wrote before their boundary moved. */
async function expectGone(
  bob: Person,
  conversationId: string,
  sent: MessageEnvelope,
  request: { clientId: string; body: string },
) {
  const id = sent.message.id
  const retry = await send(bob, conversationId, request)
  expect(retry.status).toBe(404)
  expect(errorCode(retry)).toBe('NOT_FOUND')
  expectNothingLeaked(retry, id)
  expect((await bob.get(`/api/messages/${id}`)).status).toBe(404)
  const listed = await bob.get<MessagesResponse>(`/api/conversations/${conversationId}/messages`)
  expect(JSON.stringify(listed.body)).not.toContain(SAID)
  const edit = await bob.patch(`/api/messages/${id}`, {
    body: 'rewritten',
    expectedChangeSeq: sent.message.changeSeq,
  })
  const recall = await bob.post(`/api/messages/${id}/recall`)
  const hide = await bob.post(`/api/messages/${id}/hide`)
  for (const reply of [edit, recall, hide]) {
    expect(reply.status).toBe(404)
    expectNothingLeaked(reply, id)
  }
  const feed = await bob.get<ConversationChangesResponse>(
    `/api/conversations/${conversationId}/changes?after=0`,
  )
  expect(JSON.stringify(feed.body)).not.toContain(SAID)
  // Untouched by all of it: the author's words are still what they were for everybody who is allowed to see them.
  const [row] = await dbs.owner.db.select().from(messages).where(eq(messages.id, id))
  expect(row?.body).toBe(SAID)
  expect(row?.editedAt).toBeNull()
  expect(row?.recalledAt).toBeNull()
}

describe('a retry in the same membership', () => {
  test('is the same message however long it takes and whoever writes in between', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'steady',
      memberIds: [bob.id],
    })
    const request = { clientId: crypto.randomUUID(), body: SAID }
    const first = await send(bob, group.id, request)
    expect(first.status).toBe(201)
    await send(alice, group.id, { clientId: crypto.randomUUID(), body: 'and somebody else' })
    app.clock.advance(3 * 3_600_000)
    const again = await send(bob, group.id, request)
    expect(again.status).toBe(200)
    expect(again.body.message.id).toBe(first.body.message.id)
    expect(again.body.message.body).toBe(SAID)
    expect(
      await dbs.owner.db.select().from(messages).where(eq(messages.clientId, request.clientId)),
    ).toHaveLength(1)
  })

  test('is nobody else’s message: another sender using the same clientId writes their own', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'shared id',
      memberIds: [bob.id],
    })
    const clientId = crypto.randomUUID()
    const theirs = await send(bob, group.id, { clientId, body: SAID })
    const mine = await send(alice, group.id, { clientId, body: 'not the same message' })
    expect(mine.status).toBe(201)
    expect(mine.body.message.id).not.toBe(theirs.body.message.id)
    expect(mine.body.message.senderId).toBe(alice.id)
  })
})

describe('a retry after the boundary moved', () => {
  test('leaving ends it, coming back does not bring it back, and the new boundary applies to every door', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'left and back',
      memberIds: [bob.id],
    })
    const request = { clientId: crypto.randomUUID(), body: SAID }
    const sent = await send(bob, group.id, request)
    expect(sent.status).toBe(201)

    expect((await bob.post(`/api/conversations/${group.id}/leave`)).status).toBe(200)
    const whileOut = await send(bob, group.id, request)
    expect(whileOut.status).toBe(404)
    expectNothingLeaked(whileOut, sent.body.message.id)

    expect((await add(alice, group.id, bob)).status).toBe(200)
    await expectGone(bob, group.id, sent.body, request)

    // What is said from the new boundary on is theirs, and a retry of it is as idempotent as ever.
    const fresh = { clientId: crypto.randomUUID(), body: 'back again' }
    const written = await send(bob, group.id, fresh)
    expect(written.status).toBe(201)
    expect((await send(bob, group.id, fresh)).status).toBe(200)
    // Alice, who never left, still sees the old words.
    const hers = await alice.get<MessagesResponse>(`/api/conversations/${group.id}/messages`)
    expect(hers.body.messages.map((m) => m.body)).toContain(SAID)
  })

  test('being removed and added again, or banned, forgiven and added again, is the same', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'sent away',
      memberIds: [bob.id],
    })
    const removedRequest = { clientId: crypto.randomUUID(), body: SAID }
    const sent = await send(bob, group.id, removedRequest)
    expect(
      (await alice.del(`/api/conversations/${group.id}/members/${bob.id}`)).status,
    ).toBeLessThan(300)
    expect((await send(bob, group.id, removedRequest)).status).toBe(404)
    expect((await add(alice, group.id, bob)).status).toBe(200)
    await expectGone(bob, group.id, sent.body, removedRequest)

    // Second round on the same person: banned (a retry is refused), the ban lifted, added once more.
    const request = { clientId: crypto.randomUUID(), body: SAID }
    const second = await send(bob, group.id, request)
    expect(second.status).toBe(201)
    expect(
      (await alice.post(`/api/conversations/${group.id}/bans`, { userId: bob.id })).status,
    ).toBeLessThan(300)
    const banned = await send(bob, group.id, request)
    expect(banned.status).toBe(404)
    expectNothingLeaked(banned, second.body.message.id)
    expect((await alice.del(`/api/conversations/${group.id}/bans/${bob.id}`)).status).toBeLessThan(
      300,
    )
    expect((await add(alice, group.id, bob)).status).toBe(200)
    await expectGone(bob, group.id, second.body, request)
  })

  test('a channel moves the boundary to the moment of joining again', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const channel = await createConversation(alice, { kind: 'channel', name: 'open house' })
    expect((await bob.post(`/api/conversations/${channel.id}/join`)).status).toBe(200)
    const request = { clientId: crypto.randomUUID(), body: SAID }
    const sent = await send(bob, channel.id, request)
    expect(sent.status).toBe(201)
    expect((await bob.post(`/api/conversations/${channel.id}/leave`)).status).toBe(200)
    expect((await bob.post(`/api/conversations/${channel.id}/join`)).status).toBe(200)
    await expectGone(bob, channel.id, sent.body, request)
  })

  test('following an invitation link back in gives the new boundary too', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'by the link',
      memberIds: [bob.id],
    })
    const link = await alice.post<CreatedConversationInvite>(
      `/api/conversations/${group.id}/invites`,
      {},
    )
    const request = { clientId: crypto.randomUUID(), body: SAID }
    const sent = await send(bob, group.id, request)
    expect((await bob.post(`/api/conversations/${group.id}/leave`)).status).toBe(200)
    expect(
      (await bob.post('/api/conversation-invites/accept', { code: link.body.code })).status,
    ).toBe(200)
    await expectGone(bob, group.id, sent.body, request)
  })

  test('a different request under the old clientId is the conflict it always was and says nothing about the message', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'clash',
      memberIds: [bob.id],
    })
    const clientId = crypto.randomUUID()
    const sent = await send(bob, group.id, { clientId, body: SAID })
    expect((await bob.post(`/api/conversations/${group.id}/leave`)).status).toBe(200)
    expect((await add(alice, group.id, bob)).status).toBe(200)
    const clash = await send(bob, group.id, { clientId, body: 'something else entirely' })
    expect(clash.status).toBe(409)
    expect(errorCode(clash)).toBe('IDEMPOTENCY_CONFLICT')
    expectNothingLeaked(clash, sent.body.message.id)
  })
})

describe('the projection of stored rows', () => {
  test('is held to the viewer’s boundary whoever fetched the rows and by what key', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'projected',
      memberIds: [bob.id],
    })
    const early = await send(alice, group.id, { clientId: crypto.randomUUID(), body: SAID })
    const late = await send(alice, group.id, { clientId: crypto.randomUUID(), body: 'after it' })
    const rows = await dbs.owner.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, group.id))
      .orderBy(messages.seq)
    expect(rows.map((row) => row.id)).toContain(early.body.message.id)

    // A boundary just past the first message: that row, and whatever came before it, is not the viewer's.
    const boundary = early.body.message.seq
    const shown = await projectMessages(
      dbs.owner.db,
      { userId: bob.id, visibleFromSeq: boundary },
      rows,
    )
    const ids = shown.messages.map((m) => m.id)
    expect(ids).not.toContain(early.body.message.id)
    expect(ids).toContain(late.body.message.id)
    expect(ids).toEqual(rows.filter((row) => row.seq > boundary).map((row) => row.id))
    expect(JSON.stringify(shown)).not.toContain(SAID)

    // The same rows for a viewer whose boundary is before all of them: nothing is left out.
    const all = await projectMessages(dbs.owner.db, { userId: bob.id, visibleFromSeq: 0 }, rows)
    expect(all.messages).toHaveLength(rows.length)
  })
})
