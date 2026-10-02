/**
 * Registration invitations (docs/01 section 4.2, docs/05 section 3.2). Only the SHA-256 of a code is stored; the
 * plaintext is returned once, at creation. Creating a code costs nothing; a slot of the inviter's quota is taken when
 * somebody registers with it (see registration.ts).
 */
import {
  AppError,
  type CreatedInvite,
  type CreateInviteRequest,
  formatInviteCode,
  type Invite,
  type InviteRegistration,
  LIMITS,
  normalizeInviteCode,
} from '@chatapp/contracts'
import { registrationInvites, registrationInviteUses, users } from '@chatapp/db'
import { and, count, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm'
import { randomBase32, sha256Hex } from '../lib/crypto.ts'
import { isUniqueViolation } from '../lib/pg-error.ts'
import { writeAudit } from './audit.ts'
import type { Deps } from './deps.ts'
import type { SessionPrincipal } from './principal.ts'
import { accountAllowsSession, lockAndRevalidate } from './sessions.ts'
import { inTransaction } from './tx.ts'

const DAY_MS = 86_400_000

export const hashInviteCode = (normalizedCode: string): string =>
  sha256Hex(`invite:${normalizedCode}`)

const invalid = () =>
  new AppError('INVITE_INVALID', 'Invitation code is invalid, expired or used up')

function toDto(row: typeof registrationInvites.$inferSelect): Invite {
  return {
    id: row.id,
    note: row.note,
    maxUses: row.maxUses,
    useCount: row.useCount,
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

/** Is this code usable right now? Advisory only (registration re-checks under locks); every failure looks the same. */
export async function checkInvite(deps: Deps, rawCode: string): Promise<void> {
  const code = normalizeInviteCode(rawCode)
  if (code === null) throw invalid()
  const [row] = await deps.db
    .select({ invite: registrationInvites, inviter: users })
    .from(registrationInvites)
    .innerJoin(users, eq(users.id, registrationInvites.createdBy))
    .where(eq(registrationInvites.codeHash, hashInviteCode(code)))
    .limit(1)
  const now = deps.clock.now()
  if (
    !row ||
    row.invite.revokedAt !== null ||
    row.invite.expiresAt <= now ||
    (row.invite.maxUses !== null && row.invite.useCount >= row.invite.maxUses) ||
    !accountAllowsSession(row.inviter, now) ||
    (row.inviter.role !== 'admin' && row.inviter.invitesUsed >= row.inviter.inviteQuota)
  ) {
    throw invalid()
  }
}

export async function createInvite(
  deps: Deps,
  principal: SessionPrincipal,
  input: CreateInviteRequest,
): Promise<CreatedInvite> {
  const isAdmin = principal.role === 'admin'
  // `maxUses: null` means unlimited, which only administrators may ask for; omitted means one use.
  if (input.maxUses === null && !isAdmin) {
    throw new AppError('FORBIDDEN', 'Only administrators can create unlimited invitations')
  }
  const maxUses = input.maxUses === undefined ? LIMITS.inviteDefaultMaxUses : input.maxUses
  const now = deps.clock.now()
  const expiresAt = new Date(
    now.getTime() + (input.expiresInDays ?? LIMITS.inviteDefaultTtlDays) * DAY_MS,
  )

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const code = randomBase32(10)
    try {
      return await inTransaction(deps.db, async (tx) => {
        await lockAndRevalidate(tx, deps, principal)
        if (!isAdmin) {
          const [live] = await tx
            .select({ n: count() })
            .from(registrationInvites)
            .where(
              and(
                eq(registrationInvites.createdBy, principal.userId),
                isNull(registrationInvites.revokedAt),
                gt(registrationInvites.expiresAt, now),
              ),
            )
          if ((live?.n ?? 0) >= LIMITS.maxLiveInvitesPerMember) {
            throw new AppError(
              'QUOTA_EXCEEDED',
              'Too many live invitations; revoke or wait for some to expire',
            )
          }
        }
        const [row] = await tx
          .insert(registrationInvites)
          .values({
            codeHash: hashInviteCode(code),
            createdBy: principal.userId,
            note: input.note ?? null,
            maxUses,
            expiresAt,
          })
          .returning()
        if (!row) throw new Error('invite was not created')
        await writeAudit(tx, {
          actorId: principal.userId,
          action: 'invite.created',
          targetType: 'invite',
          targetId: row.id,
        })
        return { ...toDto(row), code: formatInviteCode(code) }
      })
    } catch (error) {
      // A 80-bit collision is not going to happen; retrying keeps the contract honest anyway.
      if (isUniqueViolation(error, 'registration_invites_code_hash_unique')) continue
      throw error
    }
  }
  throw new Error('could not generate a unique invitation code')
}

export async function listInvites(
  deps: Deps,
  principal: SessionPrincipal,
): Promise<{ invites: Invite[]; registrations: InviteRegistration[] }> {
  const rows = await deps.db
    .select()
    .from(registrationInvites)
    .where(eq(registrationInvites.createdBy, principal.userId))
    .orderBy(desc(registrationInvites.createdAt))
    .limit(100)
  // Registrations made with this member's codes whose email is still unverified: the inviter may withdraw them.
  const open = await deps.db
    .select({
      id: registrationInviteUses.id,
      inviteId: registrationInviteUses.inviteId,
      status: registrationInviteUses.status,
      username: users.username,
      createdAt: registrationInviteUses.createdAt,
    })
    .from(registrationInviteUses)
    .leftJoin(users, eq(users.id, registrationInviteUses.userId))
    .where(
      and(
        eq(registrationInviteUses.inviterId, principal.userId),
        inArray(registrationInviteUses.status, ['reserved', 'account_created', 'confirmed']),
        or(isNull(users.id), eq(users.emailVerified, false)),
      ),
    )
    .orderBy(desc(registrationInviteUses.createdAt))
    .limit(100)
  const registrations: InviteRegistration[] = []
  for (const row of open) {
    if (row.status === 'released') continue
    registrations.push({
      id: row.id,
      inviteId: row.inviteId,
      status: row.status,
      username: row.username,
      createdAt: row.createdAt.toISOString(),
    })
  }
  return { invites: rows.map(toDto), registrations }
}

export async function revokeInvite(
  deps: Deps,
  principal: SessionPrincipal,
  inviteId: string,
): Promise<void> {
  await inTransaction(deps.db, async (tx) => {
    await lockAndRevalidate(tx, deps, principal)
    const [row] = await tx
      .select()
      .from(registrationInvites)
      .where(eq(registrationInvites.id, inviteId))
      .for('update')
    if (!row || (row.createdBy !== principal.userId && principal.role !== 'admin')) {
      throw new AppError('NOT_FOUND', 'Invitation not found')
    }
    if (row.revokedAt !== null) return
    await tx
      .update(registrationInvites)
      .set({ revokedAt: deps.clock.now() })
      .where(eq(registrationInvites.id, inviteId))
    await writeAudit(tx, {
      actorId: principal.userId,
      action: 'invite.revoked',
      targetType: 'invite',
      targetId: inviteId,
    })
  })
}
