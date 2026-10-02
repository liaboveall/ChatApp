/**
 * Invitation-only registration as a recoverable activation state machine (D-059, docs/04 registration tables).
 *
 * `registerAccount` does the whole job in ONE transaction: it locks the inviter and the invite, atomically takes a
 * slot, writes the registration, inserts the account with its `registration_id` in the very first INSERT, links the
 * registration back, and creates the verification credential plus the email work item. A crash anywhere rolls all of
 * it back, so no half-registered state exists. The intermediate `reserved` / `account_created` states remain valid
 * rows (and `reconcileRegistrations` repairs them) because the schema and the spec allow multi-step creation.
 */
import {
  AppError,
  isReservedDisplayName,
  isReservedUsername,
  LIMITS,
  normalizeEmail,
  normalizeInviteCode,
} from '@chatapp/contracts'
import {
  accounts,
  registrationInvites,
  registrationInviteUses,
  type Tx,
  usernameReservations,
  users,
} from '@chatapp/db'
import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { sha256Hex } from '../lib/crypto.ts'
import { isUniqueViolation } from '../lib/pg-error.ts'
import { writeAudit } from './audit.ts'
import { issueChallenge } from './challenges.ts'
import type { Deps } from './deps.ts'
import { assertIdempotencyKey, claimIdempotency, completeIdempotency } from './idempotency.ts'
import { checkPassword } from './password-policy.ts'
import type { SessionPrincipal } from './principal.ts'
import { accountAllowsSession, lockAndRevalidate } from './sessions.ts'
import { inTransaction } from './tx.ts'

export type RegisterInput = {
  email: string
  username: string
  displayName: string
  password: string
  /** As typed by the user, from the X-Invite-Code header. */
  inviteCode: string
  idempotencyKey: string
  requestId?: string
}

/** Always this, whether the email was new or already known: registration reveals nothing about existing accounts. */
export type RegisterResult = { status: 'verification_required' }

const ACCEPTED: RegisterResult = { status: 'verification_required' }
const invalidInvite = () =>
  new AppError('INVITE_INVALID', 'Invitation code is invalid, expired or used up')

/** Thrown inside the transaction to roll it back and answer with the generic success (email already registered). */
class AlreadyRegistered extends Error {}

export async function registerAccount(deps: Deps, input: RegisterInput): Promise<RegisterResult> {
  const email = normalizeEmail(input.email)
  const inviteCode = normalizeInviteCode(input.inviteCode)
  if (inviteCode === null) throw invalidInvite()
  assertIdempotencyKey(input.idempotencyKey)

  const extraNames = [deps.config.product.agentUsername, deps.config.product.name]
  if (isReservedUsername(input.username, extraNames)) {
    throw new AppError('VALIDATION_FAILED', 'Username is reserved', {
      details: { field: 'username', reason: 'reserved' },
    })
  }
  if (
    isReservedDisplayName(input.displayName, [
      deps.config.product.agentDisplayName,
      deps.config.product.name,
    ])
  ) {
    throw new AppError('VALIDATION_FAILED', 'Display name is reserved', {
      details: { field: 'name', reason: 'reserved' },
    })
  }
  const problem = checkPassword(input.password, {
    email,
    username: input.username,
    displayName: input.displayName,
    productName: deps.config.product.name,
  })
  if (problem !== null) {
    throw new AppError('VALIDATION_FAILED', 'Password is not acceptable', {
      details: { field: 'password', reason: problem },
    })
  }

  // Hash before taking any lock, and always, so a known email costs the same time as a new one.
  const passwordHash = await deps.passwords.hash(input.password)
  const codeHash = sha256Hex(`invite:${inviteCode}`)
  const requestHash = sha256Hex(
    JSON.stringify({ v: 1, email, username: input.username, name: input.displayName }),
  )

  try {
    return await inTransaction(deps.db, async (tx) => {
      const now = deps.clock.now()
      const claim = await claimIdempotency(
        tx,
        deps,
        {
          actorKey: 'anonymous',
          operation: 'register',
          targetKey: codeHash,
          key: input.idempotencyKey,
        },
        requestHash,
      )
      if (claim.status === 'replay') return ACCEPTED

      // Lock order: inviter, then invite (docs/03 section 5.1). The invite is looked up unlocked only to find the inviter.
      const [found] = await tx
        .select({ id: registrationInvites.id, createdBy: registrationInvites.createdBy })
        .from(registrationInvites)
        .where(eq(registrationInvites.codeHash, codeHash))
        .limit(1)
      if (!found) throw invalidInvite()
      const [inviter] = await tx
        .select()
        .from(users)
        .where(eq(users.id, found.createdBy))
        .for('update')
      const [invite] = await tx
        .select()
        .from(registrationInvites)
        .where(eq(registrationInvites.id, found.id))
        .for('update')
      if (
        !inviter ||
        !invite ||
        !accountAllowsSession(inviter, now) ||
        invite.revokedAt !== null ||
        invite.expiresAt <= now ||
        (invite.maxUses !== null && invite.useCount >= invite.maxUses) ||
        (inviter.role !== 'admin' && inviter.invitesUsed >= inviter.inviteQuota)
      ) {
        throw invalidInvite()
      }

      const [knownEmail] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1)
      if (knownEmail) throw new AlreadyRegistered()

      const [takenName] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, input.username))
        .limit(1)
      const [reservation] = await tx
        .select({ reservedUntil: usernameReservations.reservedUntil })
        .from(usernameReservations)
        .where(eq(usernameReservations.username, input.username))
        .limit(1)
      if (
        takenName ||
        (reservation && (reservation.reservedUntil === null || reservation.reservedUntil > now))
      ) {
        throw new AppError('CONFLICT', 'Username is not available', {
          details: { field: 'username', reason: 'taken' },
        })
      }

      // Take the slot. The conditions repeat the checks above so the update itself is the guard even if lock order ever changes.
      const slot = await tx
        .update(registrationInvites)
        .set({ useCount: sql`${registrationInvites.useCount} + 1` })
        .where(
          and(
            eq(registrationInvites.id, invite.id),
            isNull(registrationInvites.revokedAt),
            gt(registrationInvites.expiresAt, now),
            or(
              isNull(registrationInvites.maxUses),
              lt(registrationInvites.useCount, registrationInvites.maxUses),
            ),
          ),
        )
        .returning({ id: registrationInvites.id })
      const quota = await tx
        .update(users)
        .set({ invitesUsed: sql`${users.invitesUsed} + 1` })
        .where(
          and(
            eq(users.id, inviter.id),
            or(eq(users.role, 'admin'), lt(users.invitesUsed, users.inviteQuota)),
          ),
        )
        .returning({ id: users.id })
      if (!slot[0] || !quota[0]) throw invalidInvite()

      const registrationId = deps.newId()
      await tx.insert(registrationInviteUses).values({
        id: registrationId,
        inviteId: invite.id,
        inviterId: inviter.id,
        emailNormalized: email,
        requestHash,
        status: 'reserved',
        leaseEpoch: 1,
        leaseUntil: new Date(now.getTime() + LIMITS.registrationReservationTtlMs),
        expiresAt: new Date(now.getTime() + LIMITS.registrationReservationTtlMs),
      })

      // The account's first INSERT carries the registration id and stays pending until the email is verified.
      const userId = deps.newId()
      try {
        await tx.transaction(async (savepoint) => {
          await savepoint.insert(users).values({
            id: userId,
            name: input.displayName,
            email,
            username: input.username,
            accountSource: 'registration',
            registrationId,
            activationStatus: 'pending',
            emailVerified: false,
            invitedById: inviter.id,
          })
        })
      } catch (error) {
        if (isUniqueViolation(error, 'users_email_unique')) throw new AlreadyRegistered()
        if (isUniqueViolation(error, 'users_username_unique')) {
          throw new AppError('CONFLICT', 'Username is not available', {
            details: { field: 'username', reason: 'taken' },
          })
        }
        throw error
      }
      await tx.insert(accounts).values({
        userId,
        accountId: userId,
        providerId: 'credential',
        password: passwordHash,
      })
      await tx
        .update(registrationInviteUses)
        .set({ userId, status: 'confirmed', confirmedAt: now, leaseUntil: null })
        .where(eq(registrationInviteUses.id, registrationId))

      await issueChallenge(tx, deps, {
        user: { id: userId, email, authEpoch: 0 },
        registrationId,
        purpose: 'verify_email',
      })
      await completeIdempotency(tx, claim.id, { type: 'registration', id: registrationId })
      await writeAudit(tx, {
        action: 'auth.registered',
        targetType: 'user',
        targetId: userId,
        metadata: { inviterId: inviter.id },
        requestId: input.requestId,
      })
      return ACCEPTED
    })
  } catch (error) {
    if (error instanceof AlreadyRegistered) return ACCEPTED
    throw error
  }
}

type Registration = typeof registrationInviteUses.$inferSelect

/**
 * Releases a registration and refunds its slot exactly once (the status change is the gate): the invite's use
 * count and the inviter's `invites_used` each go down by one and personal fields are cleared. If an unverified
 * account is still linked it is deleted (cascading its sessions, credentials and passkeys).
 * Lock order: both users by id, then the invite, then the registration.
 */
async function releaseRegistration(
  tx: Tx,
  deps: Pick<Deps, 'clock'>,
  registrationId: string,
  options: { deleteAccount: boolean },
): Promise<boolean> {
  const [peek] = await tx
    .select()
    .from(registrationInviteUses)
    .where(eq(registrationInviteUses.id, registrationId))
    .limit(1)
  if (!peek || peek.status === 'released') return false

  const accountId = peek.userId
  const userIds = [
    ...new Set([peek.inviterId, accountId].filter((id): id is string => id !== null)),
  ].sort()
  const locked = await tx
    .select()
    .from(users)
    .where(inArray(users.id, userIds))
    .orderBy(asc(users.id))
    .for('update')
  await tx
    .select({ id: registrationInvites.id })
    .from(registrationInvites)
    .where(eq(registrationInvites.id, peek.inviteId))
    .for('update')
  const [registration] = await tx
    .select()
    .from(registrationInviteUses)
    .where(eq(registrationInviteUses.id, registrationId))
    .for('update')
  if (!registration || registration.status === 'released') return false

  if (accountId !== null) {
    const account = locked.find((row) => row.id === accountId)
    // An account that became active is a real member now: it is never swept away by cleanup.
    if (account && account.activationStatus === 'active') return false
    if (account && options.deleteAccount) await tx.delete(users).where(eq(users.id, accountId))
  }

  const gate = await tx
    .update(registrationInviteUses)
    .set({
      status: 'released',
      releasedAt: deps.clock.now(),
      userId: null,
      emailNormalized: null,
      requestHash: null,
      leaseUntil: null,
    })
    .where(
      and(
        eq(registrationInviteUses.id, registrationId),
        inArray(registrationInviteUses.status, ['reserved', 'account_created', 'confirmed']),
      ),
    )
    .returning({ id: registrationInviteUses.id })
  if (!gate[0]) return false
  await tx
    .update(registrationInvites)
    .set({ useCount: sql`greatest(${registrationInvites.useCount} - 1, 0)` })
    .where(eq(registrationInvites.id, registration.inviteId))
  await tx
    .update(users)
    .set({ invitesUsed: sql`greatest(${users.invitesUsed} - 1, 0)` })
    .where(eq(users.id, registration.inviterId))
  return true
}

/** The inviter (or a site administrator) withdraws a registration whose email was never verified. */
export async function revokeRegistration(
  deps: Deps,
  principal: SessionPrincipal,
  registrationId: string,
): Promise<void> {
  await inTransaction(deps.db, async (tx) => {
    await lockAndRevalidate(tx, deps, principal)
    const [registration] = await tx
      .select()
      .from(registrationInviteUses)
      .where(eq(registrationInviteUses.id, registrationId))
      .limit(1)
    const allowed =
      registration && (registration.inviterId === principal.userId || principal.role === 'admin')
    if (!registration || !allowed || registration.status === 'released') {
      throw new AppError('NOT_FOUND', 'Registration not found')
    }
    const released = await releaseRegistration(tx, deps, registrationId, { deleteAccount: true })
    if (!released) throw new AppError('CONFLICT', 'Registration can no longer be withdrawn')
    await writeAudit(tx, {
      actorId: principal.userId,
      action: 'auth.registration_revoked',
      targetType: 'registration',
      targetId: registrationId,
    })
  })
}

export type ReconcileResult = { released: number; completed: number; purged: number }

/**
 * Repairs and cleans registrations (docs/04 rules 3-6), run by the worker every minute. Each registration is handled
 * in its own transaction so one failure does not block the rest.
 *  - `reserved` past its lease: if an account is already linked, finish the confirmation; otherwise release.
 *  - `account_created`: finish the confirmation (link both ways, issue the credential).
 *  - `confirmed` with an account still unverified after 7 days: delete the account and refund the slot.
 */
export async function reconcileRegistrations(deps: Deps, limit = 50): Promise<ReconcileResult> {
  const now = deps.clock.now()
  const result: ReconcileResult = { released: 0, completed: 0, purged: 0 }

  const open = await deps.db
    .select({ id: registrationInviteUses.id })
    .from(registrationInviteUses)
    .where(
      and(
        inArray(registrationInviteUses.status, ['reserved', 'account_created']),
        lt(registrationInviteUses.expiresAt, now),
      ),
    )
    .orderBy(asc(registrationInviteUses.expiresAt))
    .limit(limit)
  for (const { id } of open) {
    const outcome = await inTransaction(deps.db, (tx) => settleOpenRegistration(tx, deps, id))
    if (outcome === 'completed') result.completed += 1
    if (outcome === 'released') result.released += 1
  }

  const cutoff = new Date(now.getTime() - LIMITS.unverifiedAccountTtlDays * 86_400_000)
  const stale = await deps.db
    .select({ id: registrationInviteUses.id })
    .from(registrationInviteUses)
    .innerJoin(users, eq(users.id, registrationInviteUses.userId))
    .where(
      and(
        eq(registrationInviteUses.status, 'confirmed'),
        eq(users.activationStatus, 'pending'),
        lt(users.createdAt, cutoff),
      ),
    )
    .limit(limit)
  for (const { id } of stale) {
    const purged = await inTransaction(deps.db, (tx) =>
      releaseRegistration(tx, deps, id, { deleteAccount: true }),
    )
    if (purged) result.purged += 1
  }
  return result
}

async function settleOpenRegistration(
  tx: Tx,
  deps: Deps,
  registrationId: string,
): Promise<'completed' | 'released' | 'unchanged'> {
  const [registration]: Registration[] = await tx
    .select()
    .from(registrationInviteUses)
    .where(eq(registrationInviteUses.id, registrationId))
    .limit(1)
  if (!registration || !['reserved', 'account_created'].includes(registration.status))
    return 'unchanged'

  // Timeout alone never decides: first find out whether an account exists for this registration.
  const [account] = await tx
    .select()
    .from(users)
    .where(eq(users.registrationId, registrationId))
    .for('update')
  if (!account) {
    return (await releaseRegistration(tx, deps, registrationId, { deleteAccount: false }))
      ? 'released'
      : 'unchanged'
  }
  const now = deps.clock.now()
  const [confirmed] = await tx
    .update(registrationInviteUses)
    .set({ userId: account.id, status: 'confirmed', confirmedAt: now, leaseUntil: null })
    .where(
      and(
        eq(registrationInviteUses.id, registrationId),
        inArray(registrationInviteUses.status, ['reserved', 'account_created']),
      ),
    )
    .returning({ id: registrationInviteUses.id })
  if (!confirmed) return 'unchanged'
  if (account.activationStatus === 'pending') {
    await issueChallenge(tx, deps, {
      user: { id: account.id, email: account.email, authEpoch: account.authEpoch },
      registrationId,
      purpose: 'verify_email',
    })
  }
  return 'completed'
}
