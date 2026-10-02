import { LIMITS, type Me } from '@chatapp/contracts'
import { users } from '@chatapp/db'
import { eq } from 'drizzle-orm'
import type { Deps } from './deps.ts'
import type { SessionPrincipal } from './principal.ts'

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
