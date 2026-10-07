import { Worker } from 'bullmq'
import { processAttachment } from '../domain/attachment-processing.ts'
import type { Deps } from '../domain/deps.ts'
import type { Valkey } from '../lib/valkey.ts'
import { QUEUE, queuePrefix, type WorkJobData } from './queues.ts'

export function createMediaWorker(parts: {
  deps: Deps
  connection: Valkey
  environment: string
}): Worker<WorkJobData> {
  // Exactly one active job per isolated decoder. Busy from another worker is retried by Postgres.
  return new Worker<WorkJobData>(
    QUEUE.media,
    (job) =>
      processAttachment(parts.deps, { id: job.data.workId, leaseEpoch: job.data.leaseEpoch }),
    { connection: parts.connection, prefix: queuePrefix(parts.environment), concurrency: 1 },
  )
}
