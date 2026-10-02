/** Consumer of the `email` queue: delivers one-time credential emails for work items (docs/03 section 7: 2 at a time, 5 attempts). */
import { type Job, Worker } from 'bullmq'
import type { Deps } from '../domain/deps.ts'
import { deliverCredentialEmail, type Mailer } from '../domain/mail.ts'
import { beginWork, completeWork, failWork } from '../domain/work-queue.ts'
import { describeError, type Logger } from '../lib/logger.ts'
import type { Valkey } from '../lib/valkey.ts'
import { QUEUE, queuePrefix, type WorkJobData } from './queues.ts'

/** The processor for one job; separate from the Worker so tests can call it directly. */
export async function processEmailJob(
  parts: { deps: Deps; mailer: Mailer; log: Logger },
  data: WorkJobData,
): Promise<'sent' | 'skipped' | 'stale' | 'failed'> {
  const { deps, mailer, log } = parts
  const lease = { id: data.workId, leaseEpoch: data.leaseEpoch }
  const work = await beginWork(deps, lease)
  // A redelivered job whose epoch no longer owns the item must not do anything (INV-16 style compare-and-set).
  if (!work) return 'stale'
  try {
    const outcome = await deliverCredentialEmail(deps, mailer, {
      id: work.id,
      entityId: work.entityId,
    })
    await completeWork(deps, lease)
    return outcome
  } catch (error) {
    const result = await failWork(deps, lease, {
      kind: 'email',
      errorCode: describeError(error).errorCode?.toString() ?? 'delivery_failed',
    })
    log.warn('email.delivery_failed', { workId: work.id, reason: result, ...describeError(error) })
    return 'failed'
  }
}

export function createEmailWorker(parts: {
  deps: Deps
  mailer: Mailer
  log: Logger
  connection: Valkey
  environment: string
}): Worker<WorkJobData> {
  return new Worker<WorkJobData>(
    QUEUE.email,
    (job: Job<WorkJobData>) => processEmailJob(parts, job.data),
    { connection: parts.connection, prefix: queuePrefix(parts.environment), concurrency: 2 },
  )
}
