/**
 * Worker process (docs/03 section 7): the dispatcher that turns committed work_items into queue jobs and bus events, the
 * BullMQ consumers, and the periodic Postgres scans (reconcile every minute, cleanup every ten). It owns no HTTP port.
 * This file is a composition root, so it may use runtime-specific pieces directly (D-090).
 */
import { createDatabase } from '@chatapp/db/client'
import { Queue } from 'bullmq'
import { sdkPasswords } from './auth/passwords.ts'
import { type Config, ConfigError, loadConfig } from './config/index.ts'
import type { Deps } from './domain/deps.ts'
import { createDispatcher } from './jobs/dispatcher.ts'
import { createEmailWorker } from './jobs/email.ts'
import { createMaintenance } from './jobs/maintenance.ts'
import { createPresenceSweeper } from './jobs/presence.ts'
import { DEFAULT_JOB_OPTIONS, QUEUE, queuePrefix, type WorkJobData } from './jobs/queues.ts'
import { createSmtpMailer } from './jobs/smtp.ts'
import { systemClock } from './lib/clock.ts'
import { createLogger, describeError } from './lib/logger.ts'
import { createBullConnection, createValkey } from './lib/valkey.ts'
import { createEventBus } from './realtime/bus.ts'
import { createPresenceStore } from './realtime/presence.ts'
import { uuidv7 } from './runtime/ids.ts'
import { assertDatabaseReady } from './startup.ts'

async function main(): Promise<void> {
  let config: Config
  try {
    config = loadConfig(process.env)
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message)
      process.exit(1)
    }
    throw error
  }
  const log = createLogger({ level: config.logLevel, service: 'worker' })

  const database = createDatabase(config.databaseUrl, { max: 6, applicationName: 'chatapp-worker' })
  await assertDatabaseReady(database.db, config, log)
  const valkey = await createValkey(config.valkeyUrl, 'worker', {
    onError: (error) => log.warn('valkey.error', describeError(error)),
  })
  const subscriber = await createValkey(config.valkeyUrl, 'worker-sub')
  const bus = createEventBus({ publisher: valkey, subscriber, channel: config.eventChannel, log })

  const deps: Deps = {
    db: database.db,
    clock: systemClock,
    newId: uuidv7,
    config: {
      origin: config.origin,
      timezone: config.timezone,
      auth: {
        tokenEncryptionKey: config.auth.tokenEncryptionKey,
        cursorKey: config.auth.cursorKey,
        restoreEpoch: config.auth.restoreEpoch,
      },
      product: config.product,
    },
    passwords: sdkPasswords,
    log,
  }

  const queueConnection = createBullConnection(config.valkeyUrl, 'worker-queue')
  const consumerConnection = createBullConnection(config.valkeyUrl, 'worker-consumer')
  const emailQueue = new Queue<WorkJobData>(QUEUE.email, {
    connection: queueConnection,
    prefix: queuePrefix(config.env),
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  })
  const dispatcher = createDispatcher({ deps, bus, emailQueue, log })
  const emailWorker = createEmailWorker({
    deps,
    mailer: createSmtpMailer(config.smtp),
    log,
    connection: consumerConnection,
    environment: config.env,
  })
  const maintenance = createMaintenance({ deps, log })
  const presence = createPresenceSweeper({
    deps,
    store: createPresenceStore(valkey, `presence:${config.env}`),
    bus,
    log,
  })

  await bus.subscribe((event) => {
    if (event.type === 'work.wake') dispatcher.wake()
  })
  dispatcher.start()
  maintenance.start()
  presence.start()
  log.info('worker.started', { reason: config.env })

  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    log.info('worker.stopping')
    await dispatcher.stop()
    await maintenance.stop()
    await presence.stop()
    await emailWorker.close()
    await emailQueue.close()
    queueConnection.disconnect()
    consumerConnection.disconnect()
    valkey.disconnect()
    subscriber.disconnect()
    await database.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())
}

await main().catch((error) => {
  const fields = describeError(error)
  console.error(
    `worker failed to start: ${fields.errorName}${fields.errorCode ? ` (${fields.errorCode})` : ''}`,
  )
  if (error instanceof Error && error.message.startsWith('database is not bootstrapped')) {
    console.error(error.message)
  }
  process.exit(1)
})
