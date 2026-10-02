/** Registration invitations (docs/05 section 3.2, docs/01 section 4.2). */
import { z } from 'zod'
import { LIMITS } from './limits.ts'

export const inviteCheckRequestSchema = z.strictObject({ code: z.string().min(1).max(64) })
export type InviteCheckRequest = z.infer<typeof inviteCheckRequestSchema>

export const inviteCheckResponseSchema = z.object({ valid: z.literal(true) })
export type InviteCheckResponse = z.infer<typeof inviteCheckResponseSchema>

export const createInviteRequestSchema = z.strictObject({
  note: z.string().trim().max(LIMITS.inviteNoteMaxLength).optional(),
  /** Omitted: one use. `null` (unlimited) is only accepted from site administrators. */
  maxUses: z.number().int().min(1).max(1000).nullable().optional(),
  expiresInDays: z.number().int().min(1).max(90).optional(),
})
export type CreateInviteRequest = z.infer<typeof createInviteRequestSchema>

export const inviteSchema = z.object({
  id: z.uuid(),
  note: z.string().nullable(),
  maxUses: z.number().int().nullable(),
  useCount: z.number().int(),
  expiresAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
})
export type Invite = z.infer<typeof inviteSchema>

/** The plaintext code is returned exactly once, at creation. */
export const createdInviteSchema = inviteSchema.extend({ code: z.string() })
export type CreatedInvite = z.infer<typeof createdInviteSchema>

export const inviteRegistrationSchema = z.object({
  id: z.uuid(),
  inviteId: z.uuid(),
  status: z.enum(['reserved', 'account_created', 'confirmed']),
  username: z.string().nullable(),
  createdAt: z.iso.datetime(),
})
export type InviteRegistration = z.infer<typeof inviteRegistrationSchema>
