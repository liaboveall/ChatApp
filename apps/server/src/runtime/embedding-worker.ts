/** Optional local embedding worker for a host API. Default media/development workers keep their existing isolation. */
import { createDatabase } from '@chatapp/db/client'
import { Queue } from 'bullmq'
import { sdkPasswords } from '../auth/passwords.ts'
import { loadConfig } from '../config/index.ts'
import type { Deps } from '../domain/deps.ts'
import { recoverExpiredWork } from '../domain/work-queue.ts'
import { createDispatcher } from '../jobs/dispatcher.ts'
import { createEmbeddingWorker } from '../jobs/embedding.ts'
import {
  DEFAULT_JOB_OPTIONS,
  embeddingQueueName,
  QUEUE,
  queuePrefix,
  type WorkJobData,
} from '../jobs/queues.ts'
import { systemClock } from '../lib/clock.ts'
import { createLogger, describeError } from '../lib/logger.ts'
import { createBullConnection, createValkey } from '../lib/valkey.ts'
import { createEventBus } from '../realtime/bus.ts'
import { assertDatabaseReady } from '../startup.ts'
import { EMBEDDING_MODELS } from './embedding-catalog.ts'
import { createEmbeddingClient, embeddingSettings, startEmbeddingChild } from './embeddings.ts'
import { uuidv7 } from './ids.ts'

const config = loadConfig(process.env)
if (config.env === 'production')
  throw new Error('Production embeddings must run inside the bounded worker container')
const settings = embeddingSettings({ ...process.env, EMBEDDING_ENABLED: 'true' }),
  log = createLogger({ level: config.logLevel, service: 'embedding-worker' })
const database = createDatabase(config.databaseUrl, { max: 2 })
await assertDatabaseReady(database.db, config, log)
const child = await startEmbeddingChild(settings),
  valkey = await createValkey(config.valkeyUrl, 'embedding-worker'),
  subscriber = await createValkey(config.valkeyUrl, 'embedding-worker-sub')
const bus = createEventBus({ publisher: valkey, subscriber, channel: config.eventChannel, log }),
  connection = createBullConnection(config.valkeyUrl, 'embedding-queue'),
  consumer = createBullConnection(config.valkeyUrl, 'embedding-consumer')
const deps: Deps = {
  db: database.db,
  clock: systemClock,
  newId: uuidv7,
  passwords: sdkPasswords,
  log,
  config: {
    origin: config.origin,
    timezone: config.timezone,
    auth: config.auth,
    product: config.product,
  },
  embeddings: createEmbeddingClient(settings),
}
const options = {
    connection,
    prefix: queuePrefix(config.env),
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  },
  model = EMBEDDING_MODELS[settings.name],
  queue = new Queue<WorkJobData>(embeddingQueueName(model.version), options),
  emailQueue = new Queue<WorkJobData>(QUEUE.email, options)
const worker = createEmbeddingWorker({ deps, connection: consumer, environment: config.env }),
  dispatcher = createDispatcher({
    deps,
    bus,
    emailQueue,
    embeddingQueues: new Map([[model.version, queue]]),
    log,
    kinds: ['embedding'],
    batch: 10,
  })
await bus.subscribe((event) => {
  if (event.type === 'work.wake') dispatcher.wake()
})
dispatcher.start()
const recovery = setInterval(() => {
  void recoverExpiredWork(deps).catch((error) =>
    log.warn('embedding.recovery_failed', describeError(error)),
  )
}, 60000)
let stopped = false
const stop = async () => {
  if (stopped) return
  stopped = true
  clearInterval(recovery)
  await dispatcher.stop()
  await worker.close()
  await queue.close()
  await emailQueue.close()
  await child.stop()
  connection.disconnect()
  consumer.disconnect()
  valkey.disconnect()
  subscriber.disconnect()
  await database.close()
  process.exit(0)
}
process.on('SIGTERM', () => void stop())
process.on('SIGINT', () => void stop())
log.info('embedding.worker_started', { reason: model.version })
