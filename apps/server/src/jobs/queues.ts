/** Queue names and shared options. BullMQ is only the transport: the work_items table is the record (D-056). */
import type { JobsOptions } from 'bullmq'

export const QUEUE = { email: 'email', media: 'media', agent: 'agent' } as const

export const queuePrefix = (environment: string): string => `chatapp-${environment}`

/** Retention of queue jobs: identifiers only, one day for completed (max 1000), seven days for failed (docs/03 section 7). */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 1, // retries are scheduled from Postgres, with backoff and a cap, not by BullMQ
  removeOnComplete: { age: 86_400, count: 1000 },
  removeOnFail: { age: 7 * 86_400 },
}

export type WorkJobData = { workId: string; leaseEpoch: number }
