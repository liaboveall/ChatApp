import { z } from 'zod'

const uuid = z.uuid()
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const hash = z.string().regex(/^[a-f0-9]{64}$/)

/** Journal payloads admit identifiers and frozen versions only. No body, address, token or key fields. */
export const deletionIntentSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.enum(['message_recall', 'message_delete']),
      target: z.object({ id: uuid, conversationId: uuid, contentVersion: version }).strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal('memory_delete'),
      target: z.object({ id: uuid, userId: uuid, contentVersion: version }).strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal('agent_conversation_delete'),
      target: z.object({ id: uuid, userId: uuid }).strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal('attachment_delete'),
      target: z
        .object({
          id: uuid,
          userId: uuid,
          generation: version,
          contentVersion: version,
          finalStatus: z.enum(['deleting', 'failed']),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal('account_delete'),
      target: z
        .object({
          id: uuid,
          authEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal('retention'),
      target: z.union([
        z.object({ cutoff: z.iso.datetime(), ruleVersion: z.literal(1) }).strict(),
        z
          .object({
            cutoff: z.iso.datetime(),
            ruleVersion: z.literal(2),
            runContentDays: z.number().int().min(1).max(30),
          })
          .strict(),
      ]),
    })
    .strict(),
])
export type DeletionIntent = z.infer<typeof deletionIntentSchema>

export const journalHeadSchema = z
  .object({
    format: z.literal(1),
    writerEpoch: uuid,
    seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    hash,
    recordKey: z.string().max(256).nullable(),
    checkpoint: z
      .object({ key: z.string().max(256), hash })
      .strict()
      .optional(),
  })
  .strict()
export type JournalHead = z.infer<typeof journalHeadSchema>

export const journalRecordSchema = z
  .object({
    format: z.literal(1),
    ruleVersion: z.literal(1),
    writerEpoch: uuid,
    seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    previousHash: hash,
    operationId: uuid,
    actorId: uuid.nullable(),
    acceptedAt: z.iso.datetime(),
    preparedAt: z.iso.datetime().optional(),
    intent: deletionIntentSchema,
  })
  .strict()
export type JournalRecord = z.infer<typeof journalRecordSchema>

export const journalCheckpointSchema = z
  .object({
    format: z.literal(1),
    floor: z.object({ seq: version, hash }).strict(),
    createdAt: z.iso.datetime(),
    pruneBefore: z.iso.datetime(),
    catalogHash: hash,
    snapshotCount: version,
  })
  .strict()
export type JournalCheckpoint = z.infer<typeof journalCheckpointSchema>

export const journalEnvelopeSchema = z
  .object({
    format: z.literal(1),
    keyVersion: z.number().int().positive(),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
    ciphertext: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .max(256 * 1024),
  })
  .strict()

export const deletionOperationSchema = z
  .object({
    operationId: uuid,
    status: z.enum(['pending', 'completed', 'failed']),
    statusUrl: z.string().regex(/^\/api\/deletion-operations\/[a-f0-9-]+$/),
    version,
    errorCode: z.enum(['permanent_failure']).nullable(),
  })
  .strict()
export type DeletionOperation = z.infer<typeof deletionOperationSchema>
