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
import type { Deps } from './domain/deps.ts'
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
import { createEmbeddingClient, embeddingSettings } from './runtime/embeddings.ts'
import { uuidv7 } from './runtime/ids.ts'
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
  const { apiKey: _apiKey, ...aiPolicy } = loadAiConfig(process.env, { requireKey: false })

  const database = createDatabase(config.databaseUrl, { max: 10, applicationName: 'chatapp-api' })
  await assertDatabaseReady(database.db, config, log)
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
    blobs: createBlobStore(config.s3),
    passwords: sdkPasswords,
    log,
    // Tests never reach a provider; elsewhere the free model list verifies a member's own key before it is stored.
    aiKeyVerifier: config.env === 'test' ? mockKeyVerifier : deepSeekKeyVerifier(),
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
    config,
    deps,
    auth: createAuth(deps, { baseOrigin: config.origin, secret: config.auth.secret }),
    limiter: new RateLimiter(valkey, config.env),
    log,
    resolveClientIp: createClientIpResolver(config.trustedProxies),
    isReady: createReadiness({ db: database.db, valkey, blobs: createBlobStore(config.s3) }),
    wake: createWaker(() => bus.publish({ type: 'work.wake' })),
    realtime: gateway,
  }
  const app = createApp(services)
  // SEC-29: test-only routes must not exist outside APP_ENV=test.
  if (config.env !== 'test') assertNoTestRoutes(app)

  await connectGatewayToBus(bus, gateway)
  gateway.start()

  const server = startServer({
    app,
    services,
    gateway,
    hostname: config.apiHost,
    port: config.apiPort,
  })
  log.info('api.started', { count: server.port, reason: config.env })

  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    log.info('api.stopping')
    gateway.shutdown()
    await server.stop()
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
