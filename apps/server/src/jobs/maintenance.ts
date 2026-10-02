/** Periodic scans straight from Postgres (docs/03 section 7): reconcile every minute, cleanup every ten. None depends on the queue. */
import type { Deps } from '../domain/deps.ts'
import { purgeExpiredRecords, purgeSessionsAndOrigins } from '../domain/maintenance.ts'
import { reconcileRegistrations } from '../domain/registration.ts'
import { purgeFinishedWork, recoverExpiredWork, workBacklog } from '../domain/work-queue.ts'
import { describeError, type Logger } from '../lib/logger.ts'

export type Maintenance = {
  start(): void
  stop(): Promise<void>
  reconcile(): Promise<void>
  cleanup(): Promise<void>
}

export function createMaintenance(parts: {
  deps: Deps
  log: Logger
  reconcileMs?: number
  cleanupMs?: number
}): Maintenance {
  const { deps, log } = parts
  const timers: ReturnType<typeof setInterval>[] = []
  const inFlight = new Set<Promise<void>>()

  const guarded = (name: string, run: () => Promise<void>) => async () => {
    const job = run().catch((error) =>
      log.error(`maintenance.${name}_failed`, describeError(error)),
    )
    inFlight.add(job)
    await job.finally(() => inFlight.delete(job))
  }

  const reconcile = guarded('reconcile', async () => {
    const work = await recoverExpiredWork(deps)
    const registrations = await reconcileRegistrations(deps)
    if (work.requeued + work.dead > 0)
      log.warn('work.recovered', { count: work.requeued, reason: `dead=${work.dead}` })
    if (registrations.released + registrations.completed + registrations.purged > 0) {
      log.info('registrations.reconciled', {
        count: registrations.released + registrations.completed + registrations.purged,
      })
    }
    const backlog = await workBacklog(deps)
    if (backlog.dead > 0) log.warn('work.dead_letters', { count: backlog.dead })
  })

  const cleanup = guarded('cleanup', async () => {
    const finished = await purgeFinishedWork(deps)
    const sessions = await purgeSessionsAndOrigins(deps)
    const expired = await purgeExpiredRecords(deps)
    const total =
      finished +
      Object.values(sessions).reduce((a, b) => a + b, 0) +
      Object.values(expired).reduce((a, b) => a + b, 0)
    if (total > 0) log.info('cleanup.done', { count: total })
  })

  return {
    start() {
      timers.push(setInterval(() => void reconcile(), parts.reconcileMs ?? 60_000))
      timers.push(setInterval(() => void cleanup(), parts.cleanupMs ?? 600_000))
      void reconcile()
    },
    async stop() {
      for (const timer of timers) clearInterval(timer)
      timers.length = 0
      await Promise.all(inFlight)
    },
    reconcile,
    cleanup,
  }
}
