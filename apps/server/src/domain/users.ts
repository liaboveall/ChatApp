/**
 * The member directory (docs/05 sections 2 and 3.2): summaries for the `users` dictionaries of other responses, member
 * search for starting a direct message or adding people, and public profiles. Only active accounts (and the assistant)
 * can be found; a deleted account is shown as the anonymous placeholder its row already holds (INV-11).
 */
import {
  AppError,
  LIMITS,
  type UserProfile,
  type UserSummary,
  type UsersDictionary,
} from '@chatapp/contracts'
import { type DbOrTx, users } from '@chatapp/db'
import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import type { Deps } from './deps.ts'
import type { SessionPrincipal } from './principal.ts'

export type SummaryRow = Pick<
  typeof users.$inferSelect,
  'id' | 'profileVersion' | 'username' | 'name' | 'isBot' | 'deletedAt'
>

/** `avatarUrl` stays null until uploads exist (M3). */
export function toUserSummary(row: SummaryRow): UserSummary {
  return {
    id: row.id,
    profileVersion: row.profileVersion,
    username: row.username,
    displayName: row.name,
    avatarUrl: null,
    isBot: row.isBot,
    deleted: row.deletedAt !== null,
  }
}

const summaryColumns = {
  id: users.id,
  profileVersion: users.profileVersion,
  username: users.username,
  name: users.name,
  isBot: users.isBot,
  deletedAt: users.deletedAt,
}

export async function loadUserSummaries(
  db: DbOrTx,
  ids: Iterable<string | null | undefined>,
): Promise<Map<string, UserSummary>> {
  const wanted = [...new Set([...ids].filter((id): id is string => typeof id === 'string'))]
  const found = new Map<string, UserSummary>()
  if (wanted.length === 0) return found
  const rows = await db.select(summaryColumns).from(users).where(inArray(users.id, wanted))
  for (const row of rows) found.set(row.id, toUserSummary(row))
  return found
}

/** The `users` dictionary of a response: everyone it mentions, once. Unknown ids are simply absent. */
export async function usersDictionary(
  db: DbOrTx,
  ids: Iterable<string | null | undefined>,
): Promise<UsersDictionary> {
  return Object.fromEntries(await loadUserSummaries(db, ids))
}

const LIKE_SPECIALS = /[\\%_]/g

/** Finds members by username or display name, best matches first; never the searcher, bots or unfinished accounts. */
export async function searchUsers(
  deps: Pick<Deps, 'db'>,
  principal: SessionPrincipal,
  query: string,
): Promise<UserSummary[]> {
  const needle = query.normalize('NFKC').toLowerCase().trim()
  if (needle.length === 0) return []
  const contains = `%${needle.replace(LIKE_SPECIALS, '\\$&')}%`
  const prefix = `${needle.replace(LIKE_SPECIALS, '\\$&')}%`
  const rows = await deps.db
    .select(summaryColumns)
    .from(users)
    .where(
      and(
        eq(users.activationStatus, 'active'),
        eq(users.emailVerified, true),
        eq(users.isBot, false),
        isNull(users.deletedAt),
        ne(users.id, principal.userId),
        or(
          sql`lower(${users.username}) like ${contains} escape '\\'`,
          sql`lower(${users.name}) like ${contains} escape '\\'`,
        ),
      ),
    )
    .orderBy(
      desc(sql`(lower(${users.username}) = ${needle})`),
      desc(sql`(lower(${users.username}) like ${prefix} escape '\\')`),
      desc(sql`(lower(${users.name}) like ${prefix} escape '\\')`),
      users.username,
    )
    .limit(LIMITS.userSearchMax)
  return rows.map(toUserSummary)
}

export async function getUserProfile(deps: Pick<Deps, 'db'>, id: string): Promise<UserProfile> {
  const [row] = await deps.db
    .select({ ...summaryColumns, bio: users.bio, createdAt: users.createdAt })
    .from(users)
    .where(and(eq(users.id, id), eq(users.activationStatus, 'active')))
    .limit(1)
  if (!row) throw new AppError('NOT_FOUND', 'User not found')
  return {
    ...toUserSummary(row),
    bio: row.deletedAt === null ? row.bio : null,
    createdAt: row.createdAt.toISOString(),
  }
}
