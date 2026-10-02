/** User DTOs (docs/05 section 2). */
import { z } from 'zod'
import { userRoleSchema } from './enums.ts'

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
