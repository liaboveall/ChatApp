/**
 * Regression tests for the 24 defects of the legacy application (docs/07 section 3, docs/13). Each title starts with its
 * L-number so a failure names the defect that came back. Defects that belong to later milestones (L-05/L-06 pages, L-11
 * rendering, L-12 uploads, L-14/L-15/L-22 agent) are tested there; L-13, L-14 (anonymous WebSocket) and L-24 (username)
 * were done in M1a.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { Conversation, MessageEnvelope, MessagesResponse } from '@chatapp/contracts'
import { messages, sessions } from '@chatapp/db'
import { runBootstrap } from '@chatapp/db/bootstrap'
import { eq } from 'drizzle-orm'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createTestApp, type TestApp } from '../support/http.ts'
import {
  createConversation,
  errorCode,
  key,
  openDm,
  type Person,
  person,
} from '../support/people.ts'
import {
  connect,
  cookieHeader,
  deliverHints,
  startTestServer,
  type TestServer,
} from '../support/ws.ts'

let dbs: TestDatabases
let app: TestApp
let server: TestServer | undefined

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
  await server?.stop()
  server = undefined
  await app.close()
})

const say = (who: Person, id: string, text: string) =>
  who.post<MessageEnvelope>(`/api/conversations/${id}/messages`, {
    clientId: crypto.randomUUID(),
    body: text,
  })
const DAY = 86_400_000

test('L-01 a channel with a purely Chinese name is created and works', async () => {
  const alice = await person(app, 'alice')
  const created = await alice.post<Conversation>(
    '/api/conversations',
    { kind: 'channel', name: '测试房间' },
    key(),
  )
  expect(created.status).toBe(201)
  expect(created.body.name).toBe('测试房间')
  expect((await alice.get(`/api/conversations/${created.body.id}`)).status).toBe(200)
  expect((await say(alice, created.body.id, '你好，世界')).status).toBe(201)
})

test('L-02 after such a room exists, every other page still answers 200', async () => {
  const alice = await person(app, 'alice')
  await createConversation(alice, { kind: 'channel', name: '测试房间' })
  for (const path of [
    '/api/healthz',
    '/api/me',
    '/api/conversations',
    '/api/channels',
    '/api/sync/heads',
  ]) {
    const reply = path === '/api/healthz' ? await app.request(path) : await alice.get(path)
    expect(reply.status).toBe(200)
  }
})

test('L-03 a second Chinese-named room can be created, an identical name is a 409', async () => {
  const alice = await person(app, 'alice')
  await createConversation(alice, { kind: 'channel', name: '测试房间' })
  expect(
    (await alice.post('/api/conversations', { kind: 'channel', name: '另一个房间' }, key())).status,
  ).toBe(201)
  const again = await alice.post('/api/conversations', { kind: 'channel', name: '测试房间' }, key())
  expect(again.status).toBe(409)
  expect(errorCode(again)).toBe('CONFLICT')
})

test('L-04 a non-member reading a group’s messages gets 404, and there is no password to guess', async () => {
  const alice = await person(app, 'alice')
  const mallory = await person(app, 'mallory')
  const group = await createConversation(alice, { kind: 'group', name: 'private' })
  await say(alice, group.id, 'members only')
  const read = await mallory.get(`/api/conversations/${group.id}/messages`)
  expect(read.status).toBe(404)
  expect(JSON.stringify(read.body)).not.toContain('members only')
  // The legacy "password" was a request field; here it is not even a field.
  expect(
    (await mallory.post(`/api/conversations/${group.id}/join`, { password: 'letmein' })).status,
  ).toBe(404)
  expect(
    (await mallory.post(`/api/conversations/${group.id}/members`, { userIds: [mallory.id] }))
      .status,
  ).toBe(404)
})

test('L-07 a message three minutes old cannot be recalled: WINDOW_EXPIRED', async () => {
  const alice = await person(app, 'alice')
  const group = await createConversation(alice, { kind: 'group', name: 'late' })
  const sent = await say(alice, group.id, 'too late to take back')
  app.clock.advance(3 * 60_000)
  const recall = await alice.post(`/api/messages/${sent.body.message.id}/recall`)
  expect(recall.status).toBe(403)
  expect(errorCode(recall)).toBe('WINDOW_EXPIRED')
  expect(
    (await alice.get<MessagesResponse>(`/api/conversations/${group.id}/messages`)).body.messages[0]
      ?.body,
  ).toBe('too late to take back')
})

test('L-09 a message cannot be sent in someone else’s name: senderId and username are refused, the sender is the session', async () => {
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
    { sender: 'bob' },
    { user: bob.id },
  ]) {
    const reply = await alice.post(`/api/conversations/${group.id}/messages`, {
      clientId: crypto.randomUUID(),
      body: 'I am bob',
      ...forged,
    })
    expect(reply.status).toBe(422)
  }
  expect(await dbs.owner.db.select().from(messages)).toHaveLength(0)
  // An honest send is attributed to the session, whatever the body says.
  const sent = await say(alice, group.id, 'bob says hi')
  expect(sent.body.message.senderId).toBe(alice.id)
})

test('L-10 a message cannot be written into a conversation one is not in', async () => {
  const alice = await person(app, 'alice')
  const mallory = await person(app, 'mallory')
  const group = await createConversation(alice, { kind: 'group', name: 'locked' })
  const channel = await createConversation(alice, { kind: 'channel', name: 'public' })
  expect((await say(mallory, group.id, 'sneak')).status).toBe(404)
  expect((await say(mallory, channel.id, 'sneak')).status).toBe(403) // visible, but only for members
  expect(await dbs.owner.db.select().from(messages)).toHaveLength(0)
})

test('L-16 two rooms with Chinese names do not hear each other’s events', async () => {
  server = await startTestServer(app)
  const alice = await person(app, 'alice')
  const bob = await person(app, 'bob')
  const one = await createConversation(alice, { kind: 'channel', name: '房间甲' })
  const two = await createConversation(bob, { kind: 'channel', name: '房间乙' })
  const a = connect(server.port, { cookie: cookieHeader(alice.jar) })
  const b = connect(server.port, { cookie: cookieHeader(bob.jar) })
  await Promise.all([a.next('hello'), b.next('hello')])
  await say(alice, one.id, '甲')
  await say(bob, two.id, '乙')
  await deliverHints(app, server)
  await Bun.sleep(250)
  expect(
    a.of('message.changed').map((m) => (m.data as { conversationId: string }).conversationId),
  ).toEqual([one.id])
  expect(
    b.of('message.changed').map((m) => (m.data as { conversationId: string }).conversationId),
  ).toEqual([two.id])
})

test('L-17 a presence event has no "is this me" field: the client decides that itself', async () => {
  server = await startTestServer(app)
  const alice = await person(app, 'alice')
  const bob = await person(app, 'bob')
  const a = connect(server.port, { cookie: cookieHeader(alice.jar) })
  await a.next('hello')
  a.send({ v: 1, type: 'presence.watch', data: { userIds: [bob.id] } })
  await a.next('presence.snapshot')
  const b = connect(server.port, { cookie: cookieHeader(bob.jar) })
  await b.next('hello')
  const event = await a.waitFor('presence', () => true)
  expect(Object.keys(event.data as object).sort()).toEqual(['lastSeenAt', 'status', 'userId'])
  expect(JSON.stringify(event)).not.toMatch(/is_current|isCurrent|isMe|current_user/i)
})

test('L-18 two connections of one person: closing one leaves them online', async () => {
  server = await startTestServer(app)
  const alice = await person(app, 'alice')
  const bob = await person(app, 'bob')
  const watcher = connect(server.port, { cookie: cookieHeader(alice.jar) })
  await watcher.next('hello')
  watcher.send({ v: 1, type: 'presence.watch', data: { userIds: [bob.id] } })
  await watcher.next('presence.snapshot')
  const tab1 = connect(server.port, { cookie: cookieHeader(bob.jar) })
  const tab2 = connect(server.port, { cookie: cookieHeader(bob.jar) })
  await Promise.all([tab1.next('hello'), tab2.next('hello')])
  await watcher.waitFor('presence', (m) => (m.data as { status: string }).status === 'online')
  tab1.ws.close()
  await Bun.sleep(500)
  expect(watcher.of('presence').map((m) => (m.data as { status: string }).status)).toEqual([
    'online',
  ])
  tab2.ws.close()
  await watcher.waitFor('presence', (m) => (m.data as { status: string }).status === 'offline')
})

test('L-19 a username given up cannot be taken by someone else for 30 days; the earlier person’s history stays theirs', async () => {
  const alice = await person(app, 'alice')
  const bob = await person(app, 'bob')
  const group = await createConversation(alice, {
    kind: 'group',
    name: 'history',
    memberIds: [bob.id],
  })
  await say(alice, group.id, 'written as alice')
  const me = (await alice.get<{ meVersion: number }>('/api/me')).body.meVersion
  expect(
    (await alice.patch('/api/me', { expectedMeVersion: me, username: 'alice_new' })).status,
  ).toBe(200)
  const bobMe = (await bob.get<{ meVersion: number }>('/api/me')).body.meVersion
  const early = await bob.patch('/api/me', { expectedMeVersion: bobMe, username: 'alice' })
  expect(early.status).toBe(409)
  // Even after the name is bob's (30 days on), what alice wrote is still alice's, by account.
  await dbs.owner.db.update(sessions).set({ expiresAt: new Date(Date.now() + 120 * DAY) })
  app.clock.advance(31 * DAY)
  expect((await bob.patch('/api/me', { expectedMeVersion: bobMe, username: 'alice' })).status).toBe(
    200,
  )
  const listed = await bob.get<MessagesResponse>(`/api/conversations/${group.id}/messages`)
  expect(listed.body.messages[0]?.senderId).toBe(alice.id)
  expect(listed.body.users[alice.id]?.username).toBe('alice_new')
})

test('L-20 after a rename, the new owner of an old name cannot delete or recall the earlier person’s messages', async () => {
  const alice = await person(app, 'alice')
  const bob = await person(app, 'bob')
  const group = await createConversation(alice, {
    kind: 'group',
    name: 'owned',
    memberIds: [bob.id],
  })
  const sent = await say(alice, group.id, 'mine')
  const me = (await alice.get<{ meVersion: number }>('/api/me')).body.meVersion
  await alice.patch('/api/me', { expectedMeVersion: me, username: 'alice_new' })
  await dbs.owner.db.update(sessions).set({ expiresAt: new Date(Date.now() + 120 * DAY) })
  app.clock.advance(31 * DAY)
  const bobMe = (await bob.get<{ meVersion: number }>('/api/me')).body.meVersion
  await bob.patch('/api/me', { expectedMeVersion: bobMe, username: 'alice' })
  for (const reply of [
    await bob.del(`/api/messages/${sent.body.message.id}`),
    await bob.post(`/api/messages/${sent.body.message.id}/recall`),
  ]) {
    expect([403, 404]).toContain(reply.status)
  }
  const [row] = await dbs.owner.db
    .select()
    .from(messages)
    .where(eq(messages.id, sent.body.message.id))
  expect(row?.body).toBe('mine')
})

test('L-21 nobody who is not in a direct message can read it, and its id cannot be guessed', async () => {
  const alice = await person(app, 'alice')
  const bob = await person(app, 'bob')
  const mallory = await person(app, 'mallory')
  const dm = await openDm(alice, bob)
  await say(alice, dm.id, 'between us')
  expect((await mallory.get(`/api/conversations/${dm.id}`)).status).toBe(404)
  expect((await mallory.get(`/api/conversations/${dm.id}/messages`)).status).toBe(404)
  expect((await mallory.get(`/api/conversations/${dm.id}/changes?after=0`)).status).toBe(404)
  expect(dm.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/) // a UUIDv7, not private_1_2
  expect(JSON.stringify((await mallory.get('/api/conversations')).body)).not.toContain('between us')
})

test('L-23 a message cannot be forged into somebody else’s direct message', async () => {
  const alice = await person(app, 'alice')
  const bob = await person(app, 'bob')
  const mallory = await person(app, 'mallory')
  const dm = await openDm(alice, bob)
  expect((await say(mallory, dm.id, 'forged')).status).toBe(404)
  expect(await dbs.owner.db.select().from(messages)).toHaveLength(0)
})

test('L-24 the display name "助手" (and its variants) is refused; the username part was done in M1a', async () => {
  const alice = await person(app, 'alice')
  await runBootstrap(dbs.owner.db, {
    agentUsername: 'assistant',
    agentDisplayName: '助手',
    productName: 'ChatApp',
  })
  for (const name of ['助手', '助 手', '系统', 'ＡＳＳＩＳＴＡＮＴ']) {
    const me = (await alice.get<{ meVersion: number }>('/api/me')).body.meVersion
    expect(
      (await alice.patch('/api/me', { expectedMeVersion: me, displayName: name })).status,
    ).toBe(422)
  }
})
