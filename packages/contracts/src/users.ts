/** User DTOs (docs/05 section 2). */
import { z } from 'zod'
import { userRoleSchema } from './enums.ts'
import { displayNameSchema, timezoneSchema, usernameSchema } from './identity.ts'
import { LIMITS } from './limits.ts'

export const userSummarySchema = z.object({
  id: z.uuid(),
  profileVersion: z.number().int(),
  username: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  isBot: z.boolean(),
  deleted: z.boolean(),
})
export type UserSummary = z.infer<typeof userSummarySchema>

/** Public profile of a member (`GET /api/users/:id`): the summary plus what the person chose to say about themselves. */
export const userProfileSchema = userSummarySchema.extend({
  bio: z.string().nullable(),
  createdAt: z.iso.datetime(),
})
export type UserProfile = z.infer<typeof userProfileSchema>

/** Member search for starting a direct message or adding people; matches username or display name. */
export const userSearchQuerySchema = z.object({
  query: z.string().trim().min(1).max(LIMITS.userSearchQueryMaxLength),
})
export type UserSearchQuery = z.infer<typeof userSearchQuerySchema>

export const userSearchResponseSchema = z.object({ users: z.array(userSummarySchema) })
export type UserSearchResponse = z.infer<typeof userSearchResponseSchema>

/** The signed-in user's own view; `aiKey` appears with M5. */
export const meSchema = userSummarySchema.extend({
  meVersion: z.number().int(),
  authEpoch: z.number().int(),
  restoreEpoch: z.string(),
  email: z.string(),
  role: userRoleSchema,
  bio: z.string().nullable(),
  locale: z.string(),
  timezone: z.string(),
  settings: z.record(z.string(), z.unknown()),
  inviteQuota: z.number().int(),
  invitesUsed: z.number().int(),
  storageUsedBytes: z.number().int(),
  storageQuotaBytes: z.number().int(),
  aiDailyTokens: z.number().int(),
})
export type Me = z.infer<typeof meSchema>

/**
 * `PATCH /api/me` (docs/05 section 3.1). Every write carries the `meVersion` it was based on (D-082); a stale one is a
 * 409 VERSION_CONFLICT and the client reloads. M1 changed the time zone and the flag that makes the browser's zone win;
 * M2 adds the public profile: display name, username (30-day cooldown, old names stay reserved) and bio (D-133).
 */
export const patchMeRequestSchema = z
  .strictObject({
    expectedMeVersion: z.number().int().min(1),
    /** IANA zone, for example Asia/Shanghai. */
    timezone: timezoneSchema.optional(),
    settings: z.strictObject({ timezoneAuto: z.boolean().optional() }).optional(),
    displayName: displayNameSchema.optional(),
    username: usernameSchema.optional(),
    /** An empty or blank bio clears it. */
    bio: z.string().trim().max(LIMITS.bioMaxLength).nullable().optional(),
  })
  .refine(
    (body) =>
      body.timezone !== undefined ||
      body.settings !== undefined ||
      body.displayName !== undefined ||
      body.username !== undefined ||
      body.bio !== undefined,
    { message: 'Nothing to change' },
  )
export type PatchMeRequest = z.infer<typeof patchMeRequestSchema>
