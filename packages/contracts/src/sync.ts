/**
 * Sync feeds (docs/05 section 4.5, docs/03 section 5.2). A feed pages through a log with a fixed upper bound (`through`)
 * and answers with the *current* authorized state of each changed entity. `scannedThrough` is how far the log was read
 * (also when every entry was filtered out); only the last page may move a client's synced mark to `through`. Entity
 * versions inside the items are never a log position.
 */
import { z } from 'zod'
import { conversationSchema } from './conversations.ts'
import { LIMITS } from './limits.ts'
import { messageSchema, usersDictionarySchema } from './messages.ts'
import { meSchema } from './users.ts'

const count = z.number().int().min(0)

/** First page: `after` (the client's synced mark). Every later page: the `cursor` of the previous one, alone. */
export const changesQuerySchema = z
  .object({
    after: z.coerce.number().int().min(0).optional(),
    cursor: z.string().min(1).max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(LIMITS.changesPageMax).optional(),
  })
  .refine((query) => (query.after === undefined) !== (query.cursor === undefined), {
    message: 'Pass either after (first page) or cursor (later pages)',
  })
export type ChangesQuery = z.infer<typeof changesQuerySchema>

// ───────── A conversation's log ─────────

/** A consistent snapshot to rebuild from when the log cannot be replayed: it never mixes two points in time. */
export const conversationBaselineSchema = z.object({
  conversation: conversationSchema,
  /** The newest page of messages the reader may see. */
  messages: z.array(messageSchema),
  users: usersDictionarySchema,
  hasMoreBefore: z.boolean(),
  baselineChangeSeq: count,
  baselineUserSeq: count,
})
export type ConversationBaseline = z.infer<typeof conversationBaselineSchema>

export const tombstoneSchema = z.object({ id: z.uuid(), changeSeq: count })

export const conversationChangesResponseSchema = z.object({
  items: z.array(messageSchema),
  tombstones: z.array(tombstoneSchema),
  users: usersDictionarySchema,
  scannedThrough: count,
  through: count,
  nextCursor: z.string().nullable(),
  membershipId: z.uuid(),
  /**
   * The log expired, the gap is too large, the cursor is stale or the membership is a different one: discard the cache
   * of this conversation and start from `baseline` (D-126).
   */
  resetRequired: z.boolean(),
  baseline: conversationBaselineSchema.nullable(),
})
export type ConversationChangesResponse = z.infer<typeof conversationChangesResponseSchema>

// ───────── My own log ─────────

export const userChangeItemSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('conversation'), conversation: conversationSchema }),
  /** The tombstone of a relation that ended: a cache holding an older viewer version must drop it. */
  z.object({
    type: z.literal('conversation.removed'),
    conversationId: z.uuid(),
    membershipId: z.uuid().nullable(),
    state: z.literal('removed'),
    viewerVersion: count,
  }),
  z.object({
    type: z.literal('message.hidden'),
    conversationId: z.uuid(),
    messageId: z.uuid(),
  }),
  z.object({ type: z.literal('me'), me: meSchema }),
])
export type UserChangeItem = z.infer<typeof userChangeItemSchema>

export const userBaselineSchema = z.object({
  me: meSchema,
  conversations: z.array(conversationSchema),
  baselineUserSeq: count,
})
export type UserBaseline = z.infer<typeof userBaselineSchema>

export const userChangesResponseSchema = z.object({
  items: z.array(userChangeItemSchema),
  scannedThrough: count,
  through: count,
  nextCursor: z.string().nullable(),
  resetRequired: z.boolean(),
  baseline: userBaselineSchema.nullable(),
})
export type UserChangesResponse = z.infer<typeof userChangesResponseSchema>

// ───────── Heads ─────────

/** The lightest possible reconciliation: versions only, no content (docs/05 section 4.5). Polled about every 30 seconds. */
export const syncHeadSchema = z.object({
  id: z.uuid(),
  membershipId: z.uuid(),
  lastChangeSeq: count,
  metadataVersion: count,
  membershipVersion: count,
  viewerVersion: count,
})
export type SyncHead = z.infer<typeof syncHeadSchema>

export const syncHeadsResponseSchema = z.object({
  userChangeSeq: count,
  conversations: z.array(syncHeadSchema),
})
export type SyncHeadsResponse = z.infer<typeof syncHeadsResponseSchema>
