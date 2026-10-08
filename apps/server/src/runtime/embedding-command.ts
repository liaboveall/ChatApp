/** Explicit offline-model preparation and bounded index migration. No model downloads occur in the running service. */
import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  agentMemories,
  embeddingModels,
  memoryEmbeddings,
  messageEmbeddings,
  messages,
} from '@chatapp/db'
import { createDatabase } from '@chatapp/db/client'
import { and, eq, isNull, notExists, sql } from 'drizzle-orm'
import { loadConfig } from '../config/index.ts'
import type { Deps } from '../domain/deps.ts'
import { backfillEmbeddings } from '../domain/embeddings.ts'
import { enqueueWork } from '../domain/work.ts'
import { systemClock } from '../lib/clock.ts'
import { silentLogger } from '../lib/logger.ts'
import { EMBEDDING_MODELS, type EmbeddingModelName } from './embedding-catalog.ts'
import { assertEmbeddingEvidence } from './embedding-evidence.ts'
import { uuidv7 } from './ids.ts'

const [command, name = 'bge', ...extra] = process.argv.slice(2).filter((a) => a !== '--')
if (
  !command ||
  !['prepare', 'status', 'stage', 'backfill', 'activate'].includes(command) ||
  !Object.hasOwn(EMBEDDING_MODELS, name)
)
  throw new Error(
    'usage: embeddings prepare|status|stage|backfill|activate bge|qwen [cache or evidence path]',
  )
const model = EMBEDDING_MODELS[name as EmbeddingModelName],
  cache = resolve(process.env.EMBEDDING_CACHE_DIR ?? '.test-runs/m5/models')
if (command === 'prepare') {
  const location = extra[0] ? resolve(extra[0]) : cache
  const { loadLocalEmbedder } = await import('./embedding-model.ts')
  const embedder = await loadLocalEmbedder(name as EmbeddingModelName, location, true)
  await embedder.embed('本地模型准备完成', 'document')
  await embedder.close()
  const directory = join(location, model.id, model.revision),
    files = []
  for (const path of await readdir(directory, { recursive: true })) {
    if (!/\.(onnx|json)$/.test(path) || path === 'chatapp-model-manifest.json') continue
    const bytes = await readFile(join(directory, path))
    files.push({
      path,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }
  const totalBytes = files.reduce((n, f) => n + f.bytes, 0)
  if (totalBytes > 1_500_000_000) throw new Error('model exceeds 1.5 GB limit')
  await writeFile(
    join(directory, 'chatapp-model-manifest.json'),
    `${JSON.stringify({ ...model, dtype: 'q8', totalBytes, files }, null, 2)}\n`,
  )
  console.log(
    JSON.stringify({
      modelVersion: model.version,
      dimension: model.dimension,
      totalBytes,
      cache: location,
    }),
  )
  process.exit(0)
}
const config = loadConfig(process.env),
  database = createDatabase(config.databaseUrl, { max: 2 })
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
try {
  if (command === 'status')
    console.log(JSON.stringify(await deps.db.select().from(embeddingModels)))
  if (command === 'stage') {
    await deps.db
      .insert(embeddingModels)
      .values({
        version: model.version,
        dimension: model.dimension,
        status: 'staging',
        createdAt: deps.clock.now(),
      })
      .onConflictDoNothing()
    console.log(`staged ${model.version}; active generation preserved`)
  }
  if (command === 'backfill') {
    const queued = await backfillEmbeddings(deps, model.version)
    const memories = await deps.db
      .select({ id: agentMemories.id, version: agentMemories.contentVersion })
      .from(agentMemories)
      .where(
        and(
          isNull(agentMemories.deletedAt),
          notExists(
            deps.db
              .select({ one: sql`1` })
              .from(memoryEmbeddings)
              .where(
                and(
                  eq(memoryEmbeddings.memoryId, agentMemories.id),
                  eq(memoryEmbeddings.modelVersion, model.version),
                  eq(memoryEmbeddings.contentVersion, agentMemories.contentVersion),
                ),
              ),
          ),
        ),
      )
      .orderBy(agentMemories.id)
      .limit(100)
    let memoryQueued = 0
    for (const row of memories)
      if (
        (
          await enqueueWork(deps.db, deps, {
            kind: 'embedding',
            dedupeKey: `memory:${row.id}:${row.version}:${model.version}`,
            entityId: row.id,
            entityVersion: row.version,
            payload: {
              target: 'memory',
              modelVersion: model.version,
              dimension: model.dimension,
              backfill: true,
            },
            availableAt: new Date(deps.clock.now().getTime() + 5000),
          })
        ).created
      )
        memoryQueued++
    console.log(
      JSON.stringify({ modelVersion: model.version, queued, memoryQueued, batchLimit: 100 }),
    )
  }
  if (command === 'activate') {
    if (!extra[0])
      throw new Error(
        'activate requires the reviewed quality and native ARM resource evidence file',
      )
    const evidence = JSON.parse(await readFile(resolve(extra[0]), 'utf8')) as {
      qualityPath: string
      resourcesPath: string
    }
    assertEmbeddingEvidence(
      model.version,
      JSON.parse(await readFile(resolve(evidence.qualityPath), 'utf8')),
      JSON.parse(await readFile(resolve(evidence.resourcesPath), 'utf8')),
    )
    await deps.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(522052)`)
      const [staged] = await tx
        .select()
        .from(embeddingModels)
        .where(eq(embeddingModels.version, model.version))
        .for('update')
      if (!staged) throw new Error('model not staged')
      if (staged.dimension !== model.dimension) throw new Error('model dimension mismatch')
      const missingMessage = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.status, 'sent'),
            isNull(messages.deletedAt),
            isNull(messages.recalledAt),
            sql`${messages.kind}<>'system'`,
            sql`char_length(${messages.body})>=4`,
            notExists(
              tx
                .select({ one: sql`1` })
                .from(messageEmbeddings)
                .where(
                  and(
                    eq(messageEmbeddings.messageId, messages.id),
                    eq(messageEmbeddings.contentVersion, messages.contentVersion),
                    eq(messageEmbeddings.modelVersion, model.version),
                  ),
                ),
            ),
          ),
        )
        .limit(1)
      const missingMemory = await tx
        .select({ id: agentMemories.id })
        .from(agentMemories)
        .where(
          and(
            isNull(agentMemories.deletedAt),
            notExists(
              tx
                .select({ one: sql`1` })
                .from(memoryEmbeddings)
                .where(
                  and(
                    eq(memoryEmbeddings.memoryId, agentMemories.id),
                    eq(memoryEmbeddings.contentVersion, agentMemories.contentVersion),
                    eq(memoryEmbeddings.modelVersion, model.version),
                  ),
                ),
            ),
          ),
        )
        .limit(1)
      if (missingMessage.length || missingMemory.length)
        throw new Error('generation backfill incomplete; retain the active model')
      await tx
        .update(embeddingModels)
        .set({ status: 'staging' })
        .where(eq(embeddingModels.status, 'active'))
      await tx
        .update(embeddingModels)
        .set({ status: 'active' })
        .where(eq(embeddingModels.version, model.version))
    })
    console.log(`activated ${model.version}; previous generation retained for rollback`)
  }
} finally {
  await database.close()
}
