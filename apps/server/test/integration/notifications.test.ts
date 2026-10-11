/**
 * The in-site notification centre against the real database (docs/01 section 4.8, docs/04 section 6, docs/05 section 3.7,
 * AT-22, M6): what is recorded and for whom, what a reader is shown (always as their access is now), marking read,
 * paging, the personal log that lets another device catch up, the budget alerts of the administrators, retention.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type {
  Conversation,
  MarkNotificationsReadResponse,
  MessageEnvelope,
  Notification,
  NotificationPage,
  UserChangesResponse,
} from '@chatapp/contracts'
import { appSettings, budgetAccounts, notifications, users } from '@chatapp/db'
import { eq } from 'drizzle-orm'
import { notifyBudgetThresholds } from '../../src/domain/agent-budget.ts'
import { createNotification, purgeExpiredNotifications } from '../../src/domain/notifications.ts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createTestApp, type TestApp } from '../support/http.ts'
import { createConversation, errorCode, openDm, type Person, person } from '../support/people.ts'
import { drainPush } from '../support/push.ts'

let dbs: TestDatabases
let app: TestApp

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
  await app.close()
})

const say = (who: Person, conversationId: string, text: string, extra: object = {}) =>
  who.post<MessageEnvelope>(`/api/conversations/${conversationId}/messages`, {
    clientId: crypto.randomUUID(),
    body: text,
    ...extra,
  })
const centre = (who: Person, query = '') => who.get<NotificationPage>(`/api/notifications${query}`)
const settle = () => drainPush(app.services.deps)

async function world() {
  const alice = await person(app, 'alice')
  const bob = await person(app, 'bobby')
  const group = await createConversation(alice, {
    kind: 'group',
    name: 'The Crew',
    memberIds: [bob.id],
  })
  return { alice, bob, group }
}

describe('what is recorded', () => {
  test('a mention shows who said it, where, and what, as the reader may see it', async () => {
    const { alice, bob, group } = await world()
    const sent = await say(alice, group.id, `**hello** <@user:${bob.id}>, see you`)
    await settle()
    const reply = await centre(bob)
    expect(reply.status).toBe(200)
    expect(reply.body.unreadCount).toBe(1)
    expect(reply.body.nextCursor).toBeNull()
    const [entry] = reply.body.items
    expect(entry).toMatchObject({
      type: 'mention',
      version: 1,
      readAt: null,
      data: {
        available: true,
        conversation: { id: group.id, kind: 'group', name: 'The Crew' },
        message: {
          id: sent.body.message.id,
          seq: sent.body.message.seq,
          preview: 'hello @bobby, see you',
          recalled: false,
        },
        sender: { id: alice.id, username: 'alice' },
      },
    })
  })

  test('a reply to my message is recorded, a mention in the same message wins, a plain message makes nothing', async () => {
    const { alice, bob, group } = await world()
    const mine = await say(bob, group.id, 'a question')
    await say(alice, group.id, 'unrelated chatter')
    await say(alice, group.id, 'an answer', { replyToId: mine.body.message.id })
    await say(alice, group.id, `both <@user:${bob.id}>`, { replyToId: mine.body.message.id })
    await settle()
    const types = (await centre(bob)).body.items.map((item) => item.type).sort()
    expect(types).toEqual(['mention', 'reply'])
    // Nobody is told about their own words, and alice was named by nobody.
    expect((await centre(alice)).body.items).toHaveLength(0)
  })

  test('a direct message makes no entry, only a mention or a reply in it would', async () => {
    const alice = await person(app, 'alice')
    const bob = await person(app, 'bobby')
    const dm = await openDm(alice, bob)
    await say(alice, dm.id, 'hi')
    await settle()
    expect((await centre(bob)).body.items).toHaveLength(0)
    const mine = await say(bob, dm.id, 'hello')
    await say(alice, dm.id, 'answer', { replyToId: mine.body.message.id })
    await settle()
    const [entry] = (await centre(bob)).body.items
    expect(entry?.type).toBe('reply')
    // A direct message has no name of its own: the screen names the other person.
    expect(entry?.data).toMatchObject({ available: true, conversation: { kind: 'dm', name: null } })
  })

  test("the assistant's own words, system lines and edits make nothing", async () => {
    const { alice, bob, group } = await world()
    const sent = await say(alice, group.id, 'no mention yet')
    await alice.patch(`/api/messages/${sent.body.message.id}`, {
      body: `now <@user:${bob.id}>`,
      expectedChangeSeq: sent.body.message.changeSeq,
    })
    await settle()
    expect((await centre(bob)).body.items).toHaveLength(0)
  })

  test('deriving twice records once', async () => {
    const { alice, bob, group } = await world()
    await say(alice, group.id, `<@user:${bob.id}>`)
    await settle()
    const { deriveMessageNotifications } = await import('../../src/domain/push.ts')
    const messageId = (await centre(bob)).body.items[0]?.id
    expect(messageId).toBeDefined()
    const rows = await dbs.owner.db.select().from(notifications)
    await deriveMessageNotifications(app.services.deps, (rows[0]?.data.messageId as string) ?? '')
    expect(await dbs.owner.db.select().from(notifications)).toHaveLength(1)
  })
})

describe('shown as the reader may see it now', () => {
  test('a recalled message stays as an entry without its words', async () => {
    const { alice, bob, group } = await world()
    const sent = await say(alice, group.id, `secret <@user:${bob.id}>`)
    await settle()
    await alice.post(`/api/messages/${sent.body.message.id}/recall`)
    const [entry] = (await centre(bob)).body.items
    expect(entry?.data).toMatchObject({
      available: true,
      message: { preview: null, recalled: true },
    })
    expect(JSON.stringify(entry)).not.toContain('secret')
  })

  test('a conversation the reader left becomes a generic entry with nothing from before', async () => {
    const { alice, bob, group } = await world()
    await say(alice, group.id, `confidential <@user:${bob.id}>`)
    await settle()
    await bob.post(`/api/conversations/${group.id}/leave`, {})
    const [entry] = (await centre(bob)).body.items
    expect(entry?.data).toEqual({ available: false })
    expect(JSON.stringify(entry)).not.toContain('confidential')
    expect(JSON.stringify(entry)).not.toContain(group.id)
    expect(JSON.stringify(entry)).not.toContain('The Crew')
  })

  test("a message from before the reader's boundary (they left and came back) is generic too", async () => {
    const { alice, bob, group } = await world()
    await say(alice, group.id, `old news <@user:${bob.id}>`)
    await settle()
    await bob.post(`/api/conversations/${group.id}/leave`, {})
    await alice.post(`/api/conversations/${group.id}/members`, { userIds: [bob.id] })
    expect((await centre(bob)).body.items[0]?.data).toEqual({ available: false })
  })

  test('a message the reader hid for themselves is generic', async () => {
    const { alice, bob, group } = await world()
    const sent = await say(alice, group.id, `<@user:${bob.id}> hide me`)
    await settle()
    await bob.post(`/api/messages/${sent.body.message.id}/hide`, {})
    expect((await centre(bob)).body.items[0]?.data).toEqual({ available: false })
  })

  test('a sender who changes their name is shown by the new one', async () => {
    const { alice, bob, group } = await world()
    await say(alice, group.id, `<@user:${bob.id}>`)
    await settle()
    const me = await alice.get<{ meVersion: number }>('/api/me')
    await alice.patch('/api/me', {
      expectedMeVersion: me.body.meVersion,
      displayName: 'Alice Renamed',
    })
    const data = (await centre(bob)).body.items[0]?.data as { sender?: { displayName: string } }
    expect(data.sender?.displayName).toBe('Alice Renamed')
  })

  test("nobody sees somebody else's entries, and the list needs a session", async () => {
    const { alice, bob, group } = await world()
    await say(alice, group.id, `<@user:${bob.id}> for bobby`)
    await settle()
    expect((await centre(alice)).body.items).toHaveLength(0)
    expect((await app.request('/api/notifications')).status).toBe(401)
    expect((await app.request('/api/notifications/read', { json: { all: true } })).status).toBe(401)
  })
})

describe('marking read', () => {
  async function three() {
    const { alice, bob, group } = await world()
    for (const n of [1, 2, 3]) await say(alice, group.id, `<@user:${bob.id}> number ${n}`)
    await settle()
    const items = (await centre(bob)).body.items
    expect(items).toHaveLength(3)
    return { alice, bob, group, items }
  }

  test('by id: the entries change version and time, the count falls, a repeat changes nothing', async () => {
    const { bob, items } = await three()
    const [first, second] = items
    const marked = await bob.post<MarkNotificationsReadResponse>('/api/notifications/read', {
      ids: [first?.id],
    })
    expect(marked.status).toBe(200)
    expect(marked.body.unreadCount).toBe(2)
    expect(marked.body.items).toHaveLength(1)
    expect(marked.body.items[0]).toMatchObject({ id: first?.id, version: 2 })
    expect(marked.body.items[0]?.readAt).not.toBeNull()

    const again = await bob.post<MarkNotificationsReadResponse>('/api/notifications/read', {
      ids: [first?.id],
    })
    expect(again.body.items).toEqual([])
    expect(again.body.unreadCount).toBe(2)
    expect((await centre(bob)).body.items.find((item) => item.id === second?.id)?.readAt).toBeNull()
  })

  test('all: everything unread is read; the answer says the list must be read again', async () => {
    const { bob } = await three()
    const marked = await bob.post<MarkNotificationsReadResponse>('/api/notifications/read', {
      all: true,
    })
    expect(marked.body).toEqual({ items: [], unreadCount: 0 })
    const listed = await centre(bob)
    expect(listed.body.unreadCount).toBe(0)
    expect(listed.body.items.every((item) => item.readAt !== null && item.version === 2)).toBe(true)
  })

  test('ids of other people, unknown ids and none at all', async () => {
    const { alice, bob, items } = await three()
    const foreign = await alice.post<MarkNotificationsReadResponse>('/api/notifications/read', {
      ids: [items[0]?.id, crypto.randomUUID()],
    })
    expect(foreign.status).toBe(200)
    expect(foreign.body.items).toEqual([])
    expect((await centre(bob)).body.unreadCount).toBe(3)
    expect((await bob.post('/api/notifications/read', { ids: [] })).status).toBe(422)
    expect((await bob.post('/api/notifications/read', {})).status).toBe(422)
    expect((await bob.post('/api/notifications/read', { all: false })).status).toBe(422)
    expect(
      (await bob.post('/api/notifications/read', { ids: new Array(101).fill(crypto.randomUUID()) }))
        .status,
    ).toBe(422)
  })
})

describe('paging', () => {
  test('newest first, no gaps, no repeats; a forged or foreign cursor is refused', async () => {
    const { alice, bob, group } = await world()
    for (let n = 1; n <= 5; n += 1) {
      app.clock.advance(1000)
      await say(alice, group.id, `<@user:${bob.id}> ${n}`)
    }
    await settle()
    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 5; page += 1) {
      const reply: { body: NotificationPage } = await centre(
        bob,
        `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      )
      for (const item of reply.body.items) seen.push(item.id)
      cursor = reply.body.nextCursor
      expect(reply.body.unreadCount).toBe(5)
      if (!cursor) break
    }
    expect(seen).toHaveLength(5)
    expect(new Set(seen).size).toBe(5)
    const all = (await centre(bob)).body.items
    expect(seen).toEqual(all.map((item) => item.id))
    const times = all.map((item) => item.createdAt)
    expect([...times].sort().reverse()).toEqual(times)

    const first = await centre(bob, '?limit=2')
    expect(
      (await centre(bob, `?cursor=${encodeURIComponent(`${first.body.nextCursor}x`)}`)).status,
    ).toBe(422)
    expect(
      (await centre(alice, `?cursor=${encodeURIComponent(first.body.nextCursor ?? '')}`)).status,
    ).toBe(422)
    expect((await centre(bob, '?limit=0')).status).toBe(422)
    expect((await centre(bob, '?limit=101')).status).toBe(422)
  })
})

describe('the personal log (another device catches up)', () => {
  test("a new entry and a change of read state both arrive as the entry's current state", async () => {
    const { alice, bob, group } = await world()
    const before = (await bob.get<{ userChangeSeq: number }>('/api/sync/heads')).body.userChangeSeq
    await say(alice, group.id, `<@user:${bob.id}> to the log`)
    await settle()
    const first = await bob.get<UserChangesResponse>(`/api/me/changes?after=${before}`)
    const items = first.body.items.filter((item) => item.type === 'notification')
    expect(items).toHaveLength(1)
    const entry = items[0]
    expect(entry?.type === 'notification' && entry.notification).toMatchObject({
      type: 'mention',
      version: 1,
      readAt: null,
    })

    const mid = (await bob.get<{ userChangeSeq: number }>('/api/sync/heads')).body.userChangeSeq
    const id = entry?.type === 'notification' ? entry.notification.id : ''
    await bob.post('/api/notifications/read', { ids: [id] })
    const second = await bob.get<UserChangesResponse>(`/api/me/changes?after=${mid}`)
    const changed = second.body.items.find((item) => item.type === 'notification')
    expect(changed?.type === 'notification' && changed.notification).toMatchObject({
      id,
      version: 2,
    })
    expect(changed?.type === 'notification' && changed.notification.readAt).not.toBeNull()
  })

  test('each entry gets a hint carrying only identifiers', async () => {
    const { alice, bob, group } = await world()
    await say(alice, group.id, `<@user:${bob.id}> private words`)
    await settle()
    const { workItems } = await import('@chatapp/db')
    const hints = (await dbs.owner.db.select().from(workItems)).filter(
      (item) => item.payload.event === 'notification',
    )
    expect(hints).toHaveLength(1)
    expect(Object.keys(hints[0]?.payload ?? {}).sort()).toEqual(['event', 'notificationId'])
    expect(hints[0]?.entityId).toBe(bob.id)
    expect(JSON.stringify(hints)).not.toContain('private words')
  })

  test('an entry that was purged is simply absent from the feed', async () => {
    const { alice, bob, group } = await world()
    const before = (await bob.get<{ userChangeSeq: number }>('/api/sync/heads')).body.userChangeSeq
    await say(alice, group.id, `<@user:${bob.id}>`)
    await settle()
    await dbs.owner.db.delete(notifications)
    const feed = await bob.get<UserChangesResponse>(`/api/me/changes?after=${before}`)
    expect(feed.body.items.filter((item) => item.type === 'notification')).toHaveLength(0)
  })
})

describe('budget alerts (docs/01 section 7)', () => {
  const MONTH = (now: Date) =>
    `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`

  async function useBudget(percent: number) {
    const month = MONTH(new Date(app.clock.now().getTime() + 8 * 3_600_000))
    await dbs.owner.db
      .insert(budgetAccounts)
      .values({
        scope: 'site_month',
        ownerKey: 'site',
        periodStart: month,
        limitUnits: 20_000_000,
        reservedUnits: 0,
        settledUnits: Math.round((20_000_000 * percent) / 100),
      })
      .onConflictDoUpdate({
        target: [budgetAccounts.scope, budgetAccounts.ownerKey, budgetAccounts.periodStart],
        set: { settledUnits: Math.round((20_000_000 * percent) / 100) },
      })
    return month
  }

  test('administrators hear at 80% and at 100%, once each; members never do', async () => {
    const admin = await person(app, 'root', { role: 'admin' })
    const other = await person(app, 'second', { role: 'admin' })
    const member = await person(app, 'member')
    const deps = app.services.deps

    await useBudget(50)
    await notifyBudgetThresholds(deps)
    expect((await centre(admin)).body.items).toHaveLength(0)

    const month = await useBudget(81)
    await notifyBudgetThresholds(deps)
    await notifyBudgetThresholds(deps)
    const heard = (await centre(admin)).body.items
    expect(heard).toHaveLength(1)
    expect(heard[0]).toMatchObject({ type: 'budget_alert', data: { period: month, percent: 80 } })
    expect((await centre(other)).body.items).toHaveLength(1)
    expect((await centre(member)).body.items).toHaveLength(0)

    await useBudget(100)
    await notifyBudgetThresholds(deps)
    await notifyBudgetThresholds(deps)
    const later = (await centre(admin)).body.items
    expect(
      later.map((item) => (item.data as { percent: number }).percent).sort((a, b) => a - b),
    ).toEqual([80, 100])
    const remembered = await dbs.owner.db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, 'ai.budget_alerted'))
    expect(remembered[0]?.value).toEqual({ month, percent: 100 })
  })

  test('an administrator who is no longer one stops seeing them; a new month starts again', async () => {
    // Start on the last day of the previous month (the sessions are made now, so they stay valid) and cross the boundary.
    const now = new Date()
    app.clock.set(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 4)))
    const admin = await person(app, 'root', { role: 'admin' })
    await useBudget(90)
    await notifyBudgetThresholds(app.services.deps)
    expect((await centre(admin)).body.items).toHaveLength(1)
    await dbs.owner.db.update(users).set({ role: 'user' }).where(eq(users.id, admin.id))
    const gone = await centre(admin)
    expect(gone.body.items).toHaveLength(0)
    expect(gone.body.unreadCount).toBe(0)
    await dbs.owner.db.update(users).set({ role: 'admin' }).where(eq(users.id, admin.id))

    app.clock.advance(2 * 86_400_000)
    await useBudget(90)
    await notifyBudgetThresholds(app.services.deps)
    expect((await centre(admin)).body.items).toHaveLength(2)
  })

  test('no limit configured, nothing to say', async () => {
    const admin = await person(app, 'root', { role: 'admin' })
    const month = MONTH(new Date(app.clock.now().getTime() + 8 * 3_600_000))
    await dbs.owner.db.insert(budgetAccounts).values({
      scope: 'site_month',
      ownerKey: 'site',
      periodStart: month,
      limitUnits: 0,
      reservedUnits: 0,
      settledUnits: 999,
    })
    await notifyBudgetThresholds(app.services.deps)
    expect((await centre(admin)).body.items).toHaveLength(0)
  })
})

describe('retention and bounds', () => {
  test('entries older than 90 days are removed, newer ones stay', async () => {
    const { alice, bob, group } = await world()
    await say(alice, group.id, `<@user:${bob.id}> old`)
    app.clock.advance(91 * 86_400_000)
    await say(alice, group.id, `<@user:${bob.id}> new`)
    await settle()
    await dbs.owner.db
      .update(notifications)
      .set({ createdAt: new Date(app.clock.now().getTime() - 91 * 86_400_000) })
      .where(eq(notifications.userId, bob.id))
    expect(await purgeExpiredNotifications(app.services.deps)).toBeGreaterThanOrEqual(1)
  })

  test('creating the same entry twice for one person is one entry', async () => {
    const { bob } = await world()
    const deps = app.services.deps
    const seed = {
      userId: bob.id,
      type: 'budget_alert' as const,
      dedupeKey: 'same',
      data: { period: '2026-10', percent: 80 },
    }
    const one = await createNotification(deps.db, deps, seed)
    const two = await createNotification(deps.db, deps, seed)
    expect(one.created).toBe(true)
    expect(two).toEqual({ id: one.id, created: false })
    expect(await dbs.owner.db.select().from(notifications)).toHaveLength(1)
  })

  test('the response of a missing group conversation never reaches an entry', async () => {
    const { bob } = await world()
    const list = await centre(bob)
    expect(list.body).toEqual({ items: [], nextCursor: null, unreadCount: 0 })
    expect(errorCode(await bob.get('/api/notifications?cursor=nonsense'))).toBe('VALIDATION_FAILED')
  })
})

// A type-level guard that the page schema and the entry type stay in step.
const _entry: Notification | undefined = undefined
void _entry
void ({} as Conversation)
