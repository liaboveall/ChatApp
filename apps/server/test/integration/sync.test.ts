/**
 * The sync feeds over HTTP (docs/05 section 4.5, docs/03 section 5.2, M2a): a conversation's change log with a fixed
 * upper bound, a person's own log, the heads, and the reset snapshots. Covers AT-01 (every change leaves a durable
 * trace, atomically), AT-03 (nothing from before the join), AT-12 (filtered pages still advance, observed never passes
 * synced) and AT-31 (versions that never go backwards, tombstones that never resurrect).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type {
  Conversation,
  ConversationChangesResponse,
  MessageEnvelope,
  SyncHeadsResponse,
  UserChangesResponse,
} from '@chatapp/contracts'
import {
  conversationChanges,
  conversationMembers,
  conversations,
  messages,
  userChanges,
  userConversationStates,
  users,
  workItems,
} from '@chatapp/db'
import { and, asc, eq } from 'drizzle-orm'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { injectInsertFailure } from '../support/deps.ts'
import { createTestApp, type TestApp } from '../support/http.ts'
import { seedMessages } from '../support/messages.ts'
import { createConversation, errorCode, type Person, person } from '../support/people.ts'

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

const feed = (who: Person, id: string, query: string) =>
  who.get<ConversationChangesResponse>(`/api/conversations/${id}/changes?${query}`)
const mine = (who: Person, query: string) =>
  who.get<UserChangesResponse>(`/api/me/changes?${query}`)
const cursorOf = (reply: { body: { nextCursor: string | null } }) =>
  encodeURIComponent(reply.body.nextCursor ?? '')
const conv = async (who: Person, id: string) =>
  (await who.get<Conversation>(`/api/conversations/${id}`)).body
const say = (who: Person, id: string, text: string) =>
  who.post<MessageEnvelope>(`/api/conversations/${id}/messages`, {
    clientId: crypto.randomUUID(),
    body: text,
  })

async function group(members = 1) {
  const alice = await person(app, 'alice')
  const others = await Promise.all(
    Array.from({ length: members }, (_, i) => person(app, `member${i}`)),
  )
  const created = await createConversation(alice, {
    kind: 'group',
    name: 'feed',
    memberIds: others.map((p) => p.id),
  })
  return { alice, others, id: created.id, created }
}

describe('a conversation’s log: pages with a fixed upper bound (AT-12)', () => {
  test('the first page reads from `after` to the head, later pages continue from the cursor and end at the same head', async () => {
    const { alice, id } = await group(0)
    await seedMessages(dbs.owner.db, id, { count: 250, senderId: alice.id })
    const first = await feed(alice, id, 'after=0&limit=100')
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({
      scannedThrough: 100,
      through: 250,
      resetRequired: false,
      baseline: null,
    })
    expect(first.body.items).toHaveLength(100)
    expect(first.body.nextCursor).not.toBeNull()
    const second = await feed(alice, id, `cursor=${cursorOf(first)}&limit=100`)
    expect(second.body).toMatchObject({ scannedThrough: 200, through: 250 })
    const third = await feed(alice, id, `cursor=${cursorOf(second)}`)
    expect(third.body).toMatchObject({ scannedThrough: 250, through: 250, nextCursor: null })
    const all = [...first.body.items, ...second.body.items, ...third.body.items]
    expect(all.map((m) => m.seq)).toEqual(Array.from({ length: 250 }, (_, i) => i + 1))
    expect(third.body.membershipId).toBe(first.body.membershipId)
    // From the head there is nothing: scannedThrough is the head itself.
    const caughtUp = await feed(alice, id, 'after=250')
    expect(caughtUp.body).toMatchObject({
      items: [],
      tombstones: [],
      scannedThrough: 250,
      through: 250,
      nextCursor: null,
    })
  })

  test('a page whose entries are all filtered out still advances the scan; history before the join is never delivered (AT-03)', async () => {
    const { alice, id } = await group(0)
    await seedMessages(dbs.owner.db, id, {
      count: 130,
      senderId: alice.id,
      body: (seq) => `secret ${seq}`,
    })
    const carol = await person(app, 'carol')
    await alice.post(`/api/conversations/${id}/members`, { userIds: [carol.id] })
    await seedMessages(dbs.owner.db, id, {
      count: 5,
      senderId: alice.id,
      body: (seq) => `public ${seq}`,
    })

    const first = await feed(carol, id, 'after=0&limit=100')
    // The first 100 entries are before carol's boundary (130): no item, but the scan moved and says where it stands.
    expect(first.body.items).toEqual([])
    expect(first.body.scannedThrough).toBe(100)
    expect(first.body.nextCursor).not.toBeNull()
    const second = await feed(carol, id, `cursor=${cursorOf(first)}&limit=100`)
    expect(second.body.scannedThrough).toBe(136)
    expect(second.body.nextCursor).toBeNull()
    expect(second.body.items.map((m) => m.seq)).toEqual([131, 132, 133, 134, 135, 136])
    const raw = JSON.stringify([first.body, second.body])
    expect(raw).not.toContain('secret')
    expect(raw.match(/public/g)).toHaveLength(5)
    // Neither a tombstone nor any id of the old messages leaks that they exist.
    expect(first.body.tombstones).toEqual([])
  })

  test('what a reader hid is left out of their feed and still counted as scanned', async () => {
    const { alice, others, id } = await group(1)
    const bob = others[0] as Person
    await seedMessages(dbs.owner.db, id, { count: 6, senderId: alice.id })
    const [fourth] = await dbs.owner.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, id), eq(messages.seq, 4)))
    await bob.post(`/api/messages/${fourth?.id}/hide`)
    const forBob = await feed(bob, id, 'after=0')
    expect(forBob.body.items.map((m) => m.seq)).toEqual([1, 2, 3, 5, 6])
    expect(forBob.body.scannedThrough).toBe(6)
    expect((await feed(alice, id, 'after=0')).body.items).toHaveLength(6)
  })

  test('entries are answered with the current state, which may be newer than the log position; the bound stays fixed', async () => {
    const { alice, id } = await group(0)
    await seedMessages(dbs.owner.db, id, { count: 150, senderId: alice.id })
    const first = await feed(alice, id, 'after=0&limit=100')
    expect(first.body.through).toBe(150)
    // While the client pages, a message arrives and an old one is edited.
    const arrival = await say(alice, id, 'brand new')
    const [old] = await dbs.owner.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, id), eq(messages.seq, 120)))
    const edited = await alice.patch<MessageEnvelope>(`/api/messages/${old?.id}`, {
      body: 'edited while paging',
      expectedChangeSeq: 120,
    })
    expect(edited.status).toBe(200)
    expect(arrival.body.message.seq).toBe(151)

    const second = await feed(alice, id, `cursor=${cursorOf(first)}&limit=100`)
    expect(second.body).toMatchObject({ scannedThrough: 150, through: 150, nextCursor: null })
    expect(second.body.items.map((m) => m.seq)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 101),
    )
    const current = second.body.items.find((m) => m.seq === 120)
    expect(current).toMatchObject({ body: 'edited while paging' })
    // The entity's own version is newer than the position of the log: it is not a log position (docs/05 section 4.5).
    expect(current?.changeSeq).toBe(152)
    expect(current?.changeSeq).toBeGreaterThan(second.body.through)
    // The next round, from the synced mark, picks up what came after the bound.
    const next = await feed(alice, id, 'after=150')
    expect(next.body.through).toBe(152)
    expect(next.body.items.map((m) => m.seq).sort((a, b) => a - b)).toEqual([120, 151])
  })

  test('an entry whose message no longer exists is a tombstone with its change number', async () => {
    const { alice, id } = await group(0)
    await seedMessages(dbs.owner.db, id, { count: 3, senderId: alice.id })
    const rows = await dbs.owner.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, id))
      .orderBy(asc(messages.seq))
    const victim = rows[1]
    await dbs.owner.db.delete(messages).where(eq(messages.id, victim?.id ?? ''))
    const reply = await feed(alice, id, 'after=0')
    expect(reply.body.items.map((m) => m.seq)).toEqual([1, 3])
    expect(reply.body.tombstones).toEqual([{ id: victim?.id ?? '', changeSeq: 2 }])
  })

  test('recalled and deleted messages come back as what they are now, not as tombstones', async () => {
    const { alice, others, id } = await group(1)
    const bob = others[0] as Person
    const one = (await say(alice, id, 'will be recalled')).body.message
    const two = (await say(bob, id, 'will be deleted')).body.message
    await alice.post(`/api/messages/${one.id}/recall`)
    await alice.del(`/api/messages/${two.id}`)
    const reply = await feed(bob, id, 'after=0')
    expect(reply.body.tombstones).toEqual([])
    expect(
      reply.body.items.map((m) => [m.seq, m.body, m.recalledAt !== null, m.deletedAt !== null]),
    ).toEqual([
      [1, null, true, false],
      [2, null, false, true],
    ])
    expect(reply.body.scannedThrough).toBe(4)
  })
})

describe('when the log cannot be replayed: a reset with a consistent snapshot', () => {
  async function seeded() {
    const ctx = await group(1)
    await seedMessages(dbs.owner.db, ctx.id, { count: 60, senderId: ctx.alice.id })
    return ctx
  }

  function expectBaseline(
    reply: { body: ConversationChangesResponse },
    lastChangeSeq: number,
  ): void {
    expect(reply.body).toMatchObject({
      resetRequired: true,
      items: [],
      tombstones: [],
      nextCursor: null,
      through: lastChangeSeq,
      scannedThrough: lastChangeSeq,
    })
    const baseline = reply.body.baseline
    expect(baseline?.baselineChangeSeq).toBe(lastChangeSeq)
    expect(baseline?.conversation.lastChangeSeq).toBe(lastChangeSeq)
    expect(baseline?.messages.map((m) => m.seq).at(-1)).toBe(60)
    expect(baseline?.messages.length).toBe(50) // the newest page, 50 by default
    expect(baseline?.hasMoreBefore).toBe(true)
    expect(baseline?.users).not.toEqual({})
  }

  test('a client behind the retained log, further ahead than the head, or too far behind, starts over', async () => {
    const { alice, id } = await seeded()
    await dbs.owner.db
      .update(conversations)
      .set({ changeLogFloor: 40 })
      .where(eq(conversations.id, id))
    expectBaseline(await feed(alice, id, 'after=10'), 60) // the entries 1 to 40 were purged
    expect((await feed(alice, id, 'after=40')).body.resetRequired).toBe(false) // exactly at the floor is fine
    expectBaseline(await feed(alice, id, 'after=500'), 60) // ahead of the head: the client's world is not this one
    await dbs.owner.db
      .update(conversations)
      .set({ lastSeq: 2500, lastChangeSeq: 2500, changeLogFloor: 0 })
      .where(eq(conversations.id, id))
    const far = await feed(alice, id, 'after=100')
    expect(far.body.resetRequired).toBe(true) // more than 1000 entries behind
    expect(far.body.baseline?.baselineChangeSeq).toBe(2500)
    expect((await feed(alice, id, 'after=1500')).body.resetRequired).toBe(false)
  })

  test('a forged, expired, foreign or stale-membership cursor is a reset, never an error and never a partial page', async () => {
    const { alice, others, id } = await seeded()
    const bob = others[0] as Person
    const first = await feed(bob, id, 'after=0&limit=20')
    const good = first.body.nextCursor ?? ''
    expect((await feed(bob, id, `cursor=${encodeURIComponent(good)}`)).body.resetRequired).toBe(
      false,
    )

    const tampered = `${good.slice(0, -2)}${good.endsWith('A') ? 'B' : 'A'}A`
    expect((await feed(bob, id, `cursor=${encodeURIComponent(tampered)}`)).body.resetRequired).toBe(
      true,
    )
    expect((await feed(bob, id, 'cursor=not.a.cursor')).body.resetRequired).toBe(true)
    // A cursor is its owner's: alice cannot use bob's.
    expect((await feed(alice, id, `cursor=${encodeURIComponent(good)}`)).body.resetRequired).toBe(
      true,
    )
    // After ten minutes it has expired.
    app.clock.advance(10 * 60_000 + 1)
    expect((await feed(bob, id, `cursor=${encodeURIComponent(good)}`)).body.resetRequired).toBe(
      true,
    )

    // A cursor of an earlier membership is no use after leaving and joining again.
    const fresh = await feed(bob, id, 'after=0&limit=20')
    const old = fresh.body.nextCursor ?? ''
    await bob.post(`/api/conversations/${id}/leave`)
    await alice.post(`/api/conversations/${id}/members`, { userIds: [bob.id] })
    const again = await feed(bob, id, `cursor=${encodeURIComponent(old)}`)
    expect(again.body.resetRequired).toBe(true)
    expect(again.body.membershipId).not.toBe(fresh.body.membershipId)
    // The rebuilt view holds only what the new membership may see.
    expect(again.body.baseline?.messages.every((m) => m.seq > 60)).toBe(true)
  })

  test('after and cursor are exclusive; neither is refused; strangers get nothing', async () => {
    const { alice, id } = await seeded()
    const mallory = await person(app, 'mallory')
    expect((await feed(alice, id, 'after=0&cursor=x')).status).toBe(422)
    expect((await feed(alice, id, 'limit=10')).status).toBe(422)
    expect((await feed(alice, id, 'after=-1')).status).toBe(422)
    expect((await feed(alice, id, 'after=0&limit=101')).status).toBe(422)
    expect((await feed(mallory, id, 'after=0')).status).toBe(404)
    const channel = await createConversation(alice, { kind: 'channel', name: 'public' })
    expect((await feed(mallory, channel.id, 'after=0')).status).toBe(403)
  })

  test('the snapshot is one point in time: its numbers are the ones the data was read at', async () => {
    const { alice, id } = await seeded()
    await dbs.owner.db
      .update(conversations)
      .set({ changeLogFloor: 59 })
      .where(eq(conversations.id, id))
    const snapshot = await feed(alice, id, 'after=1')
    expect(snapshot.body.baseline?.baselineChangeSeq).toBe(60)
    expect(snapshot.body.baseline?.conversation.lastSeq).toBe(60)
    const [head] = await dbs.owner.db
      .select({ seq: users.userChangeSeq })
      .from(users)
      .where(eq(users.id, alice.id))
    expect(snapshot.body.baseline?.baselineUserSeq).toBe(head?.seq ?? -1)
  })
})

describe('my own log (AT-31)', () => {
  test('joining, preferences, reading and hiding appear once each, as the state they leave', async () => {
    const { alice, others, id } = await group(1)
    const bob = others[0] as Person
    await seedMessages(dbs.owner.db, id, { count: 5, senderId: alice.id })
    const view = await conv(bob, id)
    await bob.patch(`/api/conversations/${id}/me`, {
      expectedViewerVersion: view.viewerVersion,
      pinned: true,
    })
    await bob.post(`/api/conversations/${id}/read`, { seq: 3 })
    const [message] = await dbs.owner.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, id), eq(messages.seq, 2)))
    await bob.post(`/api/messages/${message?.id}/hide`)
    const me = await bob.get<{ meVersion: number }>('/api/me')
    await bob.patch('/api/me', { expectedMeVersion: me.body.meVersion, bio: 'hello' })

    const reply = await mine(bob, 'after=0')
    expect(reply.status).toBe(200)
    expect(reply.body.resetRequired).toBe(false)
    const types = reply.body.items.map((i) => i.type)
    // One conversation (the final state of many changes), one hidden message, one profile.
    expect(types.filter((t) => t === 'conversation')).toHaveLength(1)
    expect(types.filter((t) => t === 'message.hidden')).toHaveLength(1)
    expect(types.filter((t) => t === 'me')).toHaveLength(1)
    const conversation = reply.body.items.find((i) => i.type === 'conversation')
    if (conversation?.type !== 'conversation') throw new Error('no conversation item')
    expect(conversation.conversation.me).toMatchObject({ lastReadSeq: 3, unread: 2 })
    expect(conversation.conversation.me?.pinnedAt).not.toBeNull()
    const hidden = reply.body.items.find((i) => i.type === 'message.hidden')
    expect(hidden).toMatchObject({ conversationId: id, messageId: message?.id })
    const profile = reply.body.items.find((i) => i.type === 'me')
    expect(profile).toMatchObject({ me: { bio: 'hello' } })
    const [head] = await dbs.owner.db
      .select({ seq: users.userChangeSeq })
      .from(users)
      .where(eq(users.id, bob.id))
    expect(reply.body).toMatchObject({
      through: head?.seq,
      scannedThrough: head?.seq,
      nextCursor: null,
    })
    // Nothing more after the head.
    expect((await mine(bob, `after=${head?.seq}`)).body.items).toEqual([])
  })

  test('leaving writes a tombstone with a newer viewer version; coming back replaces it, never the other way round', async () => {
    const { alice, others, id } = await group(1)
    const bob = others[0] as Person
    const joined = (await mine(bob, 'after=0')).body
    const joinedItem = joined.items[0]
    if (joinedItem?.type !== 'conversation') throw new Error('expected the conversation')
    const oldMembership = joinedItem.conversation.me?.membershipId
    const oldVersion = joinedItem.conversation.viewerVersion

    await bob.post(`/api/conversations/${id}/leave`)
    const left = (await mine(bob, `after=${joined.through}`)).body
    expect(left.items).toHaveLength(1)
    expect(left.items[0]).toMatchObject({
      type: 'conversation.removed',
      conversationId: id,
      membershipId: oldMembership,
      state: 'removed',
    })
    const tombstone = left.items[0]
    if (tombstone?.type !== 'conversation.removed') throw new Error('expected a tombstone')
    expect(tombstone.viewerVersion).toBeGreaterThan(oldVersion)

    await alice.post(`/api/conversations/${id}/members`, { userIds: [bob.id] })
    const back = await mine(bob, `after=${left.through}`)
    const returned = back.body.items[0]
    if (returned?.type !== 'conversation') throw new Error('expected the conversation again')
    expect(returned.conversation.me?.membershipId).not.toBe(oldMembership)
    expect(returned.conversation.viewerVersion).toBeGreaterThan(tombstone.viewerVersion)
    // Read from the beginning, both changes collapse into the present: a member again, no tombstone.
    const whole = (await mine(bob, 'after=0')).body.items.filter((i) => i.type !== 'me')
    expect(whole).toHaveLength(1)
    expect(whole[0]?.type).toBe('conversation')
    // The states table agrees: one row per (person, conversation), the latest version.
    const [state] = await dbs.owner.db
      .select()
      .from(userConversationStates)
      .where(
        and(
          eq(userConversationStates.userId, bob.id),
          eq(userConversationStates.conversationId, id),
        ),
      )
    expect(state).toMatchObject({
      state: 'active',
      viewerVersion: returned.conversation.viewerVersion,
    })
  })

  test('a removed member keeps a tombstone that outlives the conversation row’s membership, and sees nothing else of it', async () => {
    const { alice, others, id } = await group(1)
    const bob = others[0] as Person
    const before = (await mine(bob, 'after=0')).body.through
    await alice.del(`/api/conversations/${id}/members/${bob.id}`)
    await say(alice, id, 'after bob was removed')
    const reply = await mine(bob, `after=${before}`)
    expect(reply.body.items.map((i) => i.type)).toEqual(['conversation.removed'])
    expect(JSON.stringify(reply.body)).not.toContain('after bob was removed')
    expect((await bob.get(`/api/conversations/${id}`)).status).toBe(404)
    expect((await feed(bob, id, 'after=0')).status).toBe(404)
  })

  test('pages are bounded; several entities need several pages that end at the same head', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    for (let i = 0; i < 7; i += 1)
      await createConversation(alice, { kind: 'group', name: `g${i}`, memberIds: [bob.id] })
    const first = await mine(bob, 'after=0&limit=3')
    expect(first.body.items).toHaveLength(3)
    expect(first.body.scannedThrough).toBe(3)
    expect(first.body.nextCursor).not.toBeNull()
    const second = await mine(bob, `cursor=${cursorOf(first)}&limit=3`)
    const third = await mine(bob, `cursor=${cursorOf(second)}&limit=3`)
    expect(third.body).toMatchObject({ scannedThrough: 7, through: 7, nextCursor: null })
    expect([...first.body.items, ...second.body.items, ...third.body.items]).toHaveLength(7)
    expect(new Set([first, second, third].map((r) => r.body.through)).size).toBe(1)
  })

  test('behind the retained log, or with a stale cursor, it resets with my profile and my conversations', async () => {
    const { others } = await group(2)
    const bob = others[0] as Person
    await bob.post(
      '/api/conversations',
      { kind: 'group', name: 'second' },
      { 'idempotency-key': crypto.randomUUID() },
    )
    await dbs.owner.db.update(users).set({ changeLogFloor: 1 }).where(eq(users.id, bob.id))
    const reply = await mine(bob, 'after=0')
    expect(reply.body.resetRequired).toBe(true)
    expect(reply.body.items).toEqual([])
    expect(reply.body.baseline?.me).toMatchObject({ id: bob.id, username: 'member0' })
    expect(reply.body.baseline?.conversations.map((c) => c.name).sort()).toEqual(['feed', 'second'])
    const [head] = await dbs.owner.db
      .select({ seq: users.userChangeSeq })
      .from(users)
      .where(eq(users.id, bob.id))
    expect(reply.body.baseline?.baselineUserSeq).toBe(head?.seq)
    expect((await mine(bob, 'after=9999')).body.resetRequired).toBe(true)
    expect((await mine(bob, 'cursor=garbage')).body.resetRequired).toBe(true)
    expect((await mine(bob, 'after=0&cursor=x')).status).toBe(422)
    expect((await app.request('/api/me/changes?after=0')).status).toBe(401)
  })
})

describe('heads', () => {
  test('versions of my conversations and of my own log, nothing else; archived ones stay until I leave them', async () => {
    const { alice, others, id } = await group(1)
    const bob = others[0] as Person
    const other = await createConversation(alice, { kind: 'channel', name: 'elsewhere' })
    const heads = await bob.get<SyncHeadsResponse>('/api/sync/heads')
    expect(heads.status).toBe(200)
    expect(heads.body.conversations.map((h) => h.id)).toEqual([id])
    const view = await conv(bob, id)
    expect(heads.body.conversations[0]).toEqual({
      id,
      membershipId: view.me?.membershipId ?? '',
      lastChangeSeq: view.lastChangeSeq,
      metadataVersion: view.metadataVersion,
      membershipVersion: view.membershipVersion,
      viewerVersion: view.viewerVersion,
    })
    const [head] = await dbs.owner.db
      .select({ seq: users.userChangeSeq })
      .from(users)
      .where(eq(users.id, bob.id))
    expect(heads.body.userChangeSeq).toBe(head?.seq ?? -1)
    // Content has no place here: only ids and numbers.
    await say(alice, id, 'private words')
    const later = await bob.get<SyncHeadsResponse>('/api/sync/heads')
    expect(JSON.stringify(later.body)).not.toContain('private')
    expect(later.body.conversations[0]?.lastChangeSeq).toBe(
      heads.body.conversations[0]?.lastChangeSeq
        ? (heads.body.conversations[0]?.lastChangeSeq ?? 0) + 1
        : 1,
    )

    // A rename moves the shared version; archiving moves it again and the conversation is still listed here.
    await alice.patch(`/api/conversations/${id}`, {
      expectedMetadataVersion: view.metadataVersion,
      name: 'renamed',
    })
    await alice.post(`/api/conversations/${id}/archive`)
    const archived = await bob.get<SyncHeadsResponse>('/api/sync/heads')
    expect(archived.body.conversations[0]?.metadataVersion).toBeGreaterThan(
      view.metadataVersion + 1,
    )
    await bob.post(`/api/conversations/${other.id}/join`)
    expect(
      (await bob.get<SyncHeadsResponse>('/api/sync/heads')).body.conversations
        .map((h) => h.id)
        .sort(),
    ).toEqual([id, other.id].sort())
    expect((await app.request('/api/sync/heads')).status).toBe(401)
  })
})

describe('every change leaves a durable trace, atomically (AT-01, INV-16)', () => {
  test('a failure while recording the hint rolls the whole send back: no message, no number used, no log entry', async () => {
    const { alice, id } = await group(0)
    await say(alice, id, 'one')
    const restore = await injectInsertFailure(dbs.owner.db, 'work_items')
    try {
      const failed = await say(alice, id, 'doomed')
      expect(failed.status).toBe(500)
      expect(errorCode(failed)).toBe('INTERNAL')
    } finally {
      await restore()
    }
    expect(await dbs.owner.db.select().from(messages)).toHaveLength(1)
    expect((await dbs.owner.db.select().from(conversationChanges)).map((l) => l.changeSeq)).toEqual(
      [1],
    )
    expect((await conv(alice, id)).lastSeq).toBe(1)
    // Once the fault is gone the same request succeeds and takes the number that was not used.
    const retried = await say(alice, id, 'doomed, again')
    expect(retried.body.message.seq).toBe(2)
  })

  test('each kind of change has its hint, with identifiers only, written with the change', async () => {
    const { alice, others, id } = await group(1)
    const bob = others[0] as Person
    await say(alice, id, 'secret words')
    await alice.patch(`/api/conversations/${id}`, {
      expectedMetadataVersion: (await conv(alice, id)).metadataVersion,
      name: 'again',
    })
    await alice.patch(`/api/conversations/${id}/members/${bob.id}`, { role: 'admin' })
    await bob.post(`/api/conversations/${id}/read`, { seq: 1 })
    const items = await dbs.owner.db.select().from(workItems)
    const keys = items.map((i) => i.dedupeKey)
    expect(keys.some((k) => k.startsWith(`mc:${id}:`))).toBe(true)
    expect(keys.some((k) => k.startsWith(`cm:${id}:`))).toBe(true)
    expect(keys.some((k) => k.startsWith(`mm:${id}:`))).toBe(true)
    expect(keys.some((k) => k.startsWith(`uc:${bob.id}:`))).toBe(true)
    expect(items.every((i) => i.kind === 'realtime' && i.status === 'pending')).toBe(true)
    expect(JSON.stringify(items)).not.toContain('secret')
    expect(JSON.stringify(items)).not.toContain('again')
    // The log of each person is contiguous: every number from 1 to the head has an entry.
    for (const person of [alice, bob]) {
      const log = await dbs.owner.db
        .select()
        .from(userChanges)
        .where(eq(userChanges.userId, person.id))
        .orderBy(asc(userChanges.changeSeq))
      const [head] = await dbs.owner.db
        .select({ seq: users.userChangeSeq })
        .from(users)
        .where(eq(users.id, person.id))
      expect(log.map((l) => l.changeSeq)).toEqual(
        Array.from({ length: head?.seq ?? 0 }, (_, i) => i + 1),
      )
    }
  })

  test('the member row and the state row of one relation carry the same version', async () => {
    const { alice, others, id } = await group(1)
    const bob = others[0] as Person
    await bob.post(`/api/conversations/${id}/read`, { seq: 0 })
    await alice.patch(`/api/conversations/${id}/members/${bob.id}`, { role: 'admin' })
    const view = await conv(bob, id)
    const [member] = await dbs.owner.db
      .select()
      .from(conversationMembers)
      .where(
        and(eq(conversationMembers.conversationId, id), eq(conversationMembers.userId, bob.id)),
      )
    const [state] = await dbs.owner.db
      .select()
      .from(userConversationStates)
      .where(
        and(
          eq(userConversationStates.conversationId, id),
          eq(userConversationStates.userId, bob.id),
        ),
      )
    expect(member?.stateVersion).toBe(state?.viewerVersion ?? -1)
    expect(view.viewerVersion).toBe(state?.viewerVersion ?? -2)
    expect(view.me?.version).toBe(view.viewerVersion)
    // The version is a number of bob's own log (INV-27): the head is never behind it.
    const [head] = await dbs.owner.db
      .select({ seq: users.userChangeSeq })
      .from(users)
      .where(eq(users.id, bob.id))
    expect(head?.seq).toBeGreaterThanOrEqual(view.viewerVersion)
  })
})
