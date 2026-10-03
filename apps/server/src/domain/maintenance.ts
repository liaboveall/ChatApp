/**
 * Retention and cleanup (docs/04 section 10), run by the worker. Every function is idempotent and bounded, so a restart
 * in the middle loses nothing and a backlog is worked off over several runs. Nothing here touches active business data.
 */
import { LIMITS } from '@chatapp/contracts'
import {
  authChallenges,
  authorizationOrigins,
  conversationInvites,
  executionDelegations,
  idempotencyRecords,
  registrationInviteUses,
  sessions,
  userConversationStates,
  usernameReservations,
  verifications,
} from '@chatapp/db'
import { and, eq, inArray, isNull, lt, notExists, or, sql } from 'drizzle-orm'
import type { Deps } from './deps.ts'

const DAY_MS = 86_400_000
const BATCH = 1000

export type MaintenanceResult = Record<string, number>

/**
 * Sessions past their expiry end here: their origin gets `ended_at` (natural expiry, work it delegated continues) and
 * the session rows go. Origins that are long over and unreferenced are removed last (docs/04: origin is cleaned last).
 */
export async function purgeSessionsAndOrigins(deps: Deps): Promise<MaintenanceResult> {
  const now = deps.clock.now()
  const expired = await deps.db
    .select({ id: sessions.id, originId: sessions.authorizationOriginId })
    .from(sessions)
    .where(lt(sessions.expiresAt, now))
    .limit(BATCH)
  if (expired.length > 0) {
    await deps.db
      .update(authorizationOrigins)
      .set({ endedAt: now })
      .where(
        and(
          inArray(authorizationOrigins.id, [...new Set(expired.map((row) => row.originId))]),
          isNull(authorizationOrigins.endedAt),
          isNull(authorizationOrigins.revokedAt),
        ),
      )
    await deps.db.delete(sessions).where(
      inArray(
        sessions.id,
        expired.map((row) => row.id),
      ),
    )
  }

  // Terminal delegations older than 30 days go first, then origins nothing refers to any more.
  const cutoff = new Date(now.getTime() - 30 * DAY_MS)
  const oldDelegations = await deps.db
    .delete(executionDelegations)
    .where(
      and(
        inArray(executionDelegations.status, ['revoked', 'completed', 'expired']),
        lt(executionDelegations.createdAt, cutoff),
      ),
    )
    .returning({ id: executionDelegations.id })
  const origins = await deps.db
    .delete(authorizationOrigins)
    .where(
      and(
        or(lt(authorizationOrigins.endedAt, cutoff), lt(authorizationOrigins.revokedAt, cutoff)),
        notExists(
          deps.db
            .select({ one: sql`1` })
            .from(sessions)
            .where(sql`${sessions.authorizationOriginId} = ${authorizationOrigins.id}`),
        ),
        notExists(
          deps.db
            .select({ one: sql`1` })
            .from(executionDelegations)
            .where(sql`${executionDelegations.originId} = ${authorizationOrigins.id}`),
        ),
      ),
    )
    .returning({ id: authorizationOrigins.id })
  return {
    sessionsExpired: expired.length,
    delegationsPurged: oldDelegations.length,
    originsPurged: origins.length,
  }
}

/**
 * The sync logs keep seven days (docs/04 section 10). Purging records how far each log was cut, in the same statement as
 * the delete: a client whose position is below that floor can no longer be replayed and is told to rebuild (D-126). Left
 * conversations keep their tombstone for as long as any cursor could refer to it, then it goes too.
 */
export async function purgeSyncLogs(deps: Deps): Promise<MaintenanceResult> {
  const now = deps.clock.now()
  const cutoff = new Date(now.getTime() - LIMITS.changeLogRetentionDays * DAY_MS)
  const conversationRows = await deps.db.execute<{ id: string }>(sql`
    with purged as (
      delete from conversation_changes
      where (conversation_id, change_seq) in (
        select conversation_id, change_seq from conversation_changes where created_at < ${cutoff} limit ${BATCH * 5}
      )
      returning conversation_id, change_seq
    ), tops as (
      select conversation_id, max(change_seq) as top from purged group by conversation_id
    )
    update conversations c set change_log_floor = greatest(c.change_log_floor, tops.top)
    from tops where c.id = tops.conversation_id
    returning c.id
  `)
  const userRows = await deps.db.execute<{ id: string }>(sql`
    with purged as (
      delete from user_changes
      where (user_id, change_seq) in (
        select user_id, change_seq from user_changes where created_at < ${cutoff} limit ${BATCH * 5}
      )
      returning user_id, change_seq
    ), tops as (
      select user_id, max(change_seq) as top from purged group by user_id
    )
    update users u set change_log_floor = greatest(u.change_log_floor, tops.top)
    from tops where u.id = tops.user_id
    returning u.id
  `)
  const tombstones = await deps.db
    .delete(userConversationStates)
    .where(
      and(
        eq(userConversationStates.state, 'removed'),
        lt(
          userConversationStates.updatedAt,
          new Date(now.getTime() - LIMITS.removedStateRetentionDays * DAY_MS),
        ),
      ),
    )
    .returning({ conversationId: userConversationStates.conversationId })
  // Links that ended long ago are only clutter.
  const links = await deps.db
    .delete(conversationInvites)
    .where(
      or(
        lt(conversationInvites.expiresAt, new Date(now.getTime() - 30 * DAY_MS)),
        lt(conversationInvites.revokedAt, new Date(now.getTime() - 30 * DAY_MS)),
      ),
    )
    .returning({ id: conversationInvites.id })
  return {
    conversationsTrimmed: conversationRows.length,
    usersTrimmed: userRows.length,
    removedTombstones: tombstones.length,
    conversationInvites: links.length,
  }
}

export async function purgeExpiredRecords(deps: Deps): Promise<MaintenanceResult> {
  const now = deps.clock.now()
  const idempotency = await deps.db
    .delete(idempotencyRecords)
    .where(lt(idempotencyRecords.expiresAt, now))
    .returning({ id: idempotencyRecords.id })

  // Credentials: the encrypted delivery copy goes as soon as a credential is dead; metadata is kept for 7 days.
  await deps.db
    .update(authChallenges)
    .set({ deliveryCiphertext: null, deliveryNonce: null, deliveryKeyVersion: null })
    .where(
      and(lt(authChallenges.expiresAt, now), sql`${authChallenges.deliveryCiphertext} is not null`),
    )
  const metadataCutoff = new Date(
    now.getTime() - LIMITS.authChallengeMetadataRetentionDays * DAY_MS,
  )
  const challenges = await deps.db
    .delete(authChallenges)
    .where(
      or(
        lt(authChallenges.expiresAt, metadataCutoff),
        lt(authChallenges.consumedAt, metadataCutoff),
        lt(authChallenges.revokedAt, metadataCutoff),
      ),
    )
    .returning({ id: authChallenges.id })

  const ceremonies = await deps.db
    .delete(verifications)
    .where(lt(verifications.expiresAt, new Date(now.getTime() - DAY_MS)))
    .returning({ id: verifications.id })
  const released = await deps.db
    .delete(registrationInviteUses)
    .where(
      and(
        sql`${registrationInviteUses.status} = 'released'`,
        lt(
          registrationInviteUses.releasedAt,
          new Date(now.getTime() - LIMITS.releasedRegistrationRetentionDays * DAY_MS),
        ),
      ),
    )
    .returning({ id: registrationInviteUses.id })
  const names = await deps.db
    .delete(usernameReservations)
    .where(lt(usernameReservations.reservedUntil, now))
    .returning({ username: usernameReservations.username })
  return {
    idempotencyRecords: idempotency.length,
    authChallenges: challenges.length,
    passkeyCeremonies: ceremonies.length,
    releasedRegistrations: released.length,
    usernameReservations: names.length,
  }
}
