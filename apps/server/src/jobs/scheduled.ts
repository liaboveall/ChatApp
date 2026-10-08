import { Worker } from 'bullmq'
import type { Deps } from '../domain/deps.ts'
import { deliverTask } from '../domain/tasks.ts'
import { beginWork, completeWork } from '../domain/work-queue.ts'
import type { Valkey } from '../lib/valkey.ts'
import { QUEUE, queuePrefix, type WorkJobData } from './queues.ts'

/**
 * Delivers due reminders and scheduled messages (docs/03 section 7: concurrency 2). The work intent only names the
 * task; delivery re-checks everything under the task's own locks, so a redelivered job finds the task finished.
 */
export function createScheduledWorker(parts: {
  deps: Deps
  connection: Valkey
  environment: string
}): Worker<WorkJobData> {
  return new Worker<WorkJobData>(
    QUEUE.scheduled,
    async (job) => {
      const lease = { id: job.data.workId, leaseEpoch: job.data.leaseEpoch }
      const work = await beginWork(parts.deps, lease)
      if (!work?.entityId) return
      const kind = work.payload.task === 'reminder' ? 'reminder' : 'scheduled_message'
      await deliverTask(parts.deps, kind, work.entityId)
      await completeWork(parts.deps, lease)
    },
    { connection: parts.connection, prefix: queuePrefix(parts.environment), concurrency: 2 },
  )
}
