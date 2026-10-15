/** Owner-only recovery decisions. Public API code never imports this module. */
import type { BackupManifest, PermissionReview } from '@chatapp/contracts'
import {
  accounts,
  appSettings,
  attachmentObjects,
  attachments,
  auditLogs,
  conversationBans,
  conversationInvites,
  conversationMembers,
  conversations,
  type DbOrTx,
  registrationInvites,
  users,
} from '@chatapp/db'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { deletionFingerprint, type EncryptedDeletionJournal } from './deletion-journal.ts'
import type { Deps } from './deps.ts'
import { lockUsers } from './sessions.ts'

export async function verifyRecoveryObjects(
  deps: Deps,
  epoch: string,
  manifest: BackupManifest,
  read: (key: string) => Promise<{ size: number; sha256: string }>,
) {
  return await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('chatapp.deletion.dispatch'))`)
    await tx.execute(sql`set local idle_in_transaction_session_timeout = 0`)
    const state = await isolatedState({ ...deps, db: tx }, epoch)
    const value = state.value as Record<string, unknown>
    if (value.replayManifest !== deletionFingerprint(manifest))
      throw new Error('object verification manifest differs from replay')
    const live = await tx
      .select()
      .from(attachmentObjects)
      .where(eq(attachmentObjects.status, 'live'))
    const keys = new Set(live.map((item) => item.storageKey))
    const ready = await tx
      .select({ key: attachments.storageKey, variants: attachments.variants })
      .from(attachments)
      .where(eq(attachments.status, 'ready'))
    if (
      ready.some(
        (item) =>
          !item.key ||
          !keys.has(item.key) ||
          Object.values(item.variants).some((variant) => !keys.has(variant.key)),
      )
    )
      throw new Error('restored attachment reference lacks a live object')
    for (const item of live) {
      const expected = manifest.objects.find((object) => object.key === item.storageKey)
      if (!expected || expected.size !== item.sizeBytes || expected.sha256 !== item.sha256)
        throw new Error('restored ledger differs from the verified snapshot')
      const actual = await read(item.storageKey)
      if (actual.size !== expected.size || actual.sha256 !== expected.sha256)
        throw new Error('restored storage integrity mismatch')
    }
    const objectHash = deletionFingerprint(
      live
        .map((item) => ({ key: item.storageKey, size: item.sizeBytes, sha256: item.sha256 }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    )
    await tx
      .update(appSettings)
      .set({ value: { ...value, objects: 'verified', objectCount: live.length, objectHash } })
      .where(eq(appSettings.key, 'restore_state'))
    return { verified: live.length, objectHash }
  })
}

type RecoveryReadDeps = Omit<Deps, 'db'> & { db: DbOrTx }
async function isolatedState(deps: RecoveryReadDeps, epoch: string) {
  const [row] = await deps.db.select().from(appSettings).where(eq(appSettings.key, 'restore_state'))
  if (
    !row ||
    typeof row.value !== 'object' ||
    row.value === null ||
    !('epoch' in row.value) ||
    row.value.epoch !== epoch ||
    !('journal' in row.value) ||
    row.value.journal !== 'verified'
  )
    throw new Error('verified isolated recovery state required')
  return row
}

export async function recoveryPermissionInventory(deps: RecoveryReadDeps, epoch: string) {
  await isolatedState(deps, epoch)
  // No credentials, email, IP or bodies. IDs occur only in the private operator review file.
  const inventory = {
    users: await deps.db
      .select({
        id: users.id,
        username: users.username,
        role: users.role,
        banned: users.banned,
        banExpires: users.banExpires,
        active: users.activationStatus,
        verified: users.emailVerified,
        deletedAt: users.deletedAt,
        isBot: users.isBot,
      })
      .from(users)
      .orderBy(users.id),
    memberships: await deps.db
      .select({
        userId: conversationMembers.userId,
        conversationId: conversationMembers.conversationId,
        membershipId: conversationMembers.membershipId,
        role: conversationMembers.role,
        visibleFromSeq: conversationMembers.visibleFromSeq,
      })
      .from(conversationMembers)
      .orderBy(conversationMembers.userId, conversationMembers.conversationId),
    conversations: await deps.db
      .select({
        id: conversations.id,
        kind: conversations.kind,
        ownerId: conversations.ownerId,
        archivedAt: conversations.archivedAt,
      })
      .from(conversations)
      .orderBy(conversations.id),
    bans: await deps.db
      .select({ userId: conversationBans.userId, conversationId: conversationBans.conversationId })
      .from(conversationBans)
      .orderBy(conversationBans.userId, conversationBans.conversationId),
  }
  return {
    format: 1 as const,
    epoch,
    inventoryHash: deletionFingerprint(inventory),
    inventory,
    review: {
      format: 1 as const,
      epoch,
      inventoryHash: deletionFingerprint(inventory),
      reviewedBy: '',
      accounts: inventory.users
        .filter((user) => !user.isBot && !user.deletedAt)
        .map((user) => ({ userId: user.id, confirmed: false })),
    },
  }
}

export async function confirmRecoveryPermissions(deps: Deps, review: PermissionReview) {
  return await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('chatapp.deletion.dispatch'))`)
    const scoped = { ...deps, db: tx }
    const state = await isolatedState(scoped, review.epoch)
    if (
      'permissions' in (state.value as Record<string, unknown>) &&
      (state.value as Record<string, unknown>).permissions === 'verified'
    )
      throw new Error('permission review already applied; use the recorded receipt')
    const inventory = await recoveryPermissionInventory(scoped, review.epoch)
    if (
      inventory.inventoryHash !== review.inventoryHash ||
      review.accounts.length !== inventory.review.accounts.length ||
      review.accounts.some(
        (item) => !inventory.review.accounts.some((expected) => expected.userId === item.userId),
      )
    )
      throw new Error('recovery permission inventory changed or incomplete')
    await lockUsers(
      tx,
      inventory.inventory.users.map((item) => item.id),
    )
    const denied = review.accounts.filter((item) => !item.confirmed).map((item) => item.userId)
    const confirmed = review.accounts.filter((item) => item.confirmed).map((item) => item.userId)
    if (confirmed.length)
      await tx
        .update(users)
        .set({
          banned: false,
          banReason: null,
          banExpires: null,
          authEpoch: sql`${users.authEpoch}+1`,
          meVersion: sql`${users.meVersion}+1`,
          updatedAt: deps.clock.now(),
        })
        .where(
          and(
            inArray(users.id, confirmed),
            eq(users.banned, true),
            eq(users.banReason, 'restore_permission_pending'),
          ),
        )
    if (denied.length)
      await tx
        .update(users)
        .set({
          banned: true,
          banReason: 'restore_permission_pending',
          banExpires: null,
          authEpoch: sql`${users.authEpoch}+1`,
          meVersion: sql`${users.meVersion}+1`,
          updatedAt: deps.clock.now(),
        })
        .where(and(inArray(users.id, denied), eq(users.banned, false)))
    // Old links can never create authority after restoration, even if they existed in a snapshot.
    await tx
      .update(registrationInvites)
      .set({ revokedAt: deps.clock.now() })
      .where(isNull(registrationInvites.revokedAt))
    await tx
      .update(conversationInvites)
      .set({ revokedAt: deps.clock.now() })
      .where(isNull(conversationInvites.revokedAt))
    const receiptHash = deletionFingerprint(review)
    await tx
      .update(appSettings)
      .set({
        value: {
          ...(state.value as Record<string, unknown>),
          permissions: 'verified',
          permissionReview: receiptHash,
        },
      })
      .where(eq(appSettings.key, 'restore_state'))
    await tx.insert(auditLogs).values({
      id: deps.newId(),
      action: 'restore.permissions',
      targetType: 'restore',
      metadata: {
        epoch: review.epoch,
        inventoryHash: review.inventoryHash,
        reviewHash: receiptHash,
        confirmed: review.accounts.length - denied.length,
        denied: denied.length,
      },
    })
    return {
      confirmed: review.accounts.length - denied.length,
      denied: denied.length,
      reviewHash: receiptHash,
    }
  })
}

/** The operator must separately verify the account identity before issuing a fresh credential. */
export async function issueRecoveryCredential(
  deps: Deps,
  epoch: string,
  userId: string,
  password: string,
) {
  const hash = await deps.passwords.hash(password)
  await deps.db.transaction(async (tx) => {
    const state = await isolatedState({ ...deps, db: tx }, epoch)
    if ((state.value as Record<string, unknown>).permissions !== 'verified')
      throw new Error('permission review required first')
    await lockUsers(tx, [userId])
    const [user] = await tx.select().from(users).where(eq(users.id, userId))
    if (
      !user ||
      user.deletedAt ||
      user.isBot ||
      !user.emailVerified ||
      user.activationStatus !== 'active' ||
      user.banned
    )
      throw new Error('recovery account has not been confirmed active')
    const credential = await tx
      .update(accounts)
      .set({ password: hash, updatedAt: deps.clock.now() })
      .where(and(eq(accounts.userId, userId), eq(accounts.providerId, 'credential')))
      .returning({ id: accounts.id })
    if (credential.length !== 1) throw new Error('one recovery password account required')
    await tx.insert(auditLogs).values({
      id: deps.newId(),
      action: 'restore.credential',
      targetType: 'user',
      targetId: userId,
      metadata: { epoch },
    })
  })
}

/** Source writer must be fenced, all watermarks must agree, and a confirmed administrator needs a new password. */
export async function unlockRecovery(
  deps: Deps,
  journal: EncryptedDeletionJournal,
  epoch: string,
  previousWriter: string,
  nextWriter: string,
) {
  if (epoch !== deps.config.auth.restoreEpoch || previousWriter === nextWriter)
    throw new Error('fresh recovery and writer generations required')
  await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('chatapp.deletion.dispatch'))`)
    const state = await isolatedState({ ...deps, db: tx }, epoch)
    const value = state.value as Record<string, unknown>
    if (value.permissions !== 'verified' || typeof value.permissionReview !== 'string')
      throw new Error('separate permission review required')
    if (value.objects !== 'verified' || typeof value.objectHash !== 'string')
      throw new Error('complete restored-object readback required')
    const [admin] = await tx
      .select({ id: users.id })
      .from(users)
      .innerJoin(accounts, eq(accounts.userId, users.id))
      .where(
        and(
          eq(users.role, 'admin'),
          eq(users.banned, false),
          eq(users.emailVerified, true),
          eq(users.activationStatus, 'active'),
          isNull(users.deletedAt),
          eq(accounts.providerId, 'credential'),
          sql`${accounts.password} is not null`,
        ),
      )
      .limit(1)
    if (!admin) throw new Error('confirmed administrator with a fresh credential required')
    const head = (await journal.head()).head
    if (
      head.seq !== value.seq ||
      head.hash !== value.hash ||
      ![previousWriter, nextWriter].includes(head.writerEpoch)
    )
      throw new Error('journal changed after replay; remain isolated')
    if (head.writerEpoch === previousWriter) await journal.rotateWriter(previousWriter, nextWriter)
    const final = (await journal.head()).head
    if (final.writerEpoch !== nextWriter || final.seq !== value.seq || final.hash !== value.hash)
      throw new Error('writer fencing failed')
    await tx.insert(auditLogs).values({
      id: deps.newId(),
      action: 'restore.unlock',
      targetType: 'restore',
      metadata: { epoch, reviewHash: value.permissionReview },
    })
    await tx.delete(appSettings).where(eq(appSettings.key, 'restore_state'))
  })
}
