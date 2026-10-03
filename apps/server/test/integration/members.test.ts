/**
 * Members, bans and group invitation links over HTTP (docs/05 section 3.3, docs/01 sections 4.2 and 5, M2a): the member
 * list, adding, removing, banning (INV-13), roles, silences, and links that die with the people who made them.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type {
  AddMembersResponse,
  Ban,
  BansResponse,
  Conversation,
  ConversationInvite,
  ConversationInvitePreview,
  CreatedConversationInvite,
  Member,
  MembersPage,
} from '@chatapp/contracts'
import {
  auditLogs,
  conversationBans,
  conversationInvites,
  conversationMembers,
  conversations,
  users,
} from '@chatapp/db'
import { runBootstrap } from '@chatapp/db/bootstrap'
import { and, eq } from 'drizzle-orm'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createTestApp, type TestApp } from '../support/http.ts'
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

const members = async (who: Person, id: string, query = '') =>
  (await who.get<MembersPage>(`/api/conversations/${id}/members${query}`)).body
const names = (page: MembersPage) => page.members.map((m) => m.user.username)
const conv = async (who: Person, id: string) =>
  (await who.get<Conversation>(`/api/conversations/${id}`)).body
const add = (who: Person, id: string, ...others: Person[]) =>
  who.post<AddMembersResponse>(`/api/conversations/${id}/members`, {
    userIds: others.map((o) => o.id),
  })
const role = (who: Person, id: string, target: Person, body: object) =>
  who.patch<Member>(`/api/conversations/${id}/members/${target.id}`, body)

describe('the member list', () => {
  test('owner first, then administrators, then members in the order they joined; pages share one version', async () => {
    const alice = await person(app, 'alice')
    const [bob, carol, dave, erin] = await Promise.all(
      ['bob', 'carol', 'dave', 'erin'].map((n) => person(app, n)),
    )
    if (!bob || !carol || !dave || !erin) throw new Error('people missing')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'order',
      memberIds: [bob.id],
    })
    app.clock.advance(1000)
    await add(alice, group.id, carol)
    app.clock.advance(1000)
    await add(alice, group.id, dave)
    app.clock.advance(1000)
    await add(alice, group.id, erin)
    await role(alice, group.id, dave, { role: 'admin' })

    expect(names(await members(alice, group.id))).toEqual(['alice', 'dave', 'bob', 'carol', 'erin'])
    const first = await members(alice, group.id, '?limit=2')
    expect(names(first)).toEqual(['alice', 'dave'])
    expect(first.nextCursor).not.toBeNull()
    const second = await members(
      alice,
      group.id,
      `?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
    )
    expect(names(second)).toEqual(['bob', 'carol'])
    expect(second.membershipVersion).toBe(first.membershipVersion)
    const third = await members(
      alice,
      group.id,
      `?limit=2&cursor=${encodeURIComponent(second.nextCursor ?? '')}`,
    )
    expect(names(third)).toEqual(['erin'])
    expect(third.nextCursor).toBeNull()
    expect(first.members[0]).toMatchObject({ role: 'owner', silencedUntil: null })
    expect(first.members.every((m) => m.membershipVersion === first.membershipVersion)).toBe(true)

    // The list changed between two pages: the cursor of the old listing is refused, and a fresh listing works.
    const outsider = await person(app, 'frank')
    await add(alice, group.id, outsider)
    const stale = await alice.get(
      `/api/conversations/${group.id}/members?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
    )
    expect(stale.status).toBe(409)
    expect(errorCode(stale)).toBe('VERSION_CONFLICT')
    expect(names(await members(alice, group.id)).length).toBe(6)
  })

  test('is for members and site administrators; a stranger finds a private group missing and a channel closed', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const boss = await person(app, 'boss', { role: 'admin' })
    const group = await createConversation(alice, { kind: 'group', name: 'closed' })
    const channel = await createConversation(alice, { kind: 'channel', name: 'open' })
    expect((await bob.get(`/api/conversations/${group.id}/members`)).status).toBe(404)
    expect((await bob.get(`/api/conversations/${channel.id}/members`)).status).toBe(403)
    expect(names(await members(boss, group.id))).toEqual(['alice'])
    expect((await bob.get(`/api/conversations/${channel.id}/members?cursor=garbage`)).status).toBe(
      403,
    )
    expect((await alice.get(`/api/conversations/${group.id}/members?cursor=garbage`)).status).toBe(
      422,
    )
  })
})

describe('adding people', () => {
  test('new members see only what comes after they joined (D-035); who was added and who skipped is reported', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const carol = await person(app, 'carol')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'late',
      memberIds: [bob.id],
    })
    await dbs.owner.db
      .update(conversations)
      .set({ lastSeq: 9, lastChangeSeq: 9 })
      .where(eq(conversations.id, group.id))

    const reply = await alice.post<AddMembersResponse>(`/api/conversations/${group.id}/members`, {
      userIds: [carol.id, bob.id, crypto.randomUUID(), carol.id],
    })
    expect(reply.status).toBe(200)
    expect(reply.body.added.map((u) => u.username)).toEqual(['carol'])
    expect(reply.body.skipped).toHaveLength(2)
    expect(reply.body.skipped.map((s) => s.reason).sort()).toEqual([
      'already_member',
      'unavailable',
    ])
    const seen = await conv(carol, group.id)
    expect(seen.me).toMatchObject({ visibleFromSeq: 9, lastReadSeq: 9 })
    expect(seen.memberCount).toBe(3)
    // The assistant is a bot: never a member.
    const { agentUserId } = await runBootstrap(dbs.owner.db, {
      agentUsername: 'assistant',
      agentDisplayName: '助手',
      productName: 'ChatApp',
    })
    const bot = await alice.post<AddMembersResponse>(`/api/conversations/${group.id}/members`, {
      userIds: [agentUserId],
    })
    expect(bot.body.skipped).toEqual([{ userId: agentUserId, reason: 'unavailable' }])
  })

  test('a full conversation takes no one more, and says so', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const group = await createConversation(alice, { kind: 'group', name: 'full' })
    await dbs.owner.db
      .update(conversations)
      .set({ memberCount: 500 })
      .where(eq(conversations.id, group.id))
    const reply = await add(alice, group.id, bob)
    expect(reply.body.added).toEqual([])
    expect(reply.body.skipped).toEqual([{ userId: bob.id, reason: 'limit_reached' }])
    const channel = await createConversation(alice, { kind: 'channel', name: 'packed' })
    await dbs.owner.db
      .update(conversations)
      .set({ memberCount: 5000 })
      .where(eq(conversations.id, channel.id))
    const join = await bob.post(`/api/conversations/${channel.id}/join`)
    expect(join.status).toBe(403)
    expect(errorCode(join)).toBe('QUOTA_EXCEEDED')
  })

  test('"admins only" keeps ordinary members from adding people; a site administrator who is outside cannot either', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const carol = await person(app, 'carol')
    const boss = await person(app, 'boss', { role: 'admin' })
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'rules',
      memberIds: [bob.id],
    })
    expect((await add(bob, group.id, carol)).status).toBe(200) // the default lets members invite
    await alice.patch(`/api/conversations/${group.id}`, {
      expectedMetadataVersion: (await conv(alice, group.id)).metadataVersion,
      settings: { whoCanInvite: 'admins_only' },
    })
    const dave = await person(app, 'dave')
    const refused = await add(bob, group.id, dave)
    expect(refused.status).toBe(403)
    expect(errorReason(refused)).toBe('requires_admin')
    expect((await add(alice, group.id, dave)).status).toBe(200)
    const outside = await add(boss, group.id, await person(app, 'erin'))
    expect(outside.status).toBe(403)
    expect(errorReason(outside)).toBe('not_member')
    expect((await add(carol, group.id, dave)).status).toBe(403)
    // Nobody can add people to a direct message.
    const dm = (await alice.post<Conversation>('/api/conversations/dm', { userId: bob.id })).body
    expect((await add(alice, dm.id, carol)).status).toBe(403)
  })

  test('a stated member-list version that is out of date is a conflict and adds nobody', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const group = await createConversation(alice, { kind: 'group', name: 'versions' })
    const stale = await alice.post(`/api/conversations/${group.id}/members`, {
      userIds: [bob.id],
      expectedMembershipVersion: group.membershipVersion - 1,
    })
    expect(stale.status).toBe(409)
    expect(errorCode(stale)).toBe('VERSION_CONFLICT')
    expect((await conv(alice, group.id)).memberCount).toBe(1)
    const fresh = await alice.post<AddMembersResponse>(`/api/conversations/${group.id}/members`, {
      userIds: [bob.id],
      expectedMembershipVersion: group.membershipVersion,
    })
    expect(fresh.status).toBe(200)
  })
})

describe('removing and banning (INV-13)', () => {
  test('an administrator removes a member; the owner and other administrators are out of reach', async () => {
    const alice = await person(app, 'alice')
    const [bob, carol, dave] = await Promise.all(
      ['bob', 'carol', 'dave'].map((n) => person(app, n)),
    )
    if (!bob || !carol || !dave) throw new Error('people missing')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'moderated',
      memberIds: [bob.id, carol.id, dave.id],
    })
    await role(alice, group.id, bob, { role: 'admin' })
    await role(alice, group.id, carol, { role: 'admin' })

    expect((await bob.del(`/api/conversations/${group.id}/members/${dave.id}`)).status).toBe(200)
    expect((await dave.get(`/api/conversations/${group.id}`)).status).toBe(404)
    expect((await conv(alice, group.id)).memberCount).toBe(3)
    const againstAdmin = await bob.del(`/api/conversations/${group.id}/members/${carol.id}`)
    expect(againstAdmin.status).toBe(403)
    expect(errorReason(againstAdmin)).toBe('cannot_target_admin')
    const againstOwner = await bob.del(`/api/conversations/${group.id}/members/${alice.id}`)
    expect(againstOwner.status).toBe(403)
    expect(errorReason(againstOwner)).toBe('cannot_target_owner')
    expect((await alice.del(`/api/conversations/${group.id}/members/${carol.id}`)).status).toBe(200)
    // Removing oneself is leaving, and somebody who is not a member is simply not found.
    expect((await bob.del(`/api/conversations/${group.id}/members/${bob.id}`)).status).toBe(422)
    expect((await alice.del(`/api/conversations/${group.id}/members/${dave.id}`)).status).toBe(404)
    // A removed person can be brought back, as a new member.
    expect((await add(alice, group.id, dave)).body.added).toHaveLength(1)
  })

  test('an ordinary member cannot remove, ban or silence anyone', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const carol = await person(app, 'carol')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'plain',
      memberIds: [bob.id, carol.id],
    })
    expect((await bob.del(`/api/conversations/${group.id}/members/${carol.id}`)).status).toBe(403)
    expect(
      (await bob.post(`/api/conversations/${group.id}/bans`, { userId: carol.id })).status,
    ).toBe(403)
    const future = new Date(app.clock.now().getTime() + 3_600_000).toISOString()
    expect((await role(bob, group.id, carol, { silencedUntil: future })).status).toBe(403)
    expect((await bob.get(`/api/conversations/${group.id}/bans`)).status).toBe(403)
    expect((await conv(alice, group.id)).memberCount).toBe(3)
  })

  test('a ban removes the person and closes every way back in; lifting it opens them', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const channel = await createConversation(alice, { kind: 'channel', name: 'rules' })
    await bob.post(`/api/conversations/${channel.id}/join`)
    const banned = await alice.post<Ban>(`/api/conversations/${channel.id}/bans`, {
      userId: bob.id,
      reason: 'spam',
    })
    expect(banned.status).toBe(200)
    expect(banned.body).toMatchObject({ reason: 'spam', bannedBy: alice.id })
    expect(banned.body.user.username).toBe('bob')

    expect((await conv(alice, channel.id)).memberCount).toBe(1)
    const join = await bob.post(`/api/conversations/${channel.id}/join`)
    expect(join.status).toBe(403)
    expect(errorCode(join)).toBe('CONVERSATION_BANNED')
    const added = await add(alice, channel.id, bob)
    expect(added.body.skipped).toEqual([{ userId: bob.id, reason: 'banned' }])
    // Discovery does not offer it any more, and the ban list names the person.
    const found = await bob.get<{ items: Conversation[] }>('/api/channels')
    expect(found.body.items).toEqual([])
    const list = await alice.get<BansResponse>(`/api/conversations/${channel.id}/bans`)
    expect(list.body.bans.map((b) => b.user.username)).toEqual(['bob'])

    expect((await alice.del(`/api/conversations/${channel.id}/bans/${bob.id}`)).status).toBe(200)
    expect((await alice.del(`/api/conversations/${channel.id}/bans/${bob.id}`)).status).toBe(200) // already lifted
    expect((await bob.post(`/api/conversations/${channel.id}/join`)).status).toBe(200)
    expect(
      (await alice.get<BansResponse>(`/api/conversations/${channel.id}/bans`)).body.bans,
    ).toEqual([])
  })

  test('somebody who is not in the conversation can be banned in advance; nobody can ban the owner or themselves', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const carol = await person(app, 'carol')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'ahead',
      memberIds: [bob.id],
    })
    expect(
      (await alice.post(`/api/conversations/${group.id}/bans`, { userId: carol.id })).status,
    ).toBe(200)
    expect((await add(alice, group.id, carol)).body.skipped).toEqual([
      { userId: carol.id, reason: 'banned' },
    ])
    await role(alice, group.id, bob, { role: 'admin' })
    const owner = await bob.post(`/api/conversations/${group.id}/bans`, { userId: alice.id })
    expect(owner.status).toBe(403)
    expect(errorReason(owner)).toBe('cannot_target_owner')
    expect(
      (await alice.post(`/api/conversations/${group.id}/bans`, { userId: alice.id })).status,
    ).toBe(422)
    expect(
      (await alice.post(`/api/conversations/${group.id}/bans`, { userId: crypto.randomUUID() }))
        .status,
    ).toBe(404)
  })

  test('a site administrator moderates a group they are not in; every step leaves an audit row without content', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const boss = await person(app, 'boss', { role: 'admin' })
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'watched',
      memberIds: [bob.id],
    })
    expect((await boss.del(`/api/conversations/${group.id}/members/${bob.id}`)).status).toBe(200)
    expect(
      (
        await boss.post(`/api/conversations/${group.id}/bans`, {
          userId: bob.id,
          reason: 'secret reason',
        })
      ).status,
    ).toBe(200)
    expect((await boss.post(`/api/conversations/${group.id}/archive`)).status).toBe(200)
    const audits = await dbs.owner.db.select().from(auditLogs)
    const actions = audits.map((row) => row.action)
    expect(actions).toContain('member.remove')
    expect(actions).toContain('member.ban')
    expect(actions).toContain('conversation.archive')
    expect(audits.filter((row) => row.actorId === boss.id)).toHaveLength(3)
    // Ids and flags only: neither the reason nor any name is written down (SEC-21).
    expect(JSON.stringify(audits)).not.toContain('secret reason')
    expect(JSON.stringify(audits)).not.toContain('watched')
  })
})

describe('roles and silences', () => {
  test('the owner appoints and dismisses administrators, nobody else does, and the owner role moves only by transfer', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const carol = await person(app, 'carol')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'roles',
      memberIds: [bob.id, carol.id],
    })
    const promoted = await role(alice, group.id, bob, { role: 'admin' })
    expect(promoted.status).toBe(200)
    expect(promoted.body.role).toBe('admin')
    expect((await conv(bob, group.id)).me?.role).toBe('admin')
    const byAdmin = await role(bob, group.id, carol, { role: 'admin' })
    expect(byAdmin.status).toBe(403)
    expect(errorReason(byAdmin)).toBe('requires_owner')
    const toOwner = await alice.patch(`/api/conversations/${group.id}/members/${bob.id}`, {
      role: 'owner',
    })
    expect(toOwner.status).toBe(422)
    expect((await role(alice, group.id, alice, { role: 'member' })).status).toBe(422)
    const demoted = await role(alice, group.id, bob, { role: 'member' })
    expect(demoted.body.role).toBe('member')
    expect((await bob.del(`/api/conversations/${group.id}/members/${carol.id}`)).status).toBe(403)
    expect((await role(alice, group.id, await person(app, 'zed'), { role: 'admin' })).status).toBe(
      404,
    )
  })

  test('a silence is a finite time in the future; it shows in the list and in the person’s own view, and can be lifted', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'quiet',
      memberIds: [bob.id],
    })
    const until = new Date(app.clock.now().getTime() + 3_600_000).toISOString()
    const silenced = await role(alice, group.id, bob, { silencedUntil: until })
    expect(silenced.status).toBe(200)
    expect(silenced.body.silencedUntil).toBe(until)
    expect((await conv(bob, group.id)).me?.silencedUntil).toBe(until)
    expect(
      (await members(alice, group.id)).members.find((m) => m.user.username === 'bob')
        ?.silencedUntil,
    ).toBe(until)

    for (const bad of [
      new Date(app.clock.now().getTime() - 1000).toISOString(),
      new Date(app.clock.now().getTime() + 400 * 86_400_000).toISOString(),
      'Infinity',
      'forever',
    ]) {
      expect((await role(alice, group.id, bob, { silencedUntil: bad })).status).toBe(422)
    }
    app.clock.advance(3_600_001)
    expect((await conv(bob, group.id)).me?.silencedUntil).toBeNull() // it ran out by itself
    const again = await role(alice, group.id, bob, {
      silencedUntil: new Date(app.clock.now().getTime() + 60_000).toISOString(),
    })
    expect(again.body.silencedUntil).not.toBeNull()
    expect(
      (await role(alice, group.id, bob, { silencedUntil: null })).body.silencedUntil,
    ).toBeNull()
    expect((await role(alice, group.id, bob, {})).status).toBe(422)
    // The owner cannot be silenced, not even by an administrator.
    await role(alice, group.id, bob, { role: 'admin' })
    const later = new Date(app.clock.now().getTime() + 3_600_000).toISOString()
    const owner = await role(bob, group.id, alice, { silencedUntil: later })
    expect(owner.status).toBe(403)
    expect(errorReason(owner)).toBe('cannot_target_owner')
  })
})

describe('invitation links', () => {
  const invite = async (who: Person, id: string, body: object = {}) =>
    who.post<CreatedConversationInvite>(`/api/conversations/${id}/invites`, body)

  test('a member makes a link, someone else previews and follows it and joins from that moment', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const carol = await person(app, 'carol')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'link',
      memberIds: [bob.id],
    })
    await dbs.owner.db
      .update(conversations)
      .set({ lastSeq: 4, lastChangeSeq: 4 })
      .where(eq(conversations.id, group.id))
    const made = await invite(bob, group.id)
    expect(made.status).toBe(201)
    expect(made.body.code).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/)
    expect(made.body).toMatchObject({
      createdBy: bob.id,
      maxUses: null,
      useCount: 0,
      revokedAt: null,
    })
    // Only the hash is stored (docs/04): the plaintext appears nowhere in the table.
    const rows = await dbs.owner.db.select().from(conversationInvites)
    expect(JSON.stringify(rows)).not.toContain(made.body.code.replaceAll('-', ''))

    const preview = await carol.post<ConversationInvitePreview>(
      '/api/conversation-invites/preview',
      { code: made.body.code },
    )
    expect(preview.body).toEqual({
      name: 'link',
      description: null,
      memberCount: 2,
      alreadyMember: false,
    })
    const accepted = await carol.post<Conversation>('/api/conversation-invites/accept', {
      code: made.body.code,
    })
    expect(accepted.status).toBe(200)
    expect(accepted.body.me).toMatchObject({ role: 'member', visibleFromSeq: 4 })
    expect(accepted.body.memberCount).toBe(3)
    // Following it again as a member uses no further slot.
    const again = await carol.post<Conversation>('/api/conversation-invites/accept', {
      code: made.body.code,
    })
    expect(again.status).toBe(200)
    expect((await dbs.owner.db.select().from(conversationInvites))[0]?.useCount).toBe(1)
    expect(
      (
        await carol.post<ConversationInvitePreview>('/api/conversation-invites/preview', {
          code: made.body.code,
        })
      ).body.alreadyMember,
    ).toBe(true)
  })

  test('limits, expiry, revocation and plain nonsense all answer the same INVITE_INVALID', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const carol = await person(app, 'carol')
    const group = await createConversation(alice, { kind: 'group', name: 'strict' })
    const once = await invite(alice, group.id, { maxUses: 1 })
    const soon = await invite(alice, group.id, { expiresInDays: 1 })
    const revoked = await invite(alice, group.id)
    await alice.del(`/api/conversations/${group.id}/invites/${revoked.body.id}`)

    expect(
      (await bob.post('/api/conversation-invites/accept', { code: once.body.code })).status,
    ).toBe(200)
    const used = await carol.post('/api/conversation-invites/accept', { code: once.body.code })
    expect(used.status).toBe(400)
    expect(errorCode(used)).toBe('INVITE_INVALID')
    app.clock.advance(2 * 86_400_000)
    expect(
      (await carol.post('/api/conversation-invites/accept', { code: soon.body.code })).status,
    ).toBe(400)
    for (const code of [revoked.body.code, 'ABCD-EFGH-IJKL-MNOP', 'nonsense', '']) {
      const reply = await carol.post('/api/conversation-invites/preview', { code })
      expect([400, 422]).toContain(reply.status)
      if (reply.status === 400) expect(errorCode(reply)).toBe('INVITE_INVALID')
    }
    expect(
      await app
        .request('/api/conversation-invites/preview', { json: { code: once.body.code } })
        .then((r) => r.status),
    ).toBe(401)
    expect(
      (
        await dbs.owner.db
          .select()
          .from(conversationInvites)
          .where(eq(conversationInvites.id, once.body.id))
      )[0]?.useCount,
    ).toBe(1)
  })

  test('a crowd racing for a link that allows three: exactly three get in', async () => {
    const alice = await person(app, 'alice')
    const group = await createConversation(alice, { kind: 'group', name: 'race' })
    const link = await invite(alice, group.id, { maxUses: 3 })
    const crowd = await Promise.all(Array.from({ length: 8 }, (_, i) => person(app, `racer${i}`)))
    const replies = await Promise.all(
      crowd.map((p) => p.post('/api/conversation-invites/accept', { code: link.body.code })),
    )
    expect(replies.filter((r) => r.status === 200)).toHaveLength(3)
    expect(replies.filter((r) => r.status === 400)).toHaveLength(5)
    expect((await dbs.owner.db.select().from(conversationInvites))[0]?.useCount).toBe(3)
    expect((await conv(alice, group.id)).memberCount).toBe(4)
  })

  test('a banned person cannot use a link, and only groups have links', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const group = await createConversation(alice, { kind: 'group', name: 'banlist' })
    const link = await invite(alice, group.id)
    await alice.post(`/api/conversations/${group.id}/bans`, { userId: bob.id })
    const refused = await bob.post('/api/conversation-invites/accept', { code: link.body.code })
    expect(refused.status).toBe(403)
    expect(errorCode(refused)).toBe('CONVERSATION_BANNED')
    const channel = await createConversation(alice, { kind: 'channel', name: 'nolinks' })
    expect((await invite(alice, channel.id)).status).toBe(403)
  })

  test('a link dies with its creator: leaving, removal, demotion under "admins only", or the group closing to members', async () => {
    const alice = await person(app, 'alice')
    const [bob, carol, dave, erin] = await Promise.all(
      ['bob', 'carol', 'dave', 'erin'].map((n) => person(app, n)),
    )
    if (!bob || !carol || !dave || !erin) throw new Error('people missing')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'chains',
      memberIds: [bob.id, carol.id, dave.id],
    })
    const stranger = await person(app, 'stranger')
    const byBob = await invite(bob, group.id)
    const byCarol = await invite(carol, group.id)
    const byDave = await invite(dave, group.id)
    const byAlice = await invite(alice, group.id)
    const live = async () =>
      (await dbs.owner.db.select().from(conversationInvites))
        .filter((row) => row.revokedAt === null)
        .map((row) => row.id)
    expect((await live()).length).toBe(4)

    await bob.post(`/api/conversations/${group.id}/leave`) // left
    expect(await live()).not.toContain(byBob.body.id)
    await alice.del(`/api/conversations/${group.id}/members/${carol.id}`) // removed
    expect(await live()).not.toContain(byCarol.body.id)
    expect(
      (await stranger.post('/api/conversation-invites/accept', { code: byBob.body.code })).status,
    ).toBe(400)
    expect(
      (await stranger.post('/api/conversation-invites/accept', { code: byCarol.body.code })).status,
    ).toBe(400)

    // The group becomes "admins only": links of ordinary members stop working, the owner's keeps working.
    await alice.patch(`/api/conversations/${group.id}`, {
      expectedMetadataVersion: (await conv(alice, group.id)).metadataVersion,
      settings: { whoCanInvite: 'admins_only' },
    })
    expect(await live()).toEqual([byAlice.body.id])
    expect(
      (await stranger.post('/api/conversation-invites/accept', { code: byDave.body.code })).status,
    ).toBe(400)
    expect(
      (await stranger.post('/api/conversation-invites/accept', { code: byAlice.body.code })).status,
    ).toBe(200)

    // An administrator's link ends with their administration.
    await role(alice, group.id, dave, { role: 'admin' })
    const byAdmin = await invite(dave, group.id)
    expect(byAdmin.status).toBe(201)
    await role(alice, group.id, dave, { role: 'member' })
    expect(await live()).not.toContain(byAdmin.body.id)
    expect(
      (await erin.post('/api/conversation-invites/accept', { code: byAdmin.body.code })).status,
    ).toBe(400)
  })

  test('administrators see every link, members only their own; revoking is the creator’s or an administrator’s', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const carol = await person(app, 'carol')
    const outsider = await person(app, 'outsider')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'listing',
      memberIds: [bob.id, carol.id],
    })
    const mine = await invite(bob, group.id)
    const theirs = await invite(carol, group.id)
    const all = await alice.get<{ invites: ConversationInvite[] }>(
      `/api/conversations/${group.id}/invites`,
    )
    expect(all.body.invites.map((i) => i.id).sort()).toEqual([mine.body.id, theirs.body.id].sort())
    const own = await bob.get<{ invites: ConversationInvite[] }>(
      `/api/conversations/${group.id}/invites`,
    )
    expect(own.body.invites.map((i) => i.id)).toEqual([mine.body.id])
    expect((await outsider.get(`/api/conversations/${group.id}/invites`)).status).toBe(404)

    expect((await bob.del(`/api/conversations/${group.id}/invites/${theirs.body.id}`)).status).toBe(
      404,
    )
    expect(
      (await carol.del(`/api/conversations/${group.id}/invites/${theirs.body.id}`)).status,
    ).toBe(200)
    expect((await alice.del(`/api/conversations/${group.id}/invites/${mine.body.id}`)).status).toBe(
      200,
    )
    expect((await alice.del(`/api/conversations/${group.id}/invites/${mine.body.id}`)).status).toBe(
      200,
    ) // already revoked
    expect(
      (await alice.del(`/api/conversations/${group.id}/invites/${crypto.randomUUID()}`)).status,
    ).toBe(404)
  })

  test('a member can hold only a handful of live links', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'many',
      memberIds: [bob.id],
    })
    for (let i = 0; i < 10; i += 1) expect((await invite(bob, group.id)).status).toBe(201)
    const over = await invite(bob, group.id)
    expect(over.status).toBe(403)
    expect(errorCode(over)).toBe('QUOTA_EXCEEDED')
    expect((await invite(alice, group.id)).status).toBe(201) // administrators are not held to it
  })

  test('the people who are members, bans and links of a conversation all belong to it alone', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const one = await createConversation(alice, { kind: 'group', name: 'one', memberIds: [bob.id] })
    const two = await createConversation(alice, { kind: 'group', name: 'two' })
    await alice.post(`/api/conversations/${one.id}/bans`, { userId: (await person(app, 'zed')).id })
    expect(
      await dbs.owner.db
        .select()
        .from(conversationBans)
        .where(eq(conversationBans.conversationId, two.id)),
    ).toEqual([])
    expect(
      await dbs.owner.db
        .select()
        .from(conversationMembers)
        .where(
          and(
            eq(conversationMembers.conversationId, two.id),
            eq(conversationMembers.userId, bob.id),
          ),
        ),
    ).toEqual([])
    expect((await dbs.owner.db.select().from(users)).length).toBe(3)
  })
})
