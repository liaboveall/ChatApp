/**
 * Email verification, password reset and password change (D-076, docs/03 section 5.9 truth table).
 * Consumption of a credential and its effects commit in one transaction; request endpoints never reveal whether an
 * account exists. Every identity change that should end other sessions also moves the auth epoch and revokes
 * origins and delegations in the same transaction, so a stale session or an old email link cannot survive it.
 */
import { AppError, normalizeEmail } from '@chatapp/contracts'
import {
  accounts,
  authorizationOrigins,
  registrationInviteUses,
  sessions,
  users,
} from '@chatapp/db'
import { and, eq } from 'drizzle-orm'
import { writeAudit } from './audit.ts'
import {
  issueChallenge,
  lockUsableChallenge,
  markChallengeConsumed,
  revokeLiveChallenges,
} from './challenges.ts'
import type { Deps } from './deps.ts'
import { checkPassword } from './password-policy.ts'
import type { SessionPrincipal } from './principal.ts'
import {
  accountAllowsSession,
  bumpAuthEpoch,
  enqueueRevocationHint,
  lockAndRevalidate,
  revokeOrigins,
} from './sessions.ts'
import { inTransaction } from './tx.ts'

function passwordProblem(
  deps: Deps,
  password: string,
  user: { email: string; username: string; name: string },
) {
  return checkPassword(password, {
    email: user.email,
    username: user.username,
    displayName: user.name,
    productName: deps.config.product.name,
  })
}

function rejectPassword(problem: string): AppError {
  return new AppError('VALIDATION_FAILED', 'Password is not acceptable', {
    details: { field: 'password', reason: problem },
  })
}

// ───────────────────────── email verification ─────────────────────────

/** (Re)sends the verification email for a pending account. The caller answers identically in every case. */
export async function requestVerification(deps: Deps, input: { email: string }): Promise<void> {
  const email = normalizeEmail(input.email)
  await inTransaction(deps.db, async (tx) => {
    const [peek] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1)
    if (!peek) return
    const [user] = await tx.select().from(users).where(eq(users.id, peek.id)).for('update')
    if (!user) return
    if (user.activationStatus !== 'pending' || user.emailVerified || user.registrationId === null)
      return
    const [registration] = await tx
      .select({ status: registrationInviteUses.status })
      .from(registrationInviteUses)
      .where(eq(registrationInviteUses.id, user.registrationId))
      .limit(1)
    // Only a confirmed registration may be verified; the old credential dies when the new one is issued.
    if (registration?.status !== 'confirmed') return
    await issueChallenge(tx, deps, {
      user,
      registrationId: user.registrationId,
      purpose: 'verify_email',
    })
  })
}

/**
 * Consumes a verification credential: the email becomes verified and, because the registration is confirmed, the
 * account becomes active, all in one transaction. It does not sign anyone in.
 */
export async function consumeVerification(deps: Deps, input: { token: string }): Promise<void> {
  await inTransaction(deps.db, async (tx) => {
    const { challenge, user } = await lockUsableChallenge(tx, deps, input.token, 'verify_email')
    if (user.activationStatus !== 'pending' || user.emailVerified || user.registrationId === null) {
      throw new AppError('AUTH_CHALLENGE_INVALID', 'Credential is invalid, used or expired')
    }
    const [registration] = await tx
      .select({ status: registrationInviteUses.status })
      .from(registrationInviteUses)
      .where(eq(registrationInviteUses.id, user.registrationId))
      .for('update')
    if (registration?.status !== 'confirmed') {
      throw new AppError('AUTH_CHALLENGE_INVALID', 'Credential is invalid, used or expired')
    }
    await markChallengeConsumed(tx, deps, challenge.id)
    await tx
      .update(users)
      .set({
        emailVerified: true,
        activationStatus: 'active',
        meVersion: user.meVersion + 1,
      })
      .where(eq(users.id, user.id))
    await writeAudit(tx, { action: 'auth.email_verified', targetType: 'user', targetId: user.id })
  })
}

/** Operator action (admin:verify-email): same effects as consuming the credential, plus an audit trail. */
export async function verifyEmailManually(
  deps: Deps,
  input: { email: string; actor: string },
): Promise<boolean> {
  const email = normalizeEmail(input.email)
  return await inTransaction(deps.db, async (tx) => {
    const [peek] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1)
    if (!peek) return false
    const [user] = await tx.select().from(users).where(eq(users.id, peek.id)).for('update')
    if (!user || user.emailVerified) return false
    if (user.accountSource === 'registration') {
      if (user.registrationId === null) return false
      const [registration] = await tx
        .select({ status: registrationInviteUses.status })
        .from(registrationInviteUses)
        .where(eq(registrationInviteUses.id, user.registrationId))
        .for('update')
      if (registration?.status !== 'confirmed') return false
    }
    await revokeLiveChallenges(tx, deps, user.id, 'verify_email')
    await tx
      .update(users)
      .set({ emailVerified: true, activationStatus: 'active', meVersion: user.meVersion + 1 })
      .where(eq(users.id, user.id))
    await writeAudit(tx, {
      action: 'auth.email_verified_manually',
      targetType: 'user',
      targetId: user.id,
      metadata: { by: input.actor },
    })
    return true
  })
}

// ───────────────────────── password reset ─────────────────────────

/** Sends a reset link to an active, password-holding account. The caller answers identically in every case. */
export async function requestPasswordReset(deps: Deps, input: { email: string }): Promise<void> {
  const email = normalizeEmail(input.email)
  await inTransaction(deps.db, async (tx) => {
    const [peek] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1)
    if (!peek) return
    const [user] = await tx.select().from(users).where(eq(users.id, peek.id)).for('update')
    if (!user || !accountAllowsSession(user, deps.clock.now())) return
    const [credential] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.userId, user.id), eq(accounts.providerId, 'credential')))
      .limit(1)
    if (!credential) return
    await issueChallenge(tx, deps, {
      user,
      registrationId: user.registrationId,
      purpose: 'reset_password',
    })
  })
}

/**
 * Consumes a reset credential: new password, consumed credential, auth epoch +1, every session, origin and
 * delegation revoked, and a realtime hint, in one transaction. Nothing signs the user in.
 */
export async function consumePasswordReset(
  deps: Deps,
  input: { token: string; newPassword: string },
): Promise<void> {
  // Hash outside the lock; a bad token costs a hash but never touches a row.
  const passwordHash = await deps.passwords.hash(input.newPassword)
  await inTransaction(deps.db, async (tx) => {
    const { challenge, user } = await lockUsableChallenge(tx, deps, input.token, 'reset_password')
    if (!accountAllowsSession(user, deps.clock.now())) {
      throw new AppError('AUTH_CHALLENGE_INVALID', 'Credential is invalid, used or expired')
    }
    const problem = passwordProblem(deps, input.newPassword, user)
    if (problem !== null) throw rejectPassword(problem)

    const updated = await tx
      .update(accounts)
      .set({ password: passwordHash })
      .where(and(eq(accounts.userId, user.id), eq(accounts.providerId, 'credential')))
      .returning({ id: accounts.id })
    if (!updated[0])
      throw new AppError('AUTH_CHALLENGE_INVALID', 'Credential is invalid, used or expired')

    await markChallengeConsumed(tx, deps, challenge.id)
    await bumpAuthEpoch(tx, user.id)
    await revokeOrigins(tx, deps, user.id, { kind: 'all' }, 'password_reset')
    await revokeLiveChallenges(tx, deps, user.id)
    await writeAudit(tx, { action: 'auth.password_reset', targetType: 'user', targetId: user.id })
    await enqueueRevocationHint(tx, deps, user.id)
  })
}

// ───────────────────────── password change ─────────────────────────

/** A well-formed hash of a throw-away password, verified against when no credential exists, to keep timing alike. */
const DUMMY_HASH =
  'f8df1ab5c96c4b1ffc6ce0d46c9ac9a6:24d08966717baac431f4f1829ac7d7187d3f6ae36a9840adee2efcb364580af5222028e86b23c8c2067385e7d970fe56f07b71f5baae8bbf49900c1240866aa2'

/**
 * Changes the password of the signed-in user. The current session survives but is re-bound to a fresh origin under
 * the new epoch (docs/03 truth table): the old origin is revoked with everything it started, and every other
 * session and delegation ends.
 */
export async function changePassword(
  deps: Deps,
  principal: SessionPrincipal,
  input: { currentPassword: string; newPassword: string },
): Promise<void> {
  const [row] = await deps.db
    .select({ user: users, hash: accounts.password })
    .from(users)
    .innerJoin(accounts, and(eq(accounts.userId, users.id), eq(accounts.providerId, 'credential')))
    .where(eq(users.id, principal.userId))
    .limit(1)
  // Always verify something, so a missing credential costs the same as a wrong password.
  const verified = await deps.passwords.verify(row?.hash ?? DUMMY_HASH, input.currentPassword)
  if (!row?.hash || !verified) {
    throw new AppError('FORBIDDEN', 'Current password is incorrect', {
      details: { reason: 'wrong_password' },
    })
  }
  const problem = passwordProblem(deps, input.newPassword, row.user)
  if (problem !== null) throw rejectPassword(problem)
  const newHash = await deps.passwords.hash(input.newPassword)

  await inTransaction(deps.db, async (tx) => {
    const user = await lockAndRevalidate(tx, deps, principal)
    // The credential could have changed between the check above and the lock.
    const [current] = await tx
      .select({ password: accounts.password })
      .from(accounts)
      .where(and(eq(accounts.userId, user.id), eq(accounts.providerId, 'credential')))
      .for('update')
    if (current?.password !== row.hash)
      throw new AppError('CONFLICT', 'Password changed concurrently')

    await tx
      .update(accounts)
      .set({ password: newHash })
      .where(and(eq(accounts.userId, user.id), eq(accounts.providerId, 'credential')))
    const epoch = await bumpAuthEpoch(tx, user.id)

    // Re-bind the current session to a new origin and the new epoch first, then revoke every other origin.
    const [fresh] = await tx
      .insert(authorizationOrigins)
      .values({ userId: user.id, restoreEpoch: deps.config.auth.restoreEpoch })
      .returning({ id: authorizationOrigins.id })
    if (!fresh) throw new Error('origin was not created')
    await tx
      .update(sessions)
      .set({ authEpoch: epoch, authorizationOriginId: fresh.id })
      .where(eq(sessions.id, principal.sessionId))
    await revokeOrigins(
      tx,
      deps,
      user.id,
      { kind: 'except', originId: fresh.id },
      'password_changed',
    )

    await revokeLiveChallenges(tx, deps, user.id)
    await writeAudit(tx, {
      actorId: user.id,
      action: 'auth.password_changed',
      targetType: 'user',
      targetId: user.id,
    })
    await enqueueRevocationHint(tx, deps, user.id)
  })
}
