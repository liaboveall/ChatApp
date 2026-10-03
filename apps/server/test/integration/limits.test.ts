/**
 * The edges of the rules the other files test in the middle: the limit of conversations per person (docs/01 section 7),
 * a full group, a replay whose result is gone (D-066), a hand-over based on an old member list (D-128), restoring with
 * an owner named when one exists or cannot be used, and attachments before M3.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Conversation, CreatedConversationInvite, MessagesResponse } from '@chatapp/contracts'
import { LIMITS } from '@chatapp/contracts'
import { conversations } from '@chatapp/db'
import { eq } from 'drizzle-orm'
import { createConversation as createInDomain } from '../../src/domain/conversations.ts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { makePrincipal } from '../support/deps.ts'
import { createTestApp, type TestApp } from '../support/http.ts'
import {
  createConversation,
  errorCode,
  errorReason,
  key,
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

const details = (reply: Reply) =>
  (reply.body as { error: { details?: Record<string, unknown> } }).error.details

describe('the limit of conversations per person', () => {
  /** Puts a person in as many live groups as is allowed, the quick way: the domain function, not 200 HTTP calls. */
  async function fillUp(who: Person): Promise<void> {
    const principal = await makePrincipal(app.services.deps, who)
    for (let i = 0; i < LIMITS.maxConversationsPerUser; i += 1) {
      await createInDomain(
        app.services.deps,
        principal,
        { kind: 'group', name: `filler ${i}` },
        crypto.randomUUID(),
      )
    }
  }

  test('somebody at the limit cannot create, join or follow a link into one more; others leave them out; leaving frees a place', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    await fillUp(alice)

    const create = await alice.post(
      '/api/conversations',
      { kind: 'group', name: 'one too many' },
      key(),
    )
    expect(create.status).toBe(403)
    expect(errorCode(create)).toBe('QUOTA_EXCEEDED')
    expect(details(create)).toMatchObject({
      resource: 'conversations',
      limit: LIMITS.maxConversationsPerUser,
    })

    const channel = await createConversation(bob, { kind: 'channel', name: 'open' })
    const group = await createConversation(bob, { kind: 'group', name: 'closed' })
    const join = await alice.post(`/api/conversations/${channel.id}/join`)
    expect(join.status).toBe(403)
    expect(errorCode(join)).toBe('QUOTA_EXCEEDED')

    const added = await bob.post<{
      added: unknown[]
      skipped: Array<{ userId: string; reason: string }>
    }>(`/api/conversations/${group.id}/members`, { userIds: [alice.id] })
    expect(added.status).toBe(200)
    expect(added.body.added).toEqual([])
    expect(added.body.skipped).toEqual([{ userId: alice.id, reason: 'limit_reached' }])

    const link = await bob.post<CreatedConversationInvite>(
      `/api/conversations/${group.id}/invites`,
      {},
    )
    const accept = await alice.post('/api/conversation-invites/accept', { code: link.body.code })
    expect(accept.status).toBe(403)
    expect(errorCode(accept)).toBe('QUOTA_EXCEEDED')

    // Naming her when creating something leaves her out; the rest of the request goes through.
    const named = await bob.post<Conversation>(
      '/api/conversations',
      { kind: 'group', name: 'named', memberIds: [alice.id] },
      key(),
    )
    expect(named.status).toBe(201)
    expect(named.body.memberCount).toBe(1)

    // Leaving a group of her own (she is alone in it, so it is archived) gives a place back.
    const mine = (await alice.get<{ conversations: Conversation[] }>('/api/conversations')).body
      .conversations[0]
    expect((await alice.post(`/api/conversations/${mine?.id}/leave`)).status).toBe(200)
    expect((await alice.post(`/api/conversations/${channel.id}/join`)).status).toBe(200)
    // And she is at the limit again.
    expect(
      (await alice.post('/api/conversations', { kind: 'group', name: 'again' }, key())).status,
    ).toBe(403)
  }, 60_000)

  test('a group that is full turns a link follower away and says what is full', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const group = await createConversation(alice, { kind: 'group', name: 'packed' })
    const link = await alice.post<CreatedConversationInvite>(
      `/api/conversations/${group.id}/invites`,
      {},
    )
    await dbs.owner.db
      .update(conversations)
      .set({ memberCount: 500 })
      .where(eq(conversations.id, group.id))
    const accept = await bob.post('/api/conversation-invites/accept', { code: link.body.code })
    expect(accept.status).toBe(403)
    expect(errorCode(accept)).toBe('QUOTA_EXCEEDED')
    expect(details(accept)).toMatchObject({ resource: 'members', limit: 500 })
  })
})

describe('creating, replayed', () => {
  test('a replay whose conversation has since been removed is GONE, not a second conversation', async () => {
    const alice = await person(app, 'alice')
    const headers = key()
    const body = { kind: 'group', name: 'short-lived' }
    const first = await alice.post<Conversation>('/api/conversations', body, headers)
    expect(first.status).toBe(201)
    await dbs.owner.db.delete(conversations).where(eq(conversations.id, first.body.id))
    const replay = await alice.post('/api/conversations', body, headers)
    expect(replay.status).toBe(410)
    expect(errorCode(replay)).toBe('RESOURCE_GONE')
    expect(await dbs.owner.db.select().from(conversations)).toHaveLength(0)
  })
})

describe('handing over and restoring', () => {
  test('a hand-over that names the member-list version it was based on fails when the list moved', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'versions',
      memberIds: [bob.id],
    })
    const version = (await alice.get<Conversation>(`/api/conversations/${group.id}`)).body
      .membershipVersion
    const stale = await alice.post(`/api/conversations/${group.id}/transfer`, {
      userId: bob.id,
      expectedMembershipVersion: version - 1,
    })
    expect(stale.status).toBe(409)
    expect(errorCode(stale)).toBe('VERSION_CONFLICT')
    expect(details(stale)).toMatchObject({ membershipVersion: version })
    expect((await alice.get<Conversation>(`/api/conversations/${group.id}`)).body.me?.role).toBe(
      'owner',
    )

    const done = await alice.post<Conversation>(`/api/conversations/${group.id}/transfer`, {
      userId: bob.id,
      expectedMembershipVersion: version,
    })
    expect(done.status).toBe(200)
    expect(done.body.me?.role).toBe('admin')
  })

  test('naming an owner for a conversation that has one is refused; a named heir must be somebody who can be one', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const root = await person(app, 'root', { role: 'admin' })
    const group = await createConversation(alice, { kind: 'group', name: 'to restore' })
    expect((await alice.post(`/api/conversations/${group.id}/leave`)).status).toBe(200) // alone: archived, hers to restore

    const hasOwner = await alice.post(`/api/conversations/${group.id}/restore`, {
      ownerUserId: bob.id,
    })
    expect(hasOwner.status).toBe(422)
    expect(errorReason(hasOwner)).toBe('has_owner')

    // Nobody owns it any more (as after an account is closed): the site administrator names the heir.
    await dbs.owner.db
      .update(conversations)
      .set({ ownerId: null })
      .where(eq(conversations.id, group.id))
    const unknown = await root.post(`/api/conversations/${group.id}/restore`, {
      ownerUserId: crypto.randomUUID(),
    })
    expect(unknown.status).toBe(422)
    expect(errorReason(unknown)).toBe('unavailable')
    const missing = await root.post(`/api/conversations/${group.id}/restore`, {})
    expect(errorReason(missing)).toBe('required')
    const restored = await root.post<Conversation>(`/api/conversations/${group.id}/restore`, {
      ownerUserId: bob.id,
    })
    expect(restored.status).toBe(200)
    expect(restored.body.archivedAt).toBeNull()
  })
})

describe('messages before attachments exist', () => {
  test('naming an attachment is refused, as not available yet, and nothing is written', async () => {
    const alice = await person(app, 'alice')
    const group = await createConversation(alice, { kind: 'group', name: 'text only' })
    const reply = await alice.post(`/api/conversations/${group.id}/messages`, {
      clientId: crypto.randomUUID(),
      body: 'with a picture',
      attachmentIds: [crypto.randomUUID()],
    })
    expect(reply.status).toBe(422)
    expect(errorReason(reply)).toBe('not_available')
    const listed = await alice.get<MessagesResponse>(`/api/conversations/${group.id}/messages`)
    expect(listed.body.messages.filter((m) => m.kind === 'user')).toEqual([])
  })
})
