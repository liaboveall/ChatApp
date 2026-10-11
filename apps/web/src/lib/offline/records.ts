/**
 * What the browser keeps on disk for the person who is signed in (docs/03 section 11, D-070, D-205, M6): the text they have
 * typed and not sent, and the plain-text messages they wrote while the network was down. Nothing else. No message that was
 * received, no name, no attachment and no quote of somebody else's words is ever written: what is on disk is what the person
 * wrote themselves.
 *
 * Every record carries the account, the login generation and the restore generation it was written under, and is read back
 * only under the same ones: a record of another account, or of a generation that has ended, is deleted unread.
 */
import { LIMITS } from '@chatapp/contracts'
import { z } from 'zod'

/** Who a record was written for. Taken from the scope of the sync engine. */
export type Stamp = { userId: string; authEpoch: number; restoreEpoch: string }

const stamped = {
  userId: z.string().min(1).max(64),
  authEpoch: z.number().int().nonnegative(),
  restoreEpoch: z.string().max(64),
  /** When the record last changed, in the page's clock: what the retention periods count from. */
  updatedAt: z.number().int().nonnegative(),
  conversationId: z.uuid(),
  /** The membership it was written under: after leaving and joining again it is not read. */
  membershipId: z.uuid(),
}

/** A UTF-16 code unit count that cannot be exceeded by a message of the longest allowed length in code points. */
export const TEXT_MAX = LIMITS.messageMaxCodePoints * 2

export const draftRecordSchema = z.strictObject({
  kind: z.literal('draft'),
  ...stamped,
  text: z.string().min(1).max(TEXT_MAX),
})
export type DraftRecord = z.infer<typeof draftRecordSchema>

/**
 * A message written and not accepted yet. `offline` waits for the network and is sent by itself, once, after the account and
 * the membership are checked; `failed` is kept for the person to deal with (send again, or delete) and is never sent on its own.
 */
export const queuedRecordSchema = z.strictObject({
  kind: z.literal('queued'),
  ...stamped,
  clientId: z.uuid(),
  body: z.string().min(1).max(TEXT_MAX),
  replyToId: z.uuid().nullable(),
  /** When it was written (the person's clock corrected by the server's): the 24 hours count from here. */
  createdAt: z.iso.datetime(),
  state: z.enum(['offline', 'failed']),
  error: z.string().max(40).nullable(),
})
export type QueuedRecord = z.infer<typeof queuedRecordSchema>

export const storedRecordSchema = z.discriminatedUnion('kind', [
  draftRecordSchema,
  queuedRecordSchema,
])
export type StoredRecord = z.infer<typeof storedRecordSchema>

export const draftKey = (userId: string, conversationId: string): string =>
  `d/${userId}/${conversationId}`
export const queuedKey = (userId: string, clientId: string): string => `q/${userId}/${clientId}`

export const keyOf = (record: StoredRecord): string =>
  record.kind === 'draft'
    ? draftKey(record.userId, record.conversationId)
    : queuedKey(record.userId, record.clientId)

export const stampOf = (scope: Stamp): Stamp => ({
  userId: scope.userId,
  authEpoch: scope.authEpoch,
  restoreEpoch: scope.restoreEpoch,
})

export const sameStamp = (record: Stamp, who: Stamp): boolean =>
  record.userId === who.userId &&
  record.authEpoch === who.authEpoch &&
  record.restoreEpoch === who.restoreEpoch
