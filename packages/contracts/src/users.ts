/** User DTOs (docs/05 section 2). */
import { z } from 'zod'
import { userRoleSchema } from './enums.ts'
import { timezoneSchema } from './identity.ts'

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
 * 409 VERSION_CONFLICT and the client reloads. M1 changes the time zone and the flag that makes the browser's zone win;
 * profile fields (display name, username, bio) join with M2.
 */
export const patchMeRequestSchema = z
  .strictObject({
    expectedMeVersion: z.number().int().min(1),
    /** IANA zone, for example Asia/Shanghai. */
    timezone: timezoneSchema.optional(),
    settings: z.strictObject({ timezoneAuto: z.boolean().optional() }).optional(),
  })
  .refine((body) => body.timezone !== undefined || body.settings !== undefined, {
    message: 'Nothing to change',
  })
export type PatchMeRequest = z.infer<typeof patchMeRequestSchema>
