/**
 * Consumer of the `push` queue (docs/03 section 7: 8 at a time). One work kind, two stages: `message` works out who a
 * written message concerns, `deliver` sends one push to one subscription after checking everything again. A task is
 * finished once its business effect committed; the same task delivered twice finds nothing left to do (the entries have
 * dedupe keys, a sent push cannot be recalled, and a timed-out send is tried again and may arrive twice).
 */
import { type Job, Worker } from 'bullmq'
import type { Deps } from '../domain/deps.ts'
import { deliverPush, deriveMessageNotifications } from '../domain/push.ts'
import { beginWork, completeWork, failWork } from '../domain/work-queue.ts'
import { describeError, type Logger } from '../lib/logger.ts'
import type { Valkey } from '../lib/valkey.ts'
import type { PresenceStore } from '../realtime/presence.ts'
import { QUEUE, queuePrefix, type WorkJobData } from './queues.ts'

export type PushJobOutcome = 'done' | 'retry' | 'stale' | 'failed'

/** The processor for one job; separate from the Worker so tests can call it directly. */
export async function processPushJob(
  parts: { deps: Deps; presence: PresenceStore; log: Logger },
  data: WorkJobData,
): Promise<PushJobOutcome> {
  const { deps, presence, log } = parts
  const lease = { id: data.workId, leaseEpoch: data.leaseEpoch }
  const work = await beginWork(deps, lease)
  // A redelivered job whose epoch no longer owns the item must not do anything.
  if (!work) return 'stale'
  try {
    if (work.payload.stage === 'message') {
      const named =
        typeof work.payload.named === 'string'
          ? work.payload.named.split(',').filter((id) => id.length > 0)
          : null
      if (work.entityId) await deriveMessageNotifications(deps, work.entityId, named)
      await completeWork(deps, lease)
      return 'done'
    }
    const result = await deliverPush(deps, work, {
      viewing: (userId, conversationId) =>
        presence.viewing(userId, conversationId, deps.clock.now().getTime()),
    })
    if (result.kind === 'retry') {
      await failWork(deps, lease, { kind: 'push', errorCode: result.reason })
      return 'retry'
    }
    await completeWork(deps, lease)
    return 'done'
  } catch (error) {
    const result = await failWork(deps, lease, {
      kind: 'push',
      errorCode: describeError(error).errorCode?.toString() ?? 'push_failed',
    })
    log.warn('push.failed', { workId: work.id, reason: result, ...describeError(error) })
    return 'failed'
  }
}

export function createPushWorker(parts: {
  deps: Deps
  presence: PresenceStore
  log: Logger
  connection: Valkey
  environment: string
}): Worker<WorkJobData> {
  return new Worker<WorkJobData>(
    QUEUE.push,
    (job: Job<WorkJobData>) => processPushJob(parts, job.data),
    { connection: parts.connection, prefix: queuePrefix(parts.environment), concurrency: 8 },
  )
}
