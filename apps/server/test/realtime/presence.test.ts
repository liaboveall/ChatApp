/**
 * Presence over Valkey and through the gateway (docs/03 section 5.6, docs/01 section 4.7, M2a): connections are summed per
 * person, so closing one of two tabs keeps them online (L-18); the event carries nothing about "who is looking" (L-17);
 * a connection that dies silently is swept; the last connection to go writes `last_seen_at`; focus is recorded.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { convTopic } from '@chatapp/contracts'
import { users } from '@chatapp/db'
import { eq } from 'drizzle-orm'
import { createPresenceSweeper } from '../../src/jobs/presence.ts'
import { createValkey, type Valkey } from '../../src/lib/valkey.ts'
import { createEventBus } from '../../src/realtime/bus.ts'
import type { BusEvent } from '../../src/realtime/events.ts'
import {
  createPresenceStore,
  PRESENCE_TTL_MS,
  type PresenceStore,
} from '../../src/realtime/presence.ts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { testConfig } from '../support/env.ts'
import { createTestApp, type TestApp } from '../support/http.ts'
import { createConversation, type Person, person } from '../support/people.ts'
import {
  connect,
  cookieHeader,
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

const quiet = (ms = 300) => Bun.sleep(ms)

describe('the store: connections summed per person', () => {
  let valkey: Valkey
  let store: PresenceStore
  let prefix: string
  const user = crypto.randomUUID()
  const conn = (id: string) => ({ userId: user, connectionId: id })

  beforeEach(async () => {
    valkey = await createValkey(testConfig().valkeyUrl, 'test-presence-store')
    prefix = `presence:test-store:${Math.random().toString(36).slice(2)}`
    store = createPresenceStore(valkey, prefix)
  })
  afterEach(async () => {
    const keys = await valkey.keys(`${prefix}:*`)
    if (keys.length > 0) await valkey.del(...keys)
    valkey.disconnect()
  })

  test('online while any connection is active, away when all are idle, offline when none is left (L-18)', async () => {
    const t0 = 1_000_000
    expect(await store.connect(conn('tab1'), t0)).toEqual({
      previous: 'offline',
      current: 'online',
    })
    expect(await store.connect(conn('tab2'), t0)).toEqual({ previous: 'online', current: 'online' })
    // Closing one of two tabs changes nothing.
    expect(await store.disconnect(conn('tab1'), t0)).toEqual({
      previous: 'online',
      current: 'online',
    })
    expect((await store.statuses([user], t0)).get(user)).toBe('online')

    expect(await store.setActivity(conn('tab2'), 'idle', t0)).toEqual({
      previous: 'online',
      current: 'away',
    })
    expect(await store.connect(conn('tab3'), t0)).toEqual({ previous: 'away', current: 'online' })
    expect(await store.setActivity(conn('tab3'), 'idle', t0)).toEqual({
      previous: 'online',
      current: 'away',
    })
    expect(await store.setActivity(conn('tab2'), 'active', t0)).toEqual({
      previous: 'away',
      current: 'online',
    })
    expect(await store.disconnect(conn('tab2'), t0)).toEqual({
      previous: 'online',
      current: 'away',
    })
    expect(await store.disconnect(conn('tab3'), t0)).toEqual({
      previous: 'away',
      current: 'offline',
    })
    expect((await store.statuses([user], t0)).get(user)).toBe('offline')
    // Nothing is left behind for a person who is gone.
    expect(await valkey.keys(`${prefix}:u:*`)).toEqual([])
    expect(await valkey.zcard(`${prefix}:x`)).toBe(0)
  })

  test('a heartbeat keeps the state of its connection; a repeated state announces nothing', async () => {
    const t0 = 2_000_000
    await store.connect(conn('tab'), t0)
    await store.setActivity(conn('tab'), 'idle', t0)
    expect(await store.renew(conn('tab'), t0 + 25_000)).toEqual({
      previous: 'away',
      current: 'away',
    })
    expect((await store.statuses([user], t0 + 25_000)).get(user)).toBe('away')
    expect(await store.setActivity(conn('tab'), 'idle', t0 + 26_000)).toEqual({
      previous: 'away',
      current: 'away',
    })
  })

  test('a connection that stops renewing is dead after its expiry, and the sweeper announces it once', async () => {
    const t0 = 3_000_000
    await store.connect(conn('crashed'), t0)
    const other = crypto.randomUUID()
    await store.connect({ userId: other, connectionId: 'fine' }, t0)
    // The healthy one is renewed by its heartbeat, the crashed one is not.
    await store.renew({ userId: other, connectionId: 'fine' }, t0 + 60_000)
    const later = t0 + PRESENCE_TTL_MS + 1
    const statuses = await store.statuses([user, other], later)
    expect([statuses.get(user), statuses.get(other)]).toEqual(['offline', 'online'])

    const swept = await store.sweep(later)
    expect(swept).toEqual([{ userId: user, previous: 'online', current: 'offline' }])
    expect(await store.sweep(later)).toEqual([]) // already announced
    expect((await store.statuses([other], later)).get(other)).toBe('online')
    expect(await valkey.zscore(`${prefix}:x`, `${user}|crashed`)).toBeNull()
  })

  test('a connection renewed after it was listed is not swept; unknown people are offline; many at once', async () => {
    const t0 = 4_000_000
    await store.connect(conn('late-renewal'), t0)
    // Listed as expired at t0 + TTL + 1, but a heartbeat arrives for the very same moment before the sweeper acts.
    await store.renew(conn('late-renewal'), t0 + PRESENCE_TTL_MS)
    expect(await store.sweep(t0 + PRESENCE_TTL_MS + 1)).toEqual([])
    const crowd = Array.from({ length: 50 }, () => crypto.randomUUID())
    const statuses = await store.statuses([user, ...crowd], t0 + PRESENCE_TTL_MS + 1)
    expect(statuses.size).toBe(51)
    expect(statuses.get(user)).toBe('online')
    expect(crowd.every((id) => statuses.get(id) === 'offline')).toBe(true)
  })

  test('focus is kept per connection and cleared with it', async () => {
    const t0 = 5_000_000
    const conversationId = crypto.randomUUID()
    await store.connect(conn('tab'), t0)
    await store.setFocus(conn('tab'), { conversationId, foreground: true })
    expect(await valkey.hget(`${prefix}:u:${user}`, 'f:tab')).toBe(`${conversationId}|1`)
    await store.setFocus(conn('tab'), { conversationId, foreground: false })
    expect(await valkey.hget(`${prefix}:u:${user}`, 'f:tab')).toBe(`${conversationId}|0`)
    await store.setFocus(conn('tab'), { conversationId: null, foreground: true })
    expect(await valkey.hget(`${prefix}:u:${user}`, 'f:tab')).toBeNull()
    await store.setFocus(conn('tab'), { conversationId, foreground: true })
    await store.disconnect(conn('tab'), t0)
    expect(await valkey.keys(`${prefix}:u:*`)).toEqual([])
  })
})

describe('through the gateway', () => {
  const entry = (m: Record<string, unknown>) =>
    m.data as { userId: string; status: string; lastSeenAt: string | null }

  async function online(who: Person): Promise<TestSocket> {
    const socket = connect(server?.port ?? 0, { cookie: cookieHeader(who.jar) })
    await socket.next('hello')
    return socket
  }

  test('a watcher gets a snapshot, then every change of status, never a hint about who is looking (L-17)', async () => {
    server = await startTestServer(app)
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const carol = await person(app, 'carol')
    const a = await online(alice)
    a.send({ v: 1, type: 'presence.watch', data: { userIds: [bob.id, carol.id] } })
    const snapshot = await a.next('presence.snapshot')
    expect(snapshot.data).toEqual({
      users: [
        { userId: bob.id, status: 'offline', lastSeenAt: null },
        { userId: carol.id, status: 'offline', lastSeenAt: null },
      ],
    })

    const tab1 = await online(bob)
    const came = await a.waitFor(
      'presence',
      (m) => entry(m).userId === bob.id && entry(m).status === 'online',
    )
    expect(Object.keys(came.data as object).sort()).toEqual(['lastSeenAt', 'status', 'userId']) // no `is_current` or similar
    expect(entry(came).lastSeenAt).toBeNull()

    // A second tab, and closing the first: still online, nothing announced (L-18).
    const tab2 = await online(bob)
    tab1.ws.close()
    await quiet(500)
    expect(a.of('presence').filter((m) => entry(m).status === 'offline')).toEqual([])
    expect(a.of('presence')).toHaveLength(1)

    tab2.send({ v: 1, type: 'presence.activity', data: { state: 'idle' } })
    await a.waitFor('presence', (m) => entry(m).status === 'away')
    tab2.send({ v: 1, type: 'presence.activity', data: { state: 'active' } })
    await a.waitFor('presence', (m) => entry(m).status === 'online' && a.of('presence').length >= 3)

    const closedAt = Date.now()
    tab2.ws.close()
    const left = await a.waitFor('presence', (m) => entry(m).status === 'offline')
    expect(entry(left).userId).toBe(bob.id)
    const seen = new Date(entry(left).lastSeenAt ?? '').getTime()
    expect(Math.abs(seen - closedAt)).toBeLessThan(2_000)
    const [row] = await dbs.owner.db
      .select({ at: users.lastSeenAt })
      .from(users)
      .where(eq(users.id, bob.id))
    expect(row?.at?.getTime()).toBe(seen)
  })

  test('the watched set is replaced as a whole; a later snapshot shows last-seen for the offline', async () => {
    server = await startTestServer(app)
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const carol = await person(app, 'carol')
    const a = await online(alice)
    a.send({ v: 1, type: 'presence.watch', data: { userIds: [bob.id] } })
    await a.next('presence.snapshot')
    // Now only carol: bob's changes must stop arriving.
    a.send({ v: 1, type: 'presence.watch', data: { userIds: [carol.id] } })
    await a.waitFor('presence.snapshot', () => a.of('presence.snapshot').length === 2)
    const bobTab = await online(bob)
    await quiet(500)
    expect(a.of('presence')).toEqual([])
    bobTab.ws.close()
    await quiet(300)

    a.send({ v: 1, type: 'presence.watch', data: { userIds: [bob.id, carol.id] } })
    await a.waitFor('presence.snapshot', () => a.of('presence.snapshot').length === 3)
    const third = a.of('presence.snapshot')[2]?.data as
      | { users: Array<{ userId: string; status: string; lastSeenAt: string | null }> }
      | undefined
    const users3 = third?.users ?? []
    const bobEntry = users3.find((u) => u.userId === bob.id)
    expect(bobEntry?.status).toBe('offline')
    expect(bobEntry?.lastSeenAt).not.toBeNull() // seen a moment ago
    expect(users3.find((u) => u.userId === carol.id)).toEqual({
      userId: carol.id,
      status: 'offline',
      lastSeenAt: null,
    })
    // An empty set stops everything.
    a.send({ v: 1, type: 'presence.watch', data: { userIds: [] } })
    await a.waitFor('presence.snapshot', () => a.of('presence.snapshot').length === 4)
    expect(server.gateway.followers(`presence:${bob.id}`)).toBe(0)
  })

  test('a person’s own connection is known to presence the moment they are greeted, and gone when it closes', async () => {
    server = await startTestServer(app)
    const alice = await person(app, 'alice')
    const socket = await online(alice)
    const store = createPresenceStore(server.valkey, server.presencePrefix)
    expect((await store.statuses([alice.id], Date.now())).get(alice.id)).toBe('online')
    socket.ws.close()
    const deadline = Date.now() + 2_000
    while (
      (await store.statuses([alice.id], Date.now())).get(alice.id) !== 'offline' &&
      Date.now() < deadline
    )
      await Bun.sleep(50)
    expect((await store.statuses([alice.id], Date.now())).get(alice.id)).toBe('offline')
  })

  test('focus is accepted for a conversation the person is in and treated as nothing for any other', async () => {
    server = await startTestServer(app)
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const mine = await createConversation(alice, { kind: 'group', name: 'mine' })
    const theirs = await createConversation(bob, { kind: 'group', name: 'theirs' })
    const socket = await online(alice)
    const hash = () => server?.valkey.hgetall(`${server.presencePrefix}:u:${alice.id}`)
    socket.send({ v: 1, type: 'focus', data: { conversationId: mine.id, foreground: true } })
    await quiet()
    expect(
      Object.entries((await hash()) ?? {}).find(([field]) => field.startsWith('f:'))?.[1],
    ).toBe(`${mine.id}|1`)
    socket.send({ v: 1, type: 'focus', data: { conversationId: theirs.id, foreground: true } })
    await quiet()
    expect(Object.keys((await hash()) ?? {}).filter((field) => field.startsWith('f:'))).toEqual([])
    expect(socket.of('error')).toEqual([])
    expect(server.gateway.followers(convTopic(theirs.id))).toBe(0)
  })
})

describe('the sweeper job', () => {
  test('removes what died without closing, announces the person once on the bus and records when they were last seen', async () => {
    const config = testConfig()
    const valkey = await createValkey(config.valkeyUrl, 'test-sweeper-store')
    const subscriber = await createValkey(config.valkeyUrl, 'test-sweeper-sub')
    const channel = `events:test:${Math.random().toString(36).slice(2)}`
    const prefix = `presence:test-sweeper:${Math.random().toString(36).slice(2)}`
    const bus = createEventBus({ publisher: valkey, subscriber, channel, log: app.services.log })
    const heard: BusEvent[] = []
    await bus.subscribe((event) => heard.push(event))
    try {
      const alice = await person(app, 'alice')
      const store = createPresenceStore(valkey, prefix)
      const sweeper = createPresenceSweeper({
        deps: app.services.deps,
        store,
        bus,
        log: app.services.log,
      })
      await store.connect(
        { userId: alice.id, connectionId: 'died-with-its-process' },
        app.clock.now().getTime(),
      )
      expect(await sweeper.sweep()).toBe(0) // still alive

      app.clock.advance(PRESENCE_TTL_MS + 1000)
      expect(await sweeper.sweep()).toBe(1)
      expect(await sweeper.sweep()).toBe(0)
      const deadline = Date.now() + 2_000
      while (heard.length === 0 && Date.now() < deadline) await Bun.sleep(25)
      expect(heard).toEqual([
        {
          type: 'presence',
          userId: alice.id,
          status: 'offline',
          lastSeenAt: app.clock.now().toISOString(),
        },
      ])
      const [row] = await dbs.owner.db
        .select({ at: users.lastSeenAt })
        .from(users)
        .where(eq(users.id, alice.id))
      expect(row?.at?.toISOString()).toBe(app.clock.now().toISOString())
    } finally {
      const keys = await valkey.keys(`${prefix}:*`)
      if (keys.length > 0) await valkey.del(...keys)
      valkey.disconnect()
      subscriber.disconnect()
    }
  })
})
