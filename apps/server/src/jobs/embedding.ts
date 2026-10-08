import { Worker } from 'bullmq'
import type { Deps } from '../domain/deps.ts'
import { indexEmbedding } from '../domain/embeddings.ts'
import { beginWork, completeWork, failWork } from '../domain/work-queue.ts'
import type { Valkey } from '../lib/valkey.ts'
import { embeddingQueueName, queuePrefix, type WorkJobData } from './queues.ts'

export function createEmbeddingWorker(parts: {
  deps: Deps
  connection: Valkey
  environment: string
}) {
  if (!parts.deps.embeddings)
    throw new Error('Local embedding worker needs a configured generation')
  return new Worker<WorkJobData>(
    embeddingQueueName(parts.deps.embeddings.modelVersion),
    async (job) => {
      const lease = { id: job.data.workId, leaseEpoch: job.data.leaseEpoch }
      const work = await beginWork(parts.deps, lease)
      if (!work) return
      try {
        if (work.entityId && work.entityVersion && typeof work.payload.modelVersion === 'string')
          await indexEmbedding(parts.deps, {
            id: work.entityId,
            version: work.entityVersion,
            modelVersion: work.payload.modelVersion,
            target: work.payload.target === 'memory' ? 'memory' : 'message',
          })
        await completeWork(parts.deps, lease)
      } catch {
        await failWork(parts.deps, lease, {
          kind: 'embedding',
          errorCode: 'LOCAL_EMBEDDING_UNAVAILABLE',
        })
      }
    },
    {
      connection: parts.connection,
      prefix: queuePrefix(parts.environment),
      concurrency: 1,
      limiter: { max: 10, duration: 1000 },
    },
  )
}
