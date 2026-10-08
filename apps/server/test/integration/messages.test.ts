/**
 * Sending and reading messages over HTTP against the real database (docs/05 section 3.4, M2a): sequence numbers and
 * the sync log (INV-01, INV-02), idempotency (INV-03), who may send where (L-09, L-10, L-23), the join boundary
 * (INV-09, D-035), quotes that reveal nothing (AT-03), direct messages and system lines.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type {
  Conversation,
  ConversationListResponse,
  Message,
  MessageEnvelope,
  MessagesResponse,
} from '@chatapp/contracts'
import {
  conversationChanges,
  conversationMembers,
  conversations,
  messages,
  users,
  workItems,
} from '@chatapp/db'
import { and, asc, eq } from 'drizzle-orm'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createTestApp, type TestApp } from '../support/http.ts'
import { seedMessages } from '../support/messages.ts'
import {
  createConversation,
  errorCode,
  errorReason,
  openDm,
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

const send = (who: Person, conversationId: string, body: object) =>
  who.post<MessageEnvelope>(`/api/conversations/${conversationId}/messages`, body)
const say = (who: Person, conversationId: string, text: string, extra: object = {}) =>
  send(who, conversationId, { clientId: crypto.randomUUID(), body: text, ...extra })
const page = (who: Person, conversationId: string, query = '') =>
  who.get<MessagesResponse>(`/api/conversations/${conversationId}/messages${query}`)
const seqs = (reply: { body: MessagesResponse }) => reply.body.messages.map((m) => m.seq)
const conv = async (who: Person, id: string) =>
  (await who.get<Conversation>(`/api/conversations/${id}`)).body
const listed = async (who: Person, id: string) =>
  (await who.get<ConversationListResponse>('/api/conversations')).body.conversations.find(
    (c) => c.id === id,
  )

describe('sending (INV-01, INV-02, INV-28)', () => {
  test('a message takes the next numbers, shows its sender, moves only the sender’s read position and leaves a log entry', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'talk',
      memberIds: [bob.id],
    })

    const sent = await say(alice, group.id, 'hello **world**')
    expect(sent.status).toBe(201)
    expect(sent.body.message).toMatchObject({
      conversationId: group.id,
      seq: 1,
      changeSeq: 1,
      kind: 'user',
      status: 'sent',
      senderId: alice.id,
      body: 'hello **world**',
      replyTo: null,
      attachments: [],
      mentions: [],
      editedAt: null,
      recalledAt: null,
      deletedAt: null,
      meta: {},
    })
    expect(sent.body.users[alice.id]).toMatchObject({
      username: 'alice',
      isBot: false,
      deleted: false,
    })

    const mine = await conv(alice, group.id)
    expect(mine).toMatchObject({ lastSeq: 1, lastChangeSeq: 1 })
    expect(mine.me).toMatchObject({ lastReadSeq: 1, unread: 0 })
    expect((await conv(bob, group.id)).me).toMatchObject({ lastReadSeq: 0, unread: 1 })
    expect(mine.lastMessagePreview).toEqual({
      senderId: alice.id,
      text: 'hello world',
      kind: 'user',
      state: 'ok',
    })

    const log = await dbs.owner.db
      .select()
      .from(conversationChanges)
      .where(eq(conversationChanges.conversationId, group.id))
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({
      changeSeq: 1,
      messageId: sent.body.message.id,
      kind: 'message_created',
    })
    const hints = await dbs.owner.db.select().from(workItems)
    expect(hints.map((h) => h.dedupeKey)).toContain(`mc:${group.id}:1`)
    // The hint names ids and versions only: no text, no sender (docs/05 section 4.4, SEC-27).
    expect(JSON.stringify(hints)).not.toContain('hello')
    const [row] = await dbs.owner.db.select().from(messages)
    expect(row?.executionSource).toBe('interactive')
  })

  test('conversation previews parse Markdown before truncation and retain the original message body', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'preview',
      memberIds: [bob.id],
    })
    const cases = [
      {
        body: '**当前会话总结**\n\n- **时间**：八点\n- [路线图](https://example.com/map)',
        text: '当前会话总结 时间：八点 路线图',
      },
      { body: `**${'周'.repeat(110)}**`, text: '周'.repeat(100) },
      { body: '`**literal**` 和 \\*\\*原样\\*\\*', text: '**literal** 和 **原样**' },
    ]
    for (const { body, text } of cases) {
      const sent = await say(alice, group.id, body)
      expect(sent.status).toBe(201)
      expect(sent.body.message.body).toBe(body)
      expect((await conv(alice, group.id)).lastMessagePreview?.text).toBe(text)
      expect((await listed(bob, group.id))?.lastMessagePreview?.text).toBe(text)
      const read = await bob.get<MessageEnvelope>(`/api/messages/${sent.body.message.id}`)
      expect(read.body.message.body).toBe(body)
    }
  })

  test('the same clientId and request give the same message; another request or another conversation is a conflict (INV-03)', async () => {
    const alice = await person(app, 'alice')
    const group = await createConversation(alice, { kind: 'group', name: 'retry' })
    const other = await createConversation(alice, { kind: 'group', name: 'elsewhere' })
    const clientId = crypto.randomUUID()
    const first = await send(alice, group.id, { clientId, body: 'once' })
    const again = await send(alice, group.id, { clientId, body: 'once' })
    expect(first.status).toBe(201)
    expect(again.status).toBe(200)
    expect(again.body.message.id).toBe(first.body.message.id)
    expect(again.body.message.seq).toBe(1)

    const different = await send(alice, group.id, { clientId, body: 'something else' })
    expect(different.status).toBe(409)
    expect(errorCode(different)).toBe('IDEMPOTENCY_CONFLICT')
    const crossed = await send(alice, other.id, { clientId, body: 'once' })
    expect(crossed.status).toBe(409)
    expect(errorCode(crossed)).toBe('IDEMPOTENCY_CONFLICT')
    // Neither the conflict nor the other conversation show the original's content.
    expect(JSON.stringify(crossed.body)).not.toContain('once')
    expect(await dbs.owner.db.select().from(messages)).toHaveLength(1)
    expect((await conv(alice, other.id)).lastSeq).toBe(0)
  })

  test('eight simultaneous sends of one clientId create exactly one message', async () => {
    const alice = await person(app, 'alice')
    const group = await createConversation(alice, { kind: 'group', name: 'burst' })
    const clientId = crypto.randomUUID()
    const replies = await Promise.all(
      Array.from({ length: 8 }, () => send(alice, group.id, { clientId, body: 'same' })),
    )
    expect(replies.filter((r) => r.status === 201)).toHaveLength(1)
    expect(replies.filter((r) => r.status === 200)).toHaveLength(7)
    expect(new Set(replies.map((r) => r.body.message.id)).size).toBe(1)
    expect(await dbs.owner.db.select().from(messages)).toHaveLength(1)
  })

  test('concurrent senders get numbers without gaps or repeats (INV-01) and the log has an entry for each', async () => {
    const alice = await person(app, 'alice')
    const [bob, carol] = await Promise.all([person(app, 'bob'), person(app, 'carol')])
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'busy',
      memberIds: [bob.id, carol.id],
    })
    const everyone = [alice, bob, carol]
    const replies = await Promise.all(
      everyone.flatMap((who) =>
        Array.from({ length: 6 }, (_, i) => say(who, group.id, `${who.username} ${i}`)),
      ),
    )
    expect(replies.every((r) => r.status === 201)).toBe(true)
    const rows = await dbs.owner.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, group.id))
      .orderBy(asc(messages.seq))
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1))
    expect(rows.map((r) => r.changeSeq)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1))
    const log = await dbs.owner.db
      .select()
      .from(conversationChanges)
      .where(eq(conversationChanges.conversationId, group.id))
    expect(log.map((l) => l.changeSeq).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 18 }, (_, i) => i + 1),
    )
    expect((await conv(alice, group.id)).lastSeq).toBe(18)
    // Everyone's own messages count as read for them; the rest is unread (INV-08: never beyond the last message).
    const [row] = await dbs.owner.db
      .select()
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, group.id),
          eq(conversationMembers.userId, bob.id),
        ),
      )
    expect(row?.lastReadSeq).toBeLessThanOrEqual(18)
    expect(row?.lastReadSeq).toBeGreaterThanOrEqual(6)
  })

  test('who the sender is comes from the session alone: fields that claim otherwise are refused (L-09)', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'forgery',
      memberIds: [bob.id],
    })
    for (const forged of [
      { senderId: bob.id },
      { username: 'bob' },
      { kind: 'system' },
      { executionSource: 'scheduled' },
      { status: 'streaming' },
      { seq: 99 },
    ]) {
      const reply = await say(alice, group.id, 'I am bob', forged)
      expect(reply.status).toBe(422)
    }
    expect(await dbs.owner.db.select().from(messages)).toHaveLength(0)
    const honest = await say(alice, group.id, 'I am alice')
    expect(honest.body.message.senderId).toBe(alice.id)
  })

  test('a person outside cannot write into a conversation, whatever its kind (L-10, L-23)', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const mallory = await person(app, 'mallory')
    const group = await createConversation(alice, { kind: 'group', name: 'private' })
    const channel = await createConversation(alice, { kind: 'channel', name: 'public' })
    const dm = await openDm(alice, bob)
    expect((await say(mallory, group.id, 'let me in')).status).toBe(404)
    expect((await say(mallory, dm.id, 'hello')).status).toBe(404)
    const closed = await say(mallory, channel.id, 'hi')
    expect(closed.status).toBe(403)
    expect(errorReason(closed)).toBe('not_member')
    expect((await say(mallory, crypto.randomUUID(), 'void')).status).toBe(404)
    expect(await dbs.owner.db.select().from(messages)).toHaveLength(0)
    // Nor can anyone read them through the other doors.
    expect((await page(mallory, group.id)).status).toBe(404)
    expect((await page(mallory, dm.id)).status).toBe(404)
    expect((await mallory.get(`/api/conversations/${group.id}/changes?after=0`)).status).toBe(404)
  })

  test('the text must be there, visible and within 5000 characters; carriage returns and trailing blanks are tidied', async () => {
    const alice = await person(app, 'alice')
    const group = await createConversation(alice, { kind: 'group', name: 'text' })
    const refuse = async (body: object) =>
      expect((await send(alice, group.id, body)).status).toBe(422)
    await refuse({ clientId: crypto.randomUUID(), body: '' })
    await refuse({ clientId: crypto.randomUUID(), body: '   \n  ' })
    await refuse({ clientId: crypto.randomUUID(), body: '​​' })
    await refuse({ clientId: crypto.randomUUID(), body: 'bad\u0000text' })
    await refuse({ clientId: crypto.randomUUID(), body: 'x'.repeat(5001) })
    await refuse({ clientId: crypto.randomUUID() })
    await refuse({ clientId: 'not-a-uuid', body: 'hi' })
    await refuse({ body: 'no client id' })
    const files = await send(alice, group.id, {
      clientId: crypto.randomUUID(),
      body: 'see file',
      attachmentIds: [crypto.randomUUID()],
    })
    expect(files.status).toBe(422)
    expect(
      (files.body as unknown as { error: { details: { field: string } } }).error.details.field,
    ).toBe('attachmentIds')
    // 5000 characters is fine, counted as characters rather than bytes: 5000 emoji are 10000 UTF-16 units.
    expect((await say(alice, group.id, '😀'.repeat(5000))).status).toBe(201)
    const tidy = await say(alice, group.id, 'line one\r\nline two\r\n\n  ')
    expect(tidy.body.message.body).toBe('line one\nline two')
    const code = await say(alice, group.id, '    indented code\n```js\nlet x = 1\n```')
    expect(code.body.message.body).toBe('    indented code\n```js\nlet x = 1\n```')
    expect(await dbs.owner.db.select().from(messages)).toHaveLength(3)
  })

  test('a silenced member cannot send until it ends; an archived conversation is read-only', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'quiet',
      memberIds: [bob.id],
    })
    const until = new Date(app.clock.now().getTime() + 3_600_000).toISOString()
    await alice.patch(`/api/conversations/${group.id}/members/${bob.id}`, { silencedUntil: until })
    const refused = await say(bob, group.id, 'hello?')
    expect(refused.status).toBe(403)
    expect(errorReason(refused)).toBe('silenced')
    app.clock.advance(3_600_001)
    expect((await say(bob, group.id, 'hello again')).status).toBe(201)

    await alice.post(`/api/conversations/${group.id}/archive`)
    const archived = await say(alice, group.id, 'too late')
    expect(archived.status).toBe(409)
    expect(errorReason(archived)).toBe('archived')
    expect((await page(alice, group.id)).status).toBe(200) // reading is still allowed
  })

  test('the per-conversation limit answers 429 with Retry-After; another conversation is unaffected', async () => {
    const alice = await person(app, 'alice')
    const one = await createConversation(alice, { kind: 'group', name: 'one' })
    const two = await createConversation(alice, { kind: 'group', name: 'two' })
    for (let i = 0; i < 10; i += 1) expect((await say(alice, one.id, `m${i}`)).status).toBe(201)
    const over = await say(alice, one.id, 'one too many')
    expect(over.status).toBe(429)
    expect(errorCode(over)).toBe('RATE_LIMITED')
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect((await say(alice, two.id, 'still fine')).status).toBe(201)
    expect(
      await dbs.owner.db.select().from(messages).where(eq(messages.conversationId, one.id)),
    ).toHaveLength(10)
  })
})

describe('replies (D-035, AT-03)', () => {
  test('a quote shows the sender and the first words; what is withdrawn shows only its state', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'quotes',
      memberIds: [bob.id],
    })
    const original = await say(alice, group.id, 'a'.repeat(150))
    const reply = await say(bob, group.id, 'agreed', { replyToId: original.body.message.id })
    expect(reply.status).toBe(201)
    expect(reply.body.message.replyTo).toEqual({
      id: original.body.message.id,
      seq: 1,
      senderId: alice.id,
      excerpt: 'a'.repeat(100),
      state: 'ok',
    })
    expect(reply.body.users[alice.id]).toBeDefined() // the quoted person is in the dictionary

    await alice.post(`/api/messages/${original.body.message.id}/recall`)
    const again = await page(bob, group.id)
    const quote = again.body.messages.find((m) => m.id === reply.body.message.id)?.replyTo
    expect(quote).toEqual({
      id: original.body.message.id,
      seq: 1,
      senderId: alice.id,
      excerpt: null,
      state: 'recalled',
    })
    // A withdrawn message cannot be replied to any more.
    expect(
      (await say(bob, group.id, 'too late', { replyToId: original.body.message.id })).status,
    ).toBe(422)
  })

  test('a quote of what a newcomer cannot see is a bare "unavailable", and asking about it reveals nothing (AT-03)', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const group = await createConversation(alice, { kind: 'group', name: 'history' })
    const secret = await say(alice, group.id, 'budget numbers from before bob joined')
    await alice.post(`/api/conversations/${group.id}/members`, { userIds: [bob.id] })
    const quoting = await say(alice, group.id, 'as I said above', {
      replyToId: secret.body.message.id,
    })
    expect(quoting.body.message.replyTo).toMatchObject({
      excerpt: 'budget numbers from before bob joined',
    })

    const asBob = await page(bob, group.id)
    expect(seqs(asBob)).toEqual([2, 3]) // the join note and the quoting message; nothing from before
    const bare = asBob.body.messages.find((m) => m.id === quoting.body.message.id)?.replyTo
    expect(bare).toEqual({ state: 'unavailable' })
    // Not the text, the id, the position or the sender of the old message is anywhere in what bob receives.
    const raw = JSON.stringify(asBob.body)
    for (const leak of ['budget', secret.body.message.id]) expect(raw).not.toContain(leak)
    expect(asBob.body.messages.map((m) => m.seq)).not.toContain(1)

    // Replying to it, to a message that does not exist, or to one from another conversation: the same answer.
    const other = await createConversation(alice, { kind: 'group', name: 'other' })
    const foreign = await say(alice, other.id, 'elsewhere')
    const probes = [secret.body.message.id, crypto.randomUUID(), foreign.body.message.id]
    const answers = await Promise.all(
      probes.map((replyToId) => say(bob, group.id, 'probe', { replyToId })),
    )
    for (const answer of answers) {
      expect(answer.status).toBe(422)
      expect(errorReason(answer)).toBe('unavailable')
    }
    expect(
      new Set(
        answers.map((a) =>
          JSON.stringify(
            (a.body as unknown as { error: { message: string; details: object } }).error.details,
          ),
        ),
      ).size,
    ).toBe(1)
    expect((await bob.get(`/api/messages/${secret.body.message.id}`)).status).toBe(404)
  })
})

describe('reading (INV-09, D-035)', () => {
  async function busyGroup() {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'archive',
      memberIds: [bob.id],
    })
    await seedMessages(dbs.owner.db, group.id, { count: 25, senderId: alice.id })
    return { alice, bob, group }
  }

  test('the newest page, and pages before, after and around an anchor, each with honest flags', async () => {
    const { alice, group } = await busyGroup()
    const latest = await page(alice, group.id, '?limit=10')
    expect(seqs(latest)).toEqual([16, 17, 18, 19, 20, 21, 22, 23, 24, 25])
    expect(latest.body).toMatchObject({ hasMoreBefore: true, hasMoreAfter: false })
    const before = await page(alice, group.id, '?beforeSeq=16&limit=5')
    expect(seqs(before)).toEqual([11, 12, 13, 14, 15])
    expect(before.body).toMatchObject({ hasMoreBefore: true, hasMoreAfter: true })
    const after = await page(alice, group.id, '?afterSeq=20&limit=10')
    expect(seqs(after)).toEqual([21, 22, 23, 24, 25])
    expect(after.body).toMatchObject({ hasMoreBefore: true, hasMoreAfter: false })
    const around = await page(alice, group.id, '?aroundSeq=12&limit=6')
    expect(seqs(around)).toEqual([9, 10, 11, 12, 13, 14])
    expect(around.body).toMatchObject({ hasMoreBefore: true, hasMoreAfter: true })
    const top = await page(alice, group.id, '?beforeSeq=3&limit=10')
    expect(seqs(top)).toEqual([1, 2])
    expect(top.body).toMatchObject({ hasMoreBefore: false, hasMoreAfter: true })
    const everything = await page(alice, group.id, '?limit=100')
    expect(everything.body.messages).toHaveLength(25)
    expect(everything.body).toMatchObject({ hasMoreBefore: false, hasMoreAfter: false })
    // Ascending, one dictionary for all senders.
    expect(Object.keys(everything.body.users)).toEqual([alice.id])
    for (const bad of [
      '?beforeSeq=5&afterSeq=2',
      '?limit=0',
      '?limit=101',
      '?beforeSeq=0',
      '?aroundSeq=abc',
    ]) {
      expect((await page(alice, group.id, bad)).status).toBe(422)
    }
  })

  test('a newcomer sees nothing from before they joined, however they ask (INV-09)', async () => {
    const { alice, group } = await busyGroup()
    const carol = await person(app, 'carol')
    await alice.post(`/api/conversations/${group.id}/members`, { userIds: [carol.id] })
    // 25 messages, then the join note (26); carol's boundary is 25.
    expect(seqs(await page(carol, group.id))).toEqual([26])
    for (const query of [
      '?beforeSeq=26',
      '?aroundSeq=10',
      '?afterSeq=0',
      '?beforeSeq=100&limit=100',
      '?aroundSeq=25&limit=100',
    ]) {
      const reply = await page(carol, group.id, query)
      expect(reply.status).toBe(200)
      expect(reply.body.messages.every((m) => m.seq > 25)).toBe(true)
    }
    expect((await page(carol, group.id, '?beforeSeq=26')).body).toMatchObject({
      messages: [],
      hasMoreBefore: false,
    })
    await seedMessages(dbs.owner.db, group.id, { count: 2, senderId: alice.id })
    expect(seqs(await page(carol, group.id))).toEqual([26, 27, 28])
    const old = await dbs.owner.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, group.id), eq(messages.seq, 10)))
    expect((await carol.get(`/api/messages/${old[0]?.id}`)).status).toBe(404)
    expect((await alice.get(`/api/messages/${old[0]?.id}`)).status).toBe(200)
    // Her list preview and unread count follow the same boundary.
    const mine = await listed(carol, group.id)
    expect(mine?.me).toMatchObject({ visibleFromSeq: 25, unread: 3 })
    // Leaving and coming back moves the boundary up again: the gap between is never visible.
    await carol.post(`/api/conversations/${group.id}/leave`)
    await seedMessages(dbs.owner.db, group.id, { count: 3, senderId: alice.id })
    await alice.post(`/api/conversations/${group.id}/members`, { userIds: [carol.id] })
    // 25 messages, 2 more, her "left" note (29), 3 more (32), then her new "joined" note (33).
    expect(seqs(await page(carol, group.id))).toEqual([33])
  })

  test('hiding is the reader’s own: others keep seeing the message; the preview moves back one', async () => {
    const { alice, bob, group } = await busyGroup()
    const [last] = await dbs.owner.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, group.id), eq(messages.seq, 25)))
    expect((await bob.post(`/api/messages/${last?.id}/hide`)).status).toBe(200)
    expect((await page(bob, group.id, '?limit=2')).body.messages.map((m) => m.seq)).toEqual([
      23, 24,
    ])
    expect((await page(alice, group.id, '?limit=2')).body.messages.map((m) => m.seq)).toEqual([
      24, 25,
    ])
    expect((await bob.get(`/api/messages/${last?.id}`)).status).toBe(404)
    expect((await alice.get(`/api/messages/${last?.id}`)).status).toBe(200)
    expect((await listed(bob, group.id))?.lastMessagePreview?.text).toBe('m24')
    expect((await listed(alice, group.id))?.lastMessagePreview?.text).toBe('m25')
    expect((await bob.post(`/api/messages/${last?.id}/hide`)).status).toBe(200) // twice is fine
    const refused = await page(bob, group.id, '?beforeSeq=26&limit=1')
    expect(seqs(refused)).toEqual([24]) // the hidden one is skipped, not counted
    expect(refused.body.hasMoreAfter).toBe(false)
  })

  test('one message by id: the reader’s own view, 404 for everyone else', async () => {
    const { alice, bob, group } = await busyGroup()
    const mallory = await person(app, 'mallory')
    const [row] = await dbs.owner.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, group.id), eq(messages.seq, 7)))
    const mine = await alice.get<MessageEnvelope>(`/api/messages/${row?.id}`)
    expect(mine.status).toBe(200)
    expect(mine.body.message).toMatchObject({ seq: 7, body: 'm7' })
    expect((await mallory.get(`/api/messages/${row?.id}`)).status).toBe(404)
    expect((await bob.get(`/api/messages/${crypto.randomUUID()}`)).status).toBe(404)
    expect((await app.request(`/api/messages/${row?.id}`)).status).toBe(401)
  })
})

describe('direct messages', () => {
  test('the first message brings the conversation into view for the other person, and again after they hid it', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const dm = await openDm(alice, bob)
    expect((await listed(bob, dm.id))?.me?.hiddenAt).not.toBeNull()
    const first = await say(alice, dm.id, 'hi bob')
    expect(first.status).toBe(201)
    const seen = await listed(bob, dm.id)
    expect(seen?.me).toMatchObject({ hiddenAt: null, unread: 1 })
    expect(seen?.lastMessagePreview?.text).toBe('hi bob')

    await bob.patch(`/api/conversations/${dm.id}/me`, {
      expectedViewerVersion: seen?.viewerVersion,
      hidden: true,
    })
    expect((await listed(bob, dm.id))?.me?.hiddenAt).not.toBeNull()
    await say(alice, dm.id, 'still there?')
    expect((await listed(bob, dm.id))?.me?.hiddenAt).toBeNull()
    // Writing into a DM one has hidden brings it back for oneself.
    const mine = await listed(alice, dm.id)
    await alice.patch(`/api/conversations/${dm.id}/me`, {
      expectedViewerVersion: mine?.viewerVersion,
      hidden: true,
    })
    await say(alice, dm.id, 'me again')
    expect((await listed(alice, dm.id))?.me?.hiddenAt).toBeNull()
  })

  test('nobody can write to someone whose account is gone, but the history stays readable', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const dm = await openDm(alice, bob)
    await say(alice, dm.id, 'before')
    await dbs.owner.db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, bob.id))
    const refused = await say(alice, dm.id, 'after')
    expect(refused.status).toBe(403)
    expect(errorReason(refused)).toBe('peer_unavailable')
    expect(seqs(await page(alice, dm.id))).toEqual([1])
    expect((await listed(alice, dm.id))?.dmPeer?.deleted).toBe(true)
  })
})

describe('system lines', () => {
  test('groups note joins, leaves, removals, renames and hand-overs; they have no sender and never read for anyone', async () => {
    const alice = await person(app, 'alice')
    const [bob, carol] = await Promise.all([person(app, 'bob'), person(app, 'carol')])
    const group = await createConversation(alice, { kind: 'group', name: 'notes' })
    await alice.post(`/api/conversations/${group.id}/members`, { userIds: [bob.id, carol.id] })
    await carol.post(`/api/conversations/${group.id}/leave`)
    await alice.del(`/api/conversations/${group.id}/members/${bob.id}`)
    await alice.post(`/api/conversations/${group.id}/members`, { userIds: [bob.id] })
    await alice.post(`/api/conversations/${group.id}/transfer`, { userId: bob.id })

    const lines = (await page(bob, group.id)).body.messages
    expect(lines.every((m) => m.kind === 'system' && m.senderId === null && m.body === null)).toBe(
      true,
    )
    const events = (
      await dbs.owner.db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, group.id))
        .orderBy(asc(messages.seq))
    ).map((row) => row.meta.system?.type)
    expect(events).toEqual([
      'member_joined',
      'member_joined',
      'member_left',
      'member_removed',
      'member_joined',
      'owner_transferred',
    ])
    const removed = (
      await dbs.owner.db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, group.id))
        .orderBy(asc(messages.seq))
    )[3]
    expect(removed?.meta.system).toEqual({
      type: 'member_removed',
      userId: bob.id,
      actorId: alice.id,
      banned: false,
    })
    // The people they mention are in the dictionary, so the client can word them with current names.
    const response = (await page(bob, group.id)).body
    expect(Object.keys(response.users).sort()).toEqual([alice.id, bob.id].sort())
    // Nothing a system line does moves a reading position: six lines were written and the owner has read none.
    expect((await conv(alice, group.id)).me).toMatchObject({ lastReadSeq: 0, unread: 6 })
    expect(response.messages.map((m) => m.seq)).toEqual([5, 6]) // bob came back at the end, so sees only the last two
  })

  test('channels skip joins and leaves but note renames and removals', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const channel = await createConversation(alice, { kind: 'channel', name: 'Quiet Hall' })
    await bob.post(`/api/conversations/${channel.id}/join`)
    await bob.post(`/api/conversations/${channel.id}/leave`)
    expect((await conv(alice, channel.id)).lastSeq).toBe(0)
    await alice.patch(`/api/conversations/${channel.id}`, {
      expectedMetadataVersion: (await conv(alice, channel.id)).metadataVersion,
      name: 'Loud Hall',
    })
    await bob.post(`/api/conversations/${channel.id}/join`)
    await alice.del(`/api/conversations/${channel.id}/members/${bob.id}`)
    const events = (
      await dbs.owner.db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, channel.id))
        .orderBy(asc(messages.seq))
    ).map((row) => row.meta.system?.type)
    expect(events).toEqual(['conversation_renamed', 'member_removed'])
    const lines = await page(alice, channel.id)
    expect(lines.body.messages.map((m: Message) => m.kind)).toEqual(['system', 'system'])
  })

  test('a direct message has none, and the preview of a conversation can be a system line', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const dm = await openDm(alice, bob)
    expect((await conv(alice, dm.id)).lastSeq).toBe(0)
    const group = await createConversation(alice, { kind: 'group', name: 'preview' })
    await alice.post(`/api/conversations/${group.id}/members`, { userIds: [bob.id] })
    expect((await listed(alice, group.id))?.lastMessagePreview).toEqual({
      senderId: null,
      text: null,
      kind: 'system',
      state: 'ok',
    })
  })
})

describe('the list and the preview', () => {
  test('conversations come back pinned first, then by latest activity, with each person’s own unread count and preview', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const quiet = await createConversation(alice, {
      kind: 'group',
      name: 'quiet',
      memberIds: [bob.id],
    })
    const lively = await createConversation(alice, {
      kind: 'group',
      name: 'lively',
      memberIds: [bob.id],
    })
    const pinned = await createConversation(alice, {
      kind: 'group',
      name: 'pinned',
      memberIds: [bob.id],
    })
    app.clock.advance(1000)
    await say(alice, quiet.id, 'first')
    app.clock.advance(1000)
    await say(alice, lively.id, 'second')
    await say(alice, lively.id, 'third')
    // The version is the reader's own: the one in alice's copy is not bob's.
    await bob.patch(`/api/conversations/${pinned.id}/me`, {
      expectedViewerVersion: (await conv(bob, pinned.id)).viewerVersion,
      pinned: true,
    })

    const order = (await bob.get<ConversationListResponse>('/api/conversations')).body.conversations
    expect(order.map((c) => c.name)).toEqual(['pinned', 'lively', 'quiet'])
    expect(order.map((c) => c.me?.unread)).toEqual([0, 2, 1])
    expect(order[1]?.lastMessagePreview).toEqual({
      senderId: alice.id,
      text: 'third',
      kind: 'user',
      state: 'ok',
    })
    // Alice wrote everything she sees as unread; the preview is hers too.
    const mine = (await alice.get<ConversationListResponse>('/api/conversations')).body
      .conversations
    expect(mine.map((c) => c.me?.unread)).toEqual([0, 0, 0])
    const [row] = await dbs.owner.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, lively.id))
    expect(row?.lastSeq).toBe(2)
  })
})
