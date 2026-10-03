/**
 * AT-01 (docs/08 section 8, D-056, M2a): a change that has committed is never lost with the process that committed it,
 * nor with the queue it would have travelled through. Real `api` and `worker` processes are killed, paused and resumed,
 * and the instance's Valkey is emptied, always inside the isolated instance of the run (D-085, AT-34); what must
 * still hold afterwards is that the intent was in Postgres all along, that a new process delivers it once, that the
 * business effect happened once, and that a client catching up finds the change (the foreground reconciliation: heads,
 * then the changes of the conversation, within 35 seconds).
 *
 * Run through `bun run test:fault`, which creates the instance and passes its manifest in CHATAPP_FAULT_MANIFEST.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { ConversationChangesResponse, SyncHeadsResponse } from '@chatapp/contracts'
import { conversationChanges, messages, workItems } from '@chatapp/db'
import { and, eq } from 'drizzle-orm'
import { createInvite } from '../../src/domain/invites.ts'
import { registerAccount } from '../../src/domain/registration.ts'
import { createActiveUser, makeDeps, makePrincipal } from '../support/deps.ts'
import {
  ApiClient,
  type ApiService,
  type FaultInstance,
  openFaultInstance,
  type Service,
  startApi,
  startWorker,
  waitUntil,
} from '../support/fault/instance.ts'
import { connect, type TestSocket } from '../support/ws.ts'

let instance: FaultInstance
const started: Service[] = []

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
  for (const service of started.splice(0)) await service.stop()
})

const deps = () => makeDeps(instance.databases.owner.db)
const db = () => instance.databases.owner.db

async function api(): Promise<ApiService> {
  const service = await startApi(instance)
  started.push(service)
  return service
}
async function worker(): Promise<Service> {
  const service = await startWorker(instance)
  started.push(service)
  return service
}

type Sent = { id: string; changeSeq: number; seq: number }

/** Two members and a group they share, created through a real API process; each is signed in there. */
async function aliceAndBob(service: ApiService) {
  const alice = await createActiveUser(deps(), { username: 'alice' })
  const bob = await createActiveUser(deps(), { username: 'bob' })
  const aliceApi = new ApiClient(service.baseUrl)
  const bobApi = new ApiClient(service.baseUrl)
  await aliceApi.signIn(alice.email, alice.password)
  await bobApi.signIn(bob.email, bob.password)
  const created = await aliceApi.call<{ id: string }>('/api/conversations', {
    json: { kind: 'group', name: 'fault line', memberIds: [bob.id] },
    headers: { 'idempotency-key': crypto.randomUUID() },
  })
  expect(created.status).toBe(201)
  return { alice, bob, aliceApi, bobApi, conversationId: created.body.id }
}

async function say(client: ApiClient, conversationId: string, text: string): Promise<Sent> {
  const reply = await client.call<{ message: Sent }>(
    `/api/conversations/${conversationId}/messages`,
    {
      json: { clientId: crypto.randomUUID(), body: text },
    },
  )
  expect(reply.status).toBe(201)
  return reply.body.message
}

const hintFor = (socket: TestSocket, messageId: string, timeoutMs = 25_000) =>
  socket.waitFor(
    'message.changed',
    (m) => (m.data as { messageId: string }).messageId === messageId,
    timeoutMs,
  )
const hintsFor = (socket: TestSocket, messageId: string) =>
  socket
    .of('message.changed')
    .filter((m) => (m.data as { messageId: string }).messageId === messageId)

const itemOf = async (conversationId: string, changeSeq: number) =>
  (
    await db()
      .select()
      .from(workItems)
      .where(eq(workItems.dedupeKey, `mc:${conversationId}:${changeSeq}`))
  )[0]

/** What a client does in the foreground: look at the heads, then read the conversation's changes from where it was. */
async function converge(
  client: ApiClient,
  conversationId: string,
  after: number,
  changeSeq: number,
) {
  const heads = await client.call<SyncHeadsResponse>('/api/sync/heads')
  const head = heads.body.conversations.find((c) => c.id === conversationId)
  expect(head?.lastChangeSeq).toBeGreaterThanOrEqual(changeSeq)
  const feed = await client.call<ConversationChangesResponse>(
    `/api/conversations/${conversationId}/changes?after=${after}`,
  )
  expect(feed.body.resetRequired).toBe(false)
  return feed.body.items
}

describe('the API that committed a change dies', () => {
  test('the intent is in Postgres, a new API and a worker deliver it once, and the client converges', async () => {
    const first = await api()
    const { bobApi, aliceApi, conversationId } = await aliceAndBob(first)
    const sent = await say(aliceApi, conversationId, 'committed, then the process dies')

    // The change and its intent were committed together; nobody has delivered it, because no worker exists yet.
    const intent = await itemOf(conversationId, sent.changeSeq)
    expect(intent).toMatchObject({ kind: 'realtime', status: 'pending' })
    expect(await db().select().from(messages).where(eq(messages.id, sent.id))).toHaveLength(1)

    const killedAt = Date.now()
    await first.stop() // SIGKILL: no shutdown handler, no last hint, nothing flushed

    // Another API process, Bob connected to it, and only then a worker.
    const second = await api()
    const bob = connect(second.port, { cookie: bobApi.cookie })
    await bob.next('hello')
    await worker()

    const hint = await hintFor(bob, sent.id)
    expect(hint.data).toMatchObject({
      conversationId,
      messageId: sent.id,
      changeSeq: sent.changeSeq,
    })
    const done = await waitUntil(
      async () => {
        const row = await itemOf(conversationId, sent.changeSeq)
        return row?.status === 'done' ? row : undefined
      },
      { what: 'the intent to be completed' },
    )
    expect(done.deliverySeq).toBe(1) // dispatched once

    // The business effect happened once, and the hint was heard once.
    expect(hintsFor(bob, sent.id)).toHaveLength(1)
    expect(await db().select().from(messages).where(eq(messages.id, sent.id))).toHaveLength(1)
    expect(
      await db()
        .select()
        .from(conversationChanges)
        .where(
          and(
            eq(conversationChanges.conversationId, conversationId),
            eq(conversationChanges.changeSeq, sent.changeSeq),
          ),
        ),
    ).toHaveLength(1)

    // The client finds it, and well inside the 35 seconds of the foreground reconciliation.
    const seen = await converge(
      ApiClient.withCookie(second.baseUrl, bobApi.cookie),
      conversationId,
      sent.changeSeq - 1,
      sent.changeSeq,
    )
    expect(seen.map((m) => m.id)).toEqual([sent.id])
    expect(Date.now() - killedAt).toBeLessThan(35_000)
  }, 120_000)

  test('only the last hint is lost: the worker that was away delivers it, once, and repeats nothing earlier', async () => {
    const first = await api()
    const away = await worker()
    const { bobApi, aliceApi, conversationId } = await aliceAndBob(first)
    const bobBefore = connect(first.port, { cookie: bobApi.cookie })
    await bobBefore.next('hello')

    // Three changes, each heard as it happens.
    const earlier: Sent[] = []
    for (const text of ['one', 'two', 'three']) {
      const sent = await say(aliceApi, conversationId, text)
      earlier.push(sent)
      await hintFor(bobBefore, sent.id)
    }

    // The worker goes away (paused, as by a stalled host), and a fourth change commits. Then the API dies too.
    away.signal('SIGSTOP')
    const last = await say(aliceApi, conversationId, 'four, with nobody to carry it')
    expect(await itemOf(conversationId, last.changeSeq)).toMatchObject({ status: 'pending' })
    await first.stop()
    await bobBefore.closed

    // A new API, Bob back on it, and the worker returns.
    const second = await api()
    const bob = connect(second.port, { cookie: bobApi.cookie })
    await bob.next('hello')
    away.signal('SIGCONT')

    await hintFor(bob, last.id)
    await waitUntil(
      async () =>
        (await itemOf(conversationId, last.changeSeq))?.status === 'done' ? true : undefined,
      {
        what: 'the missing intent to be completed',
      },
    )
    expect(hintsFor(bob, last.id)).toHaveLength(1)
    for (const sent of earlier) expect(hintsFor(bob, sent.id)).toEqual([]) // delivered before, not again
    for (const sent of [...earlier, last]) {
      expect(await itemOf(conversationId, sent.changeSeq)).toMatchObject({
        status: 'done',
        deliverySeq: 1,
      })
    }
    const seen = await converge(
      ApiClient.withCookie(second.baseUrl, bobApi.cookie),
      conversationId,
      earlier[2]?.changeSeq ?? 0,
      last.changeSeq,
    )
    expect(seen.map((m) => m.id)).toEqual([last.id])
  }, 120_000)
})

describe('the queue is emptied after the commit', () => {
  test('a hint and a verification email, both still in Postgres, are delivered once by a worker that starts afterwards', async () => {
    const service = await api()
    const { bobApi, aliceApi, conversationId } = await aliceAndBob(service)
    const bob = connect(service.port, { cookie: bobApi.cookie })
    await bob.next('hello')
    const sent = await say(aliceApi, conversationId, 'in the queue when it was emptied')

    // A registration commits the intent of its verification email.
    const admin = await createActiveUser(deps(), { username: 'admin_a', role: 'admin' })
    const invite = await createInvite(deps(), await makePrincipal(deps(), admin), {})
    const address = `queue-${Date.now()}@example.test`
    await registerAccount(deps(), {
      email: address,
      username: `q${Date.now() % 100000}`,
      displayName: 'Queue Test',
      password: 'tomato-umbrella-47-lantern',
      inviteCode: invite.code,
      idempotencyKey: 'queue-test',
    })
    const emailIntent = async () =>
      (await db().select().from(workItems).where(eq(workItems.kind, 'email')))[0]
    expect(await emailIntent()).toMatchObject({ status: 'pending' })

    // Everything Valkey held is gone: the queues, the counters, the presence of the connected.
    const client = instance.valkey()
    try {
      await client.flushall()
      await client.set('chatapp:instance-marker', instance.manifest.markers.valkey)
    } finally {
      client.disconnect()
    }
    expect(await emailIntent()).toMatchObject({ status: 'pending' }) // Postgres did not notice

    await worker()
    await hintFor(bob, sent.id)
    await waitUntil(async () => ((await emailIntent())?.status === 'done' ? true : undefined), {
      what: 'the email intent to be completed',
    })
    const mails = async () => {
      if (!instance.mailpit) return undefined
      const found = (await (
        await fetch(
          `${instance.mailpit}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`,
        )
      ).json()) as { messages?: unknown[] }
      return found.messages?.length ?? 0
    }
    if (instance.mailpit) {
      expect(
        await waitUntil(async () => ((await mails()) ? await mails() : undefined), {
          what: 'the email in the mailbox',
        }),
      ).toBe(1)
      await Bun.sleep(1_500) // and no second one follows
      expect(await mails()).toBe(1)
    }
    expect(hintsFor(bob, sent.id)).toHaveLength(1)
    expect(await itemOf(conversationId, sent.changeSeq)).toMatchObject({
      status: 'done',
      deliverySeq: 1,
    })
    expect((await emailIntent())?.deliverySeq).toBe(1)
  }, 120_000)
})
