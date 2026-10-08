/**
 * Sessions, devices and security revocation (docs/03 section 5.8-5.9, D-079).
 *
 * A session is only as good as its checks: the SDK vouches for the cookie and expiry, this module vouches for
 * the account state, the auth epoch and the device origin. Every security operation takes the user row lock first,
 * which serializes it against any write that re-validates its principal in its own transaction.
 */
import { AppError, type OriginRevokeReason } from '@chatapp/contracts'
import {
  agentRuns,
  authorizationOrigins,
  type DbOrTx,
  executionDelegations,
  sessions,
  type Tx,
  users,
} from '@chatapp/db'
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { writeAudit } from './audit.ts'
import type { Deps } from './deps.ts'
import type { SessionPrincipal } from './principal.ts'
import { inTransaction } from './tx.ts'
import { enqueueWork } from './work.ts'

type UserRow = typeof users.$inferSelect

/** Fields of a session row the SDK hands back; everything else is re-read here. */
export type SessionRecord = {
  id: string
  userId: string
  expiresAt: Date
  authEpoch: number
  authorizationOriginId: string
}

export type AccountGate = Pick<
  UserRow,
  'activationStatus' | 'emailVerified' | 'isBot' | 'banned' | 'banExpires' | 'deletedAt'
>

/** Single definition of "may this account hold a session right now" (INV-18, SEC-31). */
export function accountAllowsSession(user: AccountGate, now: Date): boolean {
  if (user.activationStatus !== 'active' || !user.emailVerified) return false
  if (user.isBot || user.deletedAt !== null) return false
  if (user.banned && (user.banExpires === null || user.banExpires > now)) return false
  return true
}

/**
 * Called when the SDK is about to create a session (password or passkey login). Refuses accounts that may not log
 * in and creates the device origin for this login; the session row then carries the user's current auth epoch.
 */
export async function beginLogin(
  deps: Deps,
  userId: string,
): Promise<{ authEpoch: number; originId: string }> {
  const [user] = await deps.db.select().from(users).where(eq(users.id, userId)).limit(1)
  if (!user || !accountAllowsSession(user, deps.clock.now())) {
    throw new AppError('FORBIDDEN', 'Account is not allowed to sign in', {
      details: { reason: 'account_not_active' },
    })
  }
  const [origin] = await deps.db
    .insert(authorizationOrigins)
    .values({ userId, restoreEpoch: deps.config.auth.restoreEpoch })
    .returning({ id: authorizationOrigins.id })
  if (!origin) throw new Error('origin was not created')
  return { authEpoch: user.authEpoch, originId: origin.id }
}

/**
 * Turns an SDK-verified session into a principal, or null when any check fails: expiry, account state, auth epoch,
 * origin ownership/revocation/restore generation. Called on every authenticated request (no cookie cache).
 */
export async function resolveSessionPrincipal(
  deps: Deps,
  session: SessionRecord,
): Promise<SessionPrincipal | null> {
  const now = deps.clock.now()
  if (session.expiresAt <= now) return null
  const [row] = await deps.db
    .select({ user: users, origin: authorizationOrigins })
    .from(users)
    .innerJoin(authorizationOrigins, eq(authorizationOrigins.id, session.authorizationOriginId))
    .where(eq(users.id, session.userId))
    .limit(1)
  if (!row) return null
  const { user, origin } = row
  if (!accountAllowsSession(user, now)) return null
  if (session.authEpoch !== user.authEpoch) return null
  if (origin.userId !== user.id || origin.revokedAt !== null || origin.endedAt !== null) return null
  if (origin.restoreEpoch !== deps.config.auth.restoreEpoch) return null
  return {
    kind: 'session',
    userId: user.id,
    sessionId: session.id,
    originId: origin.id,
    authEpoch: user.authEpoch,
    restoreEpoch: origin.restoreEpoch,
    role: user.role,
  }
}

/**
 * Locks user rows in id order, in one statement, so two transactions that name the same people can never wait for each
 * other (docs/03 section 5.1: users first, sorted by UUID). Ids that do not exist are simply absent from the result.
 */
export async function lockUsers(tx: Tx, userIds: readonly string[]): Promise<UserRow[]> {
  const ids = [...new Set(userIds)].sort()
  if (ids.length === 0) return []
  return await tx
    .select()
    .from(users)
    .where(inArray(users.id, ids))
    .orderBy(asc(users.id))
    .for('update')
}

/**
 * First step of every write on behalf of a session: lock the user row, then re-check that the principal is still
 * current. A security revocation that committed earlier makes this fail; one that starts later waits for the lock.
 * `alsoLock` names other people the operation changes (it allocates their personal sequence numbers): they are locked
 * together with the actor, in id order, before anything else.
 */
export async function lockAndRevalidate(
  tx: Tx,
  deps: Pick<Deps, 'clock' | 'config'>,
  principal: SessionPrincipal,
  options: { alsoLock?: readonly string[] } = {},
): Promise<UserRow> {
  const alsoLock = options.alsoLock ?? []
  const user =
    alsoLock.length === 0
      ? (await tx.select().from(users).where(eq(users.id, principal.userId)).for('update'))[0]
      : (await lockUsers(tx, [principal.userId, ...alsoLock])).find(
          (row) => row.id === principal.userId,
        )
  const now = deps.clock.now()
  if (!user || !accountAllowsSession(user, now) || user.authEpoch !== principal.authEpoch) {
    throw new AppError('UNAUTHENTICATED', 'Session is no longer valid')
  }
  const [origin] = await tx
    .select({
      revokedAt: authorizationOrigins.revokedAt,
      endedAt: authorizationOrigins.endedAt,
      restoreEpoch: authorizationOrigins.restoreEpoch,
    })
    .from(authorizationOrigins)
    .where(eq(authorizationOrigins.id, principal.originId))
    .limit(1)
  const [session] = await tx
    .select({ expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(eq(sessions.id, principal.sessionId))
    .limit(1)
  if (
    !origin ||
    origin.revokedAt !== null ||
    origin.endedAt !== null ||
    origin.restoreEpoch !== deps.config.auth.restoreEpoch ||
    !session ||
    session.expiresAt <= now
  ) {
    throw new AppError('UNAUTHENTICATED', 'Session is no longer valid')
  }
  return user
}

export type RevocationScope =
  | { kind: 'all' }
  | { kind: 'only'; originIds: readonly string[] }
  | { kind: 'except'; originId: string }

export type RevocationResult = {
  originIds: string[]
  delegationsRevoked: number
}

/**
 * Revokes origins of a user: marks them, ends their sessions and revokes the work they delegated, in one
 * transaction. Rows are locked in id order so concurrent revocations cannot deadlock. Caller holds the user lock.
 */
export async function revokeOrigins(
  tx: Tx,
  deps: Pick<Deps, 'clock'>,
  userId: string,
  scope: RevocationScope,
  reason: OriginRevokeReason,
): Promise<RevocationResult> {
  const now = deps.clock.now()
  const scopeCondition =
    scope.kind === 'only'
      ? scope.originIds.length > 0
        ? inArray(authorizationOrigins.id, [...scope.originIds])
        : sql`false`
      : scope.kind === 'except'
        ? ne(authorizationOrigins.id, scope.originId)
        : undefined
  const targets = await tx
    .select({ id: authorizationOrigins.id })
    .from(authorizationOrigins)
    .where(
      and(
        eq(authorizationOrigins.userId, userId),
        isNull(authorizationOrigins.revokedAt),
        scopeCondition,
      ),
    )
    .orderBy(asc(authorizationOrigins.id))
    .for('update')
  const originIds = targets.map((row) => row.id)
  if (originIds.length === 0) return { originIds, delegationsRevoked: 0 }

  await tx
    .update(authorizationOrigins)
    .set({ revokedAt: now, revokeReason: reason })
    .where(inArray(authorizationOrigins.id, originIds))
  await tx.delete(sessions).where(inArray(sessions.authorizationOriginId, originIds))

  const delegations = await tx
    .select({ id: executionDelegations.id })
    .from(executionDelegations)
    .where(
      and(
        inArray(executionDelegations.originId, originIds),
        eq(executionDelegations.status, 'active'),
      ),
    )
    .orderBy(asc(executionDelegations.id))
    .for('update')
  if (delegations.length > 0) {
    await tx
      .update(executionDelegations)
      .set({ status: 'revoked', revokedAt: now })
      .where(
        inArray(
          executionDelegations.id,
          delegations.map((row) => row.id),
        ),
      )
    await tx
      .update(agentRuns)
      .set({
        status: 'cancelled',
        cancelRequestedAt: now,
        finishedAt: now,
        leaseEpoch: sql`${agentRuns.leaseEpoch} + 1`,
        stateVersion: sql`${agentRuns.stateVersion} + 1`,
        leaseUntil: null,
        errorCode: 'UNAUTHENTICATED',
        errorMessage: 'Execution authorization is no longer valid',
      })
      .where(
        and(
          inArray(
            agentRuns.delegationId,
            delegations.map((d) => d.id),
          ),
          inArray(agentRuns.status, ['queued', 'running', 'awaiting_approval']),
        ),
      )
  }
  return { originIds, delegationsRevoked: delegations.length }
}

/** Raises the account's auth epoch, which invalidates every session and credential issued under the old one. */
export async function bumpAuthEpoch(tx: DbOrTx, userId: string): Promise<number> {
  const [row] = await tx
    .update(users)
    .set({ authEpoch: sql`${users.authEpoch} + 1` })
    .where(eq(users.id, userId))
    .returning({ authEpoch: users.authEpoch })
  if (!row) throw new Error('user vanished while bumping the auth epoch')
  return row.authEpoch
}

/** Durable hint for the realtime gateway: connections of this user re-check their session now (5 s poll backs it up). */
export async function enqueueRevocationHint(
  tx: DbOrTx,
  deps: Pick<Deps, 'newId' | 'clock'>,
  userId: string,
): Promise<void> {
  await enqueueWork(tx, deps, {
    kind: 'realtime',
    dedupeKey: `auth-revoked:${userId}:${deps.newId()}`,
    entityId: userId,
    payload: { event: 'auth.revoked' },
  })
}

/** Plain sign-out or expiry: ends this session; delegated work continues (docs/03 table, row 1). */
export async function endSession(
  deps: Deps,
  session: { id: string; userId: string; authorizationOriginId: string },
): Promise<void> {
  const now = deps.clock.now()
  await inTransaction(deps.db, async (tx) => {
    await tx.delete(sessions).where(eq(sessions.id, session.id))
    await tx
      .update(authorizationOrigins)
      .set({ endedAt: now })
      .where(
        and(
          eq(authorizationOrigins.id, session.authorizationOriginId),
          isNull(authorizationOrigins.endedAt),
          isNull(authorizationOrigins.revokedAt),
        ),
      )
    // Connections bound to this session close at once instead of at the next 5-second recheck (docs/05 section 4.1).
    await enqueueRevocationHint(tx, deps, session.userId)
  })
}

export type DeviceView = {
  originId: string
  current: boolean
  createdAt: Date
  lastActiveAt: Date
  ipAddress: string | null
  userAgent: string | null
}

export async function listDevices(deps: Deps, principal: SessionPrincipal): Promise<DeviceView[]> {
  const now = deps.clock.now()
  const rows = await deps.db
    .select({
      originId: authorizationOrigins.id,
      createdAt: authorizationOrigins.createdAt,
      lastActiveAt: sessions.updatedAt,
      ipAddress: sessions.ipAddress,
      userAgent: sessions.userAgent,
    })
    .from(authorizationOrigins)
    .innerJoin(sessions, eq(sessions.authorizationOriginId, authorizationOrigins.id))
    .where(
      and(
        eq(authorizationOrigins.userId, principal.userId),
        isNull(authorizationOrigins.revokedAt),
        isNull(authorizationOrigins.endedAt),
        sql`${sessions.expiresAt} > ${now}`,
      ),
    )
    .orderBy(asc(authorizationOrigins.createdAt))
  return rows.map((row) => ({ ...row, current: row.originId === principal.originId }))
}

/** "Revoke this device": the origin's sessions end and the work it started is cancelled. */
export async function revokeDevice(
  deps: Deps,
  principal: SessionPrincipal,
  originId: string,
): Promise<void> {
  await inTransaction(deps.db, async (tx) => {
    await lockAndRevalidate(tx, deps, principal)
    const [owned] = await tx
      .select({ id: authorizationOrigins.id })
      .from(authorizationOrigins)
      .where(
        and(
          eq(authorizationOrigins.id, originId),
          eq(authorizationOrigins.userId, principal.userId),
          isNull(authorizationOrigins.revokedAt),
        ),
      )
      .limit(1)
    if (!owned) throw new AppError('NOT_FOUND', 'Device not found')
    await revokeOrigins(
      tx,
      deps,
      principal.userId,
      { kind: 'only', originIds: [originId] },
      'device_revoked',
    )
    await writeAudit(tx, {
      actorId: principal.userId,
      action: 'auth.device_revoked',
      targetType: 'origin',
      targetId: originId,
    })
    await enqueueRevocationHint(tx, deps, principal.userId)
  })
}

/** "Sign out other devices": keeps the current origin, cancels work from the others. */
export async function revokeOtherDevices(deps: Deps, principal: SessionPrincipal): Promise<void> {
  await inTransaction(deps.db, async (tx) => {
    await lockAndRevalidate(tx, deps, principal)
    await revokeOrigins(
      tx,
      deps,
      principal.userId,
      { kind: 'except', originId: principal.originId },
      'other_devices_revoked',
    )
    await writeAudit(tx, { actorId: principal.userId, action: 'auth.other_devices_revoked' })
    await enqueueRevocationHint(tx, deps, principal.userId)
  })
}

/** "Security sign-out everywhere": every session ends, the epoch moves, all delegated work is revoked. */
export async function revokeAllDevices(deps: Deps, principal: SessionPrincipal): Promise<void> {
  await inTransaction(deps.db, async (tx) => {
    await lockAndRevalidate(tx, deps, principal)
    await bumpAuthEpoch(tx, principal.userId)
    await revokeOrigins(tx, deps, principal.userId, { kind: 'all' }, 'all_devices_revoked')
    await writeAudit(tx, { actorId: principal.userId, action: 'auth.all_devices_revoked' })
    await enqueueRevocationHint(tx, deps, principal.userId)
  })
}

export type SessionRef = {
  sessionId: string
  userId: string
  /** Epoch the connection was opened under. */
  authEpoch: number
  originId: string
}

/**
 * Batch check for long-lived connections (WebSocket): which of these sessions are still valid right now? One query for
 * all of them. A connection stays open only while its session, account, auth epoch and device origin all still check out.
 * Throws on database errors; callers must fail closed.
 */
export async function validateSessions(
  deps: Pick<Deps, 'db' | 'clock' | 'config'>,
  refs: readonly SessionRef[],
): Promise<Set<string>> {
  if (refs.length === 0) return new Set()
  const now = deps.clock.now()
  const rows = await deps.db
    .select({ session: sessions, user: users, origin: authorizationOrigins })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(authorizationOrigins, eq(authorizationOrigins.id, sessions.authorizationOriginId))
    .where(
      inArray(
        sessions.id,
        refs.map((ref) => ref.sessionId),
      ),
    )
  const expected = new Map(refs.map((ref) => [ref.sessionId, ref]))
  const valid = new Set<string>()
  for (const { session, user, origin } of rows) {
    const ref = expected.get(session.id)
    if (
      ref !== undefined &&
      ref.userId === user.id &&
      ref.originId === origin.id &&
      ref.authEpoch === user.authEpoch &&
      session.authEpoch === user.authEpoch &&
      session.expiresAt > now &&
      accountAllowsSession(user, now) &&
      origin.userId === user.id &&
      origin.revokedAt === null &&
      origin.endedAt === null &&
      origin.restoreEpoch === deps.config.auth.restoreEpoch
    ) {
      valid.add(session.id)
    }
  }
  return valid
}
