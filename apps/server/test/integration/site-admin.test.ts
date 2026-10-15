import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { type BackupManifest, permissionReviewSchema } from '@chatapp/contracts'
import {
  accounts,
  agentRuns,
  appSettings,
  auditLogs,
  authorizationOrigins,
  budgetAccounts,
  reports,
  users,
} from '@chatapp/db'
import { eq } from 'drizzle-orm'
import { adminRunDetail } from '../../src/domain/agent-admin.ts'
import { getAgentUsage } from '../../src/domain/agent-budget.ts'
import { createAgentRun } from '../../src/domain/agent-runs.ts'
import { createConversation, openDirectMessage } from '../../src/domain/conversations.ts'
import { JOURNAL_GENESIS } from '../../src/domain/deletion-journal.ts'
import { sendMessage } from '../../src/domain/messages.ts'
import {
  confirmRecoveryPermissions,
  issueRecoveryCredential,
  recoveryPermissionInventory,
  unlockRecovery,
  verifyRecoveryObjects,
} from '../../src/domain/recovery-permissions.ts'
import {
  assertRestoreUnlocked,
  isolateRestoredDatabase,
  replayDeletionJournal,
} from '../../src/domain/restore.ts'
import {
  adminCatalog,
  adminSettings,
  adminUserChange,
  updateAdminSettings,
} from '../../src/domain/site-admin.ts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { makePrincipal } from '../support/deps.ts'
import { createTestApp, type TestApp } from '../support/http.ts'
import { testJournal } from '../support/journal.ts'
import { key, person } from '../support/people.ts'

let dbs: TestDatabases, app: TestApp
beforeAll(() => {
  dbs = openTestDatabases()
})
beforeEach(async () => {
  await truncateAll(dbs.owner)
  app = await createTestApp(dbs)
})
afterEach(async () => {
  await app.close()
})
afterAll(async () => {
  await truncateAll(dbs.owner)
  await dbs.close()
})
const deps = () => app.services.deps
const claim = () => crypto.randomUUID()

test('a fresh operator review can release a recovery denial after replay, while a punitive source ban stays in force', async () => {
  const admin = await person(app, 'operatoradmin', { role: 'admin' }),
    member = await person(app, 'pendingmember'),
    punished = await person(app, 'punished')
  await dbs.owner.db
    .update(users)
    .set({ banned: true, banReason: 'punitive' })
    .where(eq(users.id, punished.id))
  const epoch = claim(),
    offsite = await testJournal(),
    recovery = {
      ...deps(),
      db: dbs.owner.db,
      config: { ...deps().config, auth: { ...deps().config.auth, restoreEpoch: epoch } },
    }
  const manifest: BackupManifest = {
    format: 1,
    runId: claim(),
    epoch: claim(),
    applicationSha: 'a'.repeat(40),
    schemaHash: 'b'.repeat(64),
    snapshotAt: app.clock.now().toISOString(),
    journal: { seq: 0, hash: JOURNAL_GENESIS },
    database: { size: 0, sha256: 'c'.repeat(64) },
    objects: [],
    keyVersions: [1],
    recoveryFiles: [{ name: 'keys.json', sha256: 'd'.repeat(64) }],
  }
  await isolateRestoredDatabase(recovery, epoch)
  await replayDeletionJournal(recovery, offsite.journal, manifest, epoch)
  const first = await recoveryPermissionInventory(recovery, epoch)
  await confirmRecoveryPermissions(
    recovery,
    permissionReviewSchema.parse({
      ...first.review,
      reviewedBy: 'operator',
      accounts: first.review.accounts.map((row) => ({
        ...row,
        confirmed: row.userId === admin.id,
      })),
    }),
  )
  expect(
    (await recovery.db.select().from(users).where(eq(users.id, member.id)))[0]?.banReason,
  ).toBe('restore_permission_pending')
  await offsite.journal.append({
    operationId: claim(),
    actorId: null,
    acceptedAt: app.clock.now().toISOString(),
    intent: {
      action: 'retention',
      target: { cutoff: app.clock.now().toISOString(), ruleVersion: 1 },
    },
  })
  await replayDeletionJournal(recovery, offsite.journal, manifest, epoch)
  const current = await recoveryPermissionInventory(recovery, epoch)
  await confirmRecoveryPermissions(
    recovery,
    permissionReviewSchema.parse({
      ...current.review,
      reviewedBy: 'operator-new-review',
      accounts: current.review.accounts.map((row) => ({ ...row, confirmed: true })),
    }),
  )
  expect((await recovery.db.select().from(users).where(eq(users.id, member.id)))[0]?.banned).toBe(
    false,
  )
  const originalBan = (await recovery.db.select().from(users).where(eq(users.id, punished.id)))[0]
  expect(originalBan?.banned).toBe(true)
  expect(originalBan?.banReason).toBe('punitive')
  await issueRecoveryCredential(recovery, epoch, member.id, 'Fresh-recovered-member-password')
  await expect(
    issueRecoveryCredential(recovery, epoch, punished.id, 'Fresh-recovered-member-password'),
  ).rejects.toThrow('confirmed active')
})

test('role truth is checked inside the transaction, and private devices/credentials never appear in admin metadata', async () => {
  const admin = await person(app, 'manager', { role: 'admin' }),
    member = await person(app, 'reader')
  const p = await makePrincipal(deps(), admin, { role: 'admin' })
  const catalog = await adminCatalog(deps(), p, 'users', { limit: 30 })
  expect(JSON.stringify(catalog)).not.toContain('password')
  expect(JSON.stringify(catalog)).not.toContain('userAgent')
  expect(JSON.stringify(catalog)).not.toContain('ipAddress')
  expect((await member.get('/api/admin/users')).status).toBe(403)
  await dbs.owner.db.update(users).set({ role: 'user' }).where(eq(users.id, admin.id))
  await expect(adminCatalog(deps(), p, 'users', { limit: 30 })).rejects.toMatchObject({
    code: 'FORBIDDEN',
  })
  await expect(
    adminUserChange(deps(), p, member.id, { expectedVersion: 1, role: 'admin' }, claim()),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect((await dbs.owner.db.select().from(users).where(eq(users.id, member.id)))[0]?.role).toBe(
    'user',
  )
})

test('user changes preserve quota usage, require a version and replay once; the last administrator cannot be demoted', async () => {
  const admin = await person(app, 'manager', { role: 'admin' }),
    member = await person(app, 'reader')
  const p = await makePrincipal(deps(), admin, { role: 'admin' })
  await expect(
    adminUserChange(deps(), p, admin.id, { expectedVersion: 1, role: 'user' }, claim()),
  ).rejects.toMatchObject({ code: 'CONFLICT' })
  const k = claim(),
    input = { expectedVersion: 1, inviteQuota: 7, storageQuotaBytes: 2048, aiDailyTokens: 123 }
  const first = await adminUserChange(deps(), p, member.id, input, k)
  const replay = await adminUserChange(deps(), p, member.id, input, k)
  expect(first).toEqual(replay)
  expect(first.meVersion).toBe(2)
  await expect(
    adminUserChange(deps(), p, member.id, { ...input, inviteQuota: 8 }, k),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  await expect(adminUserChange(deps(), p, member.id, input, claim())).rejects.toMatchObject({
    code: 'CONFLICT',
  })
  expect(
    (await dbs.owner.db.select().from(auditLogs).where(eq(auditLogs.action, 'user.limits'))).length,
  ).toBe(1)
})

test('banning revokes live devices and authority; unbanning does not restore the old session', async () => {
  const admin = await person(app, 'manager', { role: 'admin' }),
    member = await person(app, 'reader')
  const p = await makePrincipal(deps(), admin, { role: 'admin' })
  const banned = await adminUserChange(
    deps(),
    p,
    member.id,
    { expectedVersion: 1, ban: { reason: 'abuse' } },
    claim(),
  )
  expect(banned.banned).toBe(true)
  expect((await member.get('/api/me')).status).toBe(401)
  const origins = await dbs.owner.db
    .select()
    .from(authorizationOrigins)
    .where(eq(authorizationOrigins.userId, member.id))
  expect(origins.every((origin) => origin.revokedAt !== null)).toBe(true)
  const unbanned = await adminUserChange(
    deps(),
    p,
    member.id,
    { expectedVersion: banned.meVersion, ban: false },
    claim(),
  )
  expect(unbanned.banned).toBe(false)
  expect((await member.get('/api/conversations')).status).toBe(401)
})

test('versioned settings preserve settled/reserved AI usage, are idempotent and change the public retention value', async () => {
  const admin = await person(app, 'manager', { role: 'admin' }),
    member = await person(app, 'reader')
  const p = await makePrincipal(deps(), admin, { role: 'admin' }),
    reader = await makePrincipal(deps(), member)
  const before = await getAgentUsage(deps(), reader)
  await dbs.owner.db
    .update(budgetAccounts)
    .set({ settledUnits: 12, reservedUnits: 3 })
    .where(eq(budgetAccounts.scope, 'site_month'))
  const old = await adminSettings(deps(), p),
    k = claim()
  const input = {
    expectedVersion: old.version,
    policy: { runContentDays: 1, userDailyTokens: 5, monthlyMicroUsd: 2, aiPaused: true },
  }
  const saved = await updateAdminSettings(deps(), p, input, k)
  expect(saved.version).toBe(old.version + 1)
  expect(await updateAdminSettings(deps(), p, input, k)).toEqual(saved)
  await expect(updateAdminSettings(deps(), p, input, claim())).rejects.toMatchObject({
    code: 'CONFLICT',
  })
  const usage = await getAgentUsage(deps(), reader)
  expect(usage.monthly.settledMicroUsd).toBe(12)
  expect(usage.monthly.reservedMicroUsd).toBe(3)
  expect(usage.monthly.availableMicroUsd).toBe(0)
  expect(usage.daily.limit).toBe(5)
  expect(usage.paused).toBe(true)
  expect(before.daily.limit).toBeGreaterThan(5)
  expect((await app.request('/api/privacy')).status).toBe(200)
  expect(await (await app.request('/api/privacy')).json()).toEqual({ runContentDays: 1 })
})

test('a report permits only bounded current context and each view is audited; deleting its source erases copied report text', async () => {
  const admin = await person(app, 'manager', { role: 'admin' }),
    member = await person(app, 'reader'),
    stranger = await person(app, 'outsider')
  const p = await makePrincipal(deps(), member),
    manager = await makePrincipal(deps(), admin, { role: 'admin' })
  const conversation = (
    await createConversation(
      deps(),
      p,
      { kind: 'group', name: 'private evidence', memberIds: [] },
      claim(),
    )
  ).conversation
  const sent = []
  for (let i = 0; i < 16; i++)
    sent.push(
      (await sendMessage(deps(), p, conversation.id, { clientId: claim(), body: `context ${i}` }))
        .envelope.message,
    )
  const target = sent[8]
  if (!target) throw new Error('missing report fixture')
  expect((await admin.get(`/api/messages/${target.id}`)).status).toBe(404)
  expect(
    (await stranger.post('/api/reports', { messageId: target.id, reason: 'spam' }, key())).status,
  ).toBe(404)
  const first = await member.post<{ reportId: string }>(
    '/api/reports',
    { messageId: target.id, reason: 'spam', details: 'secret report explanation' },
    key(),
  )
  expect(first.status).toBe(200)
  const again = await member.post<{ reportId: string }>(
    '/api/reports',
    { messageId: target.id, reason: 'spam', details: 'another explanation' },
    key(),
  )
  expect(again.body.reportId).toBe(first.body.reportId)
  const path = `/api/admin/reports/${first.body.reportId}/context`
  const viewed = await admin.get<{ messages: { body: string | null }[] }>(path)
  expect(viewed.status).toBe(200)
  expect(viewed.body.messages).toHaveLength(11)
  expect(viewed.body.messages.map((item) => item.body)).toEqual(
    sent.slice(3, 14).map((item) => item.body),
  )
  expect(JSON.stringify(viewed.body)).not.toContain('context 0')
  await admin.get(path)
  expect(
    (await dbs.owner.db.select().from(auditLogs).where(eq(auditLogs.action, 'report.context.view')))
      .length,
  ).toBe(2)
  expect(
    JSON.stringify(await adminCatalog(deps(), manager, 'conversations', { limit: 30 })),
  ).not.toContain('context 8')
  const dm = await openDirectMessage(deps(), p, { userId: stranger.id })
  expect(
    JSON.stringify(await adminCatalog(deps(), manager, 'conversations', { limit: 30 })),
  ).not.toContain(dm.conversation.id)
  const deleted = await member.del(`/api/messages/${target.id}`)
  expect(deleted.status).toBe(200)
  const unavailable = await admin.get<{ available: boolean; messages: unknown[] }>(path)
  expect(unavailable.body).toEqual({ available: false, messages: [] })
  expect((await dbs.owner.db.select().from(reports))[0]?.details).toBeNull()
  expect(JSON.stringify(await dbs.owner.db.select().from(auditLogs))).not.toContain(
    'secret report explanation',
  )
})

test('shortening retention immediately hides old site-run traces before the cleanup job', async () => {
  const admin = await person(app, 'manager', { role: 'admin' }),
    member = await person(app, 'reader')
  const p = await makePrincipal(deps(), member),
    manager = await makePrincipal(deps(), admin, { role: 'admin' })
  const run = await createAgentRun(
    deps(),
    p,
    {
      trigger: 'agent_chat',
      prompt: 'retention evidence',
      mode: 'fast',
      timezone: 'Asia/Shanghai',
      attachmentIds: [],
    },
    claim(),
  )
  await dbs.owner.db
    .update(agentRuns)
    .set({ createdAt: new Date(app.clock.now().getTime() - 2 * 86_400_000) })
    .where(eq(agentRuns.id, run.id))
  const old = await adminSettings(deps(), manager)
  await updateAdminSettings(
    deps(),
    manager,
    { expectedVersion: old.version, policy: { ...old.policy, runContentDays: 1 } },
    claim(),
  )
  expect((await adminRunDetail(deps(), manager, run.id)).content).toEqual({ available: 'purged' })
})

test('recovery defaults to denied accounts, requires complete object evidence and fresh credentials, then fences the old writer', async () => {
  const admin = await person(app, 'manager', { role: 'admin' }),
    member = await person(app, 'reader')
  const epoch = claim(),
    offsite = await testJournal()
  const sourceWriter = (await offsite.journal.head()).head.writerEpoch,
    nextWriter = claim()
  const recovery = {
    ...deps(),
    db: dbs.owner.db,
    config: { ...deps().config, auth: { ...deps().config.auth, restoreEpoch: epoch } },
  }
  const manifest: BackupManifest = {
    format: 1,
    runId: claim(),
    epoch: claim(),
    applicationSha: 'a'.repeat(40),
    schemaHash: 'b'.repeat(64),
    snapshotAt: app.clock.now().toISOString(),
    journal: { seq: 0, hash: JOURNAL_GENESIS },
    database: { size: 0, sha256: 'c'.repeat(64) },
    objects: [],
    keyVersions: [1],
    recoveryFiles: [{ name: 'keys.json', sha256: 'd'.repeat(64) }],
  }
  await isolateRestoredDatabase(recovery, epoch)
  expect(
    (await dbs.owner.db.select().from(accounts)).every((account) => account.password === null),
  ).toBe(true)
  await replayDeletionJournal(recovery, offsite.journal, manifest, epoch)
  const inventory = await recoveryPermissionInventory(recovery, epoch)
  expect(inventory.review.accounts.every((item) => !item.confirmed)).toBe(true)
  const review = permissionReviewSchema.parse({
    ...inventory.review,
    reviewedBy: 'operator',
    accounts: inventory.review.accounts.map((item) => ({
      ...item,
      confirmed: item.userId === admin.id,
    })),
  })
  await expect(
    confirmRecoveryPermissions(recovery, { ...review, inventoryHash: '0'.repeat(64) }),
  ).rejects.toThrow('inventory changed')
  await expect(confirmRecoveryPermissions(recovery, { ...review, accounts: [] })).rejects.toThrow(
    'incomplete',
  )
  await confirmRecoveryPermissions(recovery, review)
  expect(
    (await dbs.owner.db.select().from(users).where(eq(users.id, member.id)))[0]?.banReason,
  ).toBe('restore_permission_pending')
  await expect(
    unlockRecovery(recovery, offsite.journal, epoch, sourceWriter, nextWriter),
  ).rejects.toThrow('object')
  await verifyRecoveryObjects(recovery, epoch, manifest, async () => {
    throw new Error('empty snapshot must not request objects')
  })
  await expect(
    unlockRecovery(recovery, offsite.journal, epoch, sourceWriter, nextWriter),
  ).rejects.toThrow('fresh credential')
  await issueRecoveryCredential(recovery, epoch, admin.id, 'new-secret-password-for-recovery')
  await expect(
    issueRecoveryCredential(recovery, epoch, member.id, 'new-secret-password-for-recovery'),
  ).rejects.toThrow('confirmed active')
  await unlockRecovery(recovery, offsite.journal, epoch, sourceWriter, nextWriter)
  await assertRestoreUnlocked(recovery.db)
  const currentAdmin = await makePrincipal(recovery, admin, { role: 'admin' })
  const denied = (await recovery.db.select().from(users).where(eq(users.id, member.id)))[0]
  if (!denied) throw new Error('denied recovery account missing')
  for (const change of [
    { ban: false as const },
    { ban: { reason: 'replace-marker' } },
    { role: 'admin' as const },
    { verify: true as const },
  ]) {
    await expect(
      adminUserChange(
        recovery,
        currentAdmin,
        member.id,
        { expectedVersion: denied.meVersion, ...change },
        claim(),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  }
  expect(
    (await recovery.db.select().from(users).where(eq(users.id, member.id)))[0]?.banReason,
  ).toBe('restore_permission_pending')
  expect((await offsite.journal.head()).head.writerEpoch).toBe(nextWriter)
  await expect(
    offsite.journal.append({
      operationId: claim(),
      actorId: null,
      acceptedAt: app.clock.now().toISOString(),
      intent: {
        action: 'retention',
        target: { ruleVersion: 1, cutoff: app.clock.now().toISOString() },
      },
    }),
  ).rejects.toThrow('stale_writer')
  expect(
    await dbs.owner.db.select().from(appSettings).where(eq(appSettings.key, 'restore_state')),
  ).toHaveLength(0)
})
