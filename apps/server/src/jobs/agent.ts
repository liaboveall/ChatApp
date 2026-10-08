import { Worker } from 'bullmq'
import type { AiConfig } from '../config/ai.ts'
import type { Deps } from '../domain/deps.ts'
import { beginWork, completeWork, renewWork } from '../domain/work-queue.ts'
import type { Valkey } from '../lib/valkey.ts'
import type { EventBus } from '../realtime/bus.ts'
import { executeAgentRun } from '../runtime/agent.ts'
import { QUEUE, queuePrefix, type WorkJobData } from './queues.ts'

export function createAgentWorker(parts: {
  deps: Deps
  config: AiConfig
  bus: EventBus
  connection: Valkey
  environment: string
}): Worker<WorkJobData> {
  return new Worker<WorkJobData>(
    QUEUE.agent,
    async (job) => {
      const lease = { id: job.data.workId, leaseEpoch: job.data.leaseEpoch }
      const work = await beginWork(parts.deps, lease)
      if (!work?.entityId) return
      let renewal: Promise<unknown> | undefined
      const timer = setInterval(() => {
        renewal ??= renewWork(parts.deps, lease)
          .catch(() => false)
          .finally(() => {
            renewal = undefined
          })
      }, 30_000)
      try {
        await executeAgentRun(
          {
            deps: parts.deps,
            config: parts.config,
            emitDelta: async (data) => {
              await parts.bus.publish({ type: 'agent.delta', ...data })
            },
          },
          work.entityId,
        )
        await completeWork(parts.deps, lease)
      } finally {
        clearInterval(timer)
        await renewal
      }
    },
    { connection: parts.connection, prefix: queuePrefix(parts.environment), concurrency: 4 },
  )
}
