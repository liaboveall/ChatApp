/**
 * Profiles and the member directory (docs/01 section 4.3, docs/05 sections 3.1 and 3.2, M2a): the display name and the
 * username with their reserved words, the 30-day cooldown and the 30-day hold on a name given up (L-19, L-24, SEC-14),
 * and member search and public profiles.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Me, MessageEnvelope, UserProfile, UserSearchResponse } from '@chatapp/contracts'
import { sessions, usernameReservations, users } from '@chatapp/db'
import { runBootstrap } from '@chatapp/db/bootstrap'
import { eq } from 'drizzle-orm'
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

const DAY = 86_400_000

const meOf = async (who: Person) => (await who.get<Me>('/api/me')).body
const change = async (who: Person, body: object) =>
  who.patch<Me>('/api/me', { expectedMeVersion: (await meOf(who)).meVersion, ...body })
/** Sessions last 30 days on the real clock; the test clock is about to jump past that. */
const keepSessions = () =>
  dbs.owner.db.update(sessions).set({ expiresAt: new Date(Date.now() + 400 * DAY) })

describe('the display name (L-24)', () => {
  test('changes, moves both versions, and shows up under the new name wherever people are listed', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'names',
      memberIds: [bob.id],
    })
    const before = await meOf(alice)
    const sent = await alice.post<MessageEnvelope>(`/api/conversations/${group.id}/messages`, {
      clientId: crypto.randomUUID(),
      body: 'hello',
    })
    expect(sent.body.users[alice.id]?.displayName).toBe('alice')

    const reply = await change(alice, { displayName: '爱丽丝 🌟' })
    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({
      displayName: '爱丽丝 🌟',
      username: 'alice',
      meVersion: before.meVersion + 1,
      profileVersion: before.profileVersion + 1,
    })
    // The next list names her as she is now, with the newer profile version so clients refresh their copies.
    const page = await bob.get<{
      users: Record<string, { displayName: string; profileVersion: number }>
    }>(`/api/conversations/${group.id}/messages`)
    expect(page.body.users[alice.id]).toMatchObject({
      displayName: '爱丽丝 🌟',
      profileVersion: before.profileVersion + 1,
    })
    // Saying what is already true changes no version.
    const same = await change(alice, { displayName: '爱丽丝 🌟' })
    expect(same.body.meVersion).toBe(reply.body.meVersion)
    expect(same.body.profileVersion).toBe(reply.body.profileVersion)
  })

  test('reserved words are refused in any form: the assistant’s name, "system", full-width and spaced variants', async () => {
    const alice = await person(app, 'alice')
    await runBootstrap(dbs.owner.db, {
      agentUsername: 'assistant',
      agentDisplayName: '助手',
      productName: 'ChatApp',
    })
    for (const name of [
      '助手',
      '系统',
      '管理员',
      'System',
      'ＳＹＳＴＥＭ',
      '助 手',
      'ADMIN',
      '客服',
    ]) {
      const reply = await change(alice, { displayName: name })
      expect(reply.status).toBe(422)
      expect(errorReason(reply)).toBe('reserved')
    }
    expect((await meOf(alice)).displayName).toBe('alice')
  })

  test('has the same limits as at registration: 1 to 32 characters, nothing invisible or controlling', async () => {
    const alice = await person(app, 'alice')
    for (const name of [
      '',
      '   ',
      'x'.repeat(33),
      'bad‮name',
      'zero​width',
      'line\nbreak',
      'nul\u0000',
    ]) {
      expect((await change(alice, { displayName: name })).status).toBe(422)
    }
    expect((await change(alice, { displayName: '👨‍👩‍👧‍👦' })).status).toBe(200) // one family emoji is one character
    expect((await change(alice, { displayName: 'a'.repeat(32) })).status).toBe(200)
  })
})

describe('the username (L-19)', () => {
  test('changes once, keeps the format and the reserved words, and cannot be one that is taken', async () => {
    const alice = await person(app, 'alice')
    await person(app, 'bob')
    await runBootstrap(dbs.owner.db, {
      agentUsername: 'assistant',
      agentDisplayName: '助手',
      productName: 'ChatApp',
    })
    for (const bad of ['ab', 'Alice2', 'a-b', '用户名字', 'x'.repeat(21), 'with space']) {
      expect((await change(alice, { username: bad })).status).toBe(422)
    }
    for (const reserved of ['admin', 'assistant', 'chatapp', 'system', 'deleted_x1y2']) {
      const reply = await change(alice, { username: reserved })
      expect(reply.status).toBe(422)
      expect(errorReason(reply)).toBe('reserved')
    }
    const taken = await change(alice, { username: 'bob' })
    expect(taken.status).toBe(409)
    expect(errorReason(taken)).toBe('taken')

    const ok = await change(alice, { username: 'alice_two' })
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ username: 'alice_two' })
    const [row] = await dbs.owner.db.select().from(users).where(eq(users.id, alice.id))
    expect(row?.usernameChangedAt).not.toBeNull()
  })

  test('only once in 30 days, and the name given up stays reserved for 30 days: nobody else can take it (L-19)', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    await change(alice, { username: 'alice_new' })
    const [held] = await dbs.owner.db
      .select()
      .from(usernameReservations)
      .where(eq(usernameReservations.username, 'alice'))
    expect(held).toMatchObject({ userId: alice.id })
    expect(held?.reservedUntil?.getTime()).toBe(app.clock.now().getTime() + 30 * DAY)

    // The same person cannot change again at once.
    const again = await change(alice, { username: 'alice_third' })
    expect(again.status).toBe(422)
    expect(errorReason(again)).toBe('cooldown')
    const available = (again.body as unknown as { error: { details: { availableAt: string } } })
      .error.details.availableAt
    expect(new Date(available).getTime()).toBe(app.clock.now().getTime() + 30 * DAY)

    // Somebody else cannot take the old name for 30 days, not even bob who asks the first moment it is free.
    await keepSessions()
    app.clock.advance(29 * DAY)
    const early = await change(bob, { username: 'alice' })
    expect(early.status).toBe(409)
    expect(errorReason(early)).toBe('taken')
    app.clock.advance(DAY + 1000)
    expect((await change(bob, { username: 'alice' })).status).toBe(200)
    // And alice may change again too.
    expect((await change(alice, { username: 'alice_third' })).status).toBe(200)
  })

  test('a person who gave a name up may take it back when their cooldown ends, and a second holder is refused', async () => {
    const alice = await person(app, 'alice')
    const carol = await person(app, 'carol')
    await change(alice, { username: 'wonder' })
    await keepSessions()
    app.clock.advance(31 * DAY)
    expect((await change(alice, { username: 'alice' })).status).toBe(200)
    // Back under the old name: the reservation of "wonder" is hers, and the old one for "alice" is gone.
    const rows = await dbs.owner.db
      .select()
      .from(usernameReservations)
      .where(eq(usernameReservations.userId, alice.id))
    expect(rows.map((r) => r.username).sort()).toEqual(['wonder'])
    const refused = await change(carol, { username: 'wonder' })
    expect(refused.status).toBe(409)
  })

  test('simultaneous changes to the same name: one account gets it', async () => {
    const [a, b, c] = await Promise.all(['one', 'two', 'three'].map((n) => person(app, n)))
    if (!a || !b || !c) throw new Error('people missing')
    const results = await Promise.all(
      [a, b, c].map((who) => change(who, { username: 'contested' })),
    )
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409])
    const rows = await dbs.owner.db.select().from(users).where(eq(users.username, 'contested'))
    expect(rows).toHaveLength(1)
  })
})

describe('the bio and the rest of the body', () => {
  test('is trimmed, cleared with an empty text or null, and limited to 200 characters', async () => {
    const alice = await person(app, 'alice')
    expect((await change(alice, { bio: '  hello there  ' })).body.bio).toBe('hello there')
    expect((await change(alice, { bio: '' })).body.bio).toBeNull()
    expect((await change(alice, { bio: 'x'.repeat(200) })).body.bio).toHaveLength(200)
    expect((await change(alice, { bio: null })).body.bio).toBeNull()
    expect((await change(alice, { bio: 'x'.repeat(201) })).status).toBe(422)
    // The bio is not part of the public summary: the profile version does not move for it.
    const before = await meOf(alice)
    const reply = await change(alice, { bio: 'new bio' })
    expect(reply.body.profileVersion).toBe(before.profileVersion)
    expect(reply.body.meVersion).toBe(before.meVersion + 1)
  })

  test('privileged and unknown fields are refused, a stale version is a conflict, and one request can change several things', async () => {
    const alice = await person(app, 'alice')
    const version = (await meOf(alice)).meVersion
    for (const extra of [
      { role: 'admin' },
      { email: 'x@y.co' },
      { isBot: true },
      { avatarUrl: 'http://x' },
      { inviteQuota: 99 },
    ]) {
      expect(
        (await alice.patch('/api/me', { expectedMeVersion: version, displayName: 'ok', ...extra }))
          .status,
      ).toBe(422)
    }
    expect((await meOf(alice)).displayName).toBe('alice')
    const several = await alice.patch<Me>('/api/me', {
      expectedMeVersion: version,
      displayName: 'Alice A',
      username: 'alice_a',
      bio: 'both at once',
      timezone: 'Europe/Paris',
    })
    expect(several.status).toBe(200)
    expect(several.body).toMatchObject({
      displayName: 'Alice A',
      username: 'alice_a',
      bio: 'both at once',
      timezone: 'Europe/Paris',
      meVersion: version + 1,
    })
    const stale = await alice.patch('/api/me', { expectedMeVersion: version, displayName: 'late' })
    expect(stale.status).toBe(409)
    expect(errorCode(stale)).toBe('VERSION_CONFLICT')
    // A refused change leaves nothing behind: validation failed after the check, so the version did not move.
    const refused = await alice.patch('/api/me', {
      expectedMeVersion: version + 1,
      displayName: 'System',
      username: 'free_name',
    })
    expect(refused.status).toBe(422)
    expect((await meOf(alice)).username).toBe('alice_a')
    expect((await meOf(alice)).meVersion).toBe(version + 1)
  })
})

describe('member search', () => {
  async function crowd() {
    const alice = await person(app, 'alice')
    await person(app, 'maria')
    await person(app, 'mario')
    await person(app, 'amarillo')
    const jane = await person(app, 'jane')
    await change(jane, { displayName: 'Mary Jane' })
    return alice
  }
  const search = (who: Person, query: string) =>
    who.get<UserSearchResponse>(`/api/users?query=${encodeURIComponent(query)}`)

  test('finds people by username or display name, the closest match first, never the searcher', async () => {
    const alice = await crowd()
    const found = await search(alice, 'mar')
    expect(found.status).toBe(200)
    expect(found.body.users.map((u) => u.username)).toEqual(['maria', 'mario', 'jane', 'amarillo'])
    expect((await search(alice, 'maria')).body.users.map((u) => u.username)).toEqual(['maria'])
    expect((await search(alice, 'MARY')).body.users.map((u) => u.username)).toEqual(['jane'])
    expect((await search(alice, 'alice')).body.users).toEqual([]) // oneself is never a result
    expect((await search(alice, 'nobody-here')).body.users).toEqual([])
    const entry = found.body.users[0]
    expect(Object.keys(entry ?? {}).sort()).toEqual([
      'avatarUrl',
      'deleted',
      'displayName',
      'id',
      'isBot',
      'profileVersion',
      'username',
    ])
  })

  test('treats % and _ as plain characters, rejects empty and over-long queries, and needs a session', async () => {
    const alice = await crowd()
    for (const wildcard of ['%', '_', 'm%o', '\\']) {
      expect((await search(alice, wildcard)).body.users).toEqual([])
    }
    expect((await alice.get('/api/users?query=')).status).toBe(422)
    expect((await alice.get('/api/users')).status).toBe(422)
    expect((await search(alice, 'x'.repeat(65))).status).toBe(422)
    expect((await app.request('/api/users?query=mar')).status).toBe(401)
  })

  test('leaves out bots, accounts that are not active and accounts that are gone; returns at most 20', async () => {
    const alice = await person(app, 'alice')
    await runBootstrap(dbs.owner.db, {
      agentUsername: 'assistant',
      agentDisplayName: '助手',
      productName: 'ChatApp',
    })
    await dbs.owner.db.insert(users).values({
      name: 'Pending Pat',
      email: 'pat@example.com',
      username: 'pat_pending',
      accountSource: 'cli',
      activationStatus: 'pending',
      emailVerified: false,
    })
    const gone = await person(app, 'pat_gone')
    await dbs.owner.db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, gone.id))
    expect((await search(alice, 'pat')).body.users).toEqual([])
    expect((await search(alice, 'assistant')).body.users).toEqual([])
    for (let i = 0; i < 24; i += 1) {
      await dbs.owner.db.insert(users).values({
        name: `Crowd ${i}`,
        email: `crowd${i}@example.com`,
        username: `crowd_${String(i).padStart(2, '0')}`,
        accountSource: 'cli',
        activationStatus: 'active',
        emailVerified: true,
      })
    }
    const many = await search(alice, 'crowd')
    expect(many.body.users).toHaveLength(20)
    expect(many.body.users.map((u) => u.username)).toEqual(
      Array.from({ length: 20 }, (_, i) => `crowd_${String(i).padStart(2, '0')}`),
    )
  })
})

describe('public profiles', () => {
  const profile = (who: Person, id: string) => who.get<UserProfile>(`/api/users/${id}`)

  test('shows the public summary and the bio, never the email or the role', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    await change(bob, { bio: 'I make soup' })
    const reply = await profile(alice, bob.id)
    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({
      id: bob.id,
      username: 'bob',
      displayName: 'bob',
      bio: 'I make soup',
      isBot: false,
      deleted: false,
    })
    expect(new Date(reply.body.createdAt).toString()).not.toBe('Invalid Date')
    const raw = JSON.stringify(reply.body)
    for (const secret of ['example.com', 'role', 'email', 'invite', 'settings'])
      expect(raw).not.toContain(secret)
    expect((await profile(alice, alice.id)).status).toBe(200)
  })

  test('unknown ids and unfinished accounts are 404; a deleted account is the anonymous placeholder; the assistant is visible', async () => {
    const alice = await person(app, 'alice')
    const gone = await person(app, 'leaver')
    await change(gone, { bio: 'private bio' })
    await dbs.owner.db
      .update(users)
      .set({ deletedAt: new Date(), name: '已注销用户', username: 'deleted_ab12cd' })
      .where(eq(users.id, gone.id))
    const deleted = await profile(alice, gone.id)
    expect(deleted.status).toBe(200)
    expect(deleted.body).toMatchObject({
      displayName: '已注销用户',
      username: 'deleted_ab12cd',
      deleted: true,
      bio: null,
    })
    expect(JSON.stringify(deleted.body)).not.toContain('private bio')

    const { agentUserId } = await runBootstrap(dbs.owner.db, {
      agentUsername: 'assistant',
      agentDisplayName: '助手',
      productName: 'ChatApp',
    })
    expect((await profile(alice, agentUserId)).body).toMatchObject({
      isBot: true,
      displayName: '助手',
    })
    const [pending] = await dbs.owner.db
      .insert(users)
      .values({
        name: 'Pending',
        email: 'p@example.com',
        username: 'pending_one',
        accountSource: 'cli',
        activationStatus: 'pending',
        emailVerified: false,
      })
      .returning({ id: users.id })
    expect((await profile(alice, pending?.id ?? '')).status).toBe(404)
    expect((await profile(alice, crypto.randomUUID())).status).toBe(404)
    expect((await alice.get('/api/users/not-a-uuid')).status).toBe(422)
    expect((await app.request(`/api/users/${gone.id}`)).status).toBe(401)
  })
})
