/**
 * Events carried on the environment's Pub/Sub channel (docs/03 section 6). Ordinary events carry identifiers and versions.
 * Agent text deltas are the exception: the gateway checks live sessions, source manifests and the lease for every batch.
 * `busEventFromWork` turns a committed `realtime` work item into the event it stands for;
 * typing and presence are published directly by the gateway and are allowed to be lost.
 */
import { agentDeltaSchema, presenceStatusSchema } from '@chatapp/contracts'
import { z } from 'zod'

export const busEventSchema = z.discriminatedUnion('type', [
  agentDeltaSchema.extend({ type: z.literal('agent.delta') }),
  z.object({
    type: z.literal('agent.run.updated'),
    userId: z.uuid(),
    runId: z.uuid(),
    stateVersion: z.number().int().nonnegative(),
  }),
  /** Some session, device or the whole account of this user was revoked: connections re-check right now. */
  z.object({ type: z.literal('auth.revoked'), userId: z.uuid() }),
  /** Work was committed: the dispatcher should look now instead of waiting for its next scan. */
  z.object({ type: z.literal('work.wake') }),
  z.object({
    type: z.literal('attachment.updated'),
    userId: z.uuid(),
    attachmentId: z.uuid(),
    generation: z.number().int(),
    version: z.number().int(),
  }),
  z.object({
    type: z.literal('message.changed'),
    conversationId: z.uuid(),
    messageId: z.uuid(),
    changeSeq: z.number().int(),
  }),
  z.object({
    type: z.literal('conversation.changed'),
    conversationId: z.uuid(),
    metadataVersion: z.number().int(),
  }),
  z.object({
    type: z.literal('member.changed'),
    conversationId: z.uuid(),
    membershipVersion: z.number().int(),
  }),
  /** `membership`: the person's set of conversations changed, so their subscriptions are recomputed. */
  z.object({
    type: z.literal('user.changed'),
    userId: z.uuid(),
    userChangeSeq: z.number().int(),
    membership: z.boolean(),
  }),
  z.object({
    type: z.literal('conversation.removed'),
    userId: z.uuid(),
    conversationId: z.uuid(),
    userChangeSeq: z.number().int(),
  }),
  z.object({
    type: z.literal('typing'),
    conversationId: z.uuid(),
    userId: z.uuid(),
    state: z.enum(['start', 'stop']),
  }),
  z.object({
    type: z.literal('presence'),
    userId: z.uuid(),
    status: presenceStatusSchema,
    lastSeenAt: z.iso.datetime().nullable(),
  }),
])
export type BusEvent = z.infer<typeof busEventSchema>

/** Translates a committed `realtime` work item into the bus event it stands for (null: nothing to publish). */
export function busEventFromWork(work: {
  entityId: string | null
  entityVersion?: number | null
  payload: Record<string, unknown>
}): BusEvent | null {
  const { entityId, payload } = work
  const version = work.entityVersion ?? null
  if (entityId === null) return null
  switch (payload.event) {
    case 'agent.run.updated':
      return typeof payload.runId === 'string' && version !== null
        ? {
            type: 'agent.run.updated',
            userId: entityId,
            runId: payload.runId,
            stateVersion: version,
          }
        : null
    case 'auth.revoked':
      return { type: 'auth.revoked', userId: entityId }
    case 'message.changed':
      return typeof payload.messageId === 'string' && version !== null
        ? {
            type: 'message.changed',
            conversationId: entityId,
            messageId: payload.messageId,
            changeSeq: version,
          }
        : null
    case 'conversation.changed':
      return version !== null
        ? { type: 'conversation.changed', conversationId: entityId, metadataVersion: version }
        : null
    case 'member.changed':
      return version !== null
        ? { type: 'member.changed', conversationId: entityId, membershipVersion: version }
        : null
    case 'attachment.updated':
      return typeof payload.attachmentId === 'string' &&
        typeof payload.generation === 'number' &&
        version !== null
        ? {
            type: 'attachment.updated',
            userId: entityId,
            attachmentId: payload.attachmentId,
            generation: payload.generation,
            version,
          }
        : null
    case 'user.changed':
      return version !== null
        ? {
            type: 'user.changed',
            userId: entityId,
            userChangeSeq: version,
            membership: payload.membership === true,
          }
        : null
    case 'conversation.removed':
      return typeof payload.conversationId === 'string' && version !== null
        ? {
            type: 'conversation.removed',
            userId: entityId,
            conversationId: payload.conversationId,
            userChangeSeq: version,
          }
        : null
    default:
      return null
  }
}
