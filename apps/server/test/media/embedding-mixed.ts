/** Executed in the worker cgroup. All imports are from the freshly built image; nothing uses host credentials. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { accounts, embeddingModels, messageEmbeddings, users, workItems } from '@chatapp/db'
import { createDatabase } from '@chatapp/db/client'
import { Queue } from 'bullmq'
import { and, eq, sql } from 'drizzle-orm'
import { sdkPasswords } from '../../src/auth/passwords.ts'
import { loadConfig } from '../../src/config/index.ts'
import { backfillEmbeddings } from '../../src/domain/embeddings.ts'
import { createDispatcher } from '../../src/jobs/dispatcher.ts'
import { createEmbeddingWorker } from '../../src/jobs/embedding.ts'
import { embeddingQueueName, queuePrefix } from '../../src/jobs/queues.ts'
import { systemClock } from '../../src/lib/clock.ts'
import { silentLogger } from '../../src/lib/logger.ts'
import { createBullConnection } from '../../src/lib/valkey.ts'
import { createEmbeddingClient, startEmbeddingChild } from '../../src/runtime/embeddings.ts'
import { uuidv7 } from '../../src/runtime/ids.ts'

const data = JSON.parse(await new Response(Bun.stdin.stream()).text()) as {
  files: { path: string; data: string }[]
  png: string
  gif: string
}
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
  timer: ReturnType<typeof setInterval> | undefined
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
  const agents = (async () => {
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
  const durations: number[] = []
  for (let i = 0; i < 80; i++) {
    const begin = performance.now()
    await call(members[i % 10] ?? owner, `/api/conversations/${conversationId}/messages`, {
      clientId: uuidv7(),
      body: `实时灰度发布记录第${i}条，由韩霖负责。`,
    })
    durations.push(performance.now() - begin)
    await delay(100)
  }
  const [mediaTasks, agentRuns] = await Promise.all([uploads, agents])
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
  if (remaining || vectors < 130) throw new Error('index workload did not finish')
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
      credentialIsolation: true,
      cpuSet: '0,1',
    }),
  )
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : 'unknown' }))
} finally {
  clearInterval(timer)
  await dispatcher.stop()
  await worker.close()
  await queue.close()
  await emailQueue.close()
  connection.disconnect()
  consumer.disconnect()
  await child.stop()
  await database.close()
}
