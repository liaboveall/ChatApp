/** Local ONNX + real pgvector/authorization evaluation, isolated from both development and shared integration data. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { cpus } from 'node:os'
import { join, resolve } from 'node:path'
import {
  agentMemories,
  conversationMembers,
  conversations,
  embeddingModels,
  memoryEmbeddings,
  messageEmbeddings,
  messageHidden,
  messages,
  users,
} from '@chatapp/db'
import { createDatabase, type Database } from '@chatapp/db/client'
import { runMigrations } from '@chatapp/db/migrate'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { loadConfig } from '../src/config/index.ts'
import type { Deps } from '../src/domain/deps.ts'
import { cosine, hybridMessages, RETRIEVAL, validVector } from '../src/domain/embeddings.ts'
import { findVisibleMessages } from '../src/domain/search.ts'
import { systemClock } from '../src/lib/clock.ts'
import { silentLogger } from '../src/lib/logger.ts'
import { EMBEDDING_MODELS, type EmbeddingModelName } from '../src/runtime/embedding-catalog.ts'
import { loadLocalEmbedder } from '../src/runtime/embedding-model.ts'
import { uuidv7 } from '../src/runtime/ids.ts'
import { getEnv, readEnvFile } from './environment.ts'
import { m5Corpus } from './m5-corpus.ts'
import { aggregateRetrieval, average, retrievalScore } from './metrics.ts'
import { evaluationGitRevision, evaluationSourceManifest } from './source-manifest.ts'

const args = process.argv.slice(2).filter((a) => a !== '--'),
  name = (args.find((a) => a === 'qwen' || a === 'bge') ?? 'bge') as EmbeddingModelName
const phase = args.includes('--dev') ? 'dev' : 'holdout',
  data = m5Corpus(),
  hash = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex')
const freezePath = join(import.meta.dir, 'corpus', 'm5-v1', 'freeze.json'),
  datasetHash = hash(JSON.stringify(data))
const targets = {
  recall10: 0.85,
  ndcg10: 0.75,
  keywordRegression: 0.01,
  synonymGain: 0.05,
  noAnswerFalsePositive: 0.1,
  memoryPrecision: 0.9,
  memoryHitRate: 0.8,
  memoryUnrelatedRate: 0.05,
}
if (args.includes('--freeze')) {
  await mkdir(resolve(freezePath, '..'), { recursive: true })
  try {
    await readFile(freezePath)
    throw new Error('freeze already exists; preserve it')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await writeFile(
    freezePath,
    `${JSON.stringify({ version: 1, frozenAt: new Date().toISOString(), datasetHash, targets, counts: { messages: data.messages.length, conversations: data.conversations.length, queries: data.queries.length, memoryQueries: data.memoryQueries.length }, thresholds: RETRIEVAL, annotation: 'new synthetic source facts; source labels authored before model results' }, null, 2)}\n`,
  )
  console.log(`frozen ${datasetHash}`)
  process.exit(0)
}
const freeze = JSON.parse(await readFile(freezePath, 'utf8')) as {
  datasetHash: string
  targets: typeof targets
}
if (
  freeze.datasetHash !== datasetHash ||
  JSON.stringify(freeze.targets) !== JSON.stringify(targets)
)
  throw new Error('frozen dataset or targets changed')
if (phase === 'holdout') {
  const calibrated = JSON.parse(
    await readFile(join(import.meta.dir, 'corpus', 'm5-v1', `calibration-${name}.json`), 'utf8'),
  ) as { datasetHash: string; thresholds: typeof RETRIEVAL }
  if (
    calibrated.datasetHash !== datasetHash ||
    JSON.stringify(calibrated.thresholds) !== JSON.stringify(RETRIEVAL)
  )
    throw new Error('calibration must be frozen before holdout')
}
const id = randomUUID(),
  dir = resolve('.test-runs/m5', `search-${name}-${phase}-${id}`)
await mkdir(dir, { recursive: true, mode: 0o700 })
const sourceFiles = await evaluationSourceManifest(),
  sourceHash = hash(JSON.stringify(sourceFiles))
await writeFile(join(dir, 'source-manifest.json'), `${JSON.stringify(sourceFiles, null, 2)}\n`)
const file = await readEnvFile('.env.local'),
  source: Record<string, string> = {}
for (const line of file.lines) {
  const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1]
  if (key) {
    const value = getEnv(file, key)
    if (value !== undefined) source[key] = value
  }
}
const baseOwner = source.DATABASE_OWNER_URL_TEST,
  baseApp = source.DATABASE_URL_TEST
if (
  !baseOwner ||
  !baseApp ||
  !new URL(baseOwner).pathname.endsWith('_test') ||
  !new URL(baseApp).pathname.endsWith('_test')
)
  throw new Error('isolated TEST database URLs are required')
const databaseName = `chatapp_m5_${id.replaceAll('-', '')}_test`,
  ownerUrl = new URL(baseOwner),
  appUrl = new URL(baseApp)
ownerUrl.pathname = `/${databaseName}`
appUrl.pathname = `/${databaseName}`
const config = loadConfig({
  ...source,
  APP_ENV: 'test',
  DATABASE_OWNER_URL_TEST: ownerUrl.href,
  DATABASE_URL_TEST: appUrl.href,
})
const control = createDatabase(baseOwner, { max: 1 }),
  model = EMBEDDING_MODELS[name]
let database: Database | undefined,
  created = false,
  local: Awaited<ReturnType<typeof loadLocalEmbedder>> | undefined
const durations: number[] = [],
  cache = new Map<string, number[]>(),
  queries: unknown[] = [],
  memoryQueries: unknown[] = []
let peakRss = process.memoryUsage().rss
const timer = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss)
}, 20)
async function embed(text: string, purpose: 'query' | 'document') {
  const key = `${purpose}:${text}`
  const old = cache.get(key)
  if (old) return old
  if (!local) throw new Error('model unavailable')
  const begin = performance.now(),
    v = await local.embed(text, purpose)
  if (!validVector(v, model.dimension)) throw new Error('invalid vector')
  if (purpose === 'document') durations.push(performance.now() - begin)
  cache.set(key, v)
  peakRss = Math.max(peakRss, process.memoryUsage().rss)
  return v
}
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
  database = createDatabase(appUrl.href, { max: 2 })
  const deps: Deps = {
    db: database.db,
    clock: systemClock,
    newId: uuidv7,
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
    log: silentLogger,
  }
  local = await loadLocalEmbedder(
    name,
    resolve(process.env.EMBEDDING_CACHE_DIR ?? '.test-runs/m5/models'),
  )
  deps.embeddings = { modelVersion: model.version, dimension: model.dimension, embed }
  await deps.db.insert(embeddingModels).values({
    version: model.version,
    dimension: model.dimension,
    status: 'active',
    createdAt: new Date(),
  })
  const peer = randomUUID()
  await deps.db.insert(users).values([
    ...data.conversations.map((c, i) => ({
      id: c.ownerId,
      name: c.person,
      email: `m5-${i}@eval.invalid`,
      username: `m5_user_${i}`,
      accountSource: 'cli' as const,
      activationStatus: 'active' as const,
      emailVerified: true,
    })),
    {
      id: peer,
      name: '同伴',
      email: 'm5-peer@eval.invalid',
      username: 'm5_peer',
      accountSource: 'cli',
      activationStatus: 'active',
      emailVerified: true,
    },
  ])
  for (const c of data.conversations) {
    await deps.db.transaction(async (tx) => {
      await tx.insert(conversations).values({
        id: c.id,
        kind: 'group',
        ownerId: c.ownerId,
        createdBy: c.ownerId,
        name: c.name,
        memberCount: 2,
        lastSeq: 100,
        lastChangeSeq: 100,
      })
      await tx.insert(conversationMembers).values([
        {
          conversationId: c.id,
          userId: c.ownerId,
          role: 'owner',
          notifyLevel: 'all',
          visibleFromSeq: c.visibleFromSeq,
          lastReadSeq: c.visibleFromSeq,
        },
        {
          conversationId: c.id,
          userId: peer,
          role: 'member',
          notifyLevel: 'all',
          visibleFromSeq: 5,
          lastReadSeq: 5,
        },
      ])
      await tx.insert(messages).values(
        data.messages
          .filter((m) => m.conversationId === c.id)
          .map((m) => ({
            id: m.id,
            conversationId: c.id,
            senderId: c.ownerId,
            seq: m.seq,
            changeSeq: m.seq,
            kind: 'user' as const,
            executionSource: 'interactive' as const,
            body: m.visibility === 'recalled' ? null : m.body,
            privacyClass:
              m.visibility === 'byok_private' ? ('byok_private' as const) : ('standard' as const),
            recalledAt: m.visibility === 'recalled' ? new Date() : null,
          })),
      )
      const hidden = data.messages.find(
        (m) => m.conversationId === c.id && m.visibility === 'hidden',
      )
      if (hidden) await tx.insert(messageHidden).values({ userId: c.ownerId, messageId: hidden.id })
    })
    for (const m of data.messages.filter(
      (m) => m.conversationId === c.id && m.visibility !== 'recalled',
    )) {
      const v = await embed(m.body, 'document')
      await deps.db.insert(messageEmbeddings).values({
        messageId: m.id,
        conversationId: c.id,
        seq: m.seq,
        contentVersion: 1,
        modelVersion: model.version,
        dimension: model.dimension,
        embedding: v,
        createdAt: new Date(),
      })
    }
  }
  const scores = [],
    baseline = [],
    synonyms = [],
    baselineSynonyms = []
  for (const q of data.queries.filter((q) => q.split === phase)) {
    const c = data.conversations.find((c) => c.id === q.conversationId)
    if (!c) throw new Error('missing owner')
    const v = await embed(q.query, 'query'),
      filter = { conversationIds: [c.id], siteInput: true, limit: 10 }
    const ranked = await hybridMessages(deps.db, deps, c.ownerId, q.query, v, filter),
      keywords = await findVisibleMessages(deps.db, c.ownerId, { ...filter, query: q.query })
    const score = retrievalScore(
        q,
        ranked.map((r) => r.id),
      ),
      base = retrievalScore(
        q,
        keywords.map((r) => r.id),
      )
    scores.push(score)
    baseline.push(base)
    if (q.category === 'synonym') {
      synonyms.push(score)
      baselineSynonyms.push(base)
    }
    const forbidden = ranked.filter(
      (r) => data.messages.find((m) => m.id === r.id)?.visibility !== 'visible',
    )
    queries.push({
      id: q.id,
      category: q.category,
      query: q.query,
      ids: ranked.map((r) => r.id),
      baselineIds: keywords.map((r) => r.id),
      score,
      baseline: base,
      forbidden: forbidden.length,
    })
  }
  for (const m of data.memories) {
    await deps.db.insert(agentMemories).values({
      id: m.id,
      userId: m.ownerId,
      content: m.content,
      source: 'user',
      privacyClass: 'standard',
      createdAt: new Date(),
    })
    await deps.db.insert(memoryEmbeddings).values({
      memoryId: m.id,
      modelVersion: model.version,
      dimension: model.dimension,
      contentVersion: 1,
      embedding: await embed(m.content, 'document'),
      createdAt: new Date(),
    })
  }
  const memoryScores = []
  for (const q of data.memoryQueries.filter((q) => q.split === phase)) {
    const v = await embed(q.query, 'query')
    const rows = await deps.db
      .select({ memory: agentMemories, embedding: memoryEmbeddings.embedding })
      .from(agentMemories)
      .innerJoin(memoryEmbeddings, eq(memoryEmbeddings.memoryId, agentMemories.id))
      .where(
        and(
          eq(agentMemories.userId, q.ownerId),
          eq(agentMemories.privacyClass, 'standard'),
          isNull(agentMemories.deletedAt),
        ),
      )
    const all = rows
        .map((r) => ({ id: r.memory.id, score: cosine(v, r.embedding) }))
        .sort((a, b) => b.score - a.score),
      ranked = all.filter((r) => r.score >= RETRIEVAL.memoryThreshold).slice(0, 5)
    const correct = ranked.filter((r) => q.relevant.includes(r.id)).length
    memoryScores.push({
      answerable: q.relevant.length > 0,
      returned: ranked.length,
      correct,
      hit: correct > 0,
      unrelated: q.relevant.length === 0 && ranked.length > 0,
    })
    memoryQueries.push({ id: q.id, query: q.query, all, ranked, relevant: q.relevant })
  }
  const result = aggregateRetrieval(scores),
    base = aggregateRetrieval(baseline),
    synonym = aggregateRetrieval(synonyms),
    baseSynonym = aggregateRetrieval(baselineSynonyms)
  const memory = {
    precision:
      memoryScores.reduce((n, s) => n + s.correct, 0) /
      Math.max(
        1,
        memoryScores.reduce((n, s) => n + s.returned, 0),
      ),
    hitRate: average(memoryScores.filter((s) => s.answerable).map((s) => Number(s.hit))),
    unrelatedRate: average(
      memoryScores.filter((s) => !s.answerable).map((s) => Number(s.unrelated)),
    ),
  }
  const sourceUnchanged = sourceHash === hash(JSON.stringify(await evaluationSourceManifest()))
  const qualityPass =
    sourceUnchanged &&
    result.recall10 >= targets.recall10 &&
    result.ndcg10 >= targets.ndcg10 &&
    base.ndcg10 - result.ndcg10 <= targets.keywordRegression &&
    synonym.ndcg10 - baseSynonym.ndcg10 >= targets.synonymGain &&
    result.noAnswerFalsePositive <= targets.noAnswerFalsePositive &&
    memory.precision >= targets.memoryPrecision &&
    memory.hitRate >= targets.memoryHitRate &&
    memory.unrelatedRate <= targets.memoryUnrelatedRate &&
    (queries as { forbidden: number }[]).every((q) => q.forbidden === 0)
  const sorted = [...durations].sort((a, b) => a - b),
    p95 = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0
  const report = {
    runId: id,
    date: new Date().toISOString(),
    phase,
    datasetHash,
    sourceHash,
    sourceUnchanged,
    baseSha: evaluationGitRevision(),
    modelVersion: model.version,
    model,
    thresholds: RETRIEVAL,
    result,
    baseline: base,
    synonym,
    baselineSynonym: baseSynonym,
    byCategory: Object.fromEntries(
      [...new Set((queries as { category: string }[]).map((q) => q.category))].map((category) => [
        category,
        aggregateRetrieval(
          (queries as { category: string; score: ReturnType<typeof retrievalScore> }[])
            .filter((q) => q.category === category)
            .map((q) => q.score),
        ),
      ]),
    ),
    memory,
    qualityPass,
    armResourcesPass: false,
    hardware: {
      architecture: process.arch,
      cpu: cpus()[0]?.model,
      threads: 2,
      runtime: `Bun ${process.versions.bun}`,
    },
    resource: {
      p95Ms: p95,
      peakRssBytes: peakRss,
      withinLocalLimits: p95 <= 200 && peakRss <= 1024 ** 3,
    },
    queries,
    memoryQueries,
  }
  await writeFile(join(dir, 'result.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(
    JSON.stringify({
      directory: dir,
      phase,
      modelVersion: model.version,
      result,
      baseline: base,
      synonym,
      memory,
      qualityPass,
      p95Ms: p95,
      peakRssBytes: peakRss,
      armResourcesPass: false,
    }),
  )
  process.exitCode = qualityPass ? 0 : 1
} finally {
  clearInterval(timer)
  await local?.close()
  await database?.close()
  if (created)
    await control.db.execute(sql.raw(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`))
  await control.close()
}
