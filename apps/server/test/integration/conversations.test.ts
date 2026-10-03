/**
 * Conversations over HTTP against the real database (docs/05 section 3.3, M2a): creating, reading, joining, leaving,
 * handing over, archiving, direct messages, my own settings. Covers INV-04, INV-07, INV-23, L-01 to L-04, L-21, AT-16
 * (concurrent hand-overs) and AT-37 (mute states).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { ChannelsPage, Conversation, ConversationListResponse } from '@chatapp/contracts'
import { conversationMembers, conversations, dmPairs, messages } from '@chatapp/db'
import { runBootstrap } from '@chatapp/db/bootstrap'
import { and, eq } from 'drizzle-orm'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createTestApp, type TestApp } from '../support/http.ts'
import {
  createConversation,
  errorCode,
  errorReason,
  key,
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

const list = async (who: Person) =>
  (await who.get<ConversationListResponse>('/api/conversations')).body.conversations
const find = async (who: Person, id: string) => (await list(who)).find((c) => c.id === id)

describe('creating (L-01 to L-03)', () => {
  test('a channel with a Chinese name is created and the rest of the site keeps working', async () => {
    const alice = await person(app, 'alice')
    const created = await createConversation(alice, { kind: 'channel', name: '测试房间' })
    expect(created).toMatchObject({
      kind: 'channel',
      name: '测试房间',
      memberCount: 1,
      lastSeq: 0,
      archivedAt: null,
      dmPeer: null,
      settings: { whoCanInvite: 'all_members', agentEnabled: true },
      me: { role: 'owner', visibleFromSeq: 0, lastReadSeq: 0, unread: 0, notifyLevel: 'mentions' },
    })
    expect(created.me?.mute).toEqual({ mode: 'off' })
    // The legacy bug made every other page return 500 after such a name (L-02).
    expect((await app.request('/api/healthz')).status).toBe(200)
    expect((await alice.get('/api/me')).status).toBe(200)
    expect((await find(alice, created.id))?.name).toBe('测试房间')
  })

  test('two different Chinese names work; equal names, case and full-width forms collide (L-03)', async () => {
    const alice = await person(app, 'alice')
    await createConversation(alice, { kind: 'channel', name: '测试房间' })
    await createConversation(alice, { kind: 'channel', name: '另一个房间' })
    for (const name of ['测试房间', ' 测试房间 ']) {
      const again = await alice.post('/api/conversations', { kind: 'channel', name }, key())
      expect(again.status).toBe(409)
      expect(errorCode(again)).toBe('CONFLICT')
    }
    await createConversation(alice, { kind: 'channel', name: 'Lobby' })
    for (const name of ['lobby', 'LOBBY', 'ＬＯＢＢＹ']) {
      expect(
        (await alice.post('/api/conversations', { kind: 'channel', name }, key())).status,
      ).toBe(409)
    }
  })

  test('groups may repeat a name, and the creator owns what they create', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const first = await createConversation(alice, { kind: 'group', name: '饭搭子' })
    const second = await createConversation(bob, { kind: 'group', name: '饭搭子' })
    expect(first.id).not.toBe(second.id)
    expect(first.me?.role).toBe('owner')
    expect(second.me?.role).toBe('owner')
  })

  test('refuses bad names, unknown fields and a missing Idempotency-Key', async () => {
    const alice = await person(app, 'alice')
    const refuse = async (body: unknown, status = 422) =>
      expect((await alice.post('/api/conversations', body, key())).status).toBe(status)
    await refuse({ kind: 'channel', name: '' })
    await refuse({ kind: 'channel', name: '   ' })
    await refuse({ kind: 'channel', name: 'x'.repeat(51) })
    await refuse({ kind: 'channel', name: 'bad\u0000name' })
    await refuse({ kind: 'channel', name: 'rtl‮trick' })
    await refuse({ kind: 'dm', name: 'x' })
    await refuse({ kind: 'channel', name: 'ok', ownerId: alice.id })
    await refuse({ kind: 'channel', name: 'ok', description: 'd'.repeat(501) })
    const noKey = await alice.post('/api/conversations', { kind: 'channel', name: 'ok' })
    expect(noKey.status).toBe(422)
    expect((await list(alice)).length).toBe(0)
  })

  test('the Idempotency-Key makes a retry return the same conversation, and another request with it is a conflict', async () => {
    const alice = await person(app, 'alice')
    const headers = key()
    const body = { kind: 'group', name: 'retry', memberIds: [] }
    const first = await alice.post<Conversation>('/api/conversations', body, headers)
    const again = await alice.post<Conversation>('/api/conversations', body, headers)
    expect(first.status).toBe(201)
    expect(again.status).toBe(200)
    expect(again.body.id).toBe(first.body.id)
    const other = await alice.post('/api/conversations', { ...body, name: 'different' }, headers)
    expect(other.status).toBe(409)
    expect(errorCode(other)).toBe('IDEMPOTENCY_CONFLICT')
    expect(await dbs.owner.db.select().from(conversations)).toHaveLength(1)
  })

  test('people named at creation join from the beginning; unknown or unusable ids refuse the request', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'crew',
      memberIds: [bob.id],
    })
    expect(group.memberCount).toBe(2)
    const seenByBob = await find(bob, group.id)
    expect(seenByBob?.me).toMatchObject({ role: 'member', visibleFromSeq: 0, unread: 0 })

    const unknown = await alice.post(
      '/api/conversations',
      { kind: 'group', name: 'nobody', memberIds: [crypto.randomUUID()] },
      key(),
    )
    expect(unknown.status).toBe(422)
    expect(errorReason(unknown)).toBe('unknown_or_unavailable')
    // The assistant is a bot and never a member (D-051).
    const { agentUserId } = await runBootstrap(dbs.owner.db, {
      agentUsername: 'assistant',
      agentDisplayName: '助手',
      productName: 'ChatApp',
    })
    const withBot = await alice.post(
      '/api/conversations',
      { kind: 'group', name: 'robots', memberIds: [agentUserId] },
      key(),
    )
    expect(withBot.status).toBe(422)
    expect(await dbs.owner.db.select().from(conversations)).toHaveLength(1)
  })
})

describe('who sees what (L-04, L-21)', () => {
  test('a stranger gets 404 for a group and a direct message, but sees a channel without `me`', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const carol = await person(app, 'carol')
    const group = await createConversation(alice, { kind: 'group', name: 'private' })
    const channel = await createConversation(alice, { kind: 'channel', name: 'public' })
    const dm = await openDm(alice, bob)

    for (const hidden of [group.id, dm.id]) {
      const reply = await carol.get(`/api/conversations/${hidden}`)
      expect(reply.status).toBe(404)
      expect(errorCode(reply)).toBe('NOT_FOUND')
    }
    const open = await carol.get<Conversation>(`/api/conversations/${channel.id}`)
    expect(open.status).toBe(200)
    expect(open.body.me).toBeNull()
    expect(open.body.viewerVersion).toBe(0)
    expect(open.body.memberCount).toBe(1)
    // Her own list holds none of them.
    expect(await list(carol)).toEqual([])
    // Identifiers are UUIDs, so there is nothing to enumerate (SEC-04).
    expect(group.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)
  })

  test('a site administrator can open a group but never a direct message', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const boss = await person(app, 'boss', { role: 'admin' })
    const group = await createConversation(alice, { kind: 'group', name: 'staff' })
    const dm = await openDm(alice, bob)
    const seen = await boss.get<Conversation>(`/api/conversations/${group.id}`)
    expect(seen.status).toBe(200)
    expect(seen.body.me).toBeNull()
    expect((await boss.get(`/api/conversations/${dm.id}`)).status).toBe(404)
  })

  test('anonymous callers are refused everywhere', async () => {
    for (const path of ['/api/conversations', '/api/channels', '/api/users?query=a']) {
      expect((await app.request(path)).status).toBe(401)
    }
  })
})

describe('channel discovery', () => {
  test('lists live channels alphabetically, searchable, in pages that continue with the cursor', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    for (const name of ['Delta', 'alpha', 'Charlie', 'bravo', 'Echo']) {
      await createConversation(alice, { kind: 'channel', name })
    }
    await createConversation(alice, { kind: 'group', name: 'secret group' })

    const all = await bob.get<ChannelsPage>('/api/channels')
    expect(all.body.items.map((c) => c.name)).toEqual([
      'alpha',
      'bravo',
      'Charlie',
      'Delta',
      'Echo',
    ])
    expect(all.body.nextCursor).toBeNull()
    expect(all.body.items.every((c) => c.me === null)).toBe(true)

    const first = await bob.get<ChannelsPage>('/api/channels?limit=2')
    expect(first.body.items.map((c) => c.name)).toEqual(['alpha', 'bravo'])
    expect(first.body.nextCursor).not.toBeNull()
    const second = await bob.get<ChannelsPage>(
      `/api/channels?limit=2&cursor=${encodeURIComponent(first.body.nextCursor ?? '')}`,
    )
    expect(second.body.items.map((c) => c.name)).toEqual(['Charlie', 'Delta'])
    const third = await bob.get<ChannelsPage>(
      `/api/channels?limit=2&cursor=${encodeURIComponent(second.body.nextCursor ?? '')}`,
    )
    expect(third.body.items.map((c) => c.name)).toEqual(['Echo'])
    expect(third.body.nextCursor).toBeNull()

    const search = await bob.get<ChannelsPage>('/api/channels?query=AR')
    expect(search.body.items.map((c) => c.name)).toEqual(['Charlie'])
    // A cursor belongs to its search, and an invented one is not accepted.
    expect(
      (
        await bob.get(
          `/api/channels?query=zz&cursor=${encodeURIComponent(first.body.nextCursor ?? '')}`,
        )
      ).status,
    ).toBe(422)
    expect((await bob.get('/api/channels?cursor=not-a-cursor')).status).toBe(422)
  })

  test('an archived channel leaves discovery and gives its name back', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const old = await createConversation(alice, { kind: 'channel', name: 'Town Hall' })
    expect((await alice.post(`/api/conversations/${old.id}/archive`)).status).toBe(200)
    expect((await bob.get<ChannelsPage>('/api/channels')).body.items).toEqual([])
    await createConversation(bob, { kind: 'channel', name: 'town hall' })
  })
})

describe('joining a channel', () => {
  test('starts from the moment of joining: nothing before it, one more member, twice changes nothing (INV-07, D-035)', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const channel = await createConversation(alice, { kind: 'channel', name: 'open' })
    // Pretend the channel has history: the join boundary is the last sequence number at that time.
    await dbs.owner.db
      .update(conversations)
      .set({ lastSeq: 7, lastChangeSeq: 7 })
      .where(eq(conversations.id, channel.id))

    const joined = await bob.post<Conversation>(`/api/conversations/${channel.id}/join`)
    expect(joined.status).toBe(200)
    expect(joined.body.memberCount).toBe(2)
    expect(joined.body.me).toMatchObject({
      role: 'member',
      visibleFromSeq: 7,
      lastReadSeq: 7,
      unread: 0,
    })

    const again = await bob.post<Conversation>(`/api/conversations/${channel.id}/join`)
    expect(again.status).toBe(200)
    expect(again.body.memberCount).toBe(2)
    expect(again.body.me?.visibleFromSeq).toBe(7)
    expect(again.body.viewerVersion).toBe(joined.body.viewerVersion)
    const rows = await dbs.owner.db
      .select()
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, channel.id))
    expect(rows).toHaveLength(2)
    const [row] = await dbs.owner.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, channel.id))
    expect(row?.memberCount).toBe(2)
  })

  test('a group cannot be joined, an archived channel cannot be joined, a stranger finds no private conversation', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const group = await createConversation(alice, { kind: 'group', name: 'closed' })
    const gone = await createConversation(alice, { kind: 'channel', name: 'gone' })
    await alice.post(`/api/conversations/${gone.id}/archive`)
    expect((await bob.post(`/api/conversations/${group.id}/join`)).status).toBe(404)
    const archived = await bob.post(`/api/conversations/${gone.id}/join`)
    expect(archived.status).toBe(409)
    expect(errorReason(archived)).toBe('archived')
  })

  test('a crowd joining at once is counted exactly (INV-07)', async () => {
    const alice = await person(app, 'alice')
    const channel = await createConversation(alice, { kind: 'channel', name: 'busy' })
    const crowd = await Promise.all(Array.from({ length: 12 }, (_, i) => person(app, `joiner${i}`)))
    const results = await Promise.all(
      crowd.map((p) => p.post(`/api/conversations/${channel.id}/join`)),
    )
    expect(results.every((r) => r.status === 200)).toBe(true)
    const [row] = await dbs.owner.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, channel.id))
    expect(row?.memberCount).toBe(13)
    const members = await dbs.owner.db
      .select()
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, channel.id))
    expect(members).toHaveLength(13)
    expect(row?.membershipVersion).toBeGreaterThanOrEqual(13)
  })
})

describe('leaving and handing over (INV-23, AT-16)', () => {
  test('a member leaves and is gone from the list; leaving a channel twice is fine, a direct message cannot be left', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const channel = await createConversation(alice, { kind: 'channel', name: 'room' })
    await bob.post(`/api/conversations/${channel.id}/join`)
    expect((await bob.post(`/api/conversations/${channel.id}/leave`)).status).toBe(200)
    expect((await bob.post(`/api/conversations/${channel.id}/leave`)).status).toBe(200)
    expect(await find(bob, channel.id)).toBeUndefined()
    expect(
      (await alice.get<Conversation>(`/api/conversations/${channel.id}`)).body.memberCount,
    ).toBe(1)

    const dm = await openDm(alice, bob)
    const refused = await alice.post(`/api/conversations/${dm.id}/leave`)
    expect(refused.status).toBe(403)
    expect(errorReason(refused)).toBe('cannot_leave')

    const group = await createConversation(alice, {
      kind: 'group',
      name: 'club',
      memberIds: [bob.id],
    })
    expect((await bob.post(`/api/conversations/${group.id}/leave`)).status).toBe(200)
    // Somebody who is not in a private group is told it does not exist.
    expect((await bob.post(`/api/conversations/${group.id}/leave`)).status).toBe(404)
  })

  test('the owner must hand over first; the heir becomes the only owner (INV-23)', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'club',
      memberIds: [bob.id],
    })
    const blocked = await alice.post(`/api/conversations/${group.id}/leave`)
    expect(blocked.status).toBe(409)
    expect(errorReason(blocked)).toBe('owner_must_transfer')

    const done = await alice.post<Conversation>(`/api/conversations/${group.id}/transfer`, {
      userId: bob.id,
    })
    expect(done.status).toBe(200)
    expect(done.body.me?.role).toBe('admin')
    expect((await find(bob, group.id))?.me?.role).toBe('owner')
    const owners = await dbs.owner.db
      .select()
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, group.id),
          eq(conversationMembers.role, 'owner'),
        ),
      )
    expect(owners.map((row) => row.userId)).toEqual([bob.id])
    const [row] = await dbs.owner.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, group.id))
    expect(row?.ownerId).toBe(bob.id)
    // The old owner may leave now, and the new one cannot.
    expect((await bob.post(`/api/conversations/${group.id}/leave`)).status).toBe(409)
    expect((await alice.post(`/api/conversations/${group.id}/leave`)).status).toBe(200)
  })

  test('only the owner can hand over, only to a member, never to themselves', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const carol = await person(app, 'carol')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'club',
      memberIds: [bob.id],
    })
    const asMember = await bob.post(`/api/conversations/${group.id}/transfer`, { userId: bob.id })
    expect(asMember.status).toBe(422) // to themselves is refused before anything else
    const notOwner = await bob.post(`/api/conversations/${group.id}/transfer`, { userId: alice.id })
    expect(notOwner.status).toBe(403)
    expect(errorReason(notOwner)).toBe('requires_owner')
    const toStranger = await alice.post(`/api/conversations/${group.id}/transfer`, {
      userId: carol.id,
    })
    expect(toStranger.status).toBe(422)
    expect(errorReason(toStranger)).toBe('not_a_member')
    const outsider = await carol.post(`/api/conversations/${group.id}/transfer`, {
      userId: carol.id,
    })
    expect(outsider.status).toBe(422)
    expect(
      (await carol.post(`/api/conversations/${group.id}/transfer`, { userId: alice.id })).status,
    ).toBe(404)
  })

  test('two simultaneous hand-overs by the owner: one wins, the other is refused, one owner remains', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const carol = await person(app, 'carol')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'race',
      memberIds: [bob.id, carol.id],
    })
    const [toBob, toCarol] = await Promise.all([
      alice.post(`/api/conversations/${group.id}/transfer`, { userId: bob.id }),
      alice.post(`/api/conversations/${group.id}/transfer`, { userId: carol.id }),
    ])
    expect([toBob.status, toCarol.status].sort()).toEqual([200, 403])
    const owners = await dbs.owner.db
      .select()
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, group.id),
          eq(conversationMembers.role, 'owner'),
        ),
      )
    expect(owners).toHaveLength(1)
    const [row] = await dbs.owner.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, group.id))
    expect(row?.ownerId).toBe(owners[0]?.userId ?? '')
  })

  test('the last member, the owner, leaves: the conversation is archived, stays theirs, and comes back on restore', async () => {
    const alice = await person(app, 'alice')
    const group = await createConversation(alice, { kind: 'group', name: 'solo' })
    expect((await alice.post(`/api/conversations/${group.id}/leave`)).status).toBe(200)
    expect(await find(alice, group.id)).toBeUndefined()
    const [row] = await dbs.owner.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, group.id))
    expect(row).toMatchObject({ ownerId: alice.id, memberCount: 0 })
    expect(row?.archivedAt).not.toBeNull()
    expect(await dbs.owner.db.select().from(conversationMembers)).toHaveLength(0)

    const archived = await alice.get<ConversationListResponse>('/api/conversations?archived=true')
    expect(archived.body.conversations.map((c) => c.id)).toEqual([group.id])
    const lastSeqWhileArchived = archived.body.conversations[0]?.lastSeq ?? -1
    const restored = await alice.post<Conversation>(`/api/conversations/${group.id}/restore`, {})
    expect(restored.status).toBe(200)
    expect(restored.body).toMatchObject({ archivedAt: null, memberCount: 1 })
    expect(restored.body.me?.role).toBe('owner')
    // They see only what comes after the restore, like any new member (the "left" note stays behind them).
    expect(restored.body.me?.visibleFromSeq).toBe(lastSeqWhileArchived)
  })
})

describe('archive and restore', () => {
  test('the owner archives: read-only, gone from members’ lists, still the owner’s to restore', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'old',
      memberIds: [bob.id],
    })
    const archived = await alice.post<Conversation>(`/api/conversations/${group.id}/archive`)
    expect(archived.status).toBe(200)
    expect(archived.body.archivedAt).not.toBeNull()
    expect(archived.body.metadataVersion).toBeGreaterThan(group.metadataVersion)
    expect(await find(bob, group.id)).toBeUndefined()
    expect(
      (
        await alice.get<ConversationListResponse>('/api/conversations?archived=true')
      ).body.conversations.map((c) => c.id),
    ).toEqual([group.id])
    // Archiving twice is the same state, and members can still open what they were part of.
    expect((await alice.post(`/api/conversations/${group.id}/archive`)).status).toBe(200)
    expect(
      (await bob.get<Conversation>(`/api/conversations/${group.id}`)).body.archivedAt,
    ).not.toBeNull()
    // Nobody can change an archived conversation.
    const patch = await alice.patch(`/api/conversations/${group.id}`, {
      expectedMetadataVersion: archived.body.metadataVersion,
      name: 'new',
    })
    expect(patch.status).toBe(409)
    expect(errorReason(patch)).toBe('archived')
    expect((await bob.post(`/api/conversations/${group.id}/leave`)).status).toBe(409)

    const restored = await alice.post<Conversation>(`/api/conversations/${group.id}/restore`, {})
    expect(restored.body.archivedAt).toBeNull()
    expect((await find(bob, group.id))?.id).toBe(group.id)
    // Restoring a live conversation changes nothing.
    expect(
      (await alice.post<Conversation>(`/api/conversations/${group.id}/restore`, {})).body
        .metadataVersion,
    ).toBe(restored.body.metadataVersion)
  })

  test('only the owner or a site administrator archive and restore', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const boss = await person(app, 'boss', { role: 'admin' })
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'staff',
      memberIds: [bob.id],
    })
    const refused = await bob.post(`/api/conversations/${group.id}/archive`)
    expect(refused.status).toBe(403)
    expect(errorReason(refused)).toBe('requires_owner')
    expect((await boss.post(`/api/conversations/${group.id}/archive`)).status).toBe(200)
    expect((await bob.post(`/api/conversations/${group.id}/restore`, {})).status).toBe(403)
    expect((await boss.post(`/api/conversations/${group.id}/restore`, {})).status).toBe(200)
  })

  test('a channel whose name was taken meanwhile is restored under a new name', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const old = await createConversation(alice, { kind: 'channel', name: 'Town Hall' })
    await alice.post(`/api/conversations/${old.id}/archive`)
    await createConversation(bob, { kind: 'channel', name: 'town hall' })

    const clash = await alice.post(`/api/conversations/${old.id}/restore`, {})
    expect(clash.status).toBe(409)
    expect(errorCode(clash)).toBe('CONFLICT')
    expect(
      (await alice.get<Conversation>(`/api/conversations/${old.id}`)).body.archivedAt,
    ).not.toBeNull()

    const renamed = await alice.post<Conversation>(`/api/conversations/${old.id}/restore`, {
      name: 'Town Hall 2',
    })
    expect(renamed.status).toBe(200)
    expect(renamed.body).toMatchObject({ name: 'Town Hall 2', archivedAt: null })
  })

  test('a conversation without an owner is restored only with an owner named (INV-23)', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const boss = await person(app, 'boss', { role: 'admin' })
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'orphan',
      memberIds: [bob.id],
    })
    await alice.post(`/api/conversations/${group.id}/archive`)
    // The state account deletion leaves behind (M7): archived, no owner.
    await dbs.owner.db
      .update(conversations)
      .set({ ownerId: null })
      .where(eq(conversations.id, group.id))
    await dbs.owner.db
      .update(conversationMembers)
      .set({ role: 'member' })
      .where(eq(conversationMembers.conversationId, group.id))

    const missing = await boss.post(`/api/conversations/${group.id}/restore`, {})
    expect(missing.status).toBe(422)
    expect(errorReason(missing)).toBe('required')
    const restored = await boss.post<Conversation>(`/api/conversations/${group.id}/restore`, {
      ownerUserId: bob.id,
    })
    expect(restored.status).toBe(200)
    expect((await find(bob, group.id))?.me?.role).toBe('owner')
    const [row] = await dbs.owner.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, group.id))
    expect(row?.ownerId).toBe(bob.id)
  })
})

describe('direct messages (INV-04)', () => {
  test('one conversation per pair, whoever opens it and however often, even at the same time', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const replies = await Promise.all([
      ...Array.from({ length: 4 }, () =>
        alice.post<Conversation>('/api/conversations/dm', { userId: bob.id }),
      ),
      ...Array.from({ length: 4 }, () =>
        bob.post<Conversation>('/api/conversations/dm', { userId: alice.id }),
      ),
    ])
    expect(replies.every((r) => r.status === 200 || r.status === 201)).toBe(true)
    expect(replies.filter((r) => r.status === 201)).toHaveLength(1)
    expect(new Set(replies.map((r) => r.body.id)).size).toBe(1)
    expect(await dbs.owner.db.select().from(dmPairs)).toHaveLength(1)
    const members = await dbs.owner.db.select().from(conversationMembers)
    expect(members).toHaveLength(2)
    const [row] = await dbs.owner.db.select().from(conversations)
    expect(row).toMatchObject({ kind: 'dm', name: null, ownerId: null, memberCount: 2 })
  })

  test('shows the other person, has no name or owner, and starts hidden for the one who was not asked', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const dm = await openDm(alice, bob)
    expect(dm).toMatchObject({ kind: 'dm', name: null, memberCount: 2, settings: {} })
    expect(dm.dmPeer).toMatchObject({ id: bob.id, username: 'bob', isBot: false, deleted: false })
    expect(dm.me).toMatchObject({ role: 'member', notifyLevel: 'all', hiddenAt: null })
    const seenByBob = await find(bob, dm.id)
    expect(seenByBob?.dmPeer?.id).toBe(alice.id)
    expect(seenByBob?.me?.hiddenAt).not.toBeNull()
  })

  test('opening it again brings a hidden copy back; refuses oneself, unknown people and bots', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const dm = await openDm(alice, bob)
    const hidden = await alice.patch<Conversation>(`/api/conversations/${dm.id}/me`, {
      expectedViewerVersion: dm.viewerVersion,
      hidden: true,
    })
    expect(hidden.body.me?.hiddenAt).not.toBeNull()
    const reopened = await alice.post<Conversation>('/api/conversations/dm', { userId: bob.id })
    expect(reopened.status).toBe(200)
    expect(reopened.body.me?.hiddenAt).toBeNull()
    expect(reopened.body.viewerVersion).toBeGreaterThan(hidden.body.viewerVersion)

    expect((await alice.post('/api/conversations/dm', { userId: alice.id })).status).toBe(422)
    expect(
      (await alice.post('/api/conversations/dm', { userId: crypto.randomUUID() })).status,
    ).toBe(404)
  })
})

describe('shared settings', () => {
  test('rename, describe and set rules, conditional on the metadata version; a rename leaves a system message', async () => {
    const alice = await person(app, 'alice')
    const group = await createConversation(alice, { kind: 'group', name: 'before' })
    const changed = await alice.patch<Conversation>(`/api/conversations/${group.id}`, {
      expectedMetadataVersion: group.metadataVersion,
      name: 'after',
      description: 'what we do',
      settings: { whoCanInvite: 'admins_only', agentEnabled: false },
    })
    expect(changed.status).toBe(200)
    expect(changed.body).toMatchObject({
      name: 'after',
      description: 'what we do',
      settings: { whoCanInvite: 'admins_only', agentEnabled: false },
      metadataVersion: group.metadataVersion + 1,
    })
    const system = await dbs.owner.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, group.id), eq(messages.kind, 'system')))
    expect(system).toHaveLength(1)
    expect(system[0]?.meta).toEqual({
      system: { type: 'conversation_renamed', actorId: alice.id, from: 'before', to: 'after' },
    })
    expect(system[0]?.body).toBeNull()
    expect(system[0]?.senderId).toBeNull()

    const stale = await alice.patch(`/api/conversations/${group.id}`, {
      expectedMetadataVersion: group.metadataVersion,
      name: 'too late',
    })
    expect(stale.status).toBe(409)
    expect(errorCode(stale)).toBe('VERSION_CONFLICT')
    expect(
      (stale.body as { error: { details: { metadataVersion: number } } }).error.details
        .metadataVersion,
    ).toBe(changed.body.metadataVersion)
    // Saying what is already true changes no version.
    const same = await alice.patch<Conversation>(`/api/conversations/${group.id}`, {
      expectedMetadataVersion: changed.body.metadataVersion,
      name: 'after',
    })
    expect(same.body.metadataVersion).toBe(changed.body.metadataVersion)
    // An empty description clears it.
    const cleared = await alice.patch<Conversation>(`/api/conversations/${group.id}`, {
      expectedMetadataVersion: same.body.metadataVersion,
      description: '',
    })
    expect(cleared.body.description).toBeNull()
  })

  test('refuses members, strangers and unknown fields; a channel name that is taken is a conflict', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const carol = await person(app, 'carol')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'club',
      memberIds: [bob.id],
    })
    const body = { expectedMetadataVersion: group.metadataVersion, name: 'mine now' }
    const asMember = await bob.patch(`/api/conversations/${group.id}`, body)
    expect(asMember.status).toBe(403)
    expect(errorReason(asMember)).toBe('requires_admin')
    expect((await carol.patch(`/api/conversations/${group.id}`, body)).status).toBe(404)
    expect(
      (await alice.patch(`/api/conversations/${group.id}`, { ...body, owner: bob.id })).status,
    ).toBe(422)
    expect(
      (await alice.patch(`/api/conversations/${group.id}`, { expectedMetadataVersion: 1 })).status,
    ).toBe(422)
    expect(
      (
        await alice.patch(`/api/conversations/${group.id}`, {
          ...body,
          settings: { role: 'admin' },
        })
      ).status,
    ).toBe(422)

    await createConversation(alice, { kind: 'channel', name: 'Taken' })
    const other = await createConversation(alice, { kind: 'channel', name: 'Free' })
    const clash = await alice.patch(`/api/conversations/${other.id}`, {
      expectedMetadataVersion: other.metadataVersion,
      name: 'taken',
    })
    expect(clash.status).toBe(409)
    expect(errorCode(clash)).toBe('CONFLICT')
    const dm = await openDm(alice, bob)
    expect(
      (await alice.patch(`/api/conversations/${dm.id}`, { expectedMetadataVersion: 1, name: 'x' }))
        .status,
    ).toBe(403)
  })
})

describe('my own settings (AT-37)', () => {
  const mine = async (who: Person, id: string) =>
    (await who.get<Conversation>(`/api/conversations/${id}`)).body

  test('pin, notification level and the three mute states round-trip with finite dates only', async () => {
    const alice = await person(app, 'alice')
    const group = await createConversation(alice, { kind: 'group', name: 'prefs' })
    let current = group
    const patch = async (body: object) => {
      const reply = await alice.patch<Conversation>(`/api/conversations/${group.id}/me`, {
        expectedViewerVersion: current.viewerVersion,
        ...body,
      })
      expect(reply.status).toBe(200)
      expect(reply.body.viewerVersion).toBeGreaterThan(current.viewerVersion)
      current = reply.body
      return reply.body
    }
    expect((await patch({ pinned: true })).me?.pinnedAt).not.toBeNull()
    expect((await patch({ notifyLevel: 'none' })).me?.notifyLevel).toBe('none')
    const until = new Date(app.clock.now().getTime() + 3_600_000).toISOString()
    expect((await patch({ mute: { mode: 'until', until } })).me?.mute).toEqual({
      mode: 'until',
      until,
    })
    expect((await patch({ mute: { mode: 'forever' } })).me?.mute).toEqual({ mode: 'forever' })
    expect((await patch({ mute: { mode: 'off' } })).me?.mute).toEqual({ mode: 'off' })
    expect((await patch({ pinned: false })).me?.pinnedAt).toBeNull()
    expect(await mine(alice, group.id)).toEqual(current)

    const refuse = async (mute: unknown) => {
      const reply = await alice.patch(`/api/conversations/${group.id}/me`, {
        expectedViewerVersion: current.viewerVersion,
        mute,
      })
      expect(reply.status).toBe(422)
    }
    await refuse({ mode: 'until', until: new Date(app.clock.now().getTime() - 1000).toISOString() })
    await refuse({
      mode: 'until',
      until: new Date(app.clock.now().getTime() + 400 * 86_400_000).toISOString(),
    })
    await refuse({ mode: 'until', until: 'Infinity' })
    await refuse({ mode: 'until', until: '9999-99-99T00:00:00Z' })
    await refuse({ mode: 'forever', until })
    await refuse({ mode: 'until' })
    await refuse({ mode: 'sometimes' })
  })

  test('a limited mute that has run out reads as off', async () => {
    const alice = await person(app, 'alice')
    const group = await createConversation(alice, { kind: 'group', name: 'quiet' })
    const until = new Date(app.clock.now().getTime() + 60_000).toISOString()
    await alice.patch(`/api/conversations/${group.id}/me`, {
      expectedViewerVersion: group.viewerVersion,
      mute: { mode: 'until', until },
    })
    expect((await mine(alice, group.id)).me?.mute.mode).toBe('until')
    app.clock.advance(61_000)
    expect((await mine(alice, group.id)).me?.mute).toEqual({ mode: 'off' })
  })

  test('a stale viewer version is a conflict; the same request twice changes the version once', async () => {
    const alice = await person(app, 'alice')
    const group = await createConversation(alice, { kind: 'group', name: 'versions' })
    const first = await alice.patch<Conversation>(`/api/conversations/${group.id}/me`, {
      expectedViewerVersion: group.viewerVersion,
      pinned: true,
    })
    const stale = await alice.patch(`/api/conversations/${group.id}/me`, {
      expectedViewerVersion: group.viewerVersion,
      pinned: false,
    })
    expect(stale.status).toBe(409)
    expect(
      (stale.body as { error: { details: { viewerVersion: number } } }).error.details.viewerVersion,
    ).toBe(first.body.viewerVersion)
    const noop = await alice.patch<Conversation>(`/api/conversations/${group.id}/me`, {
      expectedViewerVersion: first.body.viewerVersion,
      pinned: true,
    })
    expect(noop.status).toBe(200)
    expect(noop.body.viewerVersion).toBe(first.body.viewerVersion)
  })

  test('only a direct message can be hidden; empty or extra fields and strangers are refused', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const carol = await person(app, 'carol')
    const group = await createConversation(alice, { kind: 'group', name: 'visible' })
    const patch = (who: Person, id: string, version: number, body: object) =>
      who.patch(`/api/conversations/${id}/me`, { expectedViewerVersion: version, ...body })
    const hideGroup = await patch(alice, group.id, group.viewerVersion, { hidden: true })
    expect(hideGroup.status).toBe(422)
    expect(errorReason(hideGroup)).toBe('not_a_direct_message')
    expect((await patch(alice, group.id, group.viewerVersion, {})).status).toBe(422)
    expect((await patch(alice, group.id, group.viewerVersion, { role: 'owner' })).status).toBe(422)
    expect((await patch(carol, group.id, 0, { pinned: true })).status).toBe(404)
    const dm = await openDm(alice, bob)
    const hidden = await patch(alice, dm.id, dm.viewerVersion, { hidden: true })
    expect(hidden.status).toBe(200)
    // A channel the person is not in has no settings of theirs to change.
    const channel = await createConversation(alice, { kind: 'channel', name: 'elsewhere' })
    expect((await patch(carol, channel.id, 0, { pinned: true })).status).toBe(403)
  })
})
