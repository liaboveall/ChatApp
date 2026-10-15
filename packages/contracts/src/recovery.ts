import { z } from 'zod'

/** Operator-only file contract: each account's complete grant inventory is separately reconfirmed. Default deny. */
export const permissionReviewSchema = z
  .object({
    format: z.literal(1),
    epoch: z.uuid(),
    inventoryHash: z.string().regex(/^[a-f0-9]{64}$/),
    reviewedBy: z.string().min(1).max(80),
    accounts: z.array(z.object({ userId: z.uuid(), confirmed: z.boolean() }).strict()).max(100_000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.accounts.map((item) => item.userId)).size !== value.accounts.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate recovery account' })
  })
export type PermissionReview = z.infer<typeof permissionReviewSchema>
export const applicationRecoveryKeysSchema = z
  .object({
    format: z.literal(1),
    applicationSha: z.string().regex(/^[a-f0-9]{40}$/),
    applicationSourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    betterAuthSecret: z.string().min(32),
    tokenEncryptionKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    aiKeyEncryptionKey: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .nullable(),
    restoreEpoch: z.string().min(8),
    vapid: z
      .object({ publicKey: z.string(), privateKey: z.string(), subject: z.string() })
      .strict()
      .nullable(),
  })
  .strict()
