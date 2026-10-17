import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { adminAuditLogsSchema } from '@chatapp/contracts'
import {
  auditLogs,
  deletionOperations,
  notifications,
  reports,
  users,
  workItems,
} from '@chatapp/db'
import { and, eq, sql } from 'drizzle-orm'
import { requestAccountDeletion } from '../../src/domain/account-deletion.ts'
import { createConversation, leaveConversation } from '../../src/domain/conversations.ts'
import { applyDeletion } from '../../src/domain/deletion-apply.ts'
import { dispatchDeletions } from '../../src/domain/deletion-operations.ts'
import { requestMessageDeletion, sendMessage } from '../../src/domain/messages.ts'
import {
  deliverAdminNotification,
  reconcileReportNotifications,
} from '../../src/domain/notifications.ts'
import { submitReport } from '../../src/domain/reports.ts'
import { searchMessages } from '../../src/domain/search.ts'
import { adminCatalog, adminUserChange } from '../../src/domain/site-admin.ts'
import { claimReadyWork, recoverExpiredWork } from '../../src/domain/work-queue.ts'
import { createDispatcher } from '../../src/jobs/dispatcher.ts'
import { silentLogger } from '../../src/lib/logger.ts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createActiveUser, makeDeps, makePrincipal } from '../support/deps.ts'
import { testJournal } from '../support/journal.ts'

let dbs: TestDatabases
beforeAll(() => {
  dbs = openTestDatabases()
})
beforeEach(async () => {
  await truncateAll(dbs.owner)
})
afterEach(async () => {
  await dbs.owner.db.execute(
    sql`drop trigger if exists review_notification_failure on notifications`,
  )
  await dbs.owner.db.execute(sql`drop function if exists review_notification_failure()`)
})
afterAll(async () => {
  await truncateAll(dbs.owner)
  await dbs.close()
})

async function fixture() {
  const offsite = await testJournal()
  const deps = makeDeps(dbs.app.db, { deletionJournal: offsite.journal })
  const admin = await createActiveUser(deps, { username: 'firstadmin', role: 'admin' })
  const principal = await makePrincipal(deps, admin)
  return { deps, offsite, admin, principal }
}

test('the only administrator cannot freeze or journal their account; a verified successor allows deletion', async () => {
  const { deps, offsite, admin, principal } = await fixture()
  await expect(requestAccountDeletion(deps, principal, admin.password)).rejects.toMatchObject({
    code: 'CONFLICT',
    details: { reason: 'admin_successor_required' },
  })
  expect(await deps.db.select().from(deletionOperations)).toHaveLength(0)
  expect((await offsite.journal.head()).head.seq).toBe(0)
  const successor = await createActiveUser(deps, { username: 'successor', role: 'admin' })
  await deps.db
    .update(users)
    .set({ emailVerified: false, activationStatus: 'pending' })
    .where(eq(users.id, successor.id))
  await expect(requestAccountDeletion(deps, principal, admin.password)).rejects.toMatchObject({
    code: 'CONFLICT',
  })
  await deps.db
    .update(users)
    .set({ emailVerified: true, activationStatus: 'active' })
    .where(eq(users.id, successor.id))
  expect((await requestAccountDeletion(deps, principal, admin.password)).status).toBe('completed')
  expect((await deps.db.select().from(users).where(eq(users.id, successor.id)))[0]?.role).toBe(
    'admin',
  )
})

test('two concurrent administrator deletions leave exactly one usable administrator', async () => {
  const { deps, admin, principal } = await fixture()
  const second = await createActiveUser(deps, { username: 'secondadmin', role: 'admin' })
  const secondPrincipal = await makePrincipal(deps, second)
  const outcomes = await Promise.allSettled([
    requestAccountDeletion(deps, principal, admin.password),
    requestAccountDeletion(deps, secondPrincipal, second.password),
  ])
  expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
  expect(
    await deps.db
      .select()
      .from(users)
      .where(and(eq(users.role, 'admin'), eq(users.banned, false))),
  ).toHaveLength(1)
})

test('an expired ban does not let the last usable administrator bypass continuity protection', async () => {
  const { deps, principal, admin } = await fixture()
  await deps.db
    .update(users)
    .set({ banned: true, banExpires: new Date(deps.clock.now().getTime() - 1) })
    .where(eq(users.id, admin.id))
  await expect(
    adminUserChange(
      deps,
      principal,
      admin.id,
      { expectedVersion: 1, role: 'user' },
      crypto.randomUUID(),
    ),
  ).rejects.toMatchObject({ code: 'CONFLICT' })
  await expect(requestAccountDeletion(deps, principal, admin.password)).rejects.toMatchObject({
    code: 'CONFLICT',
  })
})

for (const change of ['demote', 'ban'] as const) {
  test(`a prepared deletion cannot count as the successor for a ${change}`, async () => {
    const { deps, offsite, admin, principal } = await fixture()
    const second = await createActiveUser(deps, { username: 'secondadmin', role: 'admin' })
    const secondPrincipal = await makePrincipal(deps, second)
    offsite.store.unavailable = true
    expect((await requestAccountDeletion(deps, principal, admin.password)).status).toBe('pending')
    await expect(
      adminUserChange(
        deps,
        change === 'ban' ? principal : secondPrincipal,
        second.id,
        {
          expectedVersion: 1,
          ...(change === 'ban' ? { ban: { reason: 'synthetic test' } } : { role: 'user' as const }),
        },
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    offsite.store.unavailable = false
    await dispatchDeletions(deps, applyDeletion)
    expect((await deps.db.select().from(users).where(eq(users.id, second.id)))[0]?.role).toBe(
      'admin',
    )
  })
}

for (const change of ['demote', 'ban'] as const) {
  test(`account deletion racing with ${change} preserves administrator continuity`, async () => {
    const { deps, admin, principal } = await fixture()
    const second = await createActiveUser(deps, { username: 'secondadmin', role: 'admin' })
    const secondPrincipal = await makePrincipal(deps, second)
    await Promise.allSettled([
      requestAccountDeletion(deps, principal, admin.password),
      adminUserChange(
        deps,
        secondPrincipal,
        admin.id,
        {
          expectedVersion: 1,
          ...(change === 'ban' ? { ban: { reason: 'synthetic test' } } : { role: 'user' as const }),
        },
        crypto.randomUUID(),
      ),
    ])
    const available = await deps.db
      .select()
      .from(users)
      .where(and(eq(users.role, 'admin'), eq(users.banned, false)))
    expect(available.some((row) => row.id === second.id)).toBe(true)
    await expect(
      requestAccountDeletion(deps, secondPrincipal, second.password),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })
}

async function reported() {
  const base = await fixture()
  const { deps } = base
  const second = await createActiveUser(deps, { username: 'secondadmin', role: 'admin' })
  const third = await createActiveUser(deps, { username: 'thirdadmin', role: 'admin' })
  const member = await createActiveUser(deps, { username: 'reporter' })
  const principal = await makePrincipal(deps, member)
  const { conversation: group } = await createConversation(
    deps,
    principal,
    { kind: 'group', name: 'Reported group', memberIds: [] },
    crypto.randomUUID(),
  )
  const sent = await sendMessage(deps, principal, group.id, {
    clientId: crypto.randomUUID(),
    body: 'synthetic reported text',
  })
  const input = { messageId: sent.envelope.message.id, reason: 'spam' as const, details: '' }
  const key = crypto.randomUUID()
  const receipt = await submitReport(deps, principal, input, key)
  return { ...base, second, third, member, memberPrincipal: principal, input, key, receipt }
}

test('a crash after report commit is recovered from expired leases without duplicate notifications', async () => {
  const { deps, memberPrincipal, input, key, receipt } = await reported()
  expect(await deps.db.select().from(notifications)).toHaveLength(0)
  const claimed = await claimReadyWork(deps, { limit: 100, kinds: ['notification'] })
  expect(claimed).toHaveLength(3)
  expect(await submitReport(deps, memberPrincipal, input, key)).toEqual(receipt)
  expect(await submitReport(deps, memberPrincipal, input, crypto.randomUUID())).toEqual(receipt)
  deps.clock.advance(61_000)
  expect((await recoverExpiredWork(deps)).requeued).toBe(3)
  deps.clock.advance(5_001)
  const retry = await claimReadyWork(deps, { limit: 100, kinds: ['notification'] })
  for (const work of claimed) await deliverAdminNotification(deps, work)
  expect(await deps.db.select().from(notifications)).toHaveLength(0)
  for (const work of retry) await deliverAdminNotification(deps, work)
  for (const work of retry) await deliverAdminNotification(deps, work)
  expect(
    await deps.db.select().from(notifications).where(eq(notifications.type, 'report_opened')),
  ).toHaveLength(3)
  expect(
    await deps.db
      .select()
      .from(workItems)
      .where(and(eq(workItems.kind, 'notification'), eq(workItems.status, 'done'))),
  ).toHaveLength(3)
})

for (const recipientIndex of [0, 1]) {
  test(`a database notification failure for recipient ${recipientIndex + 1} is retried independently`, async () => {
    const { deps, admin, second } = await reported()
    const failingId = recipientIndex === 0 ? admin.id : second.id
    await dbs.owner.db.execute(
      sql.raw(
        `create function review_notification_failure() returns trigger language plpgsql as $$ begin if new.user_id = '${failingId}'::uuid then raise exception 'synthetic notification failure'; end if; return new; end $$`,
      ),
    )
    await dbs.owner.db.execute(
      sql`create trigger review_notification_failure before insert on notifications for each row execute function review_notification_failure()`,
    )
    const dispatcher = createDispatcher({
      deps,
      log: silentLogger,
      kinds: ['notification'],
      emailQueue: {} as never,
      bus: {} as never,
    })
    expect(await dispatcher.tick()).toBe(3)
    expect(
      await deps.db.select().from(notifications).where(eq(notifications.type, 'report_opened')),
    ).toHaveLength(2)
    expect(
      await deps.db
        .select()
        .from(workItems)
        .where(and(eq(workItems.kind, 'notification'), eq(workItems.status, 'retry'))),
    ).toHaveLength(1)
    await dbs.owner.db.execute(sql`drop trigger review_notification_failure on notifications`)
    deps.clock.advance(5_001)
    const restarted = createDispatcher({
      deps,
      log: silentLogger,
      kinds: ['notification'],
      emailQueue: {} as never,
      bus: {} as never,
    })
    await restarted.tick()
    await restarted.tick()
    expect(
      await deps.db.select().from(notifications).where(eq(notifications.type, 'report_opened')),
    ).toHaveLength(3)
  })
}

test('upgrade compensation fills missing report intents once and preserves existing notification deduplication', async () => {
  const { deps, receipt } = await reported()
  await dbs.owner.db.delete(workItems).where(eq(workItems.kind, 'notification'))
  await dbs.owner.db
    .update(reports)
    .set({ notificationsQueuedAt: null })
    .where(eq(reports.id, receipt.reportId))
  expect(await reconcileReportNotifications(deps)).toBe(1)
  expect(await reconcileReportNotifications(deps)).toBe(0)
  for (const work of await claimReadyWork(deps, { limit: 10, kinds: ['notification'] }))
    await deliverAdminNotification(deps, work)
  expect(
    await deps.db.select().from(notifications).where(eq(notifications.type, 'report_opened')),
  ).toHaveLength(3)
})

test('audit projection identifies targets, filters by actor/action/time, binds cursors, and strips private metadata', async () => {
  const { deps, principal, admin } = await fixture()
  const target = await createActiveUser(deps, { username: 'audittarget' })
  for (const index of [0, 1, 2])
    await deps.db.insert(auditLogs).values({
      actorId: admin.id,
      action: 'user.ban',
      targetType: 'user',
      targetId: target.id,
      metadata: {
        roleChanged: true,
        status: 'resolved',
        email: 'private@example.test',
        body: 'secret text',
        secret: 'private value',
      },
      createdAt: new Date(deps.clock.now().getTime() - index * 1000),
    })
  const page = adminAuditLogsSchema.parse(
    await adminCatalog(deps, principal, 'audit', {
      limit: 1,
      action: 'user.ban',
      actorId: admin.id,
      after: new Date(deps.clock.now().getTime() - 10_000).toISOString(),
    }),
  )
  expect(page.entries[0]).toMatchObject({
    targetId: target.id,
    summary: { roleChanged: true, status: 'resolved' },
  })
  expect(JSON.stringify(page)).not.toContain('private')
  expect(JSON.stringify(page)).not.toContain('secret')
  expect(page.nextCursor).toBeTruthy()
  await expect(
    adminCatalog(deps, principal, 'audit', {
      limit: 1,
      cursor: page.nextCursor ?? undefined,
      action: 'user.unban',
    }),
  ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  expect(
    adminAuditLogsSchema.parse(
      await adminCatalog(deps, principal, 'audit', { limit: 10, actorId: target.id }),
    ).entries,
  ).toHaveLength(0)
})

test('message search continues beyond twenty, identifies the source, and rechecks recall and membership on every page', async () => {
  const { deps, principal } = await fixture()
  const viewer = await createActiveUser(deps, { username: 'searchviewer' })
  const reader = await makePrincipal(deps, viewer)
  const { conversation } = await createConversation(
    deps,
    principal,
    { kind: 'group', name: 'Search source', memberIds: [viewer.id] },
    crypto.randomUUID(),
  )
  const ids: string[] = []
  for (let index = 0; index < 24; index++)
    ids.push(
      (
        await sendMessage(deps, principal, conversation.id, {
          clientId: crypto.randomUUID(),
          body: `search regression ${index}`,
        })
      ).envelope.message.id,
    )
  const first = await searchMessages(deps, reader, { query: 'search regression', limit: 20 })
  expect(first.messages).toHaveLength(20)
  expect(first.conversations[conversation.id]?.name).toBe('Search source')
  expect(first.nextCursor).toBeTruthy()
  const oldest = ids[0]
  if (!oldest || !first.nextCursor) throw new Error('search fixture missing')
  await requestMessageDeletion(deps, principal, oldest, 'message_recall')
  const older = await searchMessages(deps, reader, {
    query: 'search regression',
    limit: 20,
    cursor: first.nextCursor,
  })
  expect(older.messages).toHaveLength(3)
  expect(older.messages.some((message) => message.id === oldest)).toBe(false)
  await expect(
    searchMessages(deps, reader, { query: 'different', limit: 20, cursor: first.nextCursor }),
  ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  await leaveConversation(deps, reader, conversation.id)
  const revoked = await searchMessages(deps, reader, {
    query: 'search regression',
    limit: 20,
    cursor: first.nextCursor,
  })
  expect(revoked.messages).toHaveLength(0)
  expect(revoked.conversations).toEqual({})
})
