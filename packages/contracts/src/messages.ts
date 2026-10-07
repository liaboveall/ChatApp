/**
 * Message DTOs and requests (docs/05 sections 2 and 3.4). A message is always projected for one reader: the body of a
 * recalled or deleted message is empty, and a reply quote shows nothing of a message the reader cannot see.
 */
import { z } from 'zod'
import { messageKindSchema, messageStatusSchema } from './enums.ts'
import { messageBodySchema } from './identity.ts'
import { LIMITS } from './limits.ts'
import { userSummarySchema } from './users.ts'

const isoDate = z.iso.datetime()
const count = z.number().int().min(0)

/** Attachments arrive with M3; the field exists from the start so the message shape never changes. */
export const attachmentSchema = z.object({
  id: z.uuid(),
  version: count,
  generation: count,
  kind: z.enum(['image', 'video', 'audio', 'file']),
  mime: z.string(),
  name: z.string(),
  sizeBytes: count,
  width: count.nullable(),
  height: count.nullable(),
  durationMs: count.nullable(),
  metadataCleared: z.boolean().nullable().optional(),
  thumbhash: z.string().nullable(),
  status: z.enum(['processing', 'ready', 'failed']),
  urls: z.object({
    original: z.string(),
    thumb: z.string().nullable(),
    preview: z.string().nullable(),
  }),
})
export type Attachment = z.infer<typeof attachmentSchema>

/**
 * What a system message says; the client words it from these fields and the `users` dictionary, so a renamed person
 * is shown under the current name. Channels do not record joins and leaves (docs/01 section 4.5, D-129).
 */
export const systemEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('member_joined'), userId: z.uuid(), addedBy: z.uuid().nullable() }),
  z.object({ type: z.literal('member_left'), userId: z.uuid() }),
  z.object({
    type: z.literal('member_removed'),
    userId: z.uuid(),
    actorId: z.uuid(),
    banned: z.boolean(),
  }),
  z.object({
    type: z.literal('conversation_renamed'),
    actorId: z.uuid(),
    from: z.string(),
    to: z.string(),
  }),
  z.object({ type: z.literal('owner_transferred'), actorId: z.uuid(), userId: z.uuid() }),
])
export type SystemEvent = z.infer<typeof systemEventSchema>

export const messageMetaSchema = z.object({
  system: systemEventSchema.optional(),
  /** M4. */
  agent: z
    .object({
      runId: z.uuid(),
      mode: z.string(),
      keySource: z.enum(['site', 'user']),
      streamIndex: count.optional(),
    })
    .optional(),
  /** M5a: sent by the assistant on the person's behalf. */
  viaAgent: z.object({ runId: z.uuid() }).optional(),
})
export type MessageMeta = z.infer<typeof messageMetaSchema>

export const replyStateSchema = z.enum(['ok', 'recalled', 'deleted'])

/**
 * `unavailable` carries nothing: no id, sequence number, sender or excerpt, so a quote cannot reveal that a message
 * from before the reader joined exists (docs/05 section 2).
 */
export const replyToSchema = z.union([
  z.object({ state: z.literal('unavailable') }),
  z.object({
    id: z.uuid(),
    seq: count,
    senderId: z.uuid().nullable(),
    excerpt: z.string().nullable(),
    attachmentKind: z.enum(['image', 'video', 'audio', 'file']).nullable().optional(),
    state: replyStateSchema,
  }),
])
export type ReplyTo = z.infer<typeof replyToSchema>

export const messageSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  seq: count,
  changeSeq: count,
  kind: messageKindSchema,
  status: messageStatusSchema,
  senderId: z.uuid().nullable(),
  body: z.string().nullable(),
  replyTo: replyToSchema.nullable(),
  attachments: z.array(attachmentSchema),
  /** Filled from `<@user:UUID>` tokens when mentions arrive with M3. */
  mentions: z.array(z.uuid()),
  streamRevision: count,
  editedAt: isoDate.nullable(),
  recalledAt: isoDate.nullable(),
  deletedAt: isoDate.nullable(),
  createdAt: isoDate,
  meta: messageMetaSchema,
})
export type Message = z.infer<typeof messageSchema>

/** Senders and everyone a message refers to, once per response instead of once per message. */
export const usersDictionarySchema = z.record(z.string(), userSummarySchema)
export type UsersDictionary = z.infer<typeof usersDictionarySchema>

export const messageEnvelopeSchema = z.object({
  message: messageSchema,
  users: usersDictionarySchema,
})
export type MessageEnvelope = z.infer<typeof messageEnvelopeSchema>

// ───────── Reading ─────────

/**
 * At most one of the three anchors; with none, the newest page. `beforeSeq` and `afterSeq` are exclusive, `aroundSeq`
 * centres a page on that message (jumping to a quote or a search hit).
 */
export const messagesQuerySchema = z
  .object({
    beforeSeq: z.coerce.number().int().min(1).optional(),
    afterSeq: z.coerce.number().int().min(0).optional(),
    aroundSeq: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(LIMITS.messagePageMax).optional(),
  })
  .refine(
    (query) =>
      [query.beforeSeq, query.afterSeq, query.aroundSeq].filter((value) => value !== undefined)
        .length <= 1,
    { message: 'Use at most one of beforeSeq, afterSeq and aroundSeq' },
  )
export type MessagesQuery = z.infer<typeof messagesQuerySchema>

/** Messages in ascending `seq` order, hidden and pre-join messages left out; the flags look past both ends of the page. */
export const messagesResponseSchema = z.object({
  messages: z.array(messageSchema),
  users: usersDictionarySchema,
  hasMoreBefore: z.boolean(),
  hasMoreAfter: z.boolean(),
})
export type MessagesResponse = z.infer<typeof messagesResponseSchema>

// ───────── Writing ─────────

/**
 * `clientId` is the stable idempotency key of one message: sending it again returns the same message (docs/05 section
 * 1, INV-03). Attachments join in M3; until then the body is required.
 */
export const sendMessageRequestSchema = z
  .strictObject({
    clientId: z.uuid(),
    body: messageBodySchema.optional(),
    attachmentIds: z.array(z.uuid()).max(10).optional(),
    replyToId: z.uuid().nullable().optional(),
  })
  .refine((body) => body.body !== undefined || (body.attachmentIds?.length ?? 0) > 0, {
    message: 'A message needs a body or an attachment',
  })
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>

export const editMessageRequestSchema = z.strictObject({
  body: messageBodySchema,
  expectedChangeSeq: z.number().int().min(1),
})
export type EditMessageRequest = z.infer<typeof editMessageRequestSchema>
