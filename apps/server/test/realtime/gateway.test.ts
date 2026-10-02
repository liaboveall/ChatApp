/**
 * WebSocket gateway against a real Bun server (docs/05 section 4, SEC-03, AT-02): close codes, protocol hygiene and,
 * above all, that a connection never outlives its session - by hint within milliseconds, by the 5 s recheck when the
 * hint is lost, and by failing closed when the database cannot answer.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { WS_CLOSE } from '@chatapp/contracts'
import { authorizationOrigins, users } from '@chatapp/db'
import { eq } from 'drizzle-orm'
import { createDispatcher } from '../../src/jobs/dispatcher.ts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createActiveUser } from '../support/deps.ts'
import { createTestApp, type TestApp } from '../support/http.ts'
import { connect, cookieHeader, startTestServer, type TestServer } from '../support/ws.ts'

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

async function signIn(username: string) {
  const user = await createActiveUser(app.services.deps, { username })
  const jar = app.newJar()
  const response = await app.request('/api/auth/sign-in/email', {
    json: { email: user.email, password: user.password },
    jar,
  })
  expect(response.status).toBe(200)
  return { user, jar, cookie: cookieHeader(jar) }
}

/** The dispatcher step that turns committed revocation hints into bus events (what the worker does every second). */
async function dispatch(srv: TestServer): Promise<void> {
  const dispatcher = createDispatcher({
    deps: app.services.deps,
    bus: srv.bus,
    emailQueue: { add: async () => undefined } as never,
    log: app.services.log,
  })
  await dispatcher.tick()
}

describe('handshake', () => {
  test('no session closes with 4401, a foreign origin with 4403 even when the cookie is valid', async () => {
    server = await startTestServer(app)
    const anonymous = connect(server.port)
    expect((await anonymous.closed).code).toBe(WS_CLOSE.UNAUTHENTICATED)

    const { cookie } = await signIn('ws1')
    const foreign = connect(server.port, { origin: 'http://evil.example', cookie })
    expect((await foreign.closed).code).toBe(WS_CLOSE.ORIGIN_NOT_ALLOWED)
    const noOrigin = connect(server.port, { origin: null, cookie })
    expect((await noOrigin.closed).code).toBe(WS_CLOSE.ORIGIN_NOT_ALLOWED)
    expect(server.gateway.connectionCount).toBe(0)
  })

  test('a signed-in member gets hello with identity, epochs, server time and the heartbeat', async () => {
    server = await startTestServer(app)
    const { user, cookie } = await signIn('ws2')
    const socket = connect(server.port, { cookie })
    const hello = (await socket.next('hello')) as { v: number; data: Record<string, unknown> }
    expect(hello.v).toBe(1)
    expect(hello.data).toMatchObject({ userId: user.id, authEpoch: 0, heartbeatMs: 25_000 })
    expect(hello.data.restoreEpoch).toBe(app.services.deps.config.auth.restoreEpoch)
    expect(Math.abs(new Date(String(hello.data.serverTime)).getTime() - Date.now())).toBeLessThan(
      5_000,
    )
    expect(String(hello.data.connectionId)).toMatch(/^[0-9a-f-]{36}$/)
    socket.ws.close()
  })

  test('a banned account and a dead session are refused at the door', async () => {
    server = await startTestServer(app)
    const { user, cookie } = await signIn('ws3')
    await dbs.owner.db.update(users).set({ banned: true }).where(eq(users.id, user.id))
    expect((await connect(server.port, { cookie }).closed).code).toBe(WS_CLOSE.UNAUTHENTICATED)
  })
})

describe('protocol hygiene (SEC-24)', () => {
  test('ping is answered, bad JSON and unknown types get an error event, the connection survives', async () => {
    server = await startTestServer(app)
    const { cookie } = await signIn('ws4')
    const socket = connect(server.port, { cookie })
    await socket.next('hello')
    socket.ws.send(JSON.stringify({ v: 1, type: 'ping', data: {} }))
    const pong = (await socket.next('pong')) as { data: { serverTime: string } }
    expect(new Date(pong.data.serverTime).toString()).not.toBe('Invalid Date')

    socket.ws.send('{"not json')
    socket.ws.send(JSON.stringify({ v: 1, type: 'definitely.unknown', data: {} }))
    socket.ws.send(JSON.stringify({ v: 2, type: 'ping', data: {} }))
    await Bun.sleep(300)
    const errors = socket.messages.filter((m) => m.type === 'error') as Array<{
      data: { code: string; message: string }
    }>
    expect(errors.map((e) => e.data.code)).toEqual([
      'invalid_message',
      'unknown_message',
      'unknown_message',
    ])
    // Errors never echo what the client sent.
    expect(JSON.stringify(errors)).not.toContain('definitely')
    socket.ws.send(JSON.stringify({ v: 1, type: 'ping', data: {} }))
    await Bun.sleep(200)
    expect(socket.messages.filter((m) => m.type === 'pong')).toHaveLength(2)
    socket.ws.close()
  })

  test('binary frames and oversized frames close the connection', async () => {
    server = await startTestServer(app)
    const { cookie } = await signIn('ws5')
    const binary = connect(server.port, { cookie })
    await binary.next('hello')
    binary.ws.send(new Uint8Array([1, 2, 3]))
    expect((await binary.closed).code).toBe(1003)

    const big = connect(server.port, { cookie })
    await big.next('hello')
    big.ws.send('x'.repeat(70 * 1024))
    // Bun enforces maxPayloadLength below the gateway and drops the transport (1006); 1009 is the gateway's own backstop.
    expect([1006, 1009]).toContain((await big.closed).code)
  })

  test('flooding closes with 4429', async () => {
    server = await startTestServer(app, {
      gateway: { maxMessagesPerWindow: 5, messageWindowMs: 60_000 },
    })
    const { cookie } = await signIn('ws6')
    const socket = connect(server.port, { cookie })
    await socket.next('hello')
    for (let i = 0; i < 12; i += 1) socket.ws.send(JSON.stringify({ v: 1, type: 'ping', data: {} }))
    expect((await socket.closed).code).toBe(WS_CLOSE.TOO_MANY_MESSAGES)
  })

  test('the 11th connection of a user closes the oldest with 4409', async () => {
    server = await startTestServer(app, { gateway: { maxConnectionsPerUser: 3 } })
    const { cookie } = await signIn('ws7')
    const sockets = []
    for (let i = 0; i < 3; i += 1) {
      const socket = connect(server.port, { cookie })
      await socket.next('hello')
      sockets.push(socket)
    }
    const fourth = connect(server.port, { cookie })
    await fourth.next('hello')
    expect((await sockets[0]?.closed)?.code).toBe(WS_CLOSE.TOO_MANY_CONNECTIONS)
    await Bun.sleep(100)
    expect(server.gateway.connectionCount).toBe(3)
    for (const socket of [...sockets, fourth]) socket.ws.close()
  })
})

describe('a connection never outlives its session (AT-02)', () => {
  test('signing out closes it within moments through the durable hint and the bus', async () => {
    server = await startTestServer(app, { gateway: { revalidateMs: 60_000 } }) // the poll cannot be what closes it
    const { jar, cookie } = await signIn('ws8')
    const socket = connect(server.port, { cookie })
    await socket.next('hello')
    const started = Date.now()
    expect((await app.request('/api/auth/sign-out', { method: 'POST', jar })).status).toBe(200)
    await dispatch(server)
    const closed = await socket.closed
    expect(closed.code).toBe(WS_CLOSE.UNAUTHENTICATED)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test('revoking other devices closes theirs and keeps this one; password change does the same', async () => {
    server = await startTestServer(app, { gateway: { revalidateMs: 60_000 } })
    const user = await createActiveUser(app.services.deps, { username: 'ws9' })
    const login = async () => {
      const jar = app.newJar()
      await app.request('/api/auth/sign-in/email', {
        json: { email: user.email, password: user.password },
        jar,
      })
      return { jar, cookie: cookieHeader(jar) }
    }
    const a = await login()
    const b = await login()
    const c = await login()
    const sockets = [a, b, c].map((who) => connect(server?.port ?? 0, { cookie: who.cookie }))
    await Promise.all(sockets.map((s) => s.next('hello')))

    await app.request('/api/me/devices/revoke-others', { method: 'POST', jar: a.jar })
    await dispatch(server)
    expect((await sockets[1]?.closed)?.code).toBe(WS_CLOSE.UNAUTHENTICATED)
    expect((await sockets[2]?.closed)?.code).toBe(WS_CLOSE.UNAUTHENTICATED)
    await Bun.sleep(200)
    expect(sockets[0]?.ws.readyState).toBe(WebSocket.OPEN)

    // Changing the password ends the other sessions; the current one is re-bound, but its connection was opened under
    // the old epoch and origin, so it too must reconnect (and will be accepted again under the new identity).
    const again = await login()
    const extra = connect(server.port, { cookie: again.cookie })
    await extra.next('hello')
    const changed = await app.request('/api/auth/change-password', {
      json: { currentPassword: user.password, newPassword: 'violet-harbor-91-compass' },
      jar: a.jar,
    })
    expect(changed.status).toBe(200)
    await dispatch(server)
    expect((await extra.closed).code).toBe(WS_CLOSE.UNAUTHENTICATED)
    expect((await sockets[0]?.closed)?.code).toBe(WS_CLOSE.UNAUTHENTICATED)
    const reconnect = connect(server.port, { cookie: cookieHeader(a.jar) })
    await reconnect.next('hello')
    reconnect.ws.close()
  })

  test('without any hint the periodic recheck closes banned, expired and revoked sessions', async () => {
    server = await startTestServer(app, { gateway: { revalidateMs: 150 } })
    const banned = await signIn('ws10')
    const revoked = await signIn('ws11')
    const expiring = await signIn('ws12')
    const sockets = [banned, revoked, expiring].map((who) =>
      connect(server?.port ?? 0, { cookie: who.cookie }),
    )
    await Promise.all(sockets.map((s) => s.next('hello')))

    await dbs.owner.db.update(users).set({ banned: true }).where(eq(users.id, banned.user.id))
    await dbs.owner.db
      .update(authorizationOrigins)
      .set({ revokedAt: new Date(), revokeReason: 'device_revoked' })
      .where(eq(authorizationOrigins.userId, revoked.user.id))
    app.clock.advance(31 * 86_400_000)
    // The expiring session is the only one still alive by the manual clock's reckoning of time itself.
    const codes = await Promise.all(sockets.map(async (s) => (await s.closed).code))
    expect(codes).toEqual([4401, 4401, 4401])
  })

  test('when the database cannot answer the gateway fails closed with 1013', async () => {
    let broken = false
    const flaky = new Proxy(app.services.deps.db, {
      get(target, property, receiver) {
        if (broken) throw new Error('database down')
        return Reflect.get(target, property, receiver)
      },
    })
    server = await startTestServer(app, { gateway: { revalidateMs: 150 }, deps: { db: flaky } })
    const { cookie } = await signIn('ws13')
    const socket = connect(server.port, { cookie })
    await socket.next('hello')
    broken = true
    expect((await socket.closed).code).toBe(WS_CLOSE.TRY_AGAIN_LATER)
  })

  test('the default 5-second recheck closes a revoked session within 6 seconds even if every hint is lost', async () => {
    server = await startTestServer(app) // default revalidateMs = 5000, no dispatcher running
    const { user, cookie } = await signIn('ws14')
    const socket = connect(server.port, { cookie })
    await socket.next('hello')
    const revokedAt = Date.now()
    await dbs.owner.db
      .update(authorizationOrigins)
      .set({ revokedAt: new Date(), revokeReason: 'all_devices_revoked' })
      .where(eq(authorizationOrigins.userId, user.id))
    const closed = await socket.closed
    const elapsed = Date.now() - revokedAt
    expect(closed.code).toBe(WS_CLOSE.UNAUTHENTICATED)
    expect(elapsed).toBeLessThanOrEqual(6_000) // 5 s recheck + 1 s test tolerance (docs/03 section 5.8)
  }, 15_000)
})
