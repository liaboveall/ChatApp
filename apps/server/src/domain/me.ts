import {
  AppError,
  isReservedDisplayName,
  isReservedUsername,
  LIMITS,
  type Me,
  type PatchMeRequest,
} from '@chatapp/contracts'
import { type DbOrTx, usernameReservations, users } from '@chatapp/db'
import { and, eq, sql } from 'drizzle-orm'
import { isUniqueViolation } from '../lib/pg-error.ts'
import { recordUserChange } from './changes.ts'
import type { Deps } from './deps.ts'
import type { SessionPrincipal } from './principal.ts'
import { lockAndRevalidate } from './sessions.ts'
import { inTransaction } from './tx.ts'

const DAY_MS = 86_400_000

/** The user's own view (docs/05 section 2). `avatarUrl` stays null until uploads arrive in M3. */
export async function loadMe(
  db: DbOrTx,
  deps: Pick<Deps, 'config'>,
  userId: string,
): Promise<Me | null> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
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

export async function getMe(deps: Deps, principal: SessionPrincipal): Promise<Me | null> {
  return await loadMe(deps.db, deps, principal.userId)
}

const taken = () =>
  new AppError('CONFLICT', 'Username is not available', {
    details: { field: 'username', reason: 'taken' },
  })

/**
 * Changes the signed-in user's own profile and settings (docs/05 section 3.1). The write is conditional on `meVersion`,
 * so two devices changing something at once cannot silently overwrite each other (D-082): the loser gets
 * VERSION_CONFLICT and reloads. Settings are merged key by key, never replaced.
 *
 * The public profile follows docs/01 section 4.3 (D-133): the display name may not be a reserved word; the username has
 * the same rules as at registration, may change once in 30 days, and the name given up stays reserved for 30 days
 * (L-19). A change of the public fields moves `profileVersion` (so every `users` dictionary refreshes), and every change
 * is written to the person's own log so their other devices pick it up.
 */
export async function updateMe(
  deps: Deps,
  principal: SessionPrincipal,
  input: PatchMeRequest,
): Promise<Me> {
  try {
    await inTransaction(deps.db, async (tx) => {
      const now = deps.clock.now()
      const user = await lockAndRevalidate(tx, deps, principal)
      if (user.meVersion !== input.expectedMeVersion) {
        throw new AppError(
          'VERSION_CONFLICT',
          'Your settings changed elsewhere; reload and try again',
          {
            details: { meVersion: user.meVersion },
          },
        )
      }

      const set: Partial<typeof users.$inferInsert> = {}
      let publicChange = false

      if (input.displayName !== undefined && input.displayName !== user.name) {
        if (isReservedDisplayName(input.displayName, [deps.config.product.agentDisplayName])) {
          throw new AppError('VALIDATION_FAILED', 'This display name is reserved', {
            details: { field: 'displayName', reason: 'reserved' },
          })
        }
        set.name = input.displayName
        publicChange = true
      }

      if (input.username !== undefined && input.username !== user.username) {
        const wanted = input.username
        if (
          isReservedUsername(wanted, [deps.config.product.agentUsername, deps.config.product.name])
        ) {
          throw new AppError('VALIDATION_FAILED', 'This username is reserved', {
            details: { field: 'username', reason: 'reserved' },
          })
        }
        const cooldownEnds =
          user.usernameChangedAt !== null
            ? new Date(
                user.usernameChangedAt.getTime() + LIMITS.usernameChangeCooldownDays * DAY_MS,
              )
            : null
        if (cooldownEnds !== null && cooldownEnds > now) {
          throw new AppError('VALIDATION_FAILED', 'The username can be changed once in 30 days', {
            details: {
              field: 'username',
              reason: 'cooldown',
              availableAt: cooldownEnds.toISOString(),
            },
          })
        }
        const [held] = await tx
          .select()
          .from(usernameReservations)
          .where(eq(usernameReservations.username, wanted))
        // A name somebody gave up is theirs again for 30 days, and nobody else's; mine to take back (docs/01 section 4.3).
        if (
          held &&
          (held.reservedUntil === null || held.reservedUntil > now) &&
          held.userId !== user.id
        ) {
          throw taken()
        }
        await tx
          .insert(usernameReservations)
          .values({
            username: user.username,
            userId: user.id,
            reservedUntil: new Date(now.getTime() + LIMITS.usernameReserveDays * DAY_MS),
          })
          .onConflictDoUpdate({
            target: usernameReservations.username,
            set: {
              userId: user.id,
              reservedUntil: new Date(now.getTime() + LIMITS.usernameReserveDays * DAY_MS),
            },
          })
        await tx
          .delete(usernameReservations)
          .where(
            and(
              eq(usernameReservations.username, wanted),
              eq(usernameReservations.userId, user.id),
            ),
          )
        set.username = wanted
        set.usernameChangedAt = now
        publicChange = true
      }

      if (input.bio !== undefined) {
        const bio = input.bio === null || input.bio === '' ? null : input.bio
        if (bio !== user.bio) set.bio = bio
      }
      if (input.timezone !== undefined && input.timezone !== user.timezone)
        set.timezone = input.timezone
      const settings = input.settings ?? {}
      const settingsChange = Object.keys(settings).length > 0

      if (Object.keys(set).length === 0 && !settingsChange) return
      await tx
        .update(users)
        .set({
          ...set,
          ...(settingsChange
            ? { settings: sql`${users.settings} || ${JSON.stringify(settings)}::text::jsonb` }
            : {}),
          ...(publicChange ? { profileVersion: sql`${users.profileVersion} + 1` } : {}),
          meVersion: sql`${users.meVersion} + 1`,
          updatedAt: now,
        })
        .where(eq(users.id, user.id))
      await recordUserChange(tx, deps, { userId: user.id, entityType: 'me', entityId: user.id })
    })
  } catch (error) {
    if (isUniqueViolation(error, 'users_username_unique')) throw taken()
    throw error
  }
  const me = await getMe(deps, principal)
  if (!me) throw new AppError('NOT_FOUND', 'User not found')
  return me
}
