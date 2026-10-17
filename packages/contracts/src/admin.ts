import { z } from 'zod'
import { UPLOAD_LIMITS } from './attachments.ts'
import { LIMITS } from './limits.ts'

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const stamp = z.iso.datetime().nullable()
export const adminPageQuerySchema = z
  .object({
    cursor: z.string().max(4096).optional(),
    query: z.string().trim().max(100).optional(),
    action: z.string().trim().min(1).max(100).optional(),
    actorId: z.uuid().optional(),
    after: z.iso.datetime().optional(),
    before: z.iso.datetime().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict()
export type AdminPageQuery = z.infer<typeof adminPageQuerySchema>
export const adminUserSchema = z
  .object({
    id: z.uuid(),
    username: z.string().nullable(),
    name: z.string(),
    email: z.string(),
    role: z.enum(['user', 'admin']),
    banned: z.boolean(),
    banReason: z.string().nullable(),
    emailVerified: z.boolean(),
    active: z.boolean(),
    inviteQuota: count,
    invitesUsed: count,
    storageUsedBytes: count,
    storageReservedBytes: count,
    storageQuotaBytes: count.nullable(),
    aiDailyTokens: count.nullable(),
    meVersion: count,
    createdAt: z.iso.datetime(),
  })
  .strict()
export const adminUsersSchema = z
  .object({ users: z.array(adminUserSchema), nextCursor: z.string().nullable() })
  .strict()
export const adminUserUpdateSchema = z
  .object({
    expectedVersion: count.min(1),
    role: z.enum(['user', 'admin']).optional(),
    inviteQuota: count.max(100_000).optional(),
    storageQuotaBytes: count.nullable().optional(),
    aiDailyTokens: count.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 1)
export const adminBanSchema = z
  .object({
    expectedVersion: count.min(1),
    reason: z.string().trim().min(1).max(400),
    until: stamp.optional(),
  })
  .strict()
export const expectedVersionSchema = z.object({ expectedVersion: count.min(1) }).strict()
export const adminInviteSchema = z
  .object({
    id: z.uuid(),
    creatorName: z.string(),
    note: z.string().nullable(),
    maxUses: count.nullable(),
    useCount: count,
    expiresAt: stamp,
    revokedAt: stamp,
    createdAt: z.iso.datetime(),
  })
  .strict()
export const adminInvitesSchema = z
  .object({ invites: z.array(adminInviteSchema), nextCursor: z.string().nullable() })
  .strict()
export const adminConversationSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(['channel', 'group']),
    name: z.string(),
    ownerName: z.string().nullable(),
    memberCount: count,
    archivedAt: stamp,
    metadataVersion: count.min(1),
    createdAt: z.iso.datetime(),
  })
  .strict()
export const adminConversationsSchema = z
  .object({ conversations: z.array(adminConversationSchema), nextCursor: z.string().nullable() })
  .strict()
export const REPORT_REASONS = ['spam', 'abuse', 'illegal', 'other'] as const
export const reportRequestSchema = z
  .object({
    messageId: z.uuid(),
    reason: z.enum(REPORT_REASONS),
    details: z.string().trim().max(1000).default(''),
  })
  .strict()
export const reportReceiptSchema = z.object({ reportId: z.uuid() }).strict()
export const adminReportSchema = z
  .object({
    id: z.uuid(),
    reporterName: z.string(),
    reason: z.enum(REPORT_REASONS),
    details: z.string().nullable(),
    status: z.enum(['open', 'resolved', 'dismissed']),
    resolutionNote: z.string().nullable(),
    version: count.min(1),
    createdAt: z.iso.datetime(),
  })
  .strict()
export const adminReportsSchema = z
  .object({ reports: z.array(adminReportSchema), nextCursor: z.string().nullable() })
  .strict()
export const reportUpdateSchema = z
  .object({
    expectedVersion: count.min(1),
    status: z.enum(['resolved', 'dismissed']),
    resolutionNote: z.string().trim().max(1000).default(''),
  })
  .strict()
// Context has no attachments, reply projections, AI traces or hidden conversation metadata to widen the exception.
export const reportContextSchema = z
  .object({
    available: z.boolean(),
    messages: z
      .array(
        z
          .object({
            id: z.uuid(),
            senderName: z.string(),
            body: z.string().nullable(),
            createdAt: z.iso.datetime(),
            reported: z.boolean(),
            unavailable: z.boolean(),
          })
          .strict(),
      )
      .max(11),
  })
  .strict()
export const adminAuditSchema = z
  .object({
    id: z.uuid(),
    action: z.string(),
    actorName: z.string().nullable(),
    targetType: z.string().nullable(),
    targetId: z.string().nullable(),
    summary: z
      .object({
        roleChanged: z.boolean().optional(),
        status: z.enum(['resolved', 'dismissed']).optional(),
        version: count.optional(),
        runContentDays: count.optional(),
      })
      .strict(),
    createdAt: z.iso.datetime(),
  })
  .strict()
export const adminAuditLogsSchema = z
  .object({ entries: z.array(adminAuditSchema), nextCursor: z.string().nullable() })
  .strict()
export const SITE_LIMIT_DEFAULTS = {
  messageRecallWindowMs: LIMITS.messageRecallWindowMs,
  messageEditWindowMs: LIMITS.messageEditWindowMs,
  fileBytes: UPLOAD_LIMITS.fileBytes,
  imageBytes: UPLOAD_LIMITS.imageBytes,
  groupMemberLimit: LIMITS.groupMemberLimit,
  channelMemberLimit: LIMITS.channelMemberLimit,
  messageRateConversationLimit: LIMITS.messageRateConversationLimit,
  messageRateUserLimit: LIMITS.messageRateUserLimit,
  uploadsPerHour: 30,
  maxConversationsPerUser: LIMITS.maxConversationsPerUser,
  maxFutureTasksPerUser: 100,
  fastSteps: 8,
  deepSteps: 16,
  fastDurationMs: 120_000,
  deepDurationMs: 300_000,
}
/** Resource and request hard limits are independent; file/image settings can only tighten them. */
export const siteLimitsSchema = z
  .object({
    messageRecallWindowMs: count.max(7 * 86_400_000),
    messageEditWindowMs: count.max(30 * 86_400_000),
    fileBytes: count.min(1).max(UPLOAD_LIMITS.fileBytes),
    imageBytes: count.min(1).max(UPLOAD_LIMITS.imageBytes),
    groupMemberLimit: count.min(2).max(10_000),
    channelMemberLimit: count.min(2).max(50_000),
    messageRateConversationLimit: count.min(1).max(1_000),
    messageRateUserLimit: count.min(1).max(6_000),
    uploadsPerHour: count.max(10_000),
    maxConversationsPerUser: count.min(1).max(10_000),
    maxFutureTasksPerUser: count.max(10_000),
    fastSteps: count.min(1).max(64),
    deepSteps: count.min(1).max(128),
    fastDurationMs: count.min(1_000).max(900_000),
    deepDurationMs: count.min(1_000).max(900_000),
  })
  .strict()
  .refine((value) => value.imageBytes <= value.fileBytes, {
    path: ['imageBytes'],
    message: 'Image limit exceeds file limit',
  })
export type SiteLimits = z.infer<typeof siteLimitsSchema>
export const clientSiteLimitsSchema = z
  .object({
    messageRecallWindowMs: siteLimitsSchema.shape.messageRecallWindowMs,
    messageEditWindowMs: siteLimitsSchema.shape.messageEditWindowMs,
    fileBytes: siteLimitsSchema.shape.fileBytes,
    imageBytes: siteLimitsSchema.shape.imageBytes,
  })
  .strict()
export type ClientSiteLimits = z.infer<typeof clientSiteLimitsSchema>
export const sitePolicySchema = z
  .object({
    runContentDays: z.number().int().min(1).max(30),
    userDailyTokens: count,
    monthlyMicroUsd: count,
    aiPaused: z.boolean(),
    limits: siteLimitsSchema.default(SITE_LIMIT_DEFAULTS),
  })
  .strict()
export type SitePolicy = z.infer<typeof sitePolicySchema>
export const siteSettingsSchema = z
  .object({
    version: count.min(1),
    policy: sitePolicySchema,
    provider: z.string(),
    fastModel: z.string(),
    deepModel: z.string(),
    storageBudgetBytes: count,
  })
  .strict()
export const siteSettingsUpdateSchema = z
  .object({
    expectedVersion: count.min(1),
    policy: sitePolicySchema.omit({ limits: true }).extend({ limits: siteLimitsSchema.optional() }),
    storageBudgetBytes: count.optional(),
  })
  .strict()
export type SiteSettingsUpdate = z.infer<typeof siteSettingsUpdateSchema>
export const privacyPolicySchema = z
  .object({ runContentDays: z.number().int().min(1).max(30) })
  .strict()
export const adminUsageSchema = z
  .object({
    usage: z
      .array(
        z
          .object({
            day: z.string(),
            inputTokens: count,
            outputTokens: count,
            costMicroUsd: count,
            calls: count,
          })
          .strict(),
      )
      .max(31),
    budget: z
      .object({
        period: z.string(),
        settledMicroUsd: count,
        reservedMicroUsd: count,
        limitMicroUsd: count,
      })
      .strict()
      .nullable(),
  })
  .strict()
