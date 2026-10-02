/**
 * One-time email credentials (D-076, docs/04 auth_challenges). A credential is a random 256-bit token whose SHA-256
 * is the only thing stored for lookup, bound to the user, registration, purpose, email digest and the auth/restore
 * generations it was issued under. A copy encrypted for the email worker lives in the same row until it is sent.
 */
import { AppError, type ChallengePurpose, LIMITS, normalizeEmail } from '@chatapp/contracts'
import { authChallenges, type Tx, users } from '@chatapp/db'
import { and, eq, isNull } from 'drizzle-orm'
import { randomToken, seal, sha256Hex } from '../lib/crypto.ts'
import type { Deps } from './deps.ts'
import { enqueueWork } from './work.ts'

type UserRow = typeof users.$inferSelect
type ChallengeRow = typeof authChallenges.$inferSelect

export const hashEmail = (email: string): string => sha256Hex(`email:${normalizeEmail(email)}`)
export const hashToken = (token: string): string => sha256Hex(`token:${token}`)

const INVALID = () =>
  new AppError('AUTH_CHALLENGE_INVALID', 'Credential is invalid, used or expired')

/**
 * Issues a credential and the work item that mails it, revoking any live credential of the same purpose first.
 * The caller holds the user row lock and passes the transaction of the business change.
 */
export async function issueChallenge(
  tx: Tx,
  deps: Deps,
  input: {
    user: Pick<UserRow, 'id' | 'email' | 'authEpoch'>
    registrationId: string | null
    purpose: ChallengePurpose
  },
): Promise<{ id: string; token: string }> {
  const now = deps.clock.now()
  await tx
    .update(authChallenges)
    .set({
      revokedAt: now,
      deliveryCiphertext: null,
      deliveryNonce: null,
      deliveryKeyVersion: null,
    })
    .where(
      and(
        eq(authChallenges.userId, input.user.id),
        eq(authChallenges.purpose, input.purpose),
        isNull(authChallenges.consumedAt),
        isNull(authChallenges.revokedAt),
      ),
    )

  const id = deps.newId()
  const token = randomToken(32)
  const sealed = seal(deps.config.auth.tokenEncryptionKey, token, id)
  await tx.insert(authChallenges).values({
    id,
    userId: input.user.id,
    registrationId: input.registrationId,
    purpose: input.purpose,
    emailHash: hashEmail(input.user.email),
    authEpoch: input.user.authEpoch,
    restoreEpoch: deps.config.auth.restoreEpoch,
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + LIMITS.authChallengeTtlMs),
    deliveryCiphertext: sealed.ciphertext,
    deliveryNonce: sealed.nonce,
    deliveryKeyVersion: sealed.keyVersion,
  })
  await enqueueWork(tx, deps, {
    kind: 'email',
    dedupeKey: `email:${id}`,
    entityId: id,
    payload: { purpose: input.purpose },
  })
  return { id, token }
}

/** Revokes live credentials of a purpose (resend, manual verification, security events). */
export async function revokeLiveChallenges(
  tx: Tx,
  deps: Pick<Deps, 'clock'>,
  userId: string,
  purpose?: ChallengePurpose,
): Promise<void> {
  await tx
    .update(authChallenges)
    .set({
      revokedAt: deps.clock.now(),
      deliveryCiphertext: null,
      deliveryNonce: null,
      deliveryKeyVersion: null,
    })
    .where(
      and(
        eq(authChallenges.userId, userId),
        purpose ? eq(authChallenges.purpose, purpose) : undefined,
        isNull(authChallenges.consumedAt),
        isNull(authChallenges.revokedAt),
      ),
    )
}

/**
 * Finds the credential for a token, locks its user and re-validates everything under the lock. Any failure is the
 * same generic error, so the response says nothing about accounts. The caller continues in the same transaction.
 */
export async function lockUsableChallenge(
  tx: Tx,
  deps: Deps,
  token: string,
  purpose: ChallengePurpose,
): Promise<{ challenge: ChallengeRow; user: UserRow }> {
  const [candidate] = await tx
    .select({ id: authChallenges.id, userId: authChallenges.userId })
    .from(authChallenges)
    .where(and(eq(authChallenges.tokenHash, hashToken(token)), eq(authChallenges.purpose, purpose)))
    .limit(1)
  if (!candidate) throw INVALID()

  // Lock order: user first, then the credential (docs/03 section 5.1).
  const [user] = await tx.select().from(users).where(eq(users.id, candidate.userId)).for('update')
  const [challenge] = await tx
    .select()
    .from(authChallenges)
    .where(eq(authChallenges.id, candidate.id))
    .for('update')
  if (!user || !challenge) throw INVALID()

  const now = deps.clock.now()
  if (challenge.consumedAt !== null || challenge.revokedAt !== null || challenge.expiresAt <= now) {
    throw INVALID()
  }
  if (
    challenge.authEpoch !== user.authEpoch ||
    challenge.restoreEpoch !== deps.config.auth.restoreEpoch ||
    challenge.emailHash !== hashEmail(user.email) ||
    challenge.registrationId !== user.registrationId
  ) {
    throw INVALID()
  }
  return { challenge, user }
}

export async function markChallengeConsumed(
  tx: Tx,
  deps: Pick<Deps, 'clock'>,
  challengeId: string,
): Promise<void> {
  await tx
    .update(authChallenges)
    .set({
      consumedAt: deps.clock.now(),
      deliveryCiphertext: null,
      deliveryNonce: null,
      deliveryKeyVersion: null,
    })
    .where(eq(authChallenges.id, challengeId))
}
