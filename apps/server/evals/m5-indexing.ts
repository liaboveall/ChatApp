/** Real Postgres -> dispatcher -> BullMQ -> credential-free Unix IPC -> native ONNX -> versioned SQL chain. */
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  authorizationOrigins,
  embeddingModels,
  memoryEmbeddings,
  messageEmbeddings,
  sessions,
  users,
  workItems,
} from '@chatapp/db'
import { runBootstrap } from '@chatapp/db/bootstrap'
import { createDatabase, type Database } from '@chatapp/db/client'
import { runMigrations } from '@chatapp/db/migrate'
import { Queue } from 'bullmq'
import { and, eq, sql } from 'drizzle-orm'
import { loadConfig } from '../src/config/index.ts'
import { createConversation } from '../src/domain/conversations.ts'
import type { Deps } from '../src/domain/deps.ts'
import { backfillEmbeddings } from '../src/domain/embeddings.ts'
import { addMemory, deleteMemory } from '../src/domain/memories.ts'
import { editMessage, recallMessage, sendMessage } from '../src/domain/messages.ts'
import type { SessionPrincipal } from '../src/domain/principal.ts'
import { createDispatcher } from '../src/jobs/dispatcher.ts'
import { createEmbeddingWorker } from '../src/jobs/embedding.ts'
import { embeddingQueueName, queuePrefix, type WorkJobData } from '../src/jobs/queues.ts'
import { systemClock } from '../src/lib/clock.ts'
import { silentLogger } from '../src/lib/logger.ts'
import { createBullConnection } from '../src/lib/valkey.ts'
import { EMBEDDING_MODELS } from '../src/runtime/embedding-catalog.ts'
import { createEmbeddingClient, startEmbeddingChild } from '../src/runtime/embeddings.ts'
import { uuidv7 } from '../src/runtime/ids.ts'
import { getEnv, readEnvFile } from './environment.ts'
import { evaluationSourceManifest, sourceDigest } from './source-manifest.ts'

const id = randomUUID(),
  dir = resolve('.test-runs/m5', `indexing-${id}`)
await mkdir(dir, { recursive: true, mode: 0o700 })
const file = await readEnvFile('.env.local'),
  source: Record<string, string | undefined> = {}
for (const line of file.lines) {
  const key = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line)?.[1]
  if (key) source[key] = getEnv(file, key)
}
const baseOwner = source.DATABASE_OWNER_URL_TEST,
  baseApp = source.DATABASE_URL_TEST
if (
  !baseOwner ||
  !baseApp ||
  !new URL(baseOwner).pathname.endsWith('_test') ||
  !new URL(baseApp).pathname.endsWith('_test')
)
  throw new Error('isolated TEST URLs required')
const databaseName = `chatapp_m5_index_${id.replaceAll('-', '')}_test`,
  ownerUrl = new URL(baseOwner),
  appUrl = new URL(baseApp)
ownerUrl.pathname = appUrl.pathname = `/${databaseName}`
const config = loadConfig({
    ...source,
    APP_ENV: 'test',
    DATABASE_OWNER_URL_TEST: ownerUrl.href,
    DATABASE_URL_TEST: appUrl.href,
  }),
  control = createDatabase(baseOwner, { max: 1 }),
  model = EMBEDDING_MODELS.bge,
  environment = `m5-${id}`,
  sourceHash = sourceDigest(JSON.stringify(await evaluationSourceManifest())),
  connection = createBullConnection(config.valkeyUrl, `m5-${id}-queue`),
  consumer = createBullConnection(config.valkeyUrl, `m5-${id}-consumer`),
  options = { connection, prefix: queuePrefix(environment) },
  queue = new Queue<WorkJobData>(embeddingQueueName(model.version), options),
  emailQueue = new Queue<WorkJobData>('email', options),
  checks: { name: string; passed: boolean }[] = []
let database: Database | undefined,
  child: Awaited<ReturnType<typeof startEmbeddingChild>> | undefined,
  worker: ReturnType<typeof createEmbeddingWorker> | undefined,
  created = false
const check = (name: string, passed: boolean) => checks.push({ name, passed })
try {
  await control.db.execute(sql.raw(`CREATE DATABASE "${databaseName}"`))
  created = true
  await runMigrations({
    ownerUrl: ownerUrl.href,
    appRole: {
      role: decodeURIComponent(new URL(baseApp).username),
      password: decodeURIComponent(new URL(baseApp).password),
    },
  })
  database = createDatabase(appUrl.href, { max: 3 })
  const settings = {
    enabled: true,
    name: 'bge' as const,
    socket: join(dir, 'ipc', 'embedding.sock'),
    cache: resolve('.test-runs/m5/models'),
  }
  child = await startEmbeddingChild(settings)
  let ready = false
  for (let i = 0; i < 100; i++) {
    try {
      if (
        (
          await fetch('http://embedding.local/health', {
            unix: settings.socket,
            signal: AbortSignal.timeout(200),
          })
        ).ok
      ) {
        ready = true
        break
      }
    } catch {}
    await delay(100)
  }
  if (!ready) throw new Error('offline child unavailable')
  const deps: Deps = {
    db: database.db,
    clock: systemClock,
    newId: uuidv7,
    log: silentLogger,
    config: {
      origin: config.origin,
      timezone: config.timezone,
      auth: config.auth,
      product: config.product,
    },
    passwords: {
      hash: async () => {
        throw new Error('not used')
      },
      verify: async () => false,
    },
    embeddings: createEmbeddingClient(settings),
  }
  await runBootstrap(deps.db, { ...deps.config.product, productName: deps.config.product.name })
  const userId = uuidv7(),
    peerId = uuidv7(),
    originId = uuidv7(),
    sessionId = uuidv7()
  await deps.db.insert(users).values([
    {
      id: userId,
      username: 'm5_index_owner',
      name: '合成本人',
      email: 'owner@index.invalid',
      activationStatus: 'active',
      accountSource: 'cli',
      emailVerified: true,
    },
    {
      id: peerId,
      username: 'm5_index_peer',
      name: '合成同伴',
      email: 'peer@index.invalid',
      activationStatus: 'active',
      accountSource: 'cli',
      emailVerified: true,
    },
  ])
  await deps.db
    .insert(authorizationOrigins)
    .values({ id: originId, userId, restoreEpoch: config.auth.restoreEpoch })
  await deps.db.insert(sessions).values({
    id: sessionId,
    userId,
    token: randomUUID(),
    authorizationOriginId: originId,
    authEpoch: 0,
    expiresAt: new Date(Date.now() + 86400000),
  })
  const principal: SessionPrincipal = {
      kind: 'session',
      userId,
      sessionId,
      originId,
      authEpoch: 0,
      restoreEpoch: config.auth.restoreEpoch,
      role: 'user',
    },
    group = (
      await createConversation(
        deps,
        principal,
        { kind: 'group', name: '索引链', memberIds: [peerId] },
        uuidv7(),
      )
    ).conversation
  // This earlier message has no realtime index intent; it must travel the bounded backfill path.
  const old = (
    await sendMessage(deps, principal, group.id, {
      clientId: uuidv7(),
      body: '历史回填保留全部正文',
    })
  ).envelope.message
  await deps.db.insert(embeddingModels).values([
    { version: model.version, dimension: 512, status: 'active', createdAt: deps.clock.now() },
    {
      version: EMBEDDING_MODELS.qwen.version,
      dimension: 1024,
      status: 'staging',
      createdAt: deps.clock.now(),
    },
  ])
  const current = (
    await sendMessage(deps, principal, group.id, {
      clientId: uuidv7(),
      body: '上线负责人是韩霖，按灰度发布。',
    })
  ).envelope.message
  await editMessage(deps, principal, current.id, {
    body: '韩霖取消发布并保留历史数据。',
    expectedChangeSeq: current.changeSeq,
  })
  const short = (await sendMessage(deps, principal, group.id, { clientId: uuidv7(), body: '好的' }))
    .envelope.message
  const memory = await addMemory(deps, principal, { content: '我喜欢无糖绿茶', allowSite: true })
  check('bounded backfill enqueued', (await backfillEmbeddings(deps, model.version, 100)) === 2)
  worker = createEmbeddingWorker({ deps, connection: consumer, environment })
  await worker.pause(true)
  const dispatcher = createDispatcher({
    deps,
    bus: {
      publish: async () => {},
      subscribe: async () => async () => {},
      onReconnect: () => () => {},
    },
    emailQueue,
    embeddingQueues: new Map([[model.version, queue]]),
    log: silentLogger,
    kinds: ['embedding'],
    batch: 10,
  })
  await dispatcher.tick()
  const waiting = await queue.getJobs(['waiting', 'prioritized'])
  check(
    'realtime jobs precede batch work',
    waiting.every((j) => j.opts.priority === 1),
  )
  check(
    'BullMQ payloads contain identifiers only',
    waiting.length === 3 &&
      waiting.every((j) => Object.keys(j.data).sort().join(',') === 'leaseEpoch,workId'),
  )
  await worker.resume()
  for (let i = 0; i < 150; i++) {
    await dispatcher.tick()
    const pending = await deps.db
      .select()
      .from(workItems)
      .where(
        and(
          eq(workItems.kind, 'embedding'),
          sql`${workItems.payload}->>'modelVersion' = ${model.version}`,
          sql`${workItems.status} <> 'done'`,
        ),
      )
    if (!pending.length) break
    await delay(100)
  }
  const vectors = await deps.db.select().from(messageEmbeddings),
    memories = await deps.db.select().from(memoryEmbeddings),
    work = await deps.db.select().from(workItems).where(eq(workItems.kind, 'embedding'))
  check(
    'native current message version committed',
    vectors.some(
      (v) => v.messageId === current.id && v.contentVersion === 2 && v.dimension === 512,
    ),
  )
  check(
    'old message version never published',
    !vectors.some((v) => v.messageId === current.id && v.contentVersion === 1),
  )
  check(
    'historical backfill committed',
    vectors.some((v) => v.messageId === old.id),
  )
  check('short messages are not indexed', !vectors.some((v) => v.messageId === short.id))
  check('personal memory indexed', memories.length === 1 && memories[0]?.memoryId === memory.id)
  check(
    'different model dimension remains pending without burning attempts',
    work
      .filter((w) => w.payload.modelVersion === EMBEDDING_MODELS.qwen.version)
      .every((w) => w.status === 'pending' && w.attempts === 0 && w.leaseEpoch === 0),
  )
  check(
    'configured generation finishes durable work',
    work.filter((w) => w.payload.modelVersion === model.version).every((w) => w.status === 'done'),
  )
  const jobs = await queue.getJobs(['completed'])
  check(
    'batch priority is lower',
    jobs.some((j) => j.opts.priority === 10),
  )
  await recallMessage(deps, principal, current.id)
  await deleteMemory(deps, principal, memory.id)
  check(
    'withdrawal removes message vector immediately',
    !(await deps.db.select().from(messageEmbeddings)).some((v) => v.messageId === current.id),
  )
  check(
    'memory deletion removes vectors immediately',
    (await deps.db.select().from(memoryEmbeddings)).length === 0,
  )
  const sourceUnchanged =
      sourceDigest(JSON.stringify(await evaluationSourceManifest())) === sourceHash,
    result = {
      id,
      sourceHash,
      sourceUnchanged,
      architecture: process.arch,
      native: true,
      nativeArm: process.arch === 'arm64',
      modelVersion: model.version,
      checks,
      passed: sourceUnchanged && checks.every((c) => c.passed),
      queueIsolation: queuePrefix(environment),
      databaseIsolation: databaseName,
      mixedLoad: false,
    }
  await writeFile(join(dir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify({ dir, passed: result.passed, checks }))
  if (!result.passed) process.exitCode = 1
} finally {
  await worker?.close()
  await queue.obliterate({ force: true })
  await emailQueue.obliterate({ force: true })
  await queue.close()
  await emailQueue.close()
  connection.disconnect()
  consumer.disconnect()
  await child?.stop()
  await database?.close()
  if (created) await control.db.execute(sql.raw(`DROP DATABASE "${databaseName}" WITH (FORCE)`))
  await control.close()
}
