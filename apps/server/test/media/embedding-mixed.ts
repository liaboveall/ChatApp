import { createHash, randomBytes } from 'node:crypto'
/** Executed in the worker cgroup. All imports are from the freshly built image; nothing uses host credentials. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { AppError, loadFixtureSchema, mixedProbeInputSchema } from '@chatapp/contracts'
import {
  accounts,
  appSettings,
  embeddingModels,
  messageEmbeddings,
  users,
  workItems,
} from '@chatapp/db'
import { createDatabase } from '@chatapp/db/client'
import { Queue } from 'bullmq'
import { and, eq, sql } from 'drizzle-orm'
import { createAuth } from '../../src/auth/better-auth.ts'
import { sdkPasswords } from '../../src/auth/passwords.ts'
import { loadConfig } from '../../src/config/index.ts'
import { seedBenchmark } from '../../src/domain/benchmark.ts'
import { backfillEmbeddings } from '../../src/domain/embeddings.ts'
import { createDispatcher } from '../../src/jobs/dispatcher.ts'
import { createEmbeddingWorker } from '../../src/jobs/embedding.ts'
import { embeddingQueueName, queuePrefix } from '../../src/jobs/queues.ts'
import { systemClock } from '../../src/lib/clock.ts'
import { silentLogger } from '../../src/lib/logger.ts'
import { createBullConnection } from '../../src/lib/valkey.ts'
import { createEmbeddingClient, startEmbeddingChild } from '../../src/runtime/embeddings.ts'
import { uuidv7 } from '../../src/runtime/ids.ts'
import { createBlobStore } from '../../src/storage/s3.ts'

const data = mixedProbeInputSchema.parse(JSON.parse(await new Response(Bun.stdin.stream()).text()))
const config = loadConfig(process.env),
  database = createDatabase(config.databaseUrl, { max: 2 }),
  modelVersion = 'bge-small-zh-q8-75c43b06',
  settings = {
    enabled: true,
    name: 'bge' as const,
    socket: '/tmp/m5-ipc/embedding.sock',
    cache: '/tmp/m5-models',
  }
for (const file of data.files) {
  if (file.path.includes('..') || file.path.startsWith('/')) throw new Error('invalid model file')
  const path = `${settings.cache}/Xenova/bge-small-zh-v1.5/75c43b069aac4d136ba6bc1122f995fedcfd2781/${file.path}`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, Buffer.from(file.data, 'base64'))
}
data.files.splice(0)
const child = await startEmbeddingChild(settings),
  connection = createBullConnection(config.valkeyUrl, 'm5-mixed-queue'),
  consumer = createBullConnection(config.valkeyUrl, 'm5-mixed-consumer'),
  queue = new Queue(embeddingQueueName(modelVersion), { connection, prefix: queuePrefix('test') }),
  emailQueue = new Queue('email', { connection, prefix: queuePrefix('test') }),
  deps = {
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
    passwords: sdkPasswords,
    embeddings: createEmbeddingClient(settings),
  },
  worker = createEmbeddingWorker({ deps, connection: consumer, environment: 'test' }),
  dispatcher = createDispatcher({
    deps,
    bus: {
      publish: async () => {},
      subscribe: async () => async () => {},
      onReconnect: () => () => {},
    },
    emailQueue,
    embeddingQueues: new Map([[modelVersion, queue]]),
    kinds: ['embedding'],
    log: silentLogger,
    batch: 10,
  })
let peak = 0,
  timer: ReturnType<typeof setInterval> | undefined,
  observationTimer: ReturnType<typeof setInterval> | undefined
try {
  let ready = false
  for (let i = 0; i < 150; i++) {
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
  if (!ready || !child.pid) throw new Error('native child unavailable')
  const env = await readFile(`/proc/${child.pid}/environ`, 'utf8')
  if (/DATABASE_URL=|SOCLAAS_API_KEY=|S3_SECRET_ACCESS_KEY=|BETTER_AUTH_SECRET=/.test(env))
    throw new Error('child credentials')
  timer = setInterval(() => {
    void readFile(`/proc/${child.pid}/status`, 'utf8')
      .then((s) => {
        peak = Math.max(peak, Number(/VmHWM:\s+(\d+)/.exec(s)?.[1] ?? 0) * 1024)
      })
      .catch(() => {})
  }, 50)
  const password = 'synthetic-m5-load-password',
    members: { id: string; cookie: string }[] = []
  for (let i = 0; i < 10; i++) {
    const [user] = await database.db
      .insert(users)
      .values({
        username: `mixed_${i}`,
        name: `负载用户${i}`,
        email: `mixed-${i}@test.invalid`,
        activationStatus: 'active',
        accountSource: 'cli',
        emailVerified: true,
      })
      .returning()
    if (!user) throw new Error('missing user')
    await database.db.insert(accounts).values({
      userId: user.id,
      accountId: user.id,
      providerId: 'credential',
      password: await sdkPasswords.hash(password),
    })
    const response = await fetch('http://api:3100/api/auth/sign-in/email', {
      method: 'POST',
      headers: { origin: config.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ email: user.email, password }),
    })
    if (!response.ok) throw new Error('real login failed')
    members.push({
      id: user.id,
      cookie: response.headers
        .getSetCookie()
        .map((s) => s.split(';')[0])
        .join('; '),
    })
  }
  async function call(
    who: (typeof members)[number],
    path: string,
    json?: unknown,
    method = json ? 'POST' : 'GET',
  ) {
    const response = await fetch(`http://api:3100${path}`, {
      method,
      headers: {
        origin: config.origin,
        cookie: who.cookie,
        'content-type': 'application/json',
        'idempotency-key': crypto.randomUUID(),
      },
      ...(json ? { body: JSON.stringify(json) } : {}),
    })
    if (!response.ok) throw new Error(`API HTTP ${response.status}`)
    return (await response.json()) as Record<string, unknown>
  }
  const owner = members[0]
  if (!owner) throw new Error('missing owner')
  const group = await call(owner, '/api/conversations', {
      kind: 'group',
      name: 'M5 混合负载',
      memberIds: members.slice(1).map((m) => m.id),
    }),
    conversationId = (group as { id: string }).id
  // Seed before staging so the bounded backfill and realtime queue compete in the same generation.
  for (let i = 0; i < 50; i++)
    await call(members[i % 10] ?? owner, `/api/conversations/${conversationId}/messages`, {
      clientId: uuidv7(),
      body: `${'历史记录保留细节。'.repeat(80)}尾部事实 ${i}`,
    })
  await database.db
    .insert(embeddingModels)
    .values({ version: modelVersion, dimension: 512, status: 'staging', createdAt: new Date() })
  await backfillEmbeddings(deps, modelVersion, 100)
  // The historical seed used the real API. Let its conversation rate window end before measuring new traffic.
  await delay(10000)
  if (data.controlId) {
    if (!data.sourceHash) throw new Error('bound mixed test required')
    const store = createBlobStore(config.s3),
      secret = randomBytes(32).toString('base64url')
    const seeded = await seedBenchmark({ ...deps, blobs: store }, data.controlId, 'smoke', {
      passwordHash: await sdkPasswords.hash(secret),
      async putObject(key, size) {
        const bytes = randomBytes(size),
          sha256 = createHash('sha256').update(bytes).digest('hex')
        if ((await store.put(key, new Blob([bytes]).stream())) !== size)
          throw new Error('seed object failed')
        const digest = createHash('sha256'),
          reader = store.read(key).getReader()
        try {
          for (;;) {
            const chunk = await reader.read()
            if (chunk.done) break
            digest.update(chunk.value)
          }
        } finally {
          await reader.cancel()
        }
        if (digest.digest('hex') !== sha256) throw new Error('seed object readback failed')
        return { size, sha256 }
      },
      progress() {},
    })
    const auth = createAuth(deps, { baseOrigin: config.origin, secret: config.auth.secret }),
      authenticated = []
    for (const user of seeded.users) {
      const signed = await auth.api.signInEmail({
        body: { email: user.email, password: secret },
        headers: new Headers({ origin: config.origin }),
        returnHeaders: true,
      })
      const cookie = signed.headers
        .getSetCookie()
        .map((line) => line.split(';')[0])
        .join('; ')
      if (!cookie) throw new Error('controlled session issuance failed')
      authenticated.push({
        userId: user.id,
        cookie,
        conversationId: seeded.messagingRoomId,
        targets: seeded.messagingTargets[user.id],
      })
    }
    await writeFile(
      '/tmp/m7-mixed-fixture.json',
      JSON.stringify(
        loadFixtureSchema.parse({
          format: 1,
          runId: data.controlId,
          sourceHash: data.sourceHash,
          origin: config.origin,
          profile: 'smoke',
          dataset: seeded.dataset,
          users: authenticated,
          hotConversationId: seeded.messagingRoomId,
        }),
      ),
      { flag: 'wx', mode: 0o600 },
    )
    await database.db
      .insert(appSettings)
      .values({ key: `m7.mixed.${data.controlId}`, value: { phase: 'ready' } })
    const deadline = Date.now() + 120_000
    for (;;) {
      const [state] = await database.db
        .select()
        .from(appSettings)
        .where(eq(appSettings.key, `m7.mixed.${data.controlId}`))
      if (
        state?.value &&
        typeof state.value === 'object' &&
        'phase' in state.value &&
        state.value.phase === 'run'
      )
        break
      if (Date.now() > deadline) throw new Error('mixed controller did not start')
      await delay(100)
    }
  }
  const until = Date.now() + data.seconds * 1000
  let maxModels = 0,
    maxQueueAgeSeconds = 0,
    maxDatabaseLockWaiters = 0,
    mixedOverlapSamples = 0
  let observation: Promise<void> | undefined
  observationTimer = setInterval(() => {
    observation ??= database.db
      .execute<{
        models: number
        media: number
        backups: number
        queue_age: number
        waiters: number
      }>(sql`
      select (select count(*)::int from agent_runs where status = 'running') as models,
      (select count(*)::int from work_items where kind = 'media' and status = 'running') as media,
      (select count(*)::int from backup_runs where status = 'copying') as backups,
      (select coalesce(max(extract(epoch from clock_timestamp()-created_at)),0)::float8 from work_items where kind in ('media','embedding') and status not in ('done','dead')) as queue_age,
      (select count(*)::int from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock') as waiters
    `)
      .then((rows) => {
        const row = rows[0]
        if (!row) return
        maxModels = Math.max(maxModels, row.models)
        maxQueueAgeSeconds = Math.max(maxQueueAgeSeconds, row.queue_age)
        maxDatabaseLockWaiters = Math.max(maxDatabaseLockWaiters, row.waiters)
        if (row.models >= 4 && row.media && row.backups) mixedOverlapSamples++
      })
      .catch(() => {})
      .finally(() => {
        observation = undefined
      })
  }, 100)
  dispatcher.start()
  const uploads = (async () => {
    for (let i = 0; i < 6; i++) {
      const bytes = Buffer.from(i % 2 === 0 ? data.png : data.gif, 'base64'),
        reservation = await call(owner, '/api/uploads/reservations', {
          purpose: 'message',
          name: `mixed-${i}.input`,
          declaredSize: bytes.length,
          conversationId,
        }),
        uploadId = reservation.uploadId
      const response = await fetch(`http://api:3100/api/uploads/${uploadId}/content`, {
        method: 'PUT',
        headers: {
          origin: config.origin,
          cookie: owner.cookie,
          'content-type': 'application/octet-stream',
        },
        body: bytes,
      })
      if (!response.ok) throw new Error('media upload failed')
      let result = (await response.json()) as { status: string }
      const deadline = Date.now() + 30000
      while (result.status === 'processing' || result.status === 'uploading') {
        if (Date.now() > deadline) throw new Error('media deadline')
        await delay(100)
        result = (await call(owner, `/api/uploads/${uploadId}`)) as { status: string }
      }
      if (result.status !== 'ready') throw new Error('media failed')
    }
    return 6
  })()
  const agents = data.controlId
    ? Promise.all(
        Array.from({ length: 4 }, async (_, index) => {
          let completed = 0
          do {
            const who = members[index],
              run = await call(who ?? owner, '/api/agent/runs', {
                trigger: 'panel',
                contextConversationId: conversationId,
                prompt: '请总结当前可见安排。',
                mode: 'fast',
                timezone: 'Asia/Shanghai',
                attachmentIds: [],
              })
            const id = (run.run as { id: string }).id,
              deadline = Date.now() + 30_000
            for (;;) {
              const detail = await call(who ?? owner, `/api/agent/runs/${id}`),
                status = (detail.run as { status: string }).status
              if (status === 'completed') break
              if (status === 'failed' || Date.now() > deadline)
                throw new Error('agent workload failed')
              await delay(100)
            }
            completed++
          } while (Date.now() < until)
          return completed
        }),
      ).then((values) => values.reduce((a, b) => a + b, 0))
    : (async () => {
        for (let i = 0; i < 6; i++) {
          const who = members[i % 10] ?? owner,
            run = await call(who, '/api/agent/runs', {
              trigger: 'panel',
              contextConversationId: conversationId,
              prompt: '请总结当前可见安排。',
              mode: 'fast',
              timezone: 'Asia/Shanghai',
              attachmentIds: [],
            }),
            id = (run.run as { id: string }).id,
            deadline = Date.now() + 30000
          for (;;) {
            const detail = await call(who, `/api/agent/runs/${id}`),
              status = (detail.run as { status: string }).status
            if (status === 'completed') break
            if (status === 'failed' || Date.now() > deadline) throw new Error('agent failed')
            await delay(100)
          }
        }
        return 6
      })()
  let vectorRequests = 0,
    vectorBackpressure = 0
  const interactiveVector = data.controlId
    ? (async () => {
        do {
          try {
            await deps.embeddings.embed('当前可见安排由谁负责？', 'query')
          } catch (error) {
            if (!(error instanceof AppError) || error.code !== 'CAPACITY_UNAVAILABLE') throw error
            vectorBackpressure++
            await delay(1000)
            continue
          }
          vectorRequests++
          await delay(300)
        } while (Date.now() < until)
      })()
    : Promise.resolve()
  const background = Promise.all([uploads, agents, interactiveVector])
  // Observe early task failures immediately, then report the original error through the structured result below.
  void background.catch(() => {})
  const durations: number[] = []
  for (let i = 0; data.controlId ? Date.now() < until : i < 80; i++) {
    const begin = performance.now()
    await call(members[i % 10] ?? owner, `/api/conversations/${conversationId}/messages`, {
      clientId: uuidv7(),
      body: `实时灰度发布记录第${i}条，由韩霖负责。`,
    })
    durations.push(performance.now() - begin)
    await delay(100)
  }
  const [mediaTasks, agentRuns] = await background
  clearInterval(observationTimer)
  await observation
  let remaining = 0
  for (let i = 0; i < 300; i++) {
    remaining = (
      await database.db
        .select()
        .from(workItems)
        .where(and(eq(workItems.kind, 'embedding'), sql`${workItems.status}<>'done'`))
    ).length
    if (!remaining) break
    await delay(100)
  }
  const vectors = (await database.db.select().from(messageEmbeddings)).length,
    cgroupPeak = Number((await readFile('/sys/fs/cgroup/memory.peak', 'utf8')).trim()),
    p95Ms = durations.sort((a, b) => a - b)[Math.ceil(durations.length * 0.95) - 1]
  if (remaining || vectors < 50 + durations.length) throw new Error('index workload did not finish')
  if (data.controlId && (maxModels < 4 || vectorRequests < 1))
    throw new Error('mixed workload was not concurrent')
  console.log(
    JSON.stringify({
      architecture: process.arch,
      debian: (await readFile('/etc/os-release', 'utf8')).includes('ID=debian'),
      childPeakBytes: peak,
      workerPeakBytes: cgroupPeak,
      p95Ms,
      interactiveMessages: durations.length,
      mediaTasks,
      agentRuns,
      vectors,
      vectorRequests,
      vectorBackpressure,
      maxModels,
      maxQueueAgeSeconds,
      maxDatabaseLockWaiters,
      mixedOverlapSamples,
      postP95Ms: p95Ms,
      postP99Ms: durations[Math.ceil(durations.length * 0.99) - 1],
      latencyScope:
        'POST completion; authorized delivery is measured separately by the concurrent HTTPS controller',
      credentialIsolation: true,
      cpuSet: '0,1',
    }),
  )
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : 'unknown' }))
} finally {
  clearInterval(timer)
  clearInterval(observationTimer)
  await dispatcher.stop()
  await worker.close()
  await queue.close()
  await emailQueue.close()
  connection.disconnect()
  consumer.disconnect()
  await child.stop()
  await database.close()
}
