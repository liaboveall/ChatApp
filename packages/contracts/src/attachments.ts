import { z } from 'zod'
import { attachmentSchema } from './messages.ts'

export const ATTACHMENT_PURPOSES = ['message', 'avatar', 'conversation_avatar'] as const
export const ATTACHMENT_STATUSES = [
  'uploading',
  'processing',
  'ready',
  'failed',
  'deleting',
] as const
export const ATTACHMENT_KINDS = ['image', 'video', 'audio', 'file'] as const
export const UPLOAD_LIMITS = {
  fileBytes: 100 * 1024 * 1024,
  imageBytes: 20 * 1024 * 1024,
  variantBytes: 10 * 1024 * 1024,
  receiveMs: 120_000,
  idleMs: 15_000,
  reservationMs: 15 * 60_000,
  leaseMs: 120_000,
  orphanMs: 24 * 60 * 60_000,
  siteBudgetBytes: 50 * 1024 ** 3,
} as const
export const reserveUploadSchema = z
  .strictObject({
    purpose: z.enum(ATTACHMENT_PURPOSES),
    declaredSize: z.number().int().positive().max(UPLOAD_LIMITS.fileBytes).optional(),
    name: z.string().min(1).max(255),
    conversationId: z.uuid().optional(),
  })
  .superRefine((value, context) => {
    if (value.purpose === 'conversation_avatar' && !value.conversationId)
      context.addIssue({
        code: 'custom',
        path: ['conversationId'],
        message: 'Conversation required',
      })
    if (value.purpose === 'avatar' && value.conversationId)
      context.addIssue({
        code: 'custom',
        path: ['conversationId'],
        message: 'Personal avatar has no conversation',
      })
  })
export type ReserveUpload = z.infer<typeof reserveUploadSchema>
export const uploadSchema = z.object({
  uploadId: z.uuid(),
  attachmentId: z.uuid().optional(),
  expiresAt: z.iso.datetime(),
  maxBytes: z.number().int().positive(),
  status: z.enum(ATTACHMENT_STATUSES),
  attachment: attachmentSchema.nullable(),
})
export type Upload = z.infer<typeof uploadSchema>
export const attachmentQuerySchema = z.object({
  cursor: z.string().max(1024).optional(),
  kind: z.enum(ATTACHMENT_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
})
export type AttachmentQuery = z.infer<typeof attachmentQuerySchema>
export const attachmentPageSchema = z.object({
  items: z.array(
    z.object({ attachment: attachmentSchema, messageId: z.uuid(), seq: z.number().int() }),
  ),
  nextCursor: z.string().nullable(),
})
export type AttachmentPage = z.infer<typeof attachmentPageSchema>
export const setAvatarSchema = z.strictObject({
  attachmentId: z.uuid().nullable(),
  expectedVersion: z.number().int().positive(),
})
export type SetAvatar = z.infer<typeof setAvatarSchema>
/** UUID references are stable across profile renames. Duplicates never create duplicate recipients. */
export function mentionIds(body: string): string[] {
  return [
    ...new Set(
      [
        ...body.matchAll(
          /<@user:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/gi,
        ),
      ].map((match) => (match[1] ?? '').toLowerCase()),
    ),
  ]
}

export const mentionQuerySchema = z.strictObject({ query: z.string().max(100).default('') })
