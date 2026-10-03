/**
 * What realtime needs from the database (docs/03 sections 5.6 and 6): which conversations a person is in (the topics
 * their connections follow), whether that set may have changed (their own log moved), and the last time they were seen.
 * Presence itself lives in Valkey; only the last-seen time is a fact worth keeping.
 */
import { conversationMembers, users } from '@chatapp/db'
import { eq, inArray } from 'drizzle-orm'
import type { Deps } from './deps.ts'

export type MembershipSnapshot = { userChangeSeq: number; conversationIds: Set<string> }

/**
 * For each person: the number of their own log at the moment of reading and the conversations they are in. The number is
 * read first, so a change that commits in between makes the snapshot look older than it is and costs one more refresh,
 * never a missed one.
 */
export async function loadMembershipSnapshots(
  deps: Pick<Deps, 'db'>,
  userIds: readonly string[],
): Promise<Map<string, MembershipSnapshot>> {
  const result = new Map<string, MembershipSnapshot>()
  if (userIds.length === 0) return result
  const seqs = await loadUserChangeSeqs(deps, userIds)
  const rows = await deps.db
    .select({
      userId: conversationMembers.userId,
      conversationId: conversationMembers.conversationId,
    })
    .from(conversationMembers)
    .where(inArray(conversationMembers.userId, [...userIds]))
  for (const id of userIds)
    result.set(id, { userChangeSeq: seqs.get(id) ?? 0, conversationIds: new Set() })
  for (const row of rows) result.get(row.userId)?.conversationIds.add(row.conversationId)
  return result
}

/** The cheap check behind the 5-second backstop: a person's own log only moves when their conversations may have. */
export async function loadUserChangeSeqs(
  deps: Pick<Deps, 'db'>,
  userIds: readonly string[],
): Promise<Map<string, number>> {
  if (userIds.length === 0) return new Map()
  const rows = await deps.db
    .select({ id: users.id, seq: users.userChangeSeq })
    .from(users)
    .where(inArray(users.id, [...userIds]))
  return new Map(rows.map((row) => [row.id, row.seq]))
}

/** Written when somebody's last connection goes (docs/03 section 5.6, step 5). */
export async function touchLastSeen(
  deps: Pick<Deps, 'db'>,
  userId: string,
  at: Date,
): Promise<void> {
  await deps.db.update(users).set({ lastSeenAt: at }).where(eq(users.id, userId))
}

export async function loadLastSeen(
  deps: Pick<Deps, 'db'>,
  userIds: readonly string[],
): Promise<Map<string, Date | null>> {
  if (userIds.length === 0) return new Map()
  const rows = await deps.db
    .select({ id: users.id, lastSeenAt: users.lastSeenAt })
    .from(users)
    .where(inArray(users.id, [...userIds]))
  return new Map(rows.map((row) => [row.id, row.lastSeenAt]))
}
