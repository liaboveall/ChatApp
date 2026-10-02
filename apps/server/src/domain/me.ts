import { AppError, LIMITS, type Me, type PatchMeRequest } from '@chatapp/contracts'
import { users } from '@chatapp/db'
import { and, eq, sql } from 'drizzle-orm'
import type { Deps } from './deps.ts'
import type { SessionPrincipal } from './principal.ts'
import { inTransaction } from './tx.ts'

/** The signed-in user's own view (docs/05 section 2). `avatarUrl` stays null until uploads arrive in M3. */
export async function getMe(deps: Deps, principal: SessionPrincipal): Promise<Me | null> {
  const [user] = await deps.db.select().from(users).where(eq(users.id, principal.userId)).limit(1)
  if (!user) return null
  return {
    id: user.id,
    profileVersion: user.profileVersion,
    username: user.username,
    displayName: user.name,
    avatarUrl: null,
    isBot: user.isBot,
    deleted: user.deletedAt !== null,
    meVersion: user.meVersion,
    authEpoch: user.authEpoch,
    restoreEpoch: deps.config.auth.restoreEpoch,
    email: user.email,
    role: user.role,
    bio: user.bio,
    locale: user.locale,
    timezone: user.timezone,
    settings: user.settings,
    inviteQuota: user.inviteQuota,
    invitesUsed: user.invitesUsed,
    storageUsedBytes: user.storageUsedBytes,
    storageQuotaBytes: user.storageQuotaBytes ?? LIMITS.defaultStorageQuotaBytes,
    aiDailyTokens: user.aiDailyTokens ?? LIMITS.defaultAiDailyTokens,
  }
}

/**
 * Changes the signed-in user's own settings (docs/05 section 3.1). The write is conditional on `meVersion`, so two
 * devices changing the time zone at once cannot silently overwrite each other (D-082): the loser gets VERSION_CONFLICT
 * and reloads. Settings are merged key by key, never replaced.
 */
export async function updateMe(
  deps: Deps,
  principal: SessionPrincipal,
  input: PatchMeRequest,
): Promise<Me> {
  await inTransaction(deps.db, async (tx) => {
    const settings = input.settings ?? {}
    const changed = await tx
      .update(users)
      .set({
        ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
        ...(Object.keys(settings).length === 0
          ? {}
          : { settings: sql`${users.settings} || ${JSON.stringify(settings)}::text::jsonb` }),
        meVersion: sql`${users.meVersion} + 1`,
        updatedAt: deps.clock.now(),
      })
      .where(and(eq(users.id, principal.userId), eq(users.meVersion, input.expectedMeVersion)))
      .returning({ id: users.id })
    if (changed.length > 0) return
    const [exists] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, principal.userId))
      .limit(1)
    if (!exists) throw new AppError('NOT_FOUND', 'User not found')
    throw new AppError('VERSION_CONFLICT', 'Your settings changed elsewhere; reload and try again')
  })
  const me = await getMe(deps, principal)
  if (!me) throw new AppError('NOT_FOUND', 'User not found')
  return me
}
