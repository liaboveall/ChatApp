/** Periodic scans straight from Postgres (docs/03 section 7): reconcile every minute, cleanup every ten. None depends on the queue. */
import { cleanupAttachments, reconcileStorage } from '../domain/attachment-processing.ts'
import type { Deps } from '../domain/deps.ts'
import {
  purgeExpiredRecords,
  purgeSessionsAndOrigins,
  purgeSyncLogs,
  runMaintenanceTask,
} from '../domain/maintenance.ts'
import { reconcileRegistrations } from '../domain/registration.ts'
import { purgeFinishedWork, recoverExpiredWork, workBacklog } from '../domain/work-queue.ts'
import { describeError, type Logger } from '../lib/logger.ts'

export type Maintenance = {
  start(): void
  stop(): Promise<void>
  reconcile(): Promise<void>
  cleanup(): Promise<void>
  attachmentCleanup(): Promise<void>
  storageReconcile(): Promise<void>
}

export function createMaintenance(parts: {
  deps: Deps
  log: Logger
  reconcileMs?: number
  cleanupMs?: number
  attachmentCleanupMs?: number
  storageReconcileMs?: number
}): Maintenance {
  const { deps, log } = parts
  const timers: ReturnType<typeof setInterval>[] = []
  const inFlight = new Set<Promise<void>>()

  const running = new Map<string, Promise<void>>()
  const guarded = (name: string, run: () => Promise<void>) => async () => {
    if (running.has(name)) return
    const job = runMaintenanceTask(deps, name, run).catch((error) =>
      log.error(`maintenance.${name}_failed`, describeError(error)),
    )
    running.set(name, job)
    inFlight.add(job)
    await job.finally(() => {
      inFlight.delete(job)
      running.delete(name)
    })
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

  const attachmentCleanup = guarded('attachment_cleanup', async () => {
    if (deps.blobs) await cleanupAttachments(deps)
  })
  let nextStorageReconcileAt = 0
  const storageReconcile = guarded('storage_reconcile', async () => {
    nextStorageReconcileAt = deps.clock.now().getTime() + 15 * 60_000
    if (deps.blobs) await reconcileStorage(deps)
    nextStorageReconcileAt =
      deps.clock.now().getTime() + (parts.storageReconcileMs ?? 6 * 60 * 60_000)
  })
  const cleanup = guarded('cleanup', async () => {
    const finished = await purgeFinishedWork(deps)
    const sessions = await purgeSessionsAndOrigins(deps)
    const expired = await purgeExpiredRecords(deps)
    const logs = await purgeSyncLogs(deps)
    const total =
      finished +
      Object.values(sessions).reduce((a, b) => a + b, 0) +
      Object.values(expired).reduce((a, b) => a + b, 0) +
      Object.values(logs).reduce((a, b) => a + b, 0)
    if (total > 0) log.info('cleanup.done', { count: total })
  })

  return {
    start() {
      timers.push(setInterval(() => void reconcile(), parts.reconcileMs ?? 60_000))
      timers.push(setInterval(() => void cleanup(), parts.cleanupMs ?? 600_000))
      timers.push(setInterval(() => void attachmentCleanup(), parts.attachmentCleanupMs ?? 60_000))
      timers.push(
        setInterval(
          () => {
            if (deps.clock.now().getTime() >= nextStorageReconcileAt) void storageReconcile()
          },
          Math.min(parts.storageReconcileMs ?? 60_000, 60_000),
        ),
      )
      void reconcile()
      void attachmentCleanup()
      void storageReconcile()
    },
    async stop() {
      for (const timer of timers) clearInterval(timer)
      timers.length = 0
      await Promise.all(inFlight)
    },
    reconcile,
    cleanup,
    attachmentCleanup,
    storageReconcile,
  }
}
