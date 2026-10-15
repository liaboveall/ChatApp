import {
  type AdminPageQuery,
  AppError,
  type SiteSettingsUpdate,
  sitePolicySchema,
  UPLOAD_LIMITS,
} from '@chatapp/contracts'
import {
  aiUsageDaily,
  appSettings,
  auditLogs,
  budgetAccounts,
  conversationBans,
  conversations,
  registrationInvites,
  registrationInviteUses,
  reports,
  siteStorage,
  type Tx,
  users,
} from '@chatapp/db'
import { and, desc, eq, ilike, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { fingerprint } from '../lib/crypto.ts'
import { budgetPeriod } from './agent-budget.ts'
import { lockStorage } from './attachment-common.ts'
import { writeAudit } from './audit.ts'
import { requireAccess } from './authorize.ts'
import { revokeLiveChallenges } from './challenges.ts'
import { recordUserChange } from './changes.ts'
import { archiveConversation, restoreConversation } from './conversations.ts'
import { cursorExpiry, decodeCursor, encodeCursor } from './cursor.ts'
import type { Deps } from './deps.ts'
import { assertIdempotencyKey, claimIdempotency, completeIdempotency } from './idempotency.ts'
import { unbanConversationMember } from './members.ts'
import type { SessionPrincipal } from './principal.ts'
import {
  bumpAuthEpoch,
  enqueueRevocationHint,
  lockAndRevalidate,
  revokeOrigins,
} from './sessions.ts'
import { readSitePolicy, SITE_POLICY_KEY } from './site-policy.ts'
import { inTransaction } from './tx.ts'

export async function requireSiteAdmin(
  tx: Tx,
  deps: Deps,
  principal: SessionPrincipal,
  alsoLock: string[] = [],
) {
  const user = await lockAndRevalidate(tx, deps, principal, { alsoLock })
  if (user.role !== 'admin')
    throw new AppError('FORBIDDEN', 'Only site administrators can manage the site')
  return user
}
const changed = () => new AppError('CONFLICT', 'The item changed; refresh before trying again')
const missing = () => new AppError('NOT_FOUND', 'Item not found')
export const adminUserDto = (row: typeof users.$inferSelect) => ({
  id: row.id,
  username: row.username,
  name: row.name,
  email: row.email,
  role: row.role,
  banned: row.banned,
  banReason: row.banReason,
  emailVerified: row.emailVerified,
  active: row.activationStatus === 'active',
  inviteQuota: row.inviteQuota,
  invitesUsed: row.invitesUsed,
  storageUsedBytes: row.storageUsedBytes,
  storageReservedBytes: row.storageReservedBytes,
  storageQuotaBytes: row.storageQuotaBytes,
  aiDailyTokens: row.aiDailyTokens,
  meVersion: row.meVersion,
  createdAt: row.createdAt.toISOString(),
})

export async function adminCatalog(
  deps: Deps,
  principal: SessionPrincipal,
  section: 'users' | 'invites' | 'conversations' | 'reports' | 'audit',
  query: AdminPageQuery,
) {
  return await inTransaction(deps.db, async (tx) => {
    await requireSiteAdmin(tx, deps, principal)
    const filter = query.query ?? '',
      token = query.cursor ? decodeCursor(deps, query.cursor, 'admin-catalog', principal) : null
    if (
      query.cursor &&
      (!token ||
        token.section !== section ||
        token.f !== filter ||
        token.ae !== principal.authEpoch ||
        token.re !== principal.restoreEpoch)
    )
      throw new AppError('VALIDATION_FAILED', 'The cursor does not belong to this list')
    const position = (table: { createdAt: AnyPgColumn; id: AnyPgColumn }) =>
      token
        ? or(
            lt(table.createdAt, new Date(token.o[0])),
            and(eq(table.createdAt, new Date(token.o[0])), lt(table.id, token.o[1])),
          )
        : undefined
    const next = (rows: { createdAt: Date; id: string }[]) => {
      const last = rows.slice(0, query.limit).at(-1)
      return rows.length > query.limit && last
        ? encodeCursor(deps, {
            k: 'admin-catalog',
            u: principal.userId,
            ae: principal.authEpoch,
            re: principal.restoreEpoch,
            section,
            f: filter,
            o: [last.createdAt.toISOString(), last.id],
            x: cursorExpiry(deps),
          })
        : null
    }
    const pattern = `%${filter.replace(/[\\%_]/g, '\\$&')}%`
    if (section === 'users') {
      const rows = await tx
        .select()
        .from(users)
        .where(
          and(
            eq(users.isBot, false),
            isNull(users.deletedAt),
            position(users),
            filter
              ? or(
                  ilike(users.username, pattern),
                  ilike(users.name, pattern),
                  ilike(users.email, pattern),
                )
              : undefined,
          ),
        )
        .orderBy(desc(users.createdAt), desc(users.id))
        .limit(query.limit + 1)
      return { users: rows.slice(0, query.limit).map(adminUserDto), nextCursor: next(rows) }
    }
    if (section === 'invites') {
      const rows = await tx
        .select({ row: registrationInvites, name: users.name })
        .from(registrationInvites)
        .innerJoin(users, eq(users.id, registrationInvites.createdBy))
        .where(position(registrationInvites))
        .orderBy(desc(registrationInvites.createdAt), desc(registrationInvites.id))
        .limit(query.limit + 1)
      return {
        invites: rows.slice(0, query.limit).map(({ row, name }) => ({
          id: row.id,
          creatorName: name,
          note: row.note,
          maxUses: row.maxUses,
          useCount: row.useCount,
          expiresAt: row.expiresAt?.toISOString() ?? null,
          revokedAt: row.revokedAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
        })),
        nextCursor: next(rows.map((item) => item.row)),
      }
    }
    if (section === 'conversations') {
      const rows = await tx
        .select({ row: conversations, name: users.name })
        .from(conversations)
        .leftJoin(users, eq(users.id, conversations.ownerId))
        .where(
          and(
            inArray(conversations.kind, ['channel', 'group']),
            position(conversations),
            filter ? ilike(conversations.name, pattern) : undefined,
          ),
        )
        .orderBy(desc(conversations.createdAt), desc(conversations.id))
        .limit(query.limit + 1)
      for (const { row } of rows)
        await requireAccess(tx, { userId: principal.userId, siteRole: 'admin' }, row.id, 'view', {
          now: deps.clock.now(),
        })
      return {
        conversations: rows.slice(0, query.limit).map(({ row, name }) => ({
          id: row.id,
          kind: row.kind as 'channel' | 'group',
          name: row.name ?? '',
          ownerName: name,
          memberCount: row.memberCount,
          archivedAt: row.archivedAt?.toISOString() ?? null,
          metadataVersion: row.metadataVersion,
          createdAt: row.createdAt.toISOString(),
        })),
        nextCursor: next(rows.map((item) => item.row)),
      }
    }
    if (section === 'reports') {
      const { policy } = await readSitePolicy(deps, tx)
      const contentCutoff = deps.clock.now().getTime() - policy.runContentDays * 86_400_000
      const rows = await tx
        .select({ row: reports, name: users.name })
        .from(reports)
        .leftJoin(users, eq(users.id, reports.reporterId))
        .where(position(reports))
        .orderBy(desc(reports.createdAt), desc(reports.id))
        .limit(query.limit + 1)
      return {
        reports: rows.slice(0, query.limit).map(({ row, name }) => ({
          id: row.id,
          reporterName: name ?? '',
          reason: row.reason,
          details: row.createdAt.getTime() < contentCutoff ? null : row.details,
          status: row.status,
          resolutionNote: row.createdAt.getTime() < contentCutoff ? null : row.resolutionNote,
          version: row.version,
          createdAt: row.createdAt.toISOString(),
        })),
        nextCursor: next(rows.map((item) => item.row)),
      }
    }
    const rows = await tx
      .select({ row: auditLogs, name: users.name })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorId))
      .where(position(auditLogs))
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(query.limit + 1)
    return {
      entries: rows.slice(0, query.limit).map(({ row, name }) => ({
        id: row.id,
        action: row.action,
        actorName: name,
        targetType: row.targetType,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: next(rows.map((item) => item.row)),
    }
  })
}

export async function adminUserChange(
  deps: Deps,
  principal: SessionPrincipal,
  id: string,
  input: {
    expectedVersion: number
    role?: 'user' | 'admin'
    inviteQuota?: number
    storageQuotaBytes?: number | null
    aiDailyTokens?: number | null
    ban?: { reason: string; until?: string | null } | false
    verify?: true
  },
  key: string,
) {
  assertIdempotencyKey(key)
  return await inTransaction(deps.db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('chatapp.admin.roles'))`)
    await requireSiteAdmin(tx, deps, principal, [id])
    const [row] = await tx
      .select()
      .from(users)
      .where(and(eq(users.id, id), eq(users.isBot, false), isNull(users.deletedAt)))
    if (!row) throw missing()
    const claim = await claimIdempotency(
      tx,
      deps,
      { actorKey: principal.userId, operation: 'admin.user', targetKey: id, key },
      fingerprint(input),
    )
    if (claim.status === 'replay') return adminUserDto(row)
    if (row.meVersion !== input.expectedVersion) throw changed()
    if (
      input.inviteQuota !== undefined &&
      input.inviteQuota < row.invitesUsed &&
      (input.role ?? row.role) !== 'admin'
    )
      throw new AppError('VALIDATION_FAILED', 'Invitation quota cannot be below used invitations')
    if (
      row.banReason === 'restore_permission_pending' &&
      (input.ban !== undefined || input.role !== undefined || input.verify)
    )
      throw new AppError('FORBIDDEN', 'Recovery permissions require separate operator confirmation')
    if (input.ban && id === principal.userId)
      throw new AppError('FORBIDDEN', 'An administrator cannot ban their current account')
    if ((input.ban || input.role === 'user') && row.role === 'admin' && !row.banned) {
      const other = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.role, 'admin'),
            eq(users.banned, false),
            isNull(users.deletedAt),
            eq(users.activationStatus, 'active'),
            eq(users.emailVerified, true),
            ne(users.id, id),
          ),
        )
        .limit(1)
      if (!other.length)
        throw new AppError('CONFLICT', 'At least one active verified administrator is required')
    }
    if (
      input.ban &&
      input.ban.until &&
      (Date.parse(input.ban.until) <= deps.clock.now().getTime() ||
        Date.parse(input.ban.until) > deps.clock.now().getTime() + 366 * 86_400_000)
    )
      throw new AppError('VALIDATION_FAILED', 'Ban expiry must be within the next year')
    if (input.verify && row.accountSource === 'registration') {
      const [registration] = row.registrationId
        ? await tx
            .select()
            .from(registrationInviteUses)
            .where(eq(registrationInviteUses.id, row.registrationId))
            .for('update')
        : []
      if (registration?.status !== 'confirmed')
        throw new AppError('CONFLICT', 'Registration must be confirmed before verification')
    }
    if (input.verify) await revokeLiveChallenges(tx, deps, id, 'verify_email')
    if (input.ban || (input.role !== undefined && input.role !== row.role)) {
      await revokeOrigins(
        tx,
        deps,
        id,
        { kind: 'all' },
        input.ban ? 'banned' : 'all_devices_revoked',
      )
      await bumpAuthEpoch(tx, id)
      await enqueueRevocationHint(tx, deps, id)
    }
    const [updated] = await tx
      .update(users)
      .set({
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.inviteQuota !== undefined ? { inviteQuota: input.inviteQuota } : {}),
        ...(input.storageQuotaBytes !== undefined
          ? { storageQuotaBytes: input.storageQuotaBytes }
          : {}),
        ...(input.aiDailyTokens !== undefined ? { aiDailyTokens: input.aiDailyTokens } : {}),
        ...(input.ban
          ? {
              banned: true,
              banReason: input.ban.reason,
              banExpires: input.ban.until ? new Date(input.ban.until) : null,
            }
          : input.ban === false
            ? { banned: false, banReason: null, banExpires: null }
            : {}),
        ...(input.verify ? { emailVerified: true, activationStatus: 'active' as const } : {}),
        meVersion: sql`${users.meVersion}+1`,
        updatedAt: deps.clock.now(),
      })
      .where(eq(users.id, id))
      .returning()
    if (!updated) throw missing()
    await recordUserChange(tx, deps, {
      userId: id,
      entityType: 'me',
      entityId: id,
    })
    await writeAudit(tx, {
      actorId: principal.userId,
      action: input.verify
        ? 'user.verify_email'
        : input.ban
          ? 'user.ban'
          : input.ban === false
            ? 'user.unban'
            : 'user.limits',
      targetType: 'user',
      targetId: id,
      metadata: { roleChanged: input.role !== undefined && input.role !== row.role },
    })
    await completeIdempotency(tx, claim.id, { type: 'user', id })
    return adminUserDto(updated)
  })
}

export async function adminRevokeInvite(
  deps: Deps,
  principal: SessionPrincipal,
  id: string,
  key: string,
) {
  assertIdempotencyKey(key)
  await inTransaction(deps.db, async (tx) => {
    await requireSiteAdmin(tx, deps, principal)
    const claim = await claimIdempotency(
      tx,
      deps,
      { actorKey: principal.userId, operation: 'admin.invite.revoke', targetKey: id, key },
      fingerprint({ id }),
    )
    if (claim.status === 'replay') return
    const changed = await tx
      .update(registrationInvites)
      .set({ revokedAt: deps.clock.now() })
      .where(eq(registrationInvites.id, id))
      .returning({ id: registrationInvites.id })
    if (!changed.length) throw missing()
    await writeAudit(tx, {
      actorId: principal.userId,
      action: 'invite.revoked',
      targetType: 'invite',
      targetId: id,
    })
    await completeIdempotency(tx, claim.id, { type: 'invite', id })
  })
}

export async function adminSettings(deps: Deps, principal: SessionPrincipal) {
  return await inTransaction(deps.db, async (tx) => {
    await requireSiteAdmin(tx, deps, principal)
    const settings = await readSitePolicy(deps, tx)
    const [storage] = await tx
      .select({ budgetBytes: siteStorage.budgetBytes })
      .from(siteStorage)
      .where(eq(siteStorage.id, 1))
    return {
      ...settings,
      storageBudgetBytes: storage?.budgetBytes ?? UPLOAD_LIMITS.siteBudgetBytes,
      provider: deps.config.ai?.provider ?? 'mock',
      fastModel: deps.config.ai?.models.fast ?? 'mock',
      deepModel: deps.config.ai?.models.deep ?? 'mock',
    }
  })
}
export async function updateAdminSettings(
  deps: Deps,
  principal: SessionPrincipal,
  input: SiteSettingsUpdate,
  key: string,
) {
  assertIdempotencyKey(key)
  return await inTransaction(deps.db, async (tx) => {
    await requireSiteAdmin(tx, deps, principal)
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('chatapp.site.policy'))`)
    const claim = await claimIdempotency(
      tx,
      deps,
      { actorKey: principal.userId, operation: 'admin.settings', targetKey: SITE_POLICY_KEY, key },
      fingerprint(input),
    )
    const old = await readSitePolicy(deps, tx)
    if (claim.status !== 'replay') {
      if (old.version !== input.expectedVersion) throw changed()
      const policy = sitePolicySchema.parse({
        ...input.policy,
        limits: input.policy.limits ?? old.policy.limits,
      })
      if (input.storageBudgetBytes !== undefined) {
        await lockStorage(tx)
        await tx
          .update(siteStorage)
          .set({ budgetBytes: input.storageBudgetBytes })
          .where(eq(siteStorage.id, 1))
      }
      await tx
        .insert(appSettings)
        .values({
          key: SITE_POLICY_KEY,
          value: policy,
          version: old.version + 1,
          updatedBy: principal.userId,
        })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: {
            value: policy,
            version: old.version + 1,
            updatedBy: principal.userId,
            updatedAt: deps.clock.now(),
          },
        })
      await writeAudit(tx, {
        actorId: principal.userId,
        action: 'settings.update',
        targetType: 'settings',
        metadata: { version: old.version + 1, runContentDays: policy.runContentDays },
      })
      await completeIdempotency(tx, claim.id, { type: 'settings', id: null })
    }
    const current = await readSitePolicy(deps, tx)
    const [storage] = await tx
      .select({ budgetBytes: siteStorage.budgetBytes })
      .from(siteStorage)
      .where(eq(siteStorage.id, 1))
    return {
      ...current,
      storageBudgetBytes: storage?.budgetBytes ?? UPLOAD_LIMITS.siteBudgetBytes,
      provider: deps.config.ai?.provider ?? 'mock',
      fastModel: deps.config.ai?.models.fast ?? 'mock',
      deepModel: deps.config.ai?.models.deep ?? 'mock',
    }
  })
}
export async function adminUsage(deps: Deps, principal: SessionPrincipal) {
  return await inTransaction(deps.db, async (tx) => {
    await requireSiteAdmin(tx, deps, principal)
    const rows = await tx
      .select({
        day: aiUsageDaily.day,
        inputTokens: sql<number>`sum(${aiUsageDaily.inputTokens})::bigint`,
        outputTokens: sql<number>`sum(${aiUsageDaily.outputTokens})::bigint`,
        costMicroUsd: sql<number>`sum(${aiUsageDaily.costMicroUsd})::bigint`,
        calls: sql<number>`sum(${aiUsageDaily.runCount})::bigint`,
      })
      .from(aiUsageDaily)
      .groupBy(aiUsageDaily.day)
      .orderBy(desc(aiUsageDaily.day))
      .limit(31)
    const period = budgetPeriod(deps.clock.now(), deps.config.timezone).month
    const [account] = await tx
      .select()
      .from(budgetAccounts)
      .where(
        and(
          eq(budgetAccounts.scope, 'site_month'),
          eq(budgetAccounts.ownerKey, 'site'),
          eq(budgetAccounts.periodStart, period),
        ),
      )
    const { policy } = await readSitePolicy(deps, tx)
    return {
      usage: rows.map((row) => ({
        day: row.day,
        inputTokens: Number(row.inputTokens),
        outputTokens: Number(row.outputTokens),
        costMicroUsd: Number(row.costMicroUsd),
        calls: Number(row.calls),
      })),
      budget: account
        ? {
            period,
            settledMicroUsd: account.settledUnits,
            reservedMicroUsd: account.reservedUnits,
            limitMicroUsd: policy.monthlyMicroUsd,
          }
        : null,
    }
  })
}

// Reuse the conversation transaction and authorization rules; the admin requirement is checked inside that same lock.
export const adminArchive = (
  deps: Deps,
  principal: SessionPrincipal,
  id: string,
  expectedVersion: number,
  idempotencyKey: string,
) =>
  archiveConversation(deps, principal, id, { siteAdminOnly: true, expectedVersion, idempotencyKey })
export const adminRestore = (
  deps: Deps,
  principal: SessionPrincipal,
  id: string,
  input: Parameters<typeof restoreConversation>[3],
  expectedVersion: number,
  idempotencyKey: string,
) =>
  restoreConversation(deps, principal, id, input, {
    siteAdminOnly: true,
    expectedVersion,
    idempotencyKey,
  })
export const adminUnban = (deps: Deps, principal: SessionPrincipal, id: string, userId: string) =>
  unbanConversationMember(deps, principal, id, userId, { siteAdminOnly: true })
export async function adminBans(deps: Deps, principal: SessionPrincipal, id: string) {
  return await inTransaction(deps.db, async (tx) => {
    await requireSiteAdmin(tx, deps, principal)
    await requireAccess(tx, { userId: principal.userId, siteRole: 'admin' }, id, 'unban', {
      now: deps.clock.now(),
    })
    const rows = await tx
      .select({ id: users.id, name: users.name, reason: conversationBans.reason })
      .from(conversationBans)
      .innerJoin(users, eq(users.id, conversationBans.userId))
      .where(eq(conversationBans.conversationId, id))
      .limit(5000)
    return { bans: rows }
  })
}
