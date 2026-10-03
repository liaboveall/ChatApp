/**
 * Who a connection follows, under reordered and failing reads (docs/03 section 5.7, AT-01, AT-02, D-137). The gateway
 * learns what conversations a person is in from the database; the answers can be slow, can arrive in any order relative
 * to the changes they describe, and can fail. Every test here puts a real reading from Postgres behind a barrier
 * (`HeldReadings`), changes the world while the answer waits, hands the answer over late, and then looks at what the
 * connection follows and at what it hears. Nothing is ordered by sleeping: the barrier, the hints the test injects and
 * `settled()` decide the order, and "never heard" is shown by a message that must arrive after the one that must not.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { convTopic, LIMITS } from '@chatapp/contracts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createTestApp, type TestApp } from '../support/http.ts'
import { createConversation, type Person, person } from '../support/people.ts'
import { HeldReadings } from '../support/readings.ts'
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
let readings: HeldReadings

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
  readings = new HeldReadings(app.services.deps)
  server = await startTestServer(app, { memberships: readings.load })
})
afterEach(async () => {
  readings.letThrough()
  await server?.stop()
  server = undefined
  await app.close()
})

const gateway = () => {
  if (!server) throw new Error('no server')
  return server.gateway
}
const followers = (conversationId: string) => gateway().followers(convTopic(conversationId))

/** Readings asked for before this point (every connection's greeting needs one) are not what a test is counting. */
let base = 0

async function online(who: Person): Promise<TestSocket> {
  const socket = connect(server?.port ?? 0, { cookie: cookieHeader(who.jar) })
  await socket.next('hello')
  base = readings.asked
  return socket
}
const add = (admin: Person, conversationId: string, other: Person) =>
  admin.post(`/api/conversations/${conversationId}/members`, { userIds: [other.id] })
const remove = (admin: Person, conversationId: string, other: Person) =>
  admin.del(`/api/conversations/${conversationId}/members/${other.id}`)
const seqOf = async (who: Person): Promise<number> =>
  (await who.get<{ userChangeSeq: number }>('/api/sync/heads')).body.userChangeSeq
const say = async (who: Person, conversationId: string, text: string) =>
  (
    await who.post<{ message: { id: string; changeSeq: number } }>(
      `/api/conversations/${conversationId}/messages`,
      { clientId: crypto.randomUUID(), body: text },
    )
  ).body

// What the bus would deliver, injected so the moment of arrival is the test's to choose.
const hintChanged = (who: Person, userChangeSeq: number) =>
  gateway().handleEvent({ type: 'user.changed', userId: who.id, userChangeSeq, membership: true })
const hintRemoved = (who: Person, conversationId: string, userChangeSeq: number) =>
  gateway().handleEvent({
    type: 'conversation.removed',
    userId: who.id,
    conversationId,
    userChangeSeq,
  })
const hintMessage = (
  conversationId: string,
  sent: { message: { id: string; changeSeq: number } },
) =>
  gateway().handleEvent({
    type: 'message.changed',
    conversationId,
    messageId: sent.message.id,
    changeSeq: sent.message.changeSeq,
  })

/** Waits for a condition of the gateway's own state (not for time); the guard only keeps a failure from hanging. */
async function eventually(condition: () => boolean, guardMs = 5_000): Promise<void> {
  const until = Date.now() + guardMs
  while (!condition()) {
    if (Date.now() > until) throw new Error('the condition was not reached')
    await Bun.sleep(1)
  }
}

const heardConversations = (socket: TestSocket) =>
  socket.of('message.changed').map((m) => (m.data as { conversationId: string }).conversationId)

describe('an answer taken before a removal and handed over after it', () => {
  test('is not applied: the person never follows the conversation again, and nothing of it is heard', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const leaving = await createConversation(alice, {
      kind: 'group',
      name: 'leaving',
      memberIds: [bob.id],
    })
    const staying = await createConversation(alice, { kind: 'group', name: 'staying' })
    const socket = await online(bob)
    expect(followers(leaving.id)).toBe(1)
    expect(followers(staying.id)).toBe(0)

    // 1. Something changes Bob's conversations (he is added to the second group): the hint starts a reading, and its
    //    answer, which says "both", is taken now and held back.
    readings.hold()
    await add(alice, staying.id, bob)
    hintChanged(bob, await seqOf(bob))
    await readings.waitingFor(1)

    // 2. Meanwhile he is removed from the first. The hint stops him following it at once, before any reading.
    await remove(alice, leaving.id, bob)
    hintRemoved(bob, leaving.id, await seqOf(bob))
    expect(followers(leaving.id)).toBe(0)

    // 3. The held answer still says "both". It arrives, and it is not applied: the gateway notices that something came
    //    in while it was out, discards it and asks again.
    await readings.release()
    await readings.waitingFor(1)
    expect(readings.asked - base).toBe(2)
    expect(followers(leaving.id)).toBe(0)
    expect(followers(staying.id)).toBe(0) // none of the stale answer was applied, not even the part that was right

    // 4. The second answer was taken after the removal: it is applied, whole.
    await readings.release()
    await gateway().settled()
    expect(followers(leaving.id)).toBe(0)
    expect(followers(staying.id)).toBe(1)

    // 5. What Bob hears: the message in the group he is in, and, being sent first, nothing of the one he left.
    const afterLeaving = await say(alice, leaving.id, 'after he left')
    const afterJoining = await say(alice, staying.id, 'after he joined')
    hintMessage(leaving.id, afterLeaving)
    hintMessage(staying.id, afterJoining)
    await socket.waitFor(
      'message.changed',
      (m) => (m.data as { conversationId: string }).conversationId === staying.id,
    )
    expect(heardConversations(socket)).toEqual([staying.id])

    // 6. The 5-second recheck finds nothing to correct, and asks for nothing.
    await gateway().revalidateAll()
    expect(readings.asked - base).toBe(2)
    expect(followers(leaving.id)).toBe(0)
    expect(followers(staying.id)).toBe(1)
  })

  test('the recheck is every five seconds, and when it runs it corrects a lost removal even with a stale answer out', async () => {
    expect(LIMITS.wsRevalidateMs).toBe(5_000)
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const leaving = await createConversation(alice, {
      kind: 'group',
      name: 'lost',
      memberIds: [bob.id],
    })
    const staying = await createConversation(alice, { kind: 'group', name: 'kept' })
    await online(bob)

    readings.hold()
    await add(alice, staying.id, bob)
    hintChanged(bob, await seqOf(bob))
    await readings.waitingFor(1)
    // Removed, and this time nobody is told: the hint is lost.
    await remove(alice, leaving.id, bob)
    const recheck = gateway().revalidateAll()
    // The recheck sees that Bob's own log is ahead of what the gateway holds and asks for a reading; because one is out,
    // that one is marked outdated instead of a second being started.
    await readings.release()
    await readings.waitingFor(1)
    expect(followers(leaving.id)).toBe(1) // not yet: the stale answer was discarded, the fresh one is still on its way
    await readings.release()
    await recheck
    expect(followers(leaving.id)).toBe(0)
    expect(followers(staying.id)).toBe(1)
  })
})

describe('requests that come in while a reading is out', () => {
  test('do not start more readings: one repeat answers them all', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const groups = await Promise.all(
      [1, 2, 3].map((n) => createConversation(alice, { kind: 'group', name: `crowd ${n}` })),
    )
    await online(bob)
    readings.hold()
    const hints: number[] = []
    for (const group of groups) {
      await add(alice, group.id, bob)
      hints.push(await seqOf(bob))
    }
    // Three changes, three hints: the first starts a reading, the next two arrive while it is out.
    hintChanged(bob, hints[0] ?? 0)
    await readings.waitingFor(1)
    hintChanged(bob, hints[1] ?? 0)
    hintChanged(bob, hints[2] ?? 0)
    expect(readings.asked - base).toBe(1)

    await readings.release()
    await readings.waitingFor(1)
    expect(readings.asked - base).toBe(2)
    for (const group of groups) expect(followers(group.id)).toBe(0) // the first answer predates the last hints: dropped
    await readings.release()
    await gateway().settled()
    expect(readings.asked - base).toBe(2)
    for (const group of groups) expect(followers(group.id)).toBe(1)
  })

  test('a connection that opens meanwhile is greeted only after a reading that began after it opened', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const leaving = await createConversation(alice, {
      kind: 'group',
      name: 'gone by hello',
      memberIds: [bob.id],
    })
    const staying = await createConversation(alice, { kind: 'group', name: 'there at hello' })
    const first = await online(bob)
    expect(followers(leaving.id)).toBe(1)

    readings.hold()
    await add(alice, staying.id, bob)
    hintChanged(bob, await seqOf(bob))
    await readings.waitingFor(1) // taken while Bob was still in the first group
    await remove(alice, leaving.id, bob) // and no hint for this one

    const second = connect(server?.port ?? 0, { cookie: cookieHeader(bob.jar) })
    await eventually(() => gateway().connectionCount === 2)
    // Not greeted: what it follows is not known yet.
    expect(second.messages).toEqual([])

    await readings.release() // the stale answer, discarded because a connection arrived while it was out
    await readings.waitingFor(1)
    expect(second.messages).toEqual([])
    expect(followers(leaving.id)).toBe(1) // nothing has been applied yet, the first connection still follows as before
    await readings.release()
    await second.next('hello')
    expect(followers(leaving.id)).toBe(0) // both connections, now
    expect(followers(staying.id)).toBe(2)
    expect(first.of('hello')).toHaveLength(1)
  })
})

describe('hints about a person who left and came back', () => {
  test('a removal hint that arrives after the return takes nothing away, not even while the reading it asks for is out', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'back again',
      memberIds: [bob.id],
    })
    const socket = await online(bob)
    await remove(alice, group.id, bob)
    const removedAt = await seqOf(bob)
    await add(alice, group.id, bob)
    hintChanged(bob, await seqOf(bob))
    await gateway().settled()
    expect(followers(group.id)).toBe(1)

    readings.hold()
    hintRemoved(bob, group.id, removedAt) // late: Bob is a member again, and the gateway already knows
    expect(followers(group.id)).toBe(1) // at once, without waiting for any reading
    await readings.waitingFor(1)
    expect(followers(group.id)).toBe(1) // and still, while the reading it asked for is out
    await readings.release()
    await gateway().settled()
    expect(followers(group.id)).toBe(1)
    const sent = await say(alice, group.id, 'welcome back')
    hintMessage(group.id, sent)
    await socket.waitFor(
      'message.changed',
      (m) => (m.data as { conversationId: string }).conversationId === group.id,
    )
  })

  test('removed, then added again while the first reading is out: only the reading taken after the return is applied', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const group = await createConversation(alice, {
      kind: 'group',
      name: 'out and in',
      memberIds: [bob.id],
    })
    const socket = await online(bob)

    readings.hold()
    await remove(alice, group.id, bob)
    hintRemoved(bob, group.id, await seqOf(bob))
    expect(followers(group.id)).toBe(0)
    await readings.waitingFor(1) // taken after the removal: it says "not in it"

    await add(alice, group.id, bob)
    hintChanged(bob, await seqOf(bob)) // arrives while that reading is out

    await readings.release() // correct when it was taken, outdated now: discarded
    await readings.waitingFor(1)
    expect(followers(group.id)).toBe(0)
    await readings.release()
    await gateway().settled()
    expect(followers(group.id)).toBe(1)
    const sent = await say(alice, group.id, 'and here again')
    hintMessage(group.id, sent)
    await socket.waitFor(
      'message.changed',
      (m) => (m.data as { conversationId: string }).conversationId === group.id,
    )
  })
})

describe('a reading that cannot be completed, and one for somebody who has gone', () => {
  test('a failed reading changes nothing, and the next recheck makes up for it', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const group = await createConversation(alice, { kind: 'group', name: 'unreadable' })
    await online(bob)
    readings.failNext()
    await add(alice, group.id, bob)
    hintChanged(bob, await seqOf(bob))
    await gateway().settled()
    expect(readings.asked - base).toBe(1)
    expect(followers(group.id)).toBe(0) // the hint could not be acted on

    await gateway().revalidateAll() // Bob's log is ahead of what the gateway holds: read again
    expect(readings.asked - base).toBe(2)
    expect(followers(group.id)).toBe(1)
  })

  test('an answer for a person whose last connection has closed is dropped, not given to their next one', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bob')
    const leaving = await createConversation(alice, {
      kind: 'group',
      name: 'old news',
      memberIds: [bob.id],
    })
    const first = await online(bob)

    readings.hold()
    hintChanged(bob, (await seqOf(bob)) + 1) // any change at all: it starts a reading, taken while Bob is in the group
    await readings.waitingFor(1)
    await remove(alice, leaving.id, bob)
    first.ws.close()
    await eventually(() => gateway().connectionCount === 0)

    const second = connect(server?.port ?? 0, { cookie: cookieHeader(bob.jar) })
    await eventually(() => gateway().connectionCount === 1)
    await readings.waitingFor(2) // the new connection's own reading, taken after the removal
    await readings.release() // the old one, for a record that no longer exists
    expect(followers(leaving.id)).toBe(0)
    expect(second.messages).toEqual([])
    await readings.release()
    await second.next('hello')
    expect(followers(leaving.id)).toBe(0)
  })
})
