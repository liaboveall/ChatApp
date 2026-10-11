/**
 * Browser push against the real database (docs/01 section 4.8, docs/03 section 7, SEC-23, D-065, AT-11, AT-22, M6):
 * subscribing and the rules for taking an endpoint over, the truth table through the whole pipeline (message written ->
 * derived -> pushed), and the re-check right before a push leaves. The push service is a fake that records what it was
 * asked to send; the real transport is covered in `runtime/push-transport.test.ts`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type {
  Conversation,
  MessageEnvelope,
  NotificationPage,
  PushSubscriptionInfo,
} from '@chatapp/contracts'
import { notifications, pushSubscriptions, sessions, users, workItems } from '@chatapp/db'
import { eq, sql } from 'drizzle-orm'
import type { PushOutcome } from '../../src/runtime/push.ts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createTestApp, type TestApp } from '../support/http.ts'
import {
  createConversation,
  errorCode,
  errorReason,
  openDm,
  type Person,
  person,
} from '../support/people.ts'
import { browserKeys, drainPush, endpointOf, type FakePush, fakePush } from '../support/push.ts'

let dbs: TestDatabases
let app: TestApp
let push: FakePush

beforeAll(() => {
  dbs = openTestDatabases()
})
afterAll(async () => {
  await truncateAll(dbs.owner)
  await dbs.close()
})
beforeEach(async () => {
  await truncateAll(dbs.owner)
  push = fakePush()
  app = await createTestApp(dbs, { deps: { push: push.service } })
})
afterEach(async () => {
  await app.close()
})

const installation = () => crypto.randomUUID()

async function subscribe(
  who: Person,
  options: {
    endpoint?: string
    installationId?: string
    keys?: { p256dh: string; auth: string }
    expectedUserId?: string
  } = {},
) {
  const keys = options.keys ?? browserKeys()
  const body = {
    endpoint: options.endpoint ?? endpointOf(),
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    installationId: options.installationId ?? installation(),
    ...(options.expectedUserId ? { expectedUserId: options.expectedUserId } : {}),
  }
  const reply = await who.post<{ subscription: PushSubscriptionInfo }>(
    '/api/push/subscriptions',
    body,
  )
  return { reply, body }
}

const say = (who: Person, conversationId: string, text: string, extra: object = {}) =>
  who.post<MessageEnvelope>(`/api/conversations/${conversationId}/messages`, {
    clientId: crypto.randomUUID(),
    body: text,
    ...extra,
  })

const setLevel = async (
  who: Person,
  conversation: Conversation,
  notifyLevel: 'all' | 'mentions' | 'none',
) => {
  const current = await who.get<Conversation>(`/api/conversations/${conversation.id}`)
  const reply = await who.patch(`/api/conversations/${conversation.id}/me`, {
    expectedViewerVersion: current.body.me?.version,
    notifyLevel,
  })
  expect(reply.status).toBe(200)
}

const subscriptionRows = () => dbs.owner.db.select().from(pushSubscriptions)

/** alice (sender), bob (recipient, subscribed) and carol in one group. */
async function groupWithSubscribedBob(options: { level?: 'all' | 'mentions' | 'none' } = {}) {
  const alice = await person(app, 'alice')
  const bob = await person(app, 'bobby')
  const carol = await person(app, 'carol')
  const group = await createConversation(alice, {
    kind: 'group',
    name: 'The Crew',
    memberIds: [bob.id, carol.id],
  })
  const { reply, body } = await subscribe(bob)
  expect(reply.status).toBe(201)
  if (options.level) await setLevel(bob, group, options.level)
  push.reset()
  return { alice, bob, carol, group, subscription: reply.body.subscription, body }
}

describe('subscribing (docs/05 section 3.7)', () => {
  test('a worker registration with a revoked cookie has no cookie effects on a later login', async () => {
    const bob = await person(app, 'bobby')
    const keys = browserKeys()
    await dbs.owner.db.delete(sessions).where(eq(sessions.userId, bob.id))
    const response = await bob.post('/api/push/subscriptions', {
      endpoint: endpointOf(),
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      installationId: installation(),
      expectedUserId: bob.id,
    })
    expect(response.status).toBe(401)
    expect(response.headers.getSetCookie()).toEqual([])
  })

  test('an asynchronous registration cannot rebind through the next account cookie', async () => {
    const bob = await person(app, 'bobby')
    const erin = await person(app, 'erin')
    const first = await subscribe(bob, { expectedUserId: bob.id })
    expect(first.reply.status).toBe(201)
    const late = await subscribe(erin, {
      endpoint: first.body.endpoint,
      installationId: first.body.installationId,
      expectedUserId: bob.id,
    })
    expect(late.reply.status).toBe(403)
    expect(errorCode(late.reply)).toBe('FORBIDDEN')
    const rows = await dbs.owner.db
      .select({ userId: pushSubscriptions.userId })
      .from(pushSubscriptions)
    expect(rows).toEqual([{ userId: bob.id }])
  })

  test('a browser subscribes, a repeat refreshes it, the list marks the current installation', async () => {
    const bob = await person(app, 'bobby')
    const installationId = installation()
    const first = await subscribe(bob, { installationId })
    expect(first.reply.status).toBe(201)
    const again = await subscribe(bob, { installationId, endpoint: first.body.endpoint })
    expect(again.reply.status).toBe(200)
    expect(again.reply.body.subscription.id).toBe(first.reply.body.subscription.id)
    expect(await subscriptionRows()).toHaveLength(1)

    const list = await bob.get<{ subscriptions: PushSubscriptionInfo[] }>(
      `/api/push/subscriptions?installationId=${installationId}`,
    )
    expect(list.body.subscriptions).toHaveLength(1)
    expect(list.body.subscriptions[0]?.current).toBe(true)
    const other = await bob.get<{ subscriptions: PushSubscriptionInfo[] }>(
      `/api/push/subscriptions?installationId=${installation()}`,
    )
    expect(other.body.subscriptions[0]?.current).toBe(false)
    // The list never carries the endpoint or the keys.
    expect(JSON.stringify(list.body)).not.toContain('fcm.googleapis.com')
    expect(JSON.stringify(list.body)).not.toContain(first.body.keys.auth)
  })

  test('the application server key is served to signed-in members only', async () => {
    const bob = await person(app, 'bobby')
    const reply = await bob.get<{ publicKey: string }>('/api/push/vapid-key')
    expect(reply.status).toBe(200)
    expect(reply.body.publicKey).toBe(push.service.vapidPublicKey)
    const anonymous = await app.request('/api/push/vapid-key')
    expect(anonymous.status).toBe(401)
  })

  test('without keys on the server nothing can be subscribed and nothing breaks', async () => {
    const bare = await createTestApp(dbs)
    try {
      const bob = await person(bare, 'bobby')
      expect((await bob.get('/api/push/vapid-key')).status).toBe(503)
      const keys = browserKeys()
      const reply = await bob.post('/api/push/subscriptions', {
        endpoint: endpointOf(),
        keys: { p256dh: keys.p256dh, auth: keys.auth },
        installationId: installation(),
      })
      expect(reply.status).toBe(503)
      expect(errorCode(reply)).toBe('CAPACITY_UNAVAILABLE')
      // The centre is not push: it answers as usual.
      const list = await bob.get<NotificationPage>('/api/notifications')
      expect(list.status).toBe(200)
      expect(list.body).toEqual({ items: [], nextCursor: null, unreadCount: 0 })
    } finally {
      await bare.close()
    }
  })

  test('only HTTPS addresses of known push services are accepted (SEC-23)', async () => {
    const bob = await person(app, 'bobby')
    const refused: Array<[string, string]> = [
      ['http://fcm.googleapis.com/fcm/send/x', 'not_https'],
      ['https://127.0.0.1/x', 'ip_literal'],
      ['https://[::1]/x', 'ip_literal'],
      ['https://fcm.googleapis.com:8443/fcm/send/x', 'port'],
      ['https://user:pass@fcm.googleapis.com/fcm/send/x', 'credentials'],
      ['https://fcm.googleapis.com.evil.example/fcm/send/x', 'host_not_allowed'],
      ['https://evilfcm.googleapis.com/fcm/send/x', 'host_not_allowed'],
      ['https://notify.windows.com/x', 'host_not_allowed'],
      ['https://metadata.google.internal/x', 'host_not_allowed'],
      ['https://fcm.googleapis.com/fcm/send/x#frag', 'fragment'],
      ['not a url', 'not_a_url'],
      [`https://fcm.googleapis.com/${'a'.repeat(2100)}`, 'too_long'],
    ]
    for (const [endpoint, reason] of refused) {
      const { reply } = await subscribe(bob, { endpoint })
      // Over-long input is stopped by the schema, everything else by the policy.
      expect([422]).toContain(reply.status)
      if (reason !== 'too_long') expect(errorReason(reply)).toBe(reason)
    }
    for (const accepted of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://web.push.apple.com/abc',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
    ]) {
      expect((await subscribe(bob, { endpoint: accepted })).reply.status).toBe(201)
    }
    expect(await subscriptionRows()).toHaveLength(4)
  })

  test('a name that resolves into the private network is refused, as is one that does not resolve', async () => {
    const bob = await person(app, 'bobby')
    push.resolve(() => [
      { address: '142.250.80.74', family: 4 },
      { address: '10.0.0.8', family: 4 },
    ])
    const mixed = await subscribe(bob)
    expect(mixed.reply.status).toBe(422)
    expect(errorReason(mixed.reply)).toBe('non_public_address')
    push.resolve(() => [{ address: '::ffff:127.0.0.1', family: 6 }])
    expect(errorReason((await subscribe(bob)).reply)).toBe('non_public_address')
    push.resolve(() => [])
    expect(errorReason((await subscribe(bob)).reply)).toBe('dns_failed')
    expect(await subscriptionRows()).toHaveLength(0)
  })

  test('keys that are not a point on the P-256 curve are refused', async () => {
    const bob = await person(app, 'bobby')
    const good = browserKeys()
    const offCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url')
    const compressed = Buffer.concat([Buffer.from([2]), Buffer.alloc(64, 9)]).toString('base64url')
    for (const p256dh of [offCurve, compressed]) {
      const { reply } = await subscribe(bob, { keys: { p256dh, auth: good.auth } })
      expect(reply.status).toBe(422)
    }
    // Wrong lengths are stopped by the request schema before they get that far.
    expect(
      (await subscribe(bob, { keys: { p256dh: good.p256dh, auth: 'AAAA' } })).reply.status,
    ).toBe(422)
    expect((await subscribe(bob, { keys: { p256dh: 'AAAA', auth: good.auth } })).reply.status).toBe(
      422,
    )
    expect(await subscriptionRows()).toHaveLength(0)
    expect((await subscribe(bob, { keys: good })).reply.status).toBe(201)
  })

  test('at most ten browsers per person', async () => {
    const bob = await person(app, 'bobby')
    for (let i = 0; i < 10; i += 1) expect((await subscribe(bob)).reply.status).toBe(201)
    const eleventh = await subscribe(bob)
    expect(eleventh.reply.status).toBe(403)
    expect(errorCode(eleventh.reply)).toBe('QUOTA_EXCEEDED')
  })

  test("removing: your own works, somebody else's and unknown ones are the same not-found", async () => {
    const bob = await person(app, 'bobby')
    const carol = await person(app, 'carol')
    const mine = await subscribe(bob)
    const theirs = await subscribe(carol)
    const stranger = await bob.del(`/api/push/subscriptions/${theirs.reply.body.subscription.id}`)
    const missing = await bob.del(`/api/push/subscriptions/${crypto.randomUUID()}`)
    expect(stranger.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(stranger.body).toEqual(expect.objectContaining({ error: expect.anything() }))
    expect(
      (await bob.del(`/api/push/subscriptions/${mine.reply.body.subscription.id}`)).status,
    ).toBe(200)
    expect(await subscriptionRows()).toHaveLength(1)
  })

  test('an endpoint passes to another account only with the installation that holds it (D-065)', async () => {
    const bob = await person(app, 'bobby')
    const carol = await person(app, 'carol')
    const endpoint = endpointOf('shared')
    const device = installation()
    const first = await subscribe(bob, { endpoint, installationId: device })
    expect(first.reply.status).toBe(201)

    // Carol knows the address but not the installation: refused, and Bob keeps it.
    const takeover = await subscribe(carol, { endpoint, installationId: installation() })
    expect(takeover.reply.status).toBe(409)
    expect(errorReason(takeover.reply)).toBe('endpoint_in_use')
    expect((await subscriptionRows())[0]?.userId).toBe(bob.id)

    // The same browser, signed in as Carol now: allowed, and the binding moves on.
    const before = (await subscriptionRows())[0]?.bindingVersion ?? 0
    const moved = await subscribe(carol, { endpoint, installationId: device })
    expect(moved.reply.status).toBe(200)
    const rows = await subscriptionRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.userId).toBe(carol.id)
    expect(rows[0]?.bindingVersion).toBe(before + 1)
  })

  test('signing out takes the subscription with the session', async () => {
    const bob = await person(app, 'bobby')
    await subscribe(bob)
    expect(await subscriptionRows()).toHaveLength(1)
    const out = await app.request('/api/auth/sign-out', { method: 'POST', jar: bob.jar, json: {} })
    expect(out.status).toBe(200)
    expect(await subscriptionRows()).toHaveLength(0)
  })

  test('a second sign-in keeps its own subscription when the first one ends', async () => {
    const bob = await person(app, 'bobby')
    const second = app.newJar()
    const login = await app.request('/api/auth/sign-in/email', {
      json: { email: bob.email, password: bob.password },
      jar: second,
    })
    expect(login.status).toBe(200)
    await subscribe(bob)
    const own = await app.request('/api/push/subscriptions', {
      method: 'POST',
      jar: second,
      json: {
        endpoint: endpointOf('b'),
        keys: (({ p256dh, auth }) => ({ p256dh, auth }))(browserKeys()),
        installationId: installation(),
      },
    })
    expect(own.status).toBe(201)
    expect(await subscriptionRows()).toHaveLength(2)
    await app.request('/api/auth/sign-out', { method: 'POST', jar: second, json: {} })
    const left = await subscriptionRows()
    expect(left).toHaveLength(1)
    const session = (
      await dbs.owner.db
        .select()
        .from(sessions)
        .where(eq(sessions.id, left[0]?.sessionId ?? ''))
    )[0]
    expect(session?.userId).toBe(bob.id)
  })
})

describe('what is pushed, through the whole pipeline (AT-22)', () => {
  test("the default push says only that there is news, in the reader's language", async () => {
    const { alice, group } = await groupWithSubscribedBob({ level: 'all' })
    await say(alice, group.id, 'the launch code is 1234')
    expect(await drainPush(app.services.deps)).toBeGreaterThan(0)
    expect(push.sent).toHaveLength(1)
    const payload = push.payloads()[0]
    expect(payload?.kind).toBe('message')
    expect(payload?.body).toBe('你有新消息')
    expect(payload?.title).toBe('ChatApp')
    expect(JSON.stringify(push.sent[0]?.message)).not.toContain('1234')
    expect(JSON.stringify(push.sent[0]?.message)).not.toContain('The Crew')
    expect(JSON.stringify(push.sent[0]?.message)).not.toContain('alice')
    expect(payload?.url).toBe(`/c/${group.id}`)
    expect(payload?.tag).toBe(`c-${group.id}`)
  })

  test('with the preview on it shows up to 80 characters, with the conversation and the sender', async () => {
    const { alice, bob, group } = await groupWithSubscribedBob({ level: 'all' })
    const me = await bob.get<{ meVersion: number }>('/api/me')
    expect(
      (
        await bob.patch('/api/me', {
          expectedMeVersion: me.body.meVersion,
          settings: { pushPreview: true },
        })
      ).status,
    ).toBe(200)
    await say(alice, group.id, `**${'x'.repeat(100)}**`)
    await drainPush(app.services.deps)
    const payload = push.payloads()[0]
    expect(payload?.title).toBe('The Crew')
    expect(payload?.body.startsWith('alice: ')).toBe(true)
    expect([...(payload?.body ?? '')].length).toBe('alice: '.length + 80)
  })

  test('levels: all pushes everything, mentions only what names or answers me, none nothing', async () => {
    const { alice, bob, group } = await groupWithSubscribedBob()
    // The default for a group is "mentions".
    await say(alice, group.id, 'just talking')
    await drainPush(app.services.deps)
    expect(push.sent).toHaveLength(0)

    await say(alice, group.id, `hello <@user:${bob.id}>`)
    await drainPush(app.services.deps)
    expect(push.payloads().map((p) => p.kind)).toEqual(['mention'])
    push.reset()

    await setLevel(bob, group, 'all')
    await say(alice, group.id, 'now everything counts')
    await drainPush(app.services.deps)
    expect(push.payloads().map((p) => p.kind)).toEqual(['message'])
    push.reset()

    await setLevel(bob, group, 'none')
    await say(alice, group.id, `again <@user:${bob.id}>`)
    await say(alice, group.id, 'and plain')
    await drainPush(app.services.deps)
    expect(push.sent).toHaveLength(0)
    // The centre still keeps what names him, whatever the level (docs/01 section 4.8).
    const kept = await dbs.owner.db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, bob.id))
    expect(kept.map((n) => n.type).sort()).toEqual(['mention', 'mention'])
  })

  test('a reply to my message pushes at "mentions", and a mention wins over a reply', async () => {
    const { alice, bob, group } = await groupWithSubscribedBob()
    const mine = await say(bob, group.id, 'my question')
    push.reset()
    await say(alice, group.id, 'my answer', { replyToId: mine.body.message.id })
    await drainPush(app.services.deps)
    expect(push.payloads().map((p) => p.kind)).toEqual(['reply'])
    const entries = await dbs.owner.db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, bob.id))
    expect(entries.map((n) => n.type)).toEqual(['reply'])
    push.reset()
    await say(alice, group.id, `and <@user:${bob.id}>`, { replyToId: mine.body.message.id })
    await drainPush(app.services.deps)
    expect(push.payloads().map((p) => p.kind)).toEqual(['mention'])
    expect(
      (await dbs.owner.db.select().from(notifications).where(eq(notifications.userId, bob.id)))
        .map((n) => n.type)
        .sort(),
    ).toEqual(['mention', 'reply'])
  })

  test('direct messages default to "all"; the sender never gets their own', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bobby')
    await subscribe(alice)
    await subscribe(bob)
    const dm = await openDm(alice, bob)
    push.reset()
    await say(alice, dm.id, 'hi bob')
    await drainPush(app.services.deps)
    expect(push.sent).toHaveLength(1)
    const subs = await subscriptionRows()
    const bobs = subs.find((row) => row.userId === bob.id)
    expect(push.sent[0]?.target.endpoint).toBe(bobs?.endpoint ?? '')
    // A direct message makes no entry in the centre unless it names or answers somebody.
    expect(await dbs.owner.db.select().from(notifications)).toHaveLength(0)
  })

  test('a mute holds back pushes until it ends; a lapsed one counts for nothing', async () => {
    const { alice, bob, group } = await groupWithSubscribedBob({ level: 'all' })
    const current = await bob.get<Conversation>(`/api/conversations/${group.id}`)
    const until = new Date(app.clock.now().getTime() + 3_600_000).toISOString()
    const muted = await bob.patch(`/api/conversations/${group.id}/me`, {
      expectedViewerVersion: current.body.me?.version,
      mute: { mode: 'until', until },
    })
    expect(muted.status).toBe(200)
    await say(alice, group.id, 'quiet please')
    await drainPush(app.services.deps)
    expect(push.sent).toHaveLength(0)

    app.clock.advance(2 * 3_600_000)
    await say(alice, group.id, 'loud again')
    await drainPush(app.services.deps)
    expect(push.sent).toHaveLength(1)
  })

  test('the account switches: all push off, and the preview', async () => {
    const { alice, bob, group } = await groupWithSubscribedBob({ level: 'all' })
    const me = await bob.get<{ meVersion: number }>('/api/me')
    expect(
      (
        await bob.patch('/api/me', {
          expectedMeVersion: me.body.meVersion,
          settings: { pushEnabled: false },
        })
      ).status,
    ).toBe(200)
    await say(alice, group.id, `hello <@user:${bob.id}>`)
    await drainPush(app.services.deps)
    expect(push.sent).toHaveLength(0)
    // The centre is not push: the mention is there.
    expect(await dbs.owner.db.select().from(notifications)).toHaveLength(1)
  })

  test('system lines, the assistant and edits push nothing', async () => {
    const { alice, bob, group } = await groupWithSubscribedBob({ level: 'all' })
    const sent = await say(alice, group.id, 'first')
    await drainPush(app.services.deps)
    push.reset()
    const edited = await alice.patch(`/api/messages/${sent.body.message.id}`, {
      body: `edit mentions <@user:${bob.id}>`,
      expectedChangeSeq: sent.body.message.changeSeq,
    })
    expect(edited.status).toBe(200)
    await alice.post(`/api/conversations/${group.id}/members`, {
      userIds: [(await person(app, 'dave')).id],
    })
    await drainPush(app.services.deps)
    expect(push.sent).toHaveLength(0)
  })

  test('the app badge count in the payload is what is unread in conversations that are not muted', async () => {
    const { alice, group } = await groupWithSubscribedBob({ level: 'all' })
    await say(alice, group.id, 'one')
    await say(alice, group.id, 'two')
    await say(alice, group.id, 'three')
    await drainPush(app.services.deps)
    expect(push.payloads().map((p) => p.unread)).toEqual([3, 3, 3])
  })
})

describe('checked again right before it leaves (AT-11)', () => {
  /** Writes the message and runs only the deriving, so the push task is waiting with everything still valid. */
  async function queued(text = 'hello') {
    const world = await groupWithSubscribedBob({ level: 'all' })
    const sent = await say(world.alice, world.group.id, text)
    await drainPush(app.services.deps, { rounds: 1 })
    const waiting = (await dbs.owner.db.select().from(workItems)).filter(
      (w) => w.payload.stage === 'deliver' && w.status === 'pending',
    )
    expect(waiting).toHaveLength(1)
    expect(push.sent).toHaveLength(0)
    return { ...world, messageId: sent.body.message.id }
  }

  test('with nothing changed, the waiting push goes out', async () => {
    await queued()
    await drainPush(app.services.deps)
    expect(push.sent).toHaveLength(1)
  })

  test('a person who left before the task ran is told nothing', async () => {
    const { bob, group } = await queued('a secret for members')
    expect((await bob.post(`/api/conversations/${group.id}/leave`, {})).status).toBe(200)
    await drainPush(app.services.deps)
    expect(push.sent).toHaveLength(0)
  })

  test('a person taken out of the conversation is told nothing, and the centre shows nothing of it either', async () => {
    const { alice, bob, group } = await groupWithSubscribedBob({ level: 'all' })
    await say(alice, group.id, `private to <@user:${bob.id}>`)
    await drainPush(app.services.deps, { rounds: 1 })
    expect(await dbs.owner.db.select().from(notifications)).toHaveLength(1)
    expect((await alice.del(`/api/conversations/${group.id}/members/${bob.id}`)).status).toBe(200)
    await drainPush(app.services.deps)
    expect(push.sent).toHaveLength(0)
    const list = await bob.get<{ items: Array<{ data: { available: boolean } }> }>(
      '/api/notifications',
    )
    expect(list.body.items).toHaveLength(1)
    expect(list.body.items[0]?.data).toEqual({ available: false })
  })

  test('a message withdrawn before the task ran is not pushed', async () => {
    const { alice, messageId } = await queued('oops')
    expect((await alice.post(`/api/messages/${messageId}/recall`)).status).toBe(200)
    await drainPush(app.services.deps)
    expect(push.sent).toHaveLength(0)
  })

  test('a message the person hid for themselves is still a message they were told about', async () => {
    // Hiding is a view preference, not a withdrawal: the push is not a leak of anything they could not see.
    const { bob, messageId } = await queued('fine')
    expect((await bob.post(`/api/messages/${messageId}/hide`, {})).status).toBe(200)
    await drainPush(app.services.deps)
    expect(push.sent).toHaveLength(1)
  })

  test('a person whose boundary moved past the message (left and came back) is told nothing', async () => {
    const { alice, bob, group } = await queued('before the return')
    expect((await bob.post(`/api/conversations/${group.id}/leave`, {})).status).toBe(200)
    expect(
      (await alice.post(`/api/conversations/${group.id}/members`, { userIds: [bob.id] })).status,
    ).toBe(200)
    await drainPush(app.services.deps)
    expect(push.sent).toHaveLength(0)
  })

  test('a subscription whose sign-in ended sends nothing and is removed', async () => {
    const { bob } = await queued('hello')
    // The session disappears between the message and the delivery (sign-out elsewhere, expiry, revocation).
    await dbs.owner.db.delete(sessions).where(eq(sessions.userId, bob.id))
    await drainPush(app.services.deps)
    expect(push.sent).toHaveLength(0)
    expect(await subscriptionRows()).toHaveLength(0)
  })

  test('an expired session sends nothing and is removed', async () => {
    const { bob } = await queued('hello')
    await dbs.owner.db
      .update(sessions)
      .set({ expiresAt: new Date(app.clock.now().getTime() - 1000) })
      .where(eq(sessions.userId, bob.id))
    await drainPush(app.services.deps)
    expect(push.sent).toHaveLength(0)
    expect(await subscriptionRows()).toHaveLength(0)
  })

  test('a banned account, and one whose password changed (new epoch), send nothing', async () => {
    const { bob } = await queued('hello')
    await dbs.owner.db.update(users).set({ banned: true }).where(eq(users.id, bob.id))
    await drainPush(app.services.deps)
    expect(push.sent).toHaveLength(0)
    expect(await subscriptionRows()).toHaveLength(0)
  })

  test('a security sign-out everywhere (the epoch moves) sends nothing', async () => {
    const { bob } = await queued('hello')
    await dbs.owner.db
      .update(users)
      .set({ authEpoch: sql`${users.authEpoch} + 1` })
      .where(eq(users.id, bob.id))
    await drainPush(app.services.deps)
    expect(push.sent).toHaveLength(0)
  })

  test('a deleted account sends nothing', async () => {
    const { bob } = await queued('hello')
    await dbs.owner.db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, bob.id))
    await drainPush(app.services.deps)
    expect(push.sent).toHaveLength(0)
  })

  test('a task made for an earlier binding of the endpoint does nothing', async () => {
    const { bob } = await queued('for the old binding')
    const before = (await subscriptionRows())[0]
    expect(before?.userId).toBe(bob.id)
    // The same browser is now signed in as somebody else: the binding moves on and the old task no longer applies.
    const erin = await person(app, 'erin')
    const moved = await subscribe(erin, {
      endpoint: before?.endpoint,
      installationId: before?.installationId,
    })
    expect(moved.reply.status).toBe(200)
    await drainPush(app.services.deps)
    expect(push.sent).toHaveLength(0)
  })

  test('a subscription removed in the meantime sends nothing', async () => {
    const { bob, subscription } = await queued('hello')
    expect((await bob.del(`/api/push/subscriptions/${subscription.id}`)).status).toBe(200)
    await drainPush(app.services.deps)
    expect(push.sent).toHaveLength(0)
  })

  test('preferences changed in the meantime are honoured: level, mute, account switch', async () => {
    const world = await queued('hello')
    await setLevel(world.bob, world.group, 'none')
    await drainPush(app.services.deps)
    expect(push.sent).toHaveLength(0)
  })

  test('a person looking at that conversation right now is not pushed to', async () => {
    const { alice, bob, group } = await groupWithSubscribedBob({ level: 'all' })
    await say(alice, group.id, 'you are here')
    await drainPush(app.services.deps, {
      viewing: async (userId, conversationId) => userId === bob.id && conversationId === group.id,
    })
    expect(push.sent).toHaveLength(0)
    await say(alice, group.id, 'and now you are elsewhere')
    await drainPush(app.services.deps, { viewing: async () => false })
    expect(push.sent).toHaveLength(1)
  })

  test('one task per message and subscription: the keys never repeat', async () => {
    const { alice, group } = await groupWithSubscribedBob({ level: 'all' })
    await say(alice, group.id, 'once')
    await drainPush(app.services.deps)
    expect(push.sent).toHaveLength(1)
    const keys = (await dbs.owner.db.select().from(workItems)).map((w) => w.dedupeKey)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('what the push service answers', () => {
  const handedOver: Array<{ name: string; outcome: PushOutcome; failures: number }> = [
    { name: 'delivered', outcome: { kind: 'delivered', status: 201 }, failures: 0 },
    { name: 'gone', outcome: { kind: 'gone', reason: 'http_410', status: 410 }, failures: 0 },
    {
      name: 'rejected',
      outcome: { kind: 'rejected', reason: 'http_403', status: 403 },
      failures: 0,
    },
    {
      name: 'fifth rejection',
      outcome: { kind: 'rejected', reason: 'http_403', status: 403 },
      failures: 4,
    },
  ]
  for (const { name, outcome, failures } of handedOver) {
    test(`a late ${name} answer for the previous binding never updates or removes the new account's subscription`, async () => {
      const { alice, group, subscription, body } = await groupWithSubscribedBob({ level: 'all' })
      const next = await person(app, 'erin')
      await dbs.owner.db.update(pushSubscriptions).set({ failureCount: failures })
      push.respond(async () => {
        const rebound = await subscribe(next, {
          endpoint: body.endpoint,
          installationId: body.installationId,
        })
        expect(rebound.reply.status).toBe(200)
        return outcome
      })
      await say(alice, group.id, 'already in flight before handover')
      await drainPush(app.services.deps)
      expect(push.sent).toHaveLength(1)
      const rows = (await subscriptionRows()).map(
        ({ id, userId, failureCount, lastSuccessAt }) => ({
          id,
          userId,
          failureCount,
          lastSuccessAt,
        }),
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        id: subscription.id,
        userId: next.id,
        failureCount: 0,
        lastSuccessAt: null,
      })
    })
  }

  test('gone (404/410): the subscription is removed', async () => {
    const { alice, group } = await groupWithSubscribedBob({ level: 'all' })
    push.respond(() => ({ kind: 'gone', reason: 'http_410', status: 410 }))
    await say(alice, group.id, 'to nobody')
    await drainPush(app.services.deps)
    expect(await subscriptionRows()).toHaveLength(0)
  })

  test('delivered: the success is recorded and the failures reset', async () => {
    const { alice, group } = await groupWithSubscribedBob({ level: 'all' })
    await dbs.owner.db.update(pushSubscriptions).set({ failureCount: 3 })
    await say(alice, group.id, 'ok')
    await drainPush(app.services.deps)
    const row = (await subscriptionRows())[0]
    expect(row?.failureCount).toBe(0)
    expect(row?.lastSuccessAt).not.toBeNull()
  })

  test('refused for good five times in a row: the subscription is dropped', async () => {
    const { alice, group } = await groupWithSubscribedBob({ level: 'all' })
    push.respond(() => ({ kind: 'rejected', reason: 'http_403', status: 403 }))
    for (let i = 1; i <= 4; i += 1) {
      await say(alice, group.id, `try ${i}`)
      await drainPush(app.services.deps)
      expect(await subscriptionRows()).toHaveLength(1)
      expect((await subscriptionRows())[0]?.failureCount).toBe(i)
    }
    await say(alice, group.id, 'try 5')
    await drainPush(app.services.deps)
    expect(await subscriptionRows()).toHaveLength(0)
  })

  test('rate limited or down: the task is tried again later, then given up on', async () => {
    const { alice, group } = await groupWithSubscribedBob({ level: 'all' })
    push.respond(() => ({ kind: 'retry', reason: 'http_429', retryAfterMs: 1000 }))
    await say(alice, group.id, 'later')
    await drainPush(app.services.deps)
    expect(push.sent).toHaveLength(1)
    const deliver = (await dbs.owner.db.select().from(workItems)).find(
      (w) => w.payload.stage === 'deliver',
    )
    expect(deliver?.status).toBe('retry')
    expect(deliver?.attempts).toBe(1)
    expect(deliver?.availableAt.getTime()).toBeGreaterThan(app.clock.now().getTime())
    // The subscription survives a service that is merely busy.
    expect(await subscriptionRows()).toHaveLength(1)

    push.respond(() => ({ kind: 'delivered', status: 201 }))
    app.clock.advance(10 * 60_000)
    await drainPush(app.services.deps)
    expect(push.sent).toHaveLength(2)
    expect(
      (await dbs.owner.db.select().from(workItems)).find((w) => w.payload.stage === 'deliver')
        ?.status,
    ).toBe('done')
  })
})

describe('the test push', () => {
  test('goes to this installation only, with a message that says so', async () => {
    const bob = await person(app, 'bobby')
    const device = installation()
    await subscribe(bob, { installationId: device })
    await subscribe(bob, { installationId: installation() })
    const queued = await bob.post<{ queued: boolean }>('/api/push/test', { installationId: device })
    expect(queued.body.queued).toBe(true)
    await drainPush(app.services.deps)
    expect(push.sent).toHaveLength(1)
    expect(push.payloads()[0]?.kind).toBe('test')
    const mine = (await subscriptionRows()).find((row) => row.installationId === device)
    expect(push.sent[0]?.target.endpoint).toBe(mine?.endpoint ?? '')
  })

  test('says nothing was queued for an installation that is not subscribed', async () => {
    const bob = await person(app, 'bobby')
    const queued = await bob.post<{ queued: boolean }>('/api/push/test', {
      installationId: installation(),
    })
    expect(queued.status).toBe(200)
    expect(queued.body.queued).toBe(false)
    await drainPush(app.services.deps)
    expect(push.sent).toHaveLength(0)
  })

  test('is limited to a handful a minute', async () => {
    const bob = await person(app, 'bobby')
    const device = installation()
    await subscribe(bob, { installationId: device })
    let limited = 0
    for (let i = 0; i < 8; i += 1) {
      if ((await bob.post('/api/push/test', { installationId: device })).status === 429)
        limited += 1
    }
    expect(limited).toBeGreaterThan(0)
  })
})
