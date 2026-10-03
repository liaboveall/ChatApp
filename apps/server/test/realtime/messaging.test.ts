/**
 * Realtime delivery over a real server, a real bus and the real dispatcher (docs/05 section 4, docs/03 section 6, M2a):
 * hints without content reach exactly the people in a conversation (L-16, SEC-27, AT-03), membership changes take effect
 * on live connections at once and, when the hint is lost, within the 5-second backstop (AT-01, AT-02), and typing is
 * for members only. The worker's dispatcher is run by hand (`deliverHints`) so every step is visible.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { convTopic, userTopic } from '@chatapp/contracts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createTestApp, type TestApp } from '../support/http.ts'
import { createConversation, type Person, person } from '../support/people.ts'
import {
  connect,
  cookieHeader,
  deliverHints,
  startTestServer,
  type TestServer,
  type TestSocket,
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

const SETTLE_MS = 250

async function online(who: Person): Promise<TestSocket> {
  const socket = connect(server?.port ?? 0, { cookie: cookieHeader(who.jar) })
  await socket.next('hello')
  return socket
}
const say = (who: Person, id: string, text: string) =>
  who.post<{ message: { id: string; changeSeq: number; seq: number } }>(
    `/api/conversations/${id}/messages`,
    {
      clientId: crypto.randomUUID(),
      body: text,
    },
  )
const quiet = (ms = SETTLE_MS) => Bun.sleep(ms)

describe('who hears about a message (L-16, SEC-27, AT-03)', () => {
  test('exactly the members of the conversation, as a hint with ids and numbers and nothing else', async () => {
    server = await startTestServer(app)
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const carol = await person(app, 'carol')
    const dave = await person(app, 'dave')
    const g1 = await createConversation(alice, { kind: 'group', name: 'one', memberIds: [bob.id] })
    await createConversation(carol, { kind: 'group', name: 'two' })
    const sockets = {
      alice: await online(alice),
      bob: await online(bob),
      carol: await online(carol),
      dave: await online(dave),
    }

    const sent = await say(alice, g1.id, 'the secret plan')
    await deliverHints(app, server)
    const heardByBob = await sockets.bob.next('message.changed')
    expect(heardByBob).toEqual({
      v: 1,
      type: 'message.changed',
      topic: convTopic(g1.id),
      data: { conversationId: g1.id, messageId: sent.body.message.id, changeSeq: 1 },
    })
    expect((await sockets.alice.next('message.changed')).data).toMatchObject({
      conversationId: g1.id,
    })
    await quiet()
    expect(sockets.carol.of('message.changed')).toEqual([])
    expect(sockets.dave.of('message.changed')).toEqual([])
    // Not the text, not the sender, not a quote: nothing to read in what travelled (docs/05 section 4.4).
    const raw = JSON.stringify(sockets.bob.messages)
    expect(raw).not.toContain('secret')
    expect(raw).not.toContain(alice.id)
  })

  test('two conversations with Chinese names never hear each other (L-16)', async () => {
    server = await startTestServer(app)
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const one = await createConversation(alice, { kind: 'channel', name: '房间一' })
    const two = await createConversation(bob, { kind: 'channel', name: '房间二' })
    const [a, b] = [await online(alice), await online(bob)]
    await say(alice, one.id, '你好')
    await say(bob, two.id, '你好')
    await deliverHints(app, server)
    await quiet()
    expect(
      a.of('message.changed').map((m) => (m.data as { conversationId: string }).conversationId),
    ).toEqual([one.id])
    expect(
      b.of('message.changed').map((m) => (m.data as { conversationId: string }).conversationId),
    ).toEqual([two.id])
  })

  test('a connection is subscribed before it is greeted: the first event after hello is not missed', async () => {
    server = await startTestServer(app)
    const alice = await person(app, 'alice')
    const group = await createConversation(alice, { kind: 'group', name: 'prompt' })
    const socket = connect(server.port, { cookie: cookieHeader(alice.jar) })
    await socket.next('hello')
    expect(server.gateway.followers(convTopic(group.id))).toBe(1)
    await say(alice, group.id, 'right away')
    await deliverHints(app, server)
    await socket.next('message.changed')
  })

  test('each change in order, one hint each; edits and recalls are hints too', async () => {
    server = await startTestServer(app)
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'order',
      memberIds: [bob.id],
    })
    const socket = await online(bob)
    const first = await say(alice, group.id, 'one')
    await say(alice, group.id, 'two')
    await alice.patch(`/api/messages/${first.body.message.id}`, {
      body: 'one (edited)',
      expectedChangeSeq: 1,
    })
    await alice.post(`/api/messages/${first.body.message.id}/recall`)
    await deliverHints(app, server)
    await socket.waitFor(
      'message.changed',
      (m) => (m.data as { changeSeq: number }).changeSeq === 4,
    )
    const numbers = socket
      .of('message.changed')
      .map((m) => (m.data as { changeSeq: number }).changeSeq)
    expect([...numbers].sort((a, b) => a - b)).toEqual([1, 2, 3, 4])
    expect(JSON.stringify(socket.messages)).not.toContain('edited')
  })
})

describe('what is not a message: metadata, members and my own log', () => {
  test('a rename reaches every member, a role change tells the member list to reload, my own changes only my devices', async () => {
    server = await startTestServer(app)
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const carol = await person(app, 'carol')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'meta',
      memberIds: [bob.id],
    })
    const [a, b, c] = [await online(alice), await online(bob), await online(carol)]
    const bobPhone = await online(bob)

    await alice.patch(`/api/conversations/${group.id}`, {
      expectedMetadataVersion: group.metadataVersion,
      name: 'renamed',
    })
    await alice.patch(`/api/conversations/${group.id}/members/${bob.id}`, { role: 'admin' })
    await bob.post(`/api/conversations/${group.id}/read`, { seq: 0 })
    const view = (await bob.get<{ viewerVersion: number }>(`/api/conversations/${group.id}`)).body
    await bob.patch(`/api/conversations/${group.id}/me`, {
      expectedViewerVersion: view.viewerVersion,
      pinned: true,
    })
    await deliverHints(app, server)

    for (const socket of [a, b, bobPhone]) {
      const changed = await socket.next('conversation.changed')
      expect(changed).toMatchObject({
        topic: convTopic(group.id),
        data: { conversationId: group.id },
      })
      expect(await socket.next('member.changed')).toMatchObject({
        data: { conversationId: group.id },
      })
    }
    // Both of bob's devices hear his own changes, with the number to continue his log from; alice and carol do not.
    for (const socket of [b, bobPhone]) {
      const mine = await socket.waitFor(
        'user.changed',
        (m) => (m.data as { userChangeSeq: number }).userChangeSeq >= 2,
      )
      expect(mine.topic).toBe(userTopic(bob.id))
    }
    await quiet()
    expect(c.of('conversation.changed')).toEqual([])
    expect(c.of('user.changed')).toEqual([])
    expect(a.of('user.changed').every((m) => m.topic === userTopic(alice.id))).toBe(true)
  })
})

describe('joining and leaving take effect on live connections (AT-01, AT-02)', () => {
  test('a person added hears the next message without reconnecting; a person removed stops hearing at once', async () => {
    server = await startTestServer(app)
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const group = await createConversation(alice, { kind: 'group', name: 'live' })
    const socket = await online(bob)
    expect(server.gateway.followers(convTopic(group.id))).toBe(0)

    await alice.post(`/api/conversations/${group.id}/members`, { userIds: [bob.id] })
    await deliverHints(app, server)
    await socket.waitFor('user.changed', () => true)
    // The subscription follows the hint, then messages flow.
    await Bun.sleep(100)
    expect(server.gateway.followers(convTopic(group.id))).toBe(1)
    await say(alice, group.id, 'welcome')
    await deliverHints(app, server)
    await socket.waitFor(
      'message.changed',
      (m) => (m.data as { conversationId: string }).conversationId === group.id,
    )

    await alice.del(`/api/conversations/${group.id}/members/${bob.id}`)
    await deliverHints(app, server)
    const removed = await socket.next('conversation.removed')
    expect(removed.data).toMatchObject({ conversationId: group.id })
    expect(server.gateway.followers(convTopic(group.id))).toBe(0)
    const before = socket.of('message.changed').length
    await say(alice, group.id, 'bob is gone')
    await deliverHints(app, server)
    await quiet()
    expect(socket.of('message.changed').length).toBe(before)
  })

  test('with every hint lost, the 5-second backstop still brings subscriptions up to date', async () => {
    server = await startTestServer(app, { gateway: { revalidateMs: 150 } })
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const group = await createConversation(alice, { kind: 'group', name: 'lost hints' })
    const socket = await online(bob)
    // Added, with no dispatcher running: nobody tells the gateway.
    await alice.post(`/api/conversations/${group.id}/members`, { userIds: [bob.id] })
    const deadline = Date.now() + 3_000
    while (server.gateway.followers(convTopic(group.id)) < 2 && Date.now() < deadline)
      await Bun.sleep(50)
    expect(server.gateway.followers(convTopic(group.id))).toBe(1)
    await say(alice, group.id, 'noticed anyway')
    await deliverHints(app, server)
    await socket.waitFor(
      'message.changed',
      (m) => (m.data as { conversationId: string }).conversationId === group.id,
    )

    // And removed: again nobody tells it, and yet it stops.
    const second = await createConversation(alice, {
      kind: 'group',
      name: 'second',
      memberIds: [bob.id],
    })
    await Bun.sleep(400)
    expect(server.gateway.followers(convTopic(second.id))).toBe(1)
    await alice.del(`/api/conversations/${second.id}/members/${bob.id}`)
    const gone = Date.now() + 3_000
    while (server.gateway.followers(convTopic(second.id)) > 0 && Date.now() < gone)
      await Bun.sleep(50)
    expect(server.gateway.followers(convTopic(second.id))).toBe(0)
  })

  test('a banned or archived-out member never receives what happens after; channels follow joins and leaves too', async () => {
    server = await startTestServer(app)
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const channel = await createConversation(alice, { kind: 'channel', name: 'open' })
    const socket = await online(bob)
    await bob.post(`/api/conversations/${channel.id}/join`)
    await deliverHints(app, server)
    await socket.waitFor('user.changed', () => true)
    await Bun.sleep(100)
    await say(alice, channel.id, 'hello bob')
    await deliverHints(app, server)
    await socket.waitFor(
      'message.changed',
      (m) => (m.data as { conversationId: string }).conversationId === channel.id,
    )
    await alice.post(`/api/conversations/${channel.id}/bans`, { userId: bob.id })
    await deliverHints(app, server)
    await socket.next('conversation.removed')
    const count = socket.of('message.changed').length
    await say(alice, channel.id, 'after the ban')
    await deliverHints(app, server)
    await quiet()
    expect(socket.of('message.changed').length).toBe(count)
  })
})

describe('typing', () => {
  test('goes to the other members only, with its lifetime, at most every 3 seconds, and non-members are ignored', async () => {
    server = await startTestServer(app)
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const dave = await person(app, 'dave')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'typing',
      memberIds: [bob.id],
    })
    const [a, b, d] = [await online(alice), await online(bob), await online(dave)]
    const aliceSecond = await online(alice)

    a.send({ v: 1, type: 'typing', data: { conversationId: group.id, state: 'start' } })
    const heard = await b.next('typing')
    expect(heard).toMatchObject({
      topic: convTopic(group.id),
      data: { conversationId: group.id, userId: alice.id, state: 'start', expiresInMs: 5000 },
    })
    await quiet()
    expect(a.of('typing')).toEqual([]) // never her own
    expect(aliceSecond.of('typing')).toEqual([]) // not even on her other device
    expect(d.of('typing')).toEqual([])

    // A second "start" within three seconds is dropped; "stop" always goes.
    a.send({ v: 1, type: 'typing', data: { conversationId: group.id, state: 'start' } })
    a.send({ v: 1, type: 'typing', data: { conversationId: group.id, state: 'stop' } })
    await b.waitFor('typing', (m) => (m.data as { state: string }).state === 'stop')
    expect(b.of('typing').map((m) => (m.data as { state: string }).state)).toEqual([
      'start',
      'stop',
    ])

    // Somebody who is not in the conversation can type all they like; nobody hears it.
    d.send({ v: 1, type: 'typing', data: { conversationId: group.id, state: 'start' } })
    await quiet()
    expect(b.of('typing').length).toBe(2)
    expect(a.of('typing')).toEqual([])
  })

  test('malformed signals get an error event and change nothing', async () => {
    server = await startTestServer(app)
    const alice = await person(app, 'alice')
    const socket = await online(alice)
    socket.send({ v: 1, type: 'typing', data: { conversationId: 'not-a-uuid', state: 'start' } })
    socket.send({
      v: 1,
      type: 'typing',
      data: { conversationId: crypto.randomUUID(), state: 'maybe' },
    })
    socket.send({
      v: 1,
      type: 'presence.watch',
      data: { userIds: Array.from({ length: 201 }, () => crypto.randomUUID()) },
    })
    socket.send({ v: 1, type: 'focus', data: { conversationId: 5, foreground: 'yes' } })
    await quiet()
    expect(socket.of('error').map((m) => (m.data as { code: string }).code)).toEqual([
      'unknown_message',
      'unknown_message',
      'unknown_message',
      'unknown_message',
    ])
    expect(socket.ws.readyState).toBe(WebSocket.OPEN)
  })
})

describe('dropping connections on purpose (V-14)', () => {
  test('the test endpoint closes one person’s connections or all, with the code asked for, and only in the test environment', async () => {
    server = await startTestServer(app)
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const [a1, a2, b1] = [await online(alice), await online(alice), await online(bob)]
    const only = await alice.post<{ closed: number }>('/api/test/realtime/disconnect', {
      userId: alice.id,
      code: 1013,
    })
    expect(only.body.closed).toBe(2)
    expect((await a1.closed).code).toBe(1013)
    expect((await a2.closed).code).toBe(1013)
    expect(b1.ws.readyState).toBe(WebSocket.OPEN)
    const all = await alice.post<{ closed: number }>('/api/test/realtime/disconnect', {
      code: 4408,
    })
    expect(all.body.closed).toBe(1)
    expect((await b1.closed).code).toBe(4408)
    // Strict body: anything else is refused.
    expect((await alice.post('/api/test/realtime/disconnect', { everything: true })).status).toBe(
      422,
    )
  })
})
