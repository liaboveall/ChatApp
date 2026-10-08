/**
 * The dispatcher turns committed work intents into queue jobs and bus events (docs/03 section 7). It claims items with
 * short leases (SKIP LOCKED), then hands them to BullMQ with the job id `workId-deliverySeq` (no colon, new for every
 * redelivery) or, for realtime hints, publishes them directly. Handing over is not completion: consumers mark items
 * done after their business effect committed. If anything here fails the lease simply expires and the item is retried.
 */

import type { WorkKind } from '@chatapp/contracts'
import type { Queue } from 'bullmq'
import type { Deps } from '../domain/deps.ts'
import { claimReadyWork, completeWork } from '../domain/work-queue.ts'
import type { Logger } from '../lib/logger.ts'
import { describeError } from '../lib/logger.ts'
import type { EventBus } from '../realtime/bus.ts'
import { busEventFromWork } from '../realtime/events.ts'
import { DEFAULT_JOB_OPTIONS, type WorkJobData } from './queues.ts'

export type Dispatcher = {
  start(): void
  /** Best-effort immediate scan (a wake hint arrived); the periodic scan is what guarantees progress. */
  wake(): void
  stop(): Promise<void>
  /** One scan; exposed for tests. Returns how many items were claimed. */
  tick(): Promise<number>
}

export function createDispatcher(parts: {
  deps: Deps
  bus: EventBus
  emailQueue: Queue<WorkJobData>
  mediaQueue?: Queue<WorkJobData>
  agentQueue?: Queue<WorkJobData>
  scheduledQueue?: Queue<WorkJobData>
  embeddingQueues?: ReadonlyMap<string, Queue<WorkJobData>>
  log: Logger
  intervalMs?: number
  batch?: number
  kinds?: readonly WorkKind[]
}): Dispatcher {
  const { deps, bus, emailQueue, log } = parts
  const intervalMs = parts.intervalMs ?? 1000
  const batch = parts.batch ?? 50
  let timer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<number> | undefined
  let stopped = true

  async function tick(): Promise<number> {
    const claimed = await claimReadyWork(deps, {
      limit: batch,
      kinds: parts.kinds,
      embeddingVersions: deps.embeddings ? [deps.embeddings.modelVersion] : [],
    })
    for (const work of claimed) {
      try {
        if (work.kind === 'realtime') {
          const event = busEventFromWork(work)
          if (event) await bus.publish(event)
          await completeWork(deps, { id: work.id, leaseEpoch: work.leaseEpoch })
        } else if (work.kind === 'agent') {
          if (!parts.agentQueue) throw new Error('agent queue unavailable')
          await parts.agentQueue.add(
            'run',
            { workId: work.id, leaseEpoch: work.leaseEpoch },
            { ...DEFAULT_JOB_OPTIONS, jobId: `${work.id}-${work.deliverySeq}` },
          )
        } else if (work.kind === 'embedding') {
          const queue =
            typeof work.payload.modelVersion === 'string'
              ? parts.embeddingQueues?.get(work.payload.modelVersion)
              : undefined
          if (!queue) throw new Error('embedding generation unavailable')
          await queue.add(
            'index',
            { workId: work.id, leaseEpoch: work.leaseEpoch },
            {
              ...DEFAULT_JOB_OPTIONS,
              jobId: `${work.id}-${work.deliverySeq}`,
              priority: work.payload.backfill ? 10 : 1,
            },
          )
        } else if (work.kind === 'scheduled') {
          if (!parts.scheduledQueue) throw new Error('scheduled queue unavailable')
          await parts.scheduledQueue.add(
            'deliver',
            { workId: work.id, leaseEpoch: work.leaseEpoch },
            { ...DEFAULT_JOB_OPTIONS, jobId: `${work.id}-${work.deliverySeq}` },
          )
        } else if (work.kind === 'media') {
          if (!parts.mediaQueue) throw new Error('media queue unavailable')
          await parts.mediaQueue.add(
            'process',
            { workId: work.id, leaseEpoch: work.leaseEpoch },
            { ...DEFAULT_JOB_OPTIONS, jobId: `${work.id}-${work.deliverySeq}` },
          )
        } else if (work.kind === 'email') {
          await emailQueue.add(
            'deliver',
            { workId: work.id, leaseEpoch: work.leaseEpoch },
            { ...DEFAULT_JOB_OPTIONS, jobId: `${work.id}-${work.deliverySeq}` },
          )
        }
      } catch (error) {
        // The item stays leased and comes back when the lease expires.
        log.warn('dispatcher.dispatch_failed', {
          workId: work.id,
          kind: work.kind,
          ...describeError(error),
        })
      }
    }
    return claimed.length
  }

  function schedule(delay: number): void {
    if (stopped) return
    timer = setTimeout(() => {
      running = tick()
        .catch((error) => {
          log.error('dispatcher.tick_failed', describeError(error))
          return 0
        })
        .finally(() => {
          running = undefined
          schedule(intervalMs)
        })
    }, delay)
  }

  return {
    start() {
      stopped = false
      schedule(0)
    },
    wake() {
      if (stopped || running) return
      if (timer) clearTimeout(timer)
      schedule(0)
    },
    async stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      await running
    },
    tick,
  }
}
