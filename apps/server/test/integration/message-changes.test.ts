/**
 * Editing, recalling, hiding and deleting messages, and the read position (docs/05 sections 3.3 and 3.4, docs/01 section
 * 4.5, M2a): the time windows on an injected clock (L-07), conditional edits (D-082), what a withdrawal clears (INV-06),
 * who may delete whose messages (L-20), and which sends move a person's read position (INV-08, INV-28, AT-32).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type {
  Conversation,
  ConversationListResponse,
  MessageEnvelope,
  MessagesResponse,
} from '@chatapp/contracts'
import {
  auditLogs,
  conversationChanges,
  conversationMembers,
  conversations,
  messages,
  sessions,
} from '@chatapp/db'
import { and, asc, eq } from 'drizzle-orm'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createTestApp, type TestApp } from '../support/http.ts'
import { seedMessages } from '../support/messages.ts'
import {
  createConversation,
  errorCode,
  errorReason,
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

const MINUTE = 60_000
const HOUR = 60 * MINUTE

const say = (who: Person, conversationId: string, text: string) =>
  who.post<MessageEnvelope>(`/api/conversations/${conversationId}/messages`, {
    clientId: crypto.randomUUID(),
    body: text,
  })
const edit = (who: Person, id: string, body: string, expectedChangeSeq: number) =>
  who.patch<MessageEnvelope>(`/api/messages/${id}`, { body, expectedChangeSeq })
const conv = async (who: Person, id: string) =>
  (await who.get<Conversation>(`/api/conversations/${id}`)).body
const messagesOf = async (who: Person, id: string) =>
  (await who.get<MessagesResponse>(`/api/conversations/${id}/messages`)).body.messages

async function pair() {
  const alice = await person(app, 'alice')
  const bob = await person(app, 'bob')
  const group = await createConversation(alice, {
    kind: 'group',
    name: 'edits',
    memberIds: [bob.id],
  })
  return { alice, bob, group }
}

describe('editing', () => {
  test('the author changes the text; the message moves to a new change number, is marked edited and logged (INV-02)', async () => {
    const { alice, bob, group } = await pair()
    const sent = await say(alice, group.id, 'teh text')
    const original = sent.body.message
    app.clock.advance(MINUTE)
    const edited = await edit(alice, original.id, 'the text', original.changeSeq)
    expect(edited.status).toBe(200)
    expect(edited.body.message).toMatchObject({
      id: original.id,
      seq: original.seq,
      body: 'the text',
      changeSeq: original.changeSeq + 1,
      editedAt: app.clock.now().toISOString(),
    })
    expect((await conv(alice, group.id)).lastChangeSeq).toBe(2)
    expect((await conv(alice, group.id)).lastSeq).toBe(1) // an edit is not a new message
    expect((await messagesOf(bob, group.id))[0]?.body).toBe('the text')
    const log = await dbs.owner.db
      .select()
      .from(conversationChanges)
      .where(eq(conversationChanges.conversationId, group.id))
      .orderBy(asc(conversationChanges.changeSeq))
    expect(log.map((l) => [l.changeSeq, l.messageId, l.kind])).toEqual([
      [1, original.id, 'message_created'],
      [2, original.id, 'message_edited'],
    ])
    const [row] = await dbs.owner.db.select().from(messages).where(eq(messages.id, original.id))
    expect(row?.contentVersion).toBe(2)
    // Saying the same thing changes nothing: no new number, no log entry.
    const same = await edit(alice, original.id, 'the text', edited.body.message.changeSeq)
    expect(same.status).toBe(200)
    expect(same.body.message.changeSeq).toBe(edited.body.message.changeSeq)
    expect(await dbs.owner.db.select().from(conversationChanges)).toHaveLength(2)
  })

  test('a stale change number is a conflict that says what the number is now; two simultaneous edits: one wins', async () => {
    const { alice, group } = await pair()
    const sent = (await say(alice, group.id, 'v1')).body.message
    const [one, two] = await Promise.all([
      edit(alice, sent.id, 'from device one', 1),
      edit(alice, sent.id, 'from device two', 1),
    ])
    expect([one.status, two.status].sort()).toEqual([200, 409])
    const loser = one.status === 409 ? one : two
    expect(errorCode(loser)).toBe('VERSION_CONFLICT')
    expect(
      (loser.body as unknown as { error: { details: { changeSeq: number } } }).error.details
        .changeSeq,
    ).toBe(2)
    expect((await messagesOf(alice, group.id))[0]?.changeSeq).toBe(2)
    const stale = await edit(alice, sent.id, 'late', 1)
    expect(stale.status).toBe(409)
  })

  test('only the author, only for 24 hours, only while the message exists and the author may write', async () => {
    const { alice, bob, group } = await pair()
    const sent = (await say(alice, group.id, 'mine')).body.message
    const other = await edit(bob, sent.id, 'hijacked', 1)
    expect(other.status).toBe(403)
    expect(errorReason(other)).toBe('not_author')

    app.clock.advance(24 * HOUR + 1000)
    const late = await edit(alice, sent.id, 'much later', 1)
    expect(late.status).toBe(403)
    expect(errorCode(late)).toBe('WINDOW_EXPIRED')
    expect((await messagesOf(alice, group.id))[0]?.body).toBe('mine')

    const fresh = (await say(alice, group.id, 'fresh')).body.message
    await alice.post(`/api/messages/${fresh.id}/recall`)
    const gone = await edit(alice, fresh.id, 'revived', 1)
    expect(gone.status).toBe(409)
    expect(errorReason(gone)).toBe('gone')
  })

  test('a silenced author, a stranger and an archived conversation cannot edit', async () => {
    const { alice, bob, group } = await pair()
    const mallory = await person(app, 'mallory')
    const word = (await say(bob, group.id, 'mine, bob')).body.message
    const until = new Date(app.clock.now().getTime() + HOUR).toISOString()
    await alice.patch(`/api/conversations/${group.id}/members/${bob.id}`, { silencedUntil: until })
    const silenced = await edit(bob, word.id, 'rewritten', word.changeSeq)
    expect(silenced.status).toBe(403)
    expect(errorReason(silenced)).toBe('silenced')
    expect((await edit(mallory, word.id, 'hijack', 1)).status).toBe(404)
    await alice.patch(`/api/conversations/${group.id}/members/${bob.id}`, { silencedUntil: null })
    await alice.post(`/api/conversations/${group.id}/archive`)
    const archived = await edit(bob, word.id, 'rewritten', word.changeSeq)
    expect(archived.status).toBe(409)
    expect(errorReason(archived)).toBe('archived')
    expect((await messagesOf(bob, group.id))[0]?.body).toBe('mine, bob')
  })

  test('the text rules apply to edits too; system lines and other people’s messages are out of reach', async () => {
    const { alice, group } = await pair()
    const sent = (await say(alice, group.id, 'fine')).body.message
    for (const bad of ['', '   ', 'x'.repeat(5001), 'nul\u0000']) {
      expect((await edit(alice, sent.id, bad, 1)).status).toBe(422)
    }
    expect((await alice.patch(`/api/messages/${sent.id}`, { body: 'x' })).status).toBe(422) // no expectedChangeSeq
    expect(
      (
        await alice.patch(`/api/messages/${sent.id}`, {
          body: 'x',
          expectedChangeSeq: 1,
          senderId: alice.id,
        })
      ).status,
    ).toBe(422)
    const [system] = await seedMessages(dbs.owner.db, group.id, { count: 1, senderId: null })
    const [line] = await dbs.owner.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, group.id), eq(messages.seq, system ?? 0)))
    expect((await edit(alice, line?.id ?? '', 'tamper', 1)).status).toBe(403)
  })
})

describe('recalling (L-07, INV-06)', () => {
  test('within two minutes the text is cleared for everybody and a repeat returns the same end state', async () => {
    const { alice, bob, group } = await pair()
    const sent = (await say(alice, group.id, 'oops wrong chat')).body.message
    app.clock.advance(MINUTE)
    const recalled = await alice.post<MessageEnvelope>(`/api/messages/${sent.id}/recall`)
    expect(recalled.status).toBe(200)
    expect(recalled.body.message).toMatchObject({
      body: null,
      recalledAt: app.clock.now().toISOString(),
      changeSeq: sent.changeSeq + 1,
      seq: sent.seq,
    })
    const [row] = await dbs.owner.db.select().from(messages).where(eq(messages.id, sent.id))
    expect(row?.body).toBeNull() // gone from the table, not only from the response (INV-06)
    expect(JSON.stringify(await dbs.owner.db.select().from(messages))).not.toContain(
      'oops wrong chat',
    )
    expect((await messagesOf(bob, group.id))[0]).toMatchObject({
      body: null,
      kind: 'user',
      senderId: alice.id,
    })
    expect((await conv(bob, group.id)).lastMessagePreview).toEqual({
      senderId: alice.id,
      text: null,
      kind: 'user',
      state: 'recalled',
    })

    const again = await alice.post<MessageEnvelope>(`/api/messages/${sent.id}/recall`)
    expect(again.status).toBe(200)
    expect(again.body.message.changeSeq).toBe(recalled.body.message.changeSeq)
    app.clock.advance(HOUR) // even long after the window, repeating an accepted recall is the same answer
    expect((await alice.post(`/api/messages/${sent.id}/recall`)).status).toBe(200)
    const log = await dbs.owner.db
      .select()
      .from(conversationChanges)
      .where(eq(conversationChanges.messageId, sent.id))
      .orderBy(asc(conversationChanges.changeSeq))
    expect(log.map((l) => l.kind)).toEqual(['message_created', 'message_recalled'])
  })

  test('after two minutes and five seconds of grace the answer is WINDOW_EXPIRED; three minutes is certainly late (L-07)', async () => {
    const { alice, group } = await pair()
    const a = (await say(alice, group.id, 'at the edge')).body.message
    app.clock.advance(2 * MINUTE + 5_000)
    expect((await alice.post(`/api/messages/${a.id}/recall`)).status).toBe(200) // the grace covers the network

    const b = (await say(alice, group.id, 'just too late')).body.message
    app.clock.advance(2 * MINUTE + 5_001)
    const late = await alice.post(`/api/messages/${b.id}/recall`)
    expect(late.status).toBe(403)
    expect(errorCode(late)).toBe('WINDOW_EXPIRED')

    const c = (await say(alice, group.id, 'three minutes ago')).body.message
    app.clock.advance(3 * MINUTE)
    expect(errorCode(await alice.post(`/api/messages/${c.id}/recall`))).toBe('WINDOW_EXPIRED')
    const bodies = (await messagesOf(alice, group.id)).map((m) => m.body)
    expect(bodies).toEqual([null, 'just too late', 'three minutes ago'])
  })

  test('only the author recalls; strangers find nothing; a recalled message cannot be quoted or edited', async () => {
    const { alice, bob, group } = await pair()
    const mallory = await person(app, 'mallory')
    const sent = (await say(alice, group.id, 'mine')).body.message
    const other = await bob.post(`/api/messages/${sent.id}/recall`)
    expect(other.status).toBe(403)
    expect(errorReason(other)).toBe('not_author')
    expect((await mallory.post(`/api/messages/${sent.id}/recall`)).status).toBe(404)
    expect((await alice.post(`/api/messages/${crypto.randomUUID()}/recall`)).status).toBe(404)
    expect((await app.request(`/api/messages/${sent.id}/recall`, { method: 'POST' })).status).toBe(
      401,
    )
    expect((await messagesOf(bob, group.id))[0]?.body).toBe('mine')
  })
})

describe('deleting for me and for everybody (L-20)', () => {
  test('delete for me hides it from that reader only and tells their other devices', async () => {
    const { alice, bob, group } = await pair()
    const sent = (await say(alice, group.id, 'noisy')).body.message
    expect((await bob.post(`/api/messages/${sent.id}/hide`)).status).toBe(200)
    expect(await messagesOf(bob, group.id)).toEqual([])
    expect((await messagesOf(alice, group.id))[0]?.body).toBe('noisy')
    expect((await conv(bob, group.id)).lastMessagePreview).toBeNull()
    // It is a view preference: the sender can still recall it for everyone, and hiding it twice is fine.
    expect((await bob.post(`/api/messages/${sent.id}/hide`)).status).toBe(200)
    expect((await alice.post(`/api/messages/${sent.id}/recall`)).status).toBe(200)
    const mine = (
      await bob.get<{ items: Array<{ type: string; messageId?: string }>; through: number }>(
        '/api/me/changes?after=0',
      )
    ).body
    expect(mine.items.filter((i) => i.type === 'message.hidden').map((i) => i.messageId)).toEqual([
      sent.id,
    ])
    const mallory = await person(app, 'mallory')
    expect((await mallory.post(`/api/messages/${sent.id}/hide`)).status).toBe(404)
  })

  test('the owner, an administrator and a site administrator delete others’ messages; a member cannot', async () => {
    const { alice, bob, group } = await pair()
    const carol = await person(app, 'carol')
    const boss = await person(app, 'boss', { role: 'admin' })
    await alice.post(`/api/conversations/${group.id}/members`, { userIds: [carol.id] })
    await alice.patch(`/api/conversations/${group.id}/members/${carol.id}`, { role: 'admin' })
    const byBob = (await say(bob, group.id, 'bob one')).body.message
    const byBob2 = (await say(bob, group.id, 'bob two')).body.message
    const byBob3 = (await say(bob, group.id, 'bob three')).body.message

    const asMember = await bob.del(
      `/api/messages/${(await say(alice, group.id, 'alice says')).body.message.id}`,
    )
    expect(asMember.status).toBe(403)
    expect(errorReason(asMember)).toBe('requires_admin')
    expect((await carol.del(`/api/messages/${byBob.id}`)).status).toBe(200) // administrator
    expect((await alice.del(`/api/messages/${byBob2.id}`)).status).toBe(200) // owner
    expect((await boss.del(`/api/messages/${byBob3.id}`)).status).toBe(200) // site administrator, not a member

    const rows = await dbs.owner.db
      .select()
      .from(messages)
      .where(eq(messages.senderId, bob.id))
      .orderBy(asc(messages.seq))
    expect(
      rows.every((r) => r.body === null && r.deletedAt !== null && r.recalledAt === null),
    ).toBe(true)
    expect(rows.map((r) => r.deletedBy)).toEqual([carol.id, alice.id, boss.id])
    const seen = await messagesOf(alice, group.id)
    expect(
      seen.filter((m) => m.senderId === bob.id).map((m) => [m.body, m.deletedAt !== null]),
    ).toEqual([
      [null, true],
      [null, true],
      [null, true],
    ])
    const audits = (await dbs.owner.db.select().from(auditLogs)).filter(
      (a) => a.action === 'message.delete',
    )
    expect(audits.map((a) => a.actorId).sort()).toEqual([carol.id, alice.id, boss.id].sort())
    // Ids and flags only; the text is neither in the log nor in the table any more.
    expect(JSON.stringify(audits)).not.toContain('bob one')
    expect(JSON.stringify(await dbs.owner.db.select().from(messages))).not.toContain('bob two')
    // Repeating, and deleting what the author already recalled, change nothing.
    expect((await alice.del(`/api/messages/${byBob2.id}`)).status).toBe(200)
    expect(
      (await dbs.owner.db.select().from(auditLogs)).filter((a) => a.action === 'message.delete'),
    ).toHaveLength(3)
    expect((await conv(bob, group.id)).lastMessagePreview?.state).toBe('ok') // alice's own line is the newest
  })

  test('system lines cannot be deleted, a stranger cannot delete anything, an archived conversation is frozen', async () => {
    const { alice, bob, group } = await pair()
    const mallory = await person(app, 'mallory')
    const [seq] = await seedMessages(dbs.owner.db, group.id, { count: 1, senderId: null })
    const [line] = await dbs.owner.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, group.id), eq(messages.seq, seq ?? 0)))
    const refused = await alice.del(`/api/messages/${line?.id}`)
    expect(refused.status).toBe(403)
    expect(errorReason(refused)).toBe('not_deletable')
    const sent = (await say(bob, group.id, 'bob')).body.message
    expect((await mallory.del(`/api/messages/${sent.id}`)).status).toBe(404)
    await alice.post(`/api/conversations/${group.id}/archive`)
    const frozen = await alice.del(`/api/messages/${sent.id}`)
    expect(frozen.status).toBe(409)
    expect(errorReason(frozen)).toBe('archived')
    expect((await alice.del(`/api/messages/${crypto.randomUUID()}`)).status).toBe(404)
  })

  test('after a rename, nobody who takes over an old username can delete or recall the earlier person’s messages (L-20)', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'names',
      memberIds: [bob.id],
    })
    const sent = (await say(alice, group.id, 'alice speaking')).body.message
    const renamed = await alice.patch('/api/me', {
      expectedMeVersion: (await alice.get<{ meVersion: number }>('/api/me')).body.meVersion,
      username: 'alice_new',
    })
    expect(renamed.status).toBe(200)
    // The sessions last 30 days by the real clock; the test clock is about to jump past that.
    await dbs.owner.db.update(sessions).set({ expiresAt: new Date(Date.now() + 120 * 24 * HOUR) })
    app.clock.advance(31 * 24 * HOUR)
    const take = await bob.patch('/api/me', {
      expectedMeVersion: (await bob.get<{ meVersion: number }>('/api/me')).body.meVersion,
      username: 'alice',
    })
    expect(take.status).toBe(200)
    // Bob now carries the name "alice", and messages are tied to the account, not to the name.
    const del = await bob.del(`/api/messages/${sent.id}`)
    expect([403, 404]).toContain(del.status)
    const recall = await bob.post(`/api/messages/${sent.id}/recall`)
    expect([403, 404]).toContain(recall.status)
    expect((await messagesOf(alice, group.id))[0]).toMatchObject({
      body: 'alice speaking',
      senderId: alice.id,
    })
  })
})

describe('the read position (INV-08, INV-28, AT-32)', () => {
  test('moves forward only, never past the last message, and changes no version when nothing moved', async () => {
    const { alice, bob, group } = await pair()
    await seedMessages(dbs.owner.db, group.id, { count: 30, senderId: alice.id })
    const fresh = await conv(bob, group.id)
    expect(fresh.me).toMatchObject({ lastReadSeq: 0, unread: 30 })

    const to10 = await bob.post<Conversation>(`/api/conversations/${group.id}/read`, { seq: 10 })
    expect(to10.body.me).toMatchObject({ lastReadSeq: 10, unread: 20 })
    expect(to10.body.viewerVersion).toBeGreaterThan(fresh.viewerVersion)
    const back = await bob.post<Conversation>(`/api/conversations/${group.id}/read`, { seq: 3 })
    expect(back.body.me?.lastReadSeq).toBe(10)
    expect(back.body.viewerVersion).toBe(to10.body.viewerVersion)
    const beyond = await bob.post<Conversation>(`/api/conversations/${group.id}/read`, {
      seq: 9_999,
    })
    expect(beyond.body.me).toMatchObject({ lastReadSeq: 30, unread: 0 })
    const [row] = await dbs.owner.db
      .select()
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, group.id),
          eq(conversationMembers.userId, bob.id),
        ),
      )
    expect(row?.lastReadSeq).toBe(30) // INV-08: visible_from <= last_read <= last_seq
    expect((await bob.post(`/api/conversations/${group.id}/read`, { seq: -1 })).status).toBe(422)
    expect((await bob.post(`/api/conversations/${group.id}/read`, { seq: 1.5 })).status).toBe(422)
    expect(
      (await bob.post(`/api/conversations/${group.id}/read`, { seq: 5, userId: alice.id })).status,
    ).toBe(422)
    // Reading is one's own: another person's position cannot be moved, and strangers have none.
    expect(
      (await alice.get<Conversation>(`/api/conversations/${group.id}`)).body.me?.lastReadSeq,
    ).toBe(0)
    const mallory = await person(app, 'mallory')
    expect((await mallory.post(`/api/conversations/${group.id}/read`, { seq: 5 })).status).toBe(404)
  })

  test('read 50 of 100, then a background send as 101: still 50, unread 51; an interactive send moves it (AT-32)', async () => {
    const { alice, bob, group } = await pair()
    await seedMessages(dbs.owner.db, group.id, { count: 100, senderId: bob.id })
    expect(
      (await alice.post<Conversation>(`/api/conversations/${group.id}/read`, { seq: 50 })).body.me
        ?.lastReadSeq,
    ).toBe(50)
    // An assistant, a scheduled message, a reminder or an offline replay writes as alice but does not read for her.
    for (const executionSource of ['agent_effect', 'scheduled', 'offline_replay'] as const) {
      await seedMessages(dbs.owner.db, group.id, { count: 1, senderId: alice.id, executionSource })
    }
    const view = await conv(alice, group.id)
    expect(view.lastSeq).toBe(103)
    expect(view.me).toMatchObject({ lastReadSeq: 50, unread: 53 })
    // A system line moves nothing either.
    await seedMessages(dbs.owner.db, group.id, { count: 1, senderId: null })
    expect((await conv(alice, group.id)).me?.lastReadSeq).toBe(50)
    // Her own interactive send (the HTTP endpoint, which sets the source itself) does read for her.
    const sent = await say(alice, group.id, 'I am here now')
    expect(sent.body.message.seq).toBe(105)
    expect((await conv(alice, group.id)).me).toMatchObject({ lastReadSeq: 105, unread: 0 })
    // The request cannot claim a different source.
    const claimed = await alice.post(`/api/conversations/${group.id}/messages`, {
      clientId: crypto.randomUUID(),
      body: 'pretend I am scheduled',
      executionSource: 'scheduled',
    })
    expect(claimed.status).toBe(422)
  })

  test('the numbers in the list follow it, and a conversation read to its end shows no unread', async () => {
    const { alice, bob, group } = await pair()
    await seedMessages(dbs.owner.db, group.id, { count: 120, senderId: alice.id })
    const before = (
      await bob.get<ConversationListResponse>('/api/conversations')
    ).body.conversations.find((c) => c.id === group.id)
    expect(before?.me?.unread).toBe(120)
    await bob.post(`/api/conversations/${group.id}/read`, { seq: 120 })
    const after = (
      await bob.get<ConversationListResponse>('/api/conversations')
    ).body.conversations.find((c) => c.id === group.id)
    expect(after?.me?.unread).toBe(0)
    // New messages count from where the position is.
    await seedMessages(dbs.owner.db, group.id, { count: 4, senderId: alice.id })
    expect((await conv(bob, group.id)).me?.unread).toBe(4)
    expect(
      (await dbs.owner.db.select().from(conversations).where(eq(conversations.id, group.id)))[0]
        ?.lastSeq,
    ).toBe(124)
  })
})
