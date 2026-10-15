/**
 * API process: Hono over Bun.serve, plus the WebSocket gateway on /ws (docs/03 section 4). This file is a composition
 * root, so it is allowed to touch Bun directly (D-090); everything it wires together stays runtime-neutral.
 */
import { LIMITS } from '@chatapp/contracts'
import { createDatabase } from '@chatapp/db/client'
import { createAuth } from './auth/better-auth.ts'
import { sdkPasswords } from './auth/passwords.ts'
import { loadAiConfig } from './config/ai.ts'
import { type Config, ConfigError, loadConfig } from './config/index.ts'
import { loadJournalSettings } from './config/journal.ts'
import { withPhysicalDeletion } from './domain/backups.ts'
import type { Deps } from './domain/deps.ts'
import { assertRestoreUnlocked } from './domain/restore.ts'
import { createReadiness } from './health.ts'
import { createApp } from './http/app.ts'
import type { Services } from './http/context.ts'
import { assertNoTestRoutes } from './http/routes/test.ts'
import { systemClock } from './lib/clock.ts'
import { createClientIpResolver } from './lib/ip.ts'
import { createLogger, describeError } from './lib/logger.ts'
import { RateLimiter } from './lib/rate-limit.ts'
import { createValkey } from './lib/valkey.ts'
import { createEventBus } from './realtime/bus.ts'
import { Gateway } from './realtime/gateway.ts'
import { createPresenceStore } from './realtime/presence.ts'
import { connectGatewayToBus } from './realtime/wiring.ts'
import { deepSeekKeyVerifier, mockKeyVerifier } from './runtime/ai-key-verifier.ts'
import { createRuntimeDeletionJournal } from './runtime/deletion-journal.ts'
import { createEmbeddingClient, embeddingSettings } from './runtime/embeddings.ts'
import { uuidv7 } from './runtime/ids.ts'
import { createMonitoring } from './runtime/monitoring.ts'
import { startProcessHealth } from './runtime/process-health.ts'
import { capturedPushKey, createPushService } from './runtime/push-service.ts'
import { startServer } from './runtime/server.ts'
import { assertDatabaseReady, createWaker } from './startup.ts'
import { createBlobStore } from './storage/s3.ts'

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
  const log = createLogger({ level: config.logLevel, service: 'api' })
  if (process.env.RESTORE_MODE && !['normal', 'isolated'].includes(process.env.RESTORE_MODE))
    throw new Error('invalid restore mode')
  if (process.env.RESTORE_MODE === 'isolated')
    throw new Error('isolated restore cannot start the public API')
  const journalSettings = loadJournalSettings(process.env)
  const deletionJournal = journalSettings
    ? await createRuntimeDeletionJournal(journalSettings)
    : undefined
  const { apiKey: _apiKey, ...aiPolicy } = loadAiConfig(process.env, { requireKey: false })

  const database = createDatabase(config.databaseUrl, { max: 10, applicationName: 'chatapp-api' })
  await assertDatabaseReady(database.db, config, log)
  await assertRestoreUnlocked(database.db)
  const valkey = await createValkey(config.valkeyUrl, 'api', {
    onError: (error) => log.warn('valkey.error', describeError(error)),
  })
  const subscriber = await createValkey(config.valkeyUrl, 'api-sub')
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
      ai: aiPolicy,
      aiKeyEncryptionKey: config.aiKeyEncryptionKey,
    },
    blobs: createBlobStore(config.s3, {
      physicalDeletion: (remove) => withPhysicalDeletion({ db: database.db }, remove),
    }),
    ...(deletionJournal ? { deletionJournal } : {}),
    passwords: sdkPasswords,
    log,
    // Tests never reach a provider; elsewhere the free model list verifies a member's own key before it is stored.
    aiKeyVerifier: config.env === 'test' ? mockKeyVerifier : deepSeekKeyVerifier(),
    ...(config.push ? { push: createPushService(config, valkey) } : {}),
    ...(embeddingSettings(process.env).enabled
      ? { embeddings: createEmbeddingClient(embeddingSettings(process.env)) }
      : {}),
  }
  const gateway = new Gateway(
    deps,
    log,
    {
      revalidateMs: LIMITS.wsRevalidateMs,
      heartbeatMs: LIMITS.wsHeartbeatMs,
      pongTimeoutMs: LIMITS.wsPongTimeoutMs,
      maxConnectionsPerUser: LIMITS.wsMaxConnectionsPerUser,
      frameBytes: LIMITS.wsFrameBytes,
      sendBufferBytes: LIMITS.wsSendBufferBytes,
      messageWindowMs: 10_000,
      maxMessagesPerWindow: 200,
    },
    Date.now,
    { bus, presence: createPresenceStore(valkey, `presence:${config.env}`) },
  )
  const services: Services = {
    monitoring: createMonitoring(process.env),
    config,
    deps,
    auth: createAuth(deps, { baseOrigin: config.origin, secret: config.auth.secret }),
    limiter: new RateLimiter(valkey, config.env),
    log,
    resolveClientIp: createClientIpResolver(config.trustedProxies),
    isReady: createReadiness({ db: database.db, valkey, blobs: createBlobStore(config.s3) }),
    wake: createWaker(() => bus.publish({ type: 'work.wake' })),
    realtime: gateway,
    ...(config.env === 'test'
      ? {
          pushOutbox: {
            list: async () =>
              (await valkey.lrange(capturedPushKey(config.env), 0, -1)).map((line) =>
                JSON.parse(line),
              ),
            clear: async () => await valkey.del(capturedPushKey(config.env)),
          },
        }
      : {}),
  }
  const app = createApp(services)
  // SEC-29: test-only routes must not exist outside APP_ENV=test.
  if (config.env !== 'test') assertNoTestRoutes(app)

  const disconnectGateway = await connectGatewayToBus(bus, gateway)
  gateway.start()

  const server = startServer({
    app,
    services,
    gateway,
    hostname: config.apiHost,
    port: config.apiPort,
  })
  log.info('api.started', { count: server.port, reason: config.env })
  const health = await startProcessHealth(process.env.PROCESS_HEALTH_FILE, 'api')

  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    await health.stop()
    log.info('api.stopping')
    gateway.shutdown()
    await disconnectGateway()
    await server.stop()
    await gateway.settled()
    valkey.disconnect()
    subscriber.disconnect()
    await database.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())
}

await main().catch((error) => {
  // Start-up failures print the class and a short code only; messages may quote connection details.
  const fields = describeError(error)
  console.error(
    `api failed to start: ${fields.errorName}${fields.errorCode ? ` (${fields.errorCode})` : ''}`,
  )
  if (error instanceof Error && error.message.startsWith('database is not bootstrapped')) {
    console.error(error.message)
  }
  process.exit(1)
})
