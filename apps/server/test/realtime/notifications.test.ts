/**
 * The `notification` hint over a real server, bus and dispatcher (docs/05 section 4.4, SEC-27, M6): it reaches the person
 * it is for and nobody else, and carries identifiers and a number, never what the notification is about.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { NotificationPage } from '@chatapp/contracts'
import { userTopic } from '@chatapp/contracts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createTestApp, type TestApp } from '../support/http.ts'
import { createConversation, type Person, person } from '../support/people.ts'
import { drainPush } from '../support/push.ts'
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

async function online(who: Person): Promise<TestSocket> {
  const socket = connect(server?.port ?? 0, { cookie: cookieHeader(who.jar) })
  await socket.next('hello')
  return socket
}

describe('the notification hint', () => {
  test('reaches the person named, only them, with identifiers and the number of their log', async () => {
    server = await startTestServer(app)
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bobby')
    const carol = await person(app, 'carol')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'crew',
      memberIds: [bob.id, carol.id],
    })
    const sockets = {
      alice: await online(alice),
      bob: await online(bob),
      carol: await online(carol),
    }

    await alice.post(`/api/conversations/${group.id}/messages`, {
      clientId: crypto.randomUUID(),
      body: `the secret plan for <@user:${bob.id}>`,
    })
    await drainPush(app.services.deps)
    await deliverHints(app, server)

    const heard = await sockets.bob.next('notification')
    const listed = await bob.get<NotificationPage>('/api/notifications')
    const heads = await bob.get<{ userChangeSeq: number }>('/api/sync/heads')
    expect(heard).toEqual({
      v: 1,
      type: 'notification',
      topic: userTopic(bob.id),
      data: { notificationId: listed.body.items[0]?.id, userChangeSeq: heads.body.userChangeSeq },
    })
    await Bun.sleep(250)
    expect(sockets.alice.of('notification')).toEqual([])
    expect(sockets.carol.of('notification')).toEqual([])
    const raw = JSON.stringify(sockets.bob.of('notification'))
    expect(raw).not.toContain('secret')
    expect(raw).not.toContain(alice.id)
    expect(raw).not.toContain(group.id)
  })

  test("marking an entry read tells the person's other devices", async () => {
    server = await startTestServer(app)
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bobby')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'crew',
      memberIds: [bob.id],
    })
    await alice.post(`/api/conversations/${group.id}/messages`, {
      clientId: crypto.randomUUID(),
      body: `<@user:${bob.id}>`,
    })
    await drainPush(app.services.deps)
    const phone = await online(bob)
    const id = (await bob.get<NotificationPage>('/api/notifications')).body.items[0]?.id
    await bob.post('/api/notifications/read', { ids: [id] })
    await deliverHints(app, server)
    const heard = await phone.waitFor(
      'notification',
      (m) => (m.data as { notificationId: string }).notificationId === id,
    )
    expect(heard.topic).toBe(userTopic(bob.id))
  })
})
