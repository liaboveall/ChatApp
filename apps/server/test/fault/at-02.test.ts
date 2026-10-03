/**
 * AT-02 (docs/08 section 8, docs/03 section 5.7, M2a): revocation reaches a live connection without the bus. Hints travel
 * over Valkey, so when it is gone nobody is told that a person was removed or signed out; the gateway's own recheck of
 * Postgres (5 seconds, plus one second of tolerance) is what ends the subscription and the connection, and when the
 * bus returns the gateway looks again at once instead of waiting for the next tick. The Valkey killed here is the
 * isolated instance's (D-085, AT-34).
 *
 * Run through `bun run test:fault`, which creates the instance and passes its manifest in CHATAPP_FAULT_MANIFEST.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { convTopic, LIMITS } from '@chatapp/contracts'
import { removeConversationMember } from '../../src/domain/members.ts'
import { sendMessage } from '../../src/domain/messages.ts'
import { revokeAllDevices } from '../../src/domain/sessions.ts'
import { makePrincipal } from '../support/deps.ts'
import { type FaultInstance, openFaultInstance, waitUntil } from '../support/fault/instance.ts'
import { verifyFaultTarget } from '../support/fault/manifest.ts'
import { createTestApp, type TestApp } from '../support/http.ts'
import { createConversation, person } from '../support/people.ts'
import {
  connect,
  cookieHeader,
  deliverHints,
  startTestServer,
  type TestServer,
} from '../support/ws.ts'

let instance: FaultInstance
let app: TestApp | undefined
let server: TestServer | undefined

beforeAll(async () => {
  instance = await openFaultInstance()
})
afterAll(async () => {
  await instance.close()
})
beforeEach(async () => {
  await instance.reset()
})
afterEach(async () => {
  try {
    await server?.stop()
    server = undefined
    await app?.close()
    app = undefined
  } finally {
    // Whatever a test did to the bus, and whatever tidying up threw, the next one starts with it running.
    await instance.target.act('valkey', 'start').catch(() => undefined)
  }
  await waitUntil(
    async () =>
      (await verifyFaultTarget(instance.manifest).then(
        () => true,
        () => false,
      )) || undefined,
    {
      guardMs: 45_000,
      intervalMs: 500,
      what: 'the instance to verify again',
    },
  )
})

const valkeyUrl = () => instance.manifest.endpoints.valkeyUrl
const NOT_BEFORE = 'the recheck is five seconds, and the test allows one more of tolerance'

async function startAll(gateway: { revalidateMs?: number } = {}) {
  app = await createTestApp(instance.databases, { valkeyUrl: valkeyUrl() })
  server = await startTestServer(app, { valkeyUrl: valkeyUrl(), gateway })
  return { app, server }
}

describe('the bus is gone', () => {
  test('a removal and a revoked session still end the subscription and the connection within the recheck, and nothing leaks when the bus returns', async () => {
    expect(LIMITS.wsRevalidateMs, NOT_BEFORE).toBe(5_000)
    const { app, server } = await startAll() // the real interval
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'cut off',
      memberIds: [bob.id],
    })
    const topic = convTopic(group.id)
    const aliceSocket = connect(server.port, { cookie: cookieHeader(alice.jar) })
    const bobSocket = connect(server.port, { cookie: cookieHeader(bob.jar) })
    await Promise.all([aliceSocket.next('hello'), bobSocket.next('hello')])
    expect(server.gateway.followers(topic)).toBe(2)

    await instance.target.act('valkey', 'kill')

    // Bob is removed while nobody can be told. The database says so; the gateway finds out by itself.
    const deps = app.services.deps
    await removeConversationMember(deps, await makePrincipal(deps, alice), group.id, bob.id)
    const removedAt = Date.now()
    await waitUntil(() => (server.gateway.followers(topic) === 1 ? true : undefined), {
      guardMs: 10_000,
      intervalMs: 25,
      what: 'Bob to stop following the group',
    })
    expect(Date.now() - removedAt).toBeLessThanOrEqual(LIMITS.wsRevalidateMs + 1_000)

    // And his session is revoked, still with no bus: the connection is closed with 4401, and a new request is refused.
    await revokeAllDevices(deps, await makePrincipal(deps, bob))
    const revokedAt = Date.now()
    const closed = await Promise.race([bobSocket.closed, Bun.sleep(10_000).then(() => undefined)])
    expect(closed?.code).toBe(4401)
    expect(Date.now() - revokedAt).toBeLessThanOrEqual(LIMITS.wsRevalidateMs + 1_000)
    expect((await bob.get('/api/me')).status).toBe(401)

    // The bus returns. Hints flow again to the member who is still there; Bob, gone, hears nothing of the group.
    await instance.target.act('valkey', 'start')
    const heard = await waitUntil(
      async () => {
        const sent = await sendMessage(deps, await makePrincipal(deps, alice), group.id, {
          clientId: crypto.randomUUID(),
          body: 'after the bus came back',
        })
        await deliverHints(app, server)
        const hint = await aliceSocket
          .waitFor(
            'message.changed',
            (m) => (m.data as { messageId: string }).messageId === sent.envelope.message.id,
            1_500,
          )
          .catch(() => undefined)
        return hint
      },
      { guardMs: 60_000, intervalMs: 100, what: 'hints to flow again' },
    )
    expect(heard.data).toMatchObject({ conversationId: group.id })
    expect(server.gateway.followers(topic)).toBe(1)
    expect(bobSocket.of('message.changed')).toEqual([])
  }, 150_000)

  test('when the bus comes back the gateway looks at the database at once, not at the next tick', async () => {
    // An interval so long that only the reaction to the return can explain what follows.
    const { app, server } = await startAll({ revalidateMs: 600_000 })
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'left alone',
      memberIds: [bob.id],
    })
    const topic = convTopic(group.id)
    const bobSocket = connect(server.port, { cookie: cookieHeader(bob.jar) })
    await bobSocket.next('hello')
    expect(server.gateway.followers(topic)).toBe(1)

    await instance.target.act('valkey', 'kill')
    const deps = app.services.deps
    await removeConversationMember(deps, await makePrincipal(deps, alice), group.id, bob.id)
    // Nobody can tell the gateway, and its own tick is ten minutes away: Bob is still followed.
    expect(server.gateway.followers(topic)).toBe(1)

    await instance.target.act('valkey', 'start')
    await waitUntil(() => (server.gateway.followers(topic) === 0 ? true : undefined), {
      guardMs: 30_000,
      intervalMs: 50,
      what: 'the gateway to look again once the bus returned',
    })
    expect(app.logs.some((line) => line.includes('bus.recovered'))).toBe(true)
  }, 120_000)
})
