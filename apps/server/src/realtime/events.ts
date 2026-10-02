/** Events carried on the environment's Pub/Sub channel (docs/03 section 6). They are hints, never authority or content. */
import { z } from 'zod'

export const busEventSchema = z.discriminatedUnion('type', [
  /** Some session, device or the whole account of this user was revoked: connections re-check right now. */
  z.object({ type: z.literal('auth.revoked'), userId: z.uuid() }),
  /** Work was committed: the dispatcher should look now instead of waiting for its next scan. */
  z.object({ type: z.literal('work.wake') }),
])
export type BusEvent = z.infer<typeof busEventSchema>

/** Translates a committed `realtime` work item into the bus event it stands for (null: nothing to publish). */
export function busEventFromWork(work: {
  entityId: string | null
  payload: Record<string, unknown>
}): BusEvent | null {
  if (work.payload.event === 'auth.revoked' && work.entityId !== null) {
    return { type: 'auth.revoked', userId: work.entityId }
  }
  return null
}
