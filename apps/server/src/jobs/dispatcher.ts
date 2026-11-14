/**
 * The dispatcher turns committed work intents into queue jobs and bus events (docs/03 section 7). It claims items with
 * short leases (SKIP LOCKED), then hands them to BullMQ with the job id `workId-deliverySeq` (no colon, new for every
 * redelivery) or, for realtime hints, publishes them directly. Handing over is not completion: consumers mark items
 * done after their business effect committed. If anything here fails the lease simply expires and the item is retried.
 */

import type { WorkKind } from '@chatapp/contracts'
import type { Queue } from 'bullmq'
import type { Deps } from '../domain/deps.ts'
import { deliverAdminNotification } from '../domain/notifications.ts'
import {
  type ClaimedWork,
  claimReadyWork,
  completeWorkMany,
  failWork,
  type WorkLease,
} from '../domain/work-queue.ts'
import type { Logger } from '../lib/logger.ts'
import { describeError } from '../lib/logger.ts'
import type { EventBus } from '../realtime/bus.ts'
import { busEventFromWork } from '../realtime/events.ts'
import { DEFAULT_JOB_OPTIONS, type WorkJobData } from './queues.ts'

export type Dispatcher = {
  start(): void
  /**
   * Best-effort immediate scan (a wake hint arrived); the periodic scan is what guarantees progress. A hint that arrives
   * while a scan is running is remembered and answered with another scan as soon as that one ends.
   */
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
  pushQueue?: Queue<WorkJobData>
  embeddingQueues?: ReadonlyMap<string, Queue<WorkJobData>>
  log: Logger
  intervalMs?: number
  batch?: number
  kinds?: readonly WorkKind[]
  /** The least time between two scans asked for by `wake`, so a burst of hints becomes one scan and not one each. */
  wakeDelayMs?: number
}): Dispatcher {
  const { deps, bus, log } = parts
  const intervalMs = parts.intervalMs ?? 1000
  const batch = parts.batch ?? 50
  const wakeDelayMs = parts.wakeDelayMs ?? 20
  let timer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<number> | undefined
  let stopped = true
  /** A hint that arrived while a scan was running: what it announced may have committed after that scan's claim. */
  let wakeRequested = false
  /** When the last scan ended (monotonic), to space the scans that hints ask for. */
  let lastEndedAt = Number.NEGATIVE_INFINITY

  /** Where a kind of work goes: the queue (absent where this process does not run it), the job name, and its priority. */
  function routeOf(work: ClaimedWork): {
    queue: Queue<WorkJobData> | undefined
    job: string
    unavailable: string
    priority?: number
  } | null {
    switch (work.kind) {
      case 'agent':
        return { queue: parts.agentQueue, job: 'run', unavailable: 'agent queue unavailable' }
      case 'embedding':
        return {
          queue:
            typeof work.payload.modelVersion === 'string'
              ? parts.embeddingQueues?.get(work.payload.modelVersion)
              : undefined,
          job: 'index',
          unavailable: 'embedding generation unavailable',
          priority: work.payload.backfill ? 10 : 1,
        }
      case 'scheduled':
        return {
          queue: parts.scheduledQueue,
          job: 'deliver',
          unavailable: 'scheduled queue unavailable',
        }
      case 'push':
        return { queue: parts.pushQueue, job: 'deliver', unavailable: 'push queue unavailable' }
      case 'media':
        return { queue: parts.mediaQueue, job: 'process', unavailable: 'media queue unavailable' }
      case 'email':
        return { queue: parts.emailQueue, job: 'deliver', unavailable: 'email queue unavailable' }
      default:
        return null
    }
  }

  const dispatchFailed = (work: ClaimedWork, error: unknown): void => {
    // The item stays leased and comes back when the lease expires.
    log.warn('dispatcher.dispatch_failed', {
      workId: work.id,
      kind: work.kind,
      ...describeError(error),
    })
  }

  async function tick(): Promise<number> {
    const claimed = await claimReadyWork(deps, {
      limit: batch,
      kinds: parts.kinds,
      embeddingVersions: deps.embeddings ? [deps.embeddings.modelVersion] : [],
    })
    // Realtime hints are published here and are done once published. They are marked done together, in one statement:
    // a burst of hints is one commit, not one per hint. A crash in between publishes them again, which clients absorb
    // (versions merge), exactly as a crash between one publish and its own completion always could.
    const published: WorkLease[] = []
    for (const work of claimed) {
      try {
        if (work.kind === 'notification') {
          await deliverAdminNotification(deps, { id: work.id, leaseEpoch: work.leaseEpoch })
          continue
        }
        if (work.kind === 'realtime') {
          const event = busEventFromWork(work)
          if (event) await bus.publish(event)
          published.push({ id: work.id, leaseEpoch: work.leaseEpoch })
          continue
        }
        const route = routeOf(work)
        if (!route) continue
        if (!route.queue) throw new Error(route.unavailable)
        // A new job id for every redelivery, so a retained finished job never swallows it.
        await route.queue.add(
          route.job,
          { workId: work.id, leaseEpoch: work.leaseEpoch },
          {
            ...DEFAULT_JOB_OPTIONS,
            jobId: `${work.id}-${work.deliverySeq}`,
            ...(route.priority !== undefined ? { priority: route.priority } : {}),
          },
        )
      } catch (error) {
        if (work.kind === 'notification')
          await failWork(
            deps,
            { id: work.id, leaseEpoch: work.leaseEpoch },
            { kind: work.kind, errorCode: 'notification_delivery_failed' },
          )
        dispatchFailed(work, error)
      }
    }
    await completeWorkMany(deps, published)
    return claimed.length
  }

  function schedule(delay: number): void {
    if (stopped) return
    timer = setTimeout(() => {
      timer = undefined
      wakeRequested = false
      running = tick()
        .then(
          (claimed) => ({ claimed, failed: false }),
          (error) => {
            log.error('dispatcher.tick_failed', describeError(error))
            return { claimed: 0, failed: true }
          },
        )
        .then(({ claimed, failed }) => {
          running = undefined
          lastEndedAt = performance.now()
          // A full batch means more is waiting, and a hint that came in during the scan may be about work this scan
          // did not see: either way the next scan does not wait for the interval (docs/03 section 7). After a failed
          // scan it does, so a database that is away is not hammered.
          if (failed) schedule(intervalMs)
          else if (claimed >= batch) schedule(0)
          else schedule(wakeRequested ? wakeDelayMs : intervalMs)
          return claimed
        })
    }, delay)
  }

  return {
    start() {
      stopped = false
      schedule(0)
    },
    wake() {
      if (stopped) return
      if (running) {
        wakeRequested = true
        return
      }
      if (timer) clearTimeout(timer)
      // At once when nothing was scanned lately; otherwise as soon as the spacing allows. A stream of finished jobs, each
      // announcing itself, therefore costs a bounded number of scans, and a lone hint costs no wait at all.
      schedule(Math.max(0, wakeDelayMs - (performance.now() - lastEndedAt)))
    },
    async stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      await running
    },
    tick,
  }
}
