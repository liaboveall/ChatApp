/**
 * The permission matrix at the HTTP boundary (docs/01 section 5, docs/07 SEC-02, AT-01 to AT-03): every conversation,
 * message, sync and directory endpoint is called as an anonymous visitor, a stranger, an ordinary member, an
 * administrator of the conversation, its owner and a site administrator who is not a member, against a group, a channel
 * and a direct message.
 *
 * Besides the status each of them must get, the test checks that
 *  - a refused call changes nothing (the rows of the conversation are identical afterwards);
 *  - a refusal does not repeat what it protects (name, message text, invitation code);
 *  - a private conversation or message one may not see is indistinguishable from one that does not exist (no oracle);
 *  - no endpoint is missing from the table, so a new route cannot ship without a row here.
 *
 * Direct messages have two participants: `member` and `owner`. `admin`, `stranger` and `siteAdmin` are outside it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import {
  conversationBans,
  conversationChanges,
  conversationInvites,
  conversationMembers,
  conversations,
  messageHidden,
  messages,
  userConversationStates,
} from '@chatapp/db'
import { and, eq, inArray } from 'drizzle-orm'
import { createConversationInvite } from '../../src/domain/conversation-invites.ts'
import {
  archiveConversation,
  createConversation as createConversationInDomain,
  openDirectMessage,
} from '../../src/domain/conversations.ts'
import {
  banConversationMember,
  removeConversationMember,
  updateConversationMember,
} from '../../src/domain/members.ts'
import { sendMessage } from '../../src/domain/messages.ts'
import type { SessionPrincipal } from '../../src/domain/principal.ts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { makePrincipal } from '../support/deps.ts'
import { createTestApp, type TestApp } from '../support/http.ts'
import { type ErrorBody, key, type Person, person, type Reply } from '../support/people.ts'

type Kind = 'group' | 'channel' | 'dm' | 'none'
type Actor = 'anon' | 'stranger' | 'member' | 'admin' | 'owner' | 'siteAdmin'
type Expected = number | 'ok'
type Row = Record<Exclude<Actor, 'anon'>, Expected>

const OK = 'ok'
/** stranger, member, admin, owner, siteAdmin (an anonymous visitor is always refused with 401). */
const row = (
  stranger: Expected,
  member: Expected,
  admin: Expected,
  owner: Expected,
  siteAdmin: Expected,
): Row => ({
  stranger,
  member,
  admin,
  owner,
  siteAdmin,
})
const EVERYONE = row(OK, OK, OK, OK, OK)

type FixtureOptions = { archived?: boolean; ban?: boolean; invite?: boolean }
type Fixture = {
  kind: Kind
  id: string
  name: string
  /** The text of the one message in it, written by `member`. */
  secret: string
  messageId: string
  messageSeq: number
  messageChangeSeq: number
  inviteId: string
  inviteCode: string
}
type Built = {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  body?: unknown
  headers?: Record<string, string>
}
type Case = {
  route: string
  fixture?: FixtureOptions
  /** The route is addressed by a message id: a channel is public, but a message one cannot read still "does not exist". */
  messageScoped?: boolean
  build: (context: { f: Fixture; who: Person | null }) => Built | Promise<Built>
  expect: Partial<Record<Kind, Row>>
}

let dbs: TestDatabases
let app: TestApp
let P: Record<'owner' | 'admin' | 'member' | 'target' | 'stranger' | 'siteAdmin' | 'extra', Person>
let K: Record<keyof typeof P, SessionPrincipal>
let actors: Record<Actor, Person | null>

beforeAll(async () => {
  dbs = openTestDatabases()
  await truncateAll(dbs.owner)
  app = await createTestApp(dbs)
  const names = ['owner', 'admin', 'member', 'target', 'stranger', 'siteAdmin', 'extra'] as const
  const people = {} as typeof P
  const principals = {} as typeof K
  for (const name of names) {
    people[name] = await person(app, name.toLowerCase(), {
      role: name === 'siteAdmin' ? 'admin' : 'user',
    })
    principals[name] = await makePrincipal(app.services.deps, people[name], {
      role: name === 'siteAdmin' ? 'admin' : 'user',
    })
  }
  P = people
  K = principals
  actors = {
    anon: null,
    stranger: P.stranger,
    member: P.member,
    admin: P.admin,
    owner: P.owner,
    siteAdmin: P.siteAdmin,
  }
})
afterAll(async () => {
  await truncateAll(dbs.owner)
  await app.close()
  await dbs.close()
})

// ───────── fixtures ─────────

const deps = () => app.services.deps
const db = () => dbs.owner.db

/**
 * Every fixture is a new conversation, and one person may be in 200 at most: what a test made goes away with it. (The
 * states of left conversations carry no foreign key on purpose, so they are removed by hand.)
 */
const made: string[] = []
afterEach(async () => {
  const ids = made.splice(0)
  if (ids.length === 0) return
  await db()
    .delete(userConversationStates)
    .where(inArray(userConversationStates.conversationId, ids))
  await db().delete(conversations).where(inArray(conversations.id, ids))
})

async function buildFixture(kind: Kind, options: FixtureOptions = {}): Promise<Fixture> {
  const tag = Math.random().toString(36).slice(2, 10)
  const fixture: Fixture = {
    kind,
    id: crypto.randomUUID(),
    name: `secret-${kind}-${tag}`,
    secret: `secret-text-${tag}`,
    messageId: crypto.randomUUID(),
    messageSeq: 1,
    messageChangeSeq: 1,
    inviteId: crypto.randomUUID(),
    inviteCode: '',
  }
  if (kind === 'none') return fixture

  let id: string
  if (kind === 'dm') {
    id = (await openDirectMessage(deps(), K.owner, { userId: P.member.id })).conversation.id
  } else {
    id = (
      await createConversationInDomain(
        deps(),
        K.owner,
        { kind, name: fixture.name, memberIds: [P.admin.id, P.member.id, P.target.id] },
        crypto.randomUUID(),
      )
    ).conversation.id
    await updateConversationMember(deps(), K.owner, id, P.admin.id, { role: 'admin' })
  }
  made.push(id)
  const sent = await sendMessage(deps(), K.member, id, {
    clientId: crypto.randomUUID(),
    body: fixture.secret,
  })
  fixture.id = id
  fixture.messageId = sent.envelope.message.id
  fixture.messageSeq = sent.envelope.message.seq
  fixture.messageChangeSeq = sent.envelope.message.changeSeq
  if (options.invite && kind === 'group') {
    const invite = await createConversationInvite(deps(), K.owner, id, {})
    fixture.inviteId = invite.id
    fixture.inviteCode = invite.code
  }
  if (options.ban && kind !== 'dm')
    await banConversationMember(deps(), K.owner, id, { userId: P.extra.id })
  if (options.archived && kind !== 'dm') await archiveConversation(deps(), K.owner, id)
  return fixture
}

/** The same fixture, pointing at things that do not exist. */
const ghostOf = (f: Fixture): Fixture => ({
  ...f,
  id: crypto.randomUUID(),
  messageId: crypto.randomUUID(),
  inviteId: crypto.randomUUID(),
})

const TABLES = [
  'conversations',
  'conversation_members',
  'conversation_bans',
  'conversation_invites',
  'messages',
  'conversation_changes',
  'user_conversation_states',
  'message_hidden',
]

/**
 * Everything a refused call could have touched in this conversation, table by table. The rows of a table are put in an order
 * of their own: a query without ORDER BY gives them in the order the planner's plan happens to produce, and a plan can change
 * between two reads (statistics refreshed in the meantime) without a row having changed.
 */
async function snapshot(f: Fixture): Promise<unknown[][]> {
  if (f.kind === 'none') return []
  const tables = await Promise.all([
    db().select().from(conversations).where(eq(conversations.id, f.id)),
    db().select().from(conversationMembers).where(eq(conversationMembers.conversationId, f.id)),
    db().select().from(conversationBans).where(eq(conversationBans.conversationId, f.id)),
    db().select().from(conversationInvites).where(eq(conversationInvites.conversationId, f.id)),
    db().select().from(messages).where(eq(messages.conversationId, f.id)),
    db().select().from(conversationChanges).where(eq(conversationChanges.conversationId, f.id)),
    db()
      .select()
      .from(userConversationStates)
      .where(eq(userConversationStates.conversationId, f.id)),
    db().select().from(messageHidden).where(eq(messageHidden.messageId, f.messageId)),
  ])
  return tables.map((rows) =>
    [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  )
}

/** What differs between two snapshots, as text for the failure message: the table, the row and the columns. */
function describeChange(before: unknown[][], after: unknown[][]): string {
  const found: string[] = []
  for (let table = 0; table < Math.max(before.length, after.length); table += 1) {
    const was = before[table] ?? []
    const now = after[table] ?? []
    if (JSON.stringify(was) === JSON.stringify(now)) continue
    if (was.length !== now.length)
      found.push(`${TABLES[table]}: ${was.length} rows, then ${now.length}`)
    for (let row = 0; row < Math.min(was.length, now.length); row += 1) {
      const a = was[row] as Record<string, unknown>
      const b = now[row] as Record<string, unknown>
      for (const column of Object.keys({ ...a, ...b })) {
        if (JSON.stringify(a[column]) !== JSON.stringify(b[column])) {
          found.push(
            `${TABLES[table]}[${row}].${column}: ${JSON.stringify(a[column])}, then ${JSON.stringify(b[column])}`,
          )
        }
      }
    }
  }
  return found.join('; ')
}

const metadataVersionOf = async (f: Fixture): Promise<number> =>
  (await db().select().from(conversations).where(eq(conversations.id, f.id)))[0]?.metadataVersion ??
  1

const viewerVersionOf = async (who: Person | null, f: Fixture): Promise<number> => {
  if (!who) return 1
  const [state] = await db()
    .select()
    .from(userConversationStates)
    .where(
      and(
        eq(userConversationStates.userId, who.id),
        eq(userConversationStates.conversationId, f.id),
      ),
    )
  return state?.viewerVersion ?? 1
}

// ───────── calling ─────────

async function call(who: Person | null, built: Built): Promise<Reply> {
  if (who) {
    switch (built.method) {
      case 'GET':
        return await who.get(built.path, built.headers)
      case 'POST':
        return await who.post(built.path, built.body, built.headers)
      case 'PATCH':
        return await who.patch(built.path, built.body)
      case 'DELETE':
        return await who.del(built.path)
    }
  }
  const response = await app.request(built.path, {
    method: built.method,
    headers: built.headers,
    ...(built.body === undefined ? {} : { json: built.body }),
  })
  const text = await response.text()
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    headers: response.headers,
  }
}

const failure = (reply: Reply) => (reply.body as ErrorBody | null)?.error

/** A person is in the dark about a conversation when it answers as if there were none. */
const hiddenFrom = (kind: Kind, actor: Actor): boolean =>
  (kind === 'group' && actor === 'stranger') ||
  (kind === 'dm' && (actor === 'stranger' || actor === 'admin' || actor === 'siteAdmin'))

// ───────── the table ─────────

const at = (f: Fixture, tail = '') => `/api/conversations/${f.id}${tail}`

/** Whom a call aims at: the plain member `target`; in a direct message, the other of its two participants. */
const aimedAt = (f: Fixture, who: Person | null): Person =>
  f.kind === 'dm' ? (who?.id === P.member.id ? P.owner : P.member) : P.target

const CASES: Case[] = [
  {
    route: 'DELETE /api/conversations/{id}',
    build: ({ f }) => ({ method: 'DELETE', path: `/api/conversations/${f.id}` }),
    expect: {
      group: row(404, 403, 403, 403, 403),
      channel: row(403, 403, 403, 403, 403),
      dm: row(404, 403, 404, 403, 404),
    },
  },
  {
    route: 'GET /api/search/messages',
    build: ({ f }) => ({
      method: 'GET',
      path: `/api/search/messages?query=secret&conversationId=${f.id}`,
    }),
    expect: {
      group: row(404, OK, OK, OK, 403),
      channel: row(403, OK, OK, OK, 403),
      dm: row(404, OK, 404, OK, 404),
    },
  },
  {
    route: 'GET /api/conversations/{id}/mentions',
    build: ({ f }) => ({ method: 'GET', path: at(f, '/mentions') }),
    expect: {
      group: row(404, OK, OK, OK, 403),
      channel: row(403, OK, OK, OK, 403),
      dm: row(404, OK, 404, OK, 404),
    },
  },
  {
    route: 'GET /api/conversations/{id}/attachments',
    build: ({ f }) => ({ method: 'GET', path: `/api/conversations/${f.id}/attachments` }),
    expect: {
      group: row(404, OK, OK, OK, 403),
      channel: row(403, OK, OK, OK, 403),
      dm: row(404, OK, 404, OK, 404),
    },
  },
  {
    route: 'POST /api/conversations/{id}/avatar',
    build: async ({ f }) => {
      const [c] = await db().select().from(conversations).where(eq(conversations.id, f.id))
      return {
        method: 'POST',
        path: `/api/conversations/${f.id}/avatar`,
        body: { attachmentId: null, expectedVersion: c?.metadataVersion ?? 1 },
      }
    },
    expect: {
      group: row(404, 403, OK, OK, OK),
      channel: row(403, 403, OK, OK, OK),
      dm: row(404, 403, 404, 403, 404),
    },
  },
  // — the person's own lists and the directory: any signed-in person —
  {
    route: 'GET /api/conversations',
    build: () => ({ method: 'GET', path: '/api/conversations' }),
    expect: { none: EVERYONE },
  },
  {
    route: 'POST /api/conversations',
    build: () => ({
      method: 'POST',
      path: '/api/conversations',
      body: { kind: 'group', name: `made-${Math.random().toString(36).slice(2, 8)}` },
      headers: key(),
    }),
    expect: { none: EVERYONE },
  },
  {
    route: 'POST /api/conversations/dm',
    build: () => ({ method: 'POST', path: '/api/conversations/dm', body: { userId: P.extra.id } }),
    expect: { none: EVERYONE },
  },
  {
    route: 'GET /api/channels',
    build: () => ({ method: 'GET', path: '/api/channels' }),
    expect: { none: EVERYONE },
  },
  {
    route: 'GET /api/users',
    build: () => ({ method: 'GET', path: '/api/users?query=owner' }),
    expect: { none: EVERYONE },
  },
  {
    route: 'GET /api/users/{id}',
    build: () => ({ method: 'GET', path: `/api/users/${P.owner.id}` }),
    expect: { none: EVERYONE },
  },
  {
    route: 'GET /api/sync/heads',
    build: () => ({ method: 'GET', path: '/api/sync/heads' }),
    expect: { none: EVERYONE },
  },
  {
    route: 'GET /api/me/changes',
    build: () => ({ method: 'GET', path: '/api/me/changes?after=0' }),
    expect: { none: EVERYONE },
  },

  // — the conversation itself —
  {
    route: 'GET /api/conversations/{id}',
    build: ({ f }) => ({ method: 'GET', path: at(f) }),
    expect: {
      group: row(404, OK, OK, OK, OK),
      channel: row(OK, OK, OK, OK, OK),
      dm: row(404, OK, 404, OK, 404),
    },
  },
  {
    route: 'PATCH /api/conversations/{id}',
    build: async ({ f }) => ({
      method: 'PATCH',
      path: at(f),
      body: { expectedMetadataVersion: await metadataVersionOf(f), description: 'changed' },
    }),
    expect: {
      group: row(404, 403, OK, OK, OK),
      channel: row(403, 403, OK, OK, OK),
      dm: row(404, 403, 404, 403, 404),
    },
  },
  {
    route: 'POST /api/conversations/{id}/archive',
    build: ({ f }) => ({ method: 'POST', path: at(f, '/archive') }),
    expect: {
      group: row(404, 403, 403, OK, OK),
      channel: row(403, 403, 403, OK, OK),
      dm: row(404, 403, 404, 403, 404),
    },
  },
  {
    route: 'POST /api/conversations/{id}/restore',
    fixture: { archived: true },
    build: ({ f }) => ({ method: 'POST', path: at(f, '/restore'), body: {} }),
    expect: {
      group: row(404, 403, 403, OK, OK),
      channel: row(403, 403, 403, OK, OK),
      dm: row(404, 403, 404, 403, 404),
    },
  },
  {
    route: 'POST /api/conversations/{id}/join',
    build: ({ f }) => ({ method: 'POST', path: at(f, '/join') }),
    expect: {
      // Members are already in (the same answer again); a site administrator may join a channel like anyone,
      // but a group needs an invitation.
      group: row(404, OK, OK, OK, 403),
      channel: row(OK, OK, OK, OK, OK),
      dm: row(404, OK, 404, OK, 404),
    },
  },
  {
    route: 'POST /api/conversations/{id}/leave',
    build: ({ f }) => ({ method: 'POST', path: at(f, '/leave') }),
    expect: {
      // The owner hands over first (409); leaving a channel one is not in is already the end state asked for.
      group: row(404, OK, OK, 409, 403),
      channel: row(OK, OK, OK, 409, OK),
      dm: row(404, 403, 404, 403, 404),
    },
  },
  {
    route: 'POST /api/conversations/{id}/transfer',
    build: ({ f }) => ({ method: 'POST', path: at(f, '/transfer'), body: { userId: P.target.id } }),
    expect: {
      group: row(404, 403, 403, OK, 403),
      channel: row(403, 403, 403, OK, 403),
      dm: row(404, 403, 404, 403, 404),
    },
  },
  {
    route: 'PATCH /api/conversations/{id}/me',
    build: async ({ f, who }) => ({
      method: 'PATCH',
      path: at(f, '/me'),
      body: { expectedViewerVersion: await viewerVersionOf(who, f), pinned: true },
    }),
    expect: {
      group: row(404, OK, OK, OK, 403),
      channel: row(403, OK, OK, OK, 403),
      dm: row(404, OK, 404, OK, 404),
    },
  },
  {
    route: 'POST /api/conversations/{id}/read',
    build: ({ f }) => ({ method: 'POST', path: at(f, '/read'), body: { seq: f.messageSeq } }),
    expect: {
      group: row(404, OK, OK, OK, 403),
      channel: row(403, OK, OK, OK, 403),
      dm: row(404, OK, 404, OK, 404),
    },
  },

  // — members, bans, invitation links —
  {
    route: 'GET /api/conversations/{id}/members',
    build: ({ f }) => ({ method: 'GET', path: at(f, '/members') }),
    expect: {
      group: row(404, OK, OK, OK, OK),
      channel: row(403, OK, OK, OK, OK),
      dm: row(404, OK, 404, OK, 404),
    },
  },
  {
    route: 'POST /api/conversations/{id}/members',
    build: ({ f }) => ({
      method: 'POST',
      path: at(f, '/members'),
      body: { userIds: [P.extra.id] },
    }),
    expect: {
      // Any member may add people unless the owner narrowed it to administrators (the default is all members).
      group: row(404, OK, OK, OK, 403),
      channel: row(403, OK, OK, OK, 403),
      dm: row(404, 403, 404, 403, 404),
    },
  },
  {
    route: 'PATCH /api/conversations/{id}/members/{userId}',
    build: ({ f, who }) => ({
      method: 'PATCH',
      path: at(f, `/members/${aimedAt(f, who).id}`),
      body: { role: 'admin' },
    }),
    expect: {
      group: row(404, 403, 403, OK, 403),
      channel: row(403, 403, 403, OK, 403),
      dm: row(404, 403, 404, 403, 404),
    },
  },
  {
    // The same route with another body is another action (silence), with another rule.
    route: 'PATCH /api/conversations/{id}/members/{userId}',
    build: ({ f, who }) => ({
      method: 'PATCH',
      path: at(f, `/members/${aimedAt(f, who).id}`),
      body: { silencedUntil: new Date(app.clock.now().getTime() + 3_600_000).toISOString() },
    }),
    expect: {
      group: row(404, 403, OK, OK, OK),
      channel: row(403, 403, OK, OK, OK),
      dm: row(404, 403, 404, 403, 404),
    },
  },
  {
    route: 'DELETE /api/conversations/{id}/members/{userId}',
    build: ({ f, who }) => ({ method: 'DELETE', path: at(f, `/members/${aimedAt(f, who).id}`) }),
    expect: {
      group: row(404, 403, OK, OK, OK),
      channel: row(403, 403, OK, OK, OK),
      dm: row(404, 403, 404, 403, 404),
    },
  },
  {
    route: 'GET /api/conversations/{id}/bans',
    build: ({ f }) => ({ method: 'GET', path: at(f, '/bans') }),
    expect: {
      group: row(404, 403, OK, OK, OK),
      channel: row(403, 403, OK, OK, OK),
      dm: row(404, 403, 404, 403, 404),
    },
  },
  {
    route: 'POST /api/conversations/{id}/bans',
    build: ({ f }) => ({ method: 'POST', path: at(f, '/bans'), body: { userId: P.extra.id } }),
    expect: {
      group: row(404, 403, OK, OK, OK),
      channel: row(403, 403, OK, OK, OK),
      dm: row(404, 403, 404, 403, 404),
    },
  },
  {
    route: 'DELETE /api/conversations/{id}/bans/{userId}',
    fixture: { ban: true },
    build: ({ f }) => ({ method: 'DELETE', path: at(f, `/bans/${P.extra.id}`) }),
    expect: {
      group: row(404, 403, OK, OK, OK),
      channel: row(403, 403, OK, OK, OK),
      dm: row(404, 403, 404, 403, 404),
    },
  },
  {
    route: 'POST /api/conversations/{id}/invites',
    build: ({ f }) => ({ method: 'POST', path: at(f, '/invites'), body: {} }),
    expect: {
      // Invitation links exist for groups only; a site administrator is not a member and cannot bring people in.
      group: row(404, OK, OK, OK, 403),
      channel: row(403, 403, 403, 403, 403),
      dm: row(404, 403, 404, 403, 404),
    },
  },
  {
    route: 'GET /api/conversations/{id}/invites',
    build: ({ f }) => ({ method: 'GET', path: at(f, '/invites') }),
    expect: {
      group: row(404, OK, OK, OK, OK),
      channel: row(403, OK, OK, OK, OK),
      dm: row(404, OK, 404, OK, 404),
    },
  },
  {
    route: 'DELETE /api/conversations/{id}/invites/{inviteId}',
    fixture: { invite: true },
    // The link was made by the owner: a plain member may revoke only their own, so it does not exist for them.
    build: ({ f }) => ({ method: 'DELETE', path: at(f, `/invites/${f.inviteId}`) }),
    expect: { group: row(404, 404, OK, OK, OK) },
  },
  {
    route: 'POST /api/conversation-invites/preview',
    fixture: { invite: true },
    build: ({ f }) => ({
      method: 'POST',
      path: '/api/conversation-invites/preview',
      body: { code: f.inviteCode },
    }),
    expect: { group: EVERYONE },
  },
  {
    route: 'POST /api/conversation-invites/accept',
    fixture: { invite: true },
    build: ({ f }) => ({
      method: 'POST',
      path: '/api/conversation-invites/accept',
      body: { code: f.inviteCode },
    }),
    expect: { group: EVERYONE },
  },

  // — messages —
  {
    route: 'GET /api/conversations/{id}/messages',
    build: ({ f }) => ({ method: 'GET', path: at(f, '/messages') }),
    expect: {
      // A site administrator moderates but does not read (docs/01 section 5).
      group: row(404, OK, OK, OK, 403),
      channel: row(403, OK, OK, OK, 403),
      dm: row(404, OK, 404, OK, 404),
    },
  },
  {
    route: 'POST /api/conversations/{id}/messages',
    build: ({ f }) => ({
      method: 'POST',
      path: at(f, '/messages'),
      body: { clientId: crypto.randomUUID(), body: 'a message from the matrix' },
    }),
    expect: {
      group: row(404, OK, OK, OK, 403),
      channel: row(403, OK, OK, OK, 403),
      dm: row(404, OK, 404, OK, 404),
    },
  },
  {
    route: 'GET /api/conversations/{id}/changes',
    build: ({ f }) => ({ method: 'GET', path: at(f, '/changes?after=0') }),
    expect: {
      group: row(404, OK, OK, OK, 403),
      channel: row(403, OK, OK, OK, 403),
      dm: row(404, OK, 404, OK, 404),
    },
  },
  {
    route: 'GET /api/messages/{id}',
    messageScoped: true,
    build: ({ f }) => ({ method: 'GET', path: `/api/messages/${f.messageId}` }),
    expect: {
      group: row(404, OK, OK, OK, 404),
      channel: row(404, OK, OK, OK, 404),
      dm: row(404, OK, 404, OK, 404),
    },
  },
  {
    // `member` wrote the message: nobody else may change what it says.
    route: 'PATCH /api/messages/{id}',
    messageScoped: true,
    build: ({ f }) => ({
      method: 'PATCH',
      path: `/api/messages/${f.messageId}`,
      body: { body: 'edited by the matrix', expectedChangeSeq: f.messageChangeSeq },
    }),
    expect: {
      group: row(404, OK, 403, 403, 403),
      channel: row(403, OK, 403, 403, 403),
      dm: row(404, OK, 404, 403, 404),
    },
  },
  {
    route: 'POST /api/messages/{id}/recall',
    messageScoped: true,
    build: ({ f }) => ({ method: 'POST', path: `/api/messages/${f.messageId}/recall` }),
    expect: {
      group: row(404, OK, 403, 403, 403),
      channel: row(403, OK, 403, 403, 403),
      dm: row(404, OK, 404, 403, 404),
    },
  },
  {
    route: 'POST /api/messages/{id}/hide',
    messageScoped: true,
    build: ({ f }) => ({ method: 'POST', path: `/api/messages/${f.messageId}/hide` }),
    expect: {
      group: row(404, OK, OK, OK, 403),
      channel: row(403, OK, OK, OK, 403),
      dm: row(404, OK, 404, OK, 404),
    },
  },
  {
    // Deleting somebody else's message for everybody: administrators, the owner and a site administrator.
    route: 'DELETE /api/messages/{id}',
    messageScoped: true,
    build: ({ f }) => ({ method: 'DELETE', path: `/api/messages/${f.messageId}` }),
    expect: {
      group: row(404, 403, OK, OK, OK),
      channel: row(403, 403, OK, OK, OK),
      dm: row(404, 403, 404, 403, 404),
    },
  },
]

const KINDS_TEXT: Record<Kind, string> = {
  group: 'a group',
  channel: 'a channel',
  dm: 'a direct message',
  none: 'nothing',
}

describe('every endpoint, as every kind of person, on every kind of conversation', () => {
  for (const testCase of CASES) {
    for (const kind of Object.keys(testCase.expect) as Kind[]) {
      const table = testCase.expect[kind]
      if (!table) continue
      test(`${testCase.route} on ${KINDS_TEXT[kind]}`, async () => {
        const wrong: string[] = []
        const expectedOf = (actor: Actor): Expected => (actor === 'anon' ? 401 : table[actor])
        const check = (actor: Actor, reply: Reply, expected: Expected) => {
          const good =
            expected === OK ? reply.status >= 200 && reply.status < 300 : reply.status === expected
          if (!good) {
            wrong.push(
              `${actor}: expected ${expected}, got ${reply.status} ${JSON.stringify(failure(reply) ?? '')}`,
            )
          }
        }

        // Everyone who is refused works against one fixture, and must leave it as it was.
        const shared = await buildFixture(kind, testCase.fixture)
        const before = await snapshot(shared)
        const protectedText = [
          shared.secret,
          kind === 'channel' ? '' : shared.name,
          shared.inviteCode,
        ].filter(Boolean)
        for (const actor of Object.keys(actors) as Actor[]) {
          const expected = expectedOf(actor)
          if (expected === OK) continue
          const who = actors[actor]
          const reply = await call(who, await testCase.build({ f: shared, who }))
          check(actor, reply, expected)
          const text = JSON.stringify(reply.body)
          for (const secret of protectedText) {
            if (text.includes(secret)) wrong.push(`${actor}: the refusal repeats "${secret}"`)
          }
          // What one may not see must answer exactly like what is not there.
          if (expected === 404 && who && (hiddenFrom(kind, actor) || testCase.messageScoped)) {
            const ghost = ghostOf(shared)
            const twin = await call(who, await testCase.build({ f: ghost, who }))
            const [a, b] = [failure(reply), failure(twin)]
            if (twin.status !== reply.status || a?.code !== b?.code || a?.message !== b?.message) {
              wrong.push(
                `${actor}: tells a hidden thing from a missing one (${reply.status} ${a?.code} "${a?.message}" against ${twin.status} ${b?.code} "${b?.message}")`,
              )
            }
          }
        }
        const after = await snapshot(shared)
        if (JSON.stringify(after) !== JSON.stringify(before))
          wrong.push(`a refused call changed the conversation (${describeChange(before, after)})`)

        // Everyone who is allowed gets a conversation of their own, because success changes it.
        for (const actor of Object.keys(actors) as Actor[]) {
          if (expectedOf(actor) !== OK) continue
          const who = actors[actor]
          const mine = await buildFixture(kind, testCase.fixture)
          check(actor, await call(who, await testCase.build({ f: mine, who })), OK)
        }
        expect(wrong).toEqual([])
      })
    }
  }
})

describe('the table is complete', () => {
  test('every conversation, message, sync and directory route of the interface has rows above, and none is invented', () => {
    const document = app.app.getOpenAPI31Document({
      openapi: '3.1.0',
      info: { title: 'ChatApp API', version: '1.0.0' },
    })
    const ours = [
      '/api/conversations',
      '/api/conversation-invites',
      '/api/channels',
      '/api/messages',
      '/api/users',
      '/api/sync',
      '/api/me/changes',
      '/api/search/messages',
    ]
    const routes = new Set<string>()
    for (const [path, item] of Object.entries(document.paths ?? {})) {
      if (!ours.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) continue
      for (const method of Object.keys(item as object)) {
        if (['get', 'post', 'patch', 'put', 'delete'].includes(method))
          routes.add(`${method.toUpperCase()} ${path}`)
      }
    }
    expect([...routes].sort()).toEqual([...new Set(CASES.map((c) => c.route))].sort())
  })
})

describe('access ends the moment a membership does', () => {
  test('a member who is removed, and one who leaves, reach nothing of a private group at once', async () => {
    const f = await buildFixture('group')
    const target = P.target
    const reads = async () => [
      (await target.get(at(f))).status,
      (await target.get(at(f, '/messages'))).status,
      (await target.get(at(f, '/changes?after=0'))).status,
      (await target.get(`/api/messages/${f.messageId}`)).status,
      (
        await target.post(at(f, '/messages'), {
          clientId: crypto.randomUUID(),
          body: 'still here?',
        })
      ).status,
      (await target.post(at(f, '/read'), { seq: f.messageSeq })).status,
      (await target.get(at(f, '/members'))).status,
    ]
    expect(await reads()).toEqual([200, 200, 200, 200, 201, 200, 200])
    await removeConversationMember(deps(), K.owner, f.id, P.target.id)
    expect(await reads()).toEqual([404, 404, 404, 404, 404, 404, 404])

    const g = await buildFixture('group')
    expect((await P.target.post(at(g, '/leave'))).status).toBeLessThan(300)
    expect(
      await (async () => [
        (await target.get(at(g))).status,
        (await target.get(at(g, '/messages'))).status,
        (await target.get(`/api/messages/${g.messageId}`)).status,
      ])(),
    ).toEqual([404, 404, 404])
  })
})
