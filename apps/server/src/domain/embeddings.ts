/** Versioned local indexing and retrieval. Inference occurs outside business locks; publication checks them again. */
import { AppError } from '@chatapp/contracts'
import {
  agentMemories,
  conversationMembers,
  conversations,
  type DbOrTx,
  embeddingModels,
  memoryEmbeddings,
  messageEmbeddings,
  messages,
} from '@chatapp/db'
import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import type { Deps } from './deps.ts'
import type { MessageRow } from './messages.ts'
import { type SearchFilter, visibleMessagePredicate } from './search.ts'
import { enqueueWork } from './work.ts'

export const RETRIEVAL = {
  rrfK: 60,
  candidates: 50,
  messageThreshold: 0.55,
  // Dev-only calibration: positive minimum .616; unrelated maximum .358. Frozen before holdout.
  memoryThreshold: 0.5,
} as const
export function validVector(vector: readonly number[], dimension: number): boolean {
  return vector.length === dimension && vector.every(Number.isFinite) && vector.some((v) => v !== 0)
}
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || !a.length) return -1
  let dot = 0,
    aa = 0,
    bb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0,
      y = b[i] ?? 0
    dot += x * y
    aa += x * x
    bb += y * y
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : -1
}
export function fuseRanks<T extends { id: string }>(
  keyword: readonly T[],
  semantic: readonly T[],
  limit: number,
): T[] {
  const scores = new Map<string, { row: T; score: number }>()
  for (const list of [keyword, semantic])
    for (const [i, row] of list.entries()) {
      const old = scores.get(row.id)
      scores.set(row.id, { row, score: (old?.score ?? 0) + 1 / (RETRIEVAL.rrfK + i + 1) })
    }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id))
    .slice(0, limit)
    .map((s) => s.row)
}
export async function embedQuery(deps: Deps, text: string): Promise<number[]> {
  if (!deps.embeddings)
    throw new AppError('CAPACITY_UNAVAILABLE', 'Local semantic search is not ready')
  const v = await deps.embeddings.embed(text, 'query')
  if (!validVector(v, deps.embeddings.dimension))
    throw new AppError('CAPACITY_UNAVAILABLE', 'Invalid local embedding')
  return v
}

/** Every send/edit records an identifier-only intent, including models being backfilled. Withdrawal removes all versions. */
export async function enqueueMessageEmbedding(
  db: DbOrTx,
  deps: Pick<Deps, 'clock'>,
  id: string,
): Promise<void> {
  const [row] = await db.select().from(messages).where(eq(messages.id, id))
  await db.delete(messageEmbeddings).where(eq(messageEmbeddings.messageId, id))
  if (
    !row?.body ||
    row.kind === 'system' ||
    row.status !== 'sent' ||
    row.recalledAt ||
    row.deletedAt ||
    [...row.body.trim()].length < 4
  )
    return
  const models = await db
    .select()
    .from(embeddingModels)
    .where(inArray(embeddingModels.status, ['active', 'staging']))
  for (const model of models)
    await enqueueWork(db, deps, {
      kind: 'embedding',
      dedupeKey: `embedding:${id}:${row.contentVersion}:${model.version}`,
      entityId: id,
      entityVersion: row.contentVersion,
      payload: { modelVersion: model.version, dimension: model.dimension, target: 'message' },
    })
}
export async function enqueueMemoryEmbedding(
  db: DbOrTx,
  deps: Pick<Deps, 'clock'>,
  id: string,
): Promise<void> {
  const [row] = await db.select().from(agentMemories).where(eq(agentMemories.id, id))
  if (!row?.content || row.deletedAt) return
  const models = await db
    .select()
    .from(embeddingModels)
    .where(inArray(embeddingModels.status, ['active', 'staging']))
  for (const model of models)
    await enqueueWork(db, deps, {
      kind: 'embedding',
      dedupeKey: `memory:${id}:${row.contentVersion}:${model.version}`,
      entityId: id,
      entityVersion: row.contentVersion,
      payload: { modelVersion: model.version, dimension: model.dimension, target: 'memory' },
    })
}

/** An edited, withdrawn or deleted row can never be resurrected by a late inference result (AT-14, INV-22). */
export async function indexEmbedding(
  deps: Deps,
  input: { id: string; version: number; modelVersion: string; target: 'message' | 'memory' },
): Promise<boolean> {
  const port = deps.embeddings
  if (!port || port.modelVersion !== input.modelVersion)
    throw new AppError('CAPACITY_UNAVAILABLE', 'Requested local model unavailable')
  const table = input.target === 'message' ? messages : agentMemories
  const [row] = await deps.db.select().from(table).where(eq(table.id, input.id))
  const text = row && ('body' in row ? row.body : row.content)
  if (
    !row ||
    row.contentVersion !== input.version ||
    row.deletedAt ||
    ('recalledAt' in row && row.recalledAt) ||
    !text
  )
    return false
  const vector = await port.embed(text, 'document')
  if (!validVector(vector, port.dimension))
    throw new AppError('CAPACITY_UNAVAILABLE', 'Invalid local embedding')
  return await deps.db.transaction(async (tx) => {
    // Index writers never acquire a user/run lock after a content lock.
    const [current] = await tx.select().from(table).where(eq(table.id, input.id)).for('update')
    const [model] = await tx
      .select()
      .from(embeddingModels)
      .where(eq(embeddingModels.version, input.modelVersion))
    if (
      !current ||
      current.contentVersion !== input.version ||
      current.deletedAt ||
      !model ||
      model.dimension !== port.dimension ||
      model.status === 'retired'
    )
      return false
    if ('body' in current) {
      if (
        !current.body ||
        current.recalledAt ||
        current.kind === 'system' ||
        current.status !== 'sent' ||
        [...current.body.trim()].length < 4
      )
        return false
      const values = {
        messageId: current.id,
        conversationId: current.conversationId,
        seq: current.seq,
        contentVersion: current.contentVersion,
        modelVersion: port.modelVersion,
        dimension: port.dimension,
        embedding: vector,
        createdAt: deps.clock.now(),
      }
      await tx
        .insert(messageEmbeddings)
        .values(values)
        .onConflictDoUpdate({
          target: [messageEmbeddings.messageId, messageEmbeddings.modelVersion],
          set: values,
        })
    } else {
      if (!current.content) return false
      const values = {
        memoryId: current.id,
        contentVersion: current.contentVersion,
        embedding: vector,
        modelVersion: port.modelVersion,
        dimension: port.dimension,
        createdAt: deps.clock.now(),
      }
      await tx
        .insert(memoryEmbeddings)
        .values(values)
        .onConflictDoUpdate({
          target: [memoryEmbeddings.memoryId, memoryEmbeddings.modelVersion],
          set: values,
        })
    }
    return true
  })
}

/** Both ranks use the ordinary search authorization predicate before scoring, then join the current content version. */
export async function hybridMessages(
  db: DbOrTx,
  deps: Deps,
  userId: string,
  query: string,
  vector: number[],
  filter: SearchFilter,
): Promise<MessageRow[]> {
  const port = deps.embeddings
  if (!port) throw new AppError('CAPACITY_UNAVAILABLE', 'Local model unavailable')
  if (filter.conversationIds?.length === 0) return []
  const [model] = await db
    .select()
    .from(embeddingModels)
    .where(
      and(eq(embeddingModels.version, port.modelVersion), eq(embeddingModels.status, 'active')),
    )
  if (!model) throw new AppError('CAPACITY_UNAVAILABLE', 'Local index has not been activated')
  const distance = sql<number>`${messageEmbeddings.embedding}::vector(${sql.raw(String(port.dimension))}) <=> ${JSON.stringify(vector)}::vector(${sql.raw(String(port.dimension))})`
  const base = visibleMessagePredicate(db, userId, { ...filter, query: undefined })
  const semantic = await db
    .select({ message: messages, distance })
    .from(messages)
    .innerJoin(conversationMembers, eq(conversationMembers.conversationId, messages.conversationId))
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .innerJoin(
      messageEmbeddings,
      and(
        eq(messageEmbeddings.messageId, messages.id),
        eq(messageEmbeddings.contentVersion, messages.contentVersion),
        eq(messageEmbeddings.modelVersion, port.modelVersion),
        eq(messageEmbeddings.conversationId, messages.conversationId),
        eq(messageEmbeddings.seq, messages.seq),
      ),
    )
    .where(and(base, sql`${distance} <= ${1 - RETRIEVAL.messageThreshold}`))
    .orderBy(distance)
    .limit(RETRIEVAL.candidates)
  const escaped = query.replace(/[\\%_]/g, '\\$&')
  const keyword = await db
    .select({ message: messages })
    .from(messages)
    .innerJoin(conversationMembers, eq(conversationMembers.conversationId, messages.conversationId))
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(base, sql`${messages.body} ilike ${`%${escaped}%`}`))
    .orderBy(sql`similarity(${messages.body}, ${query}) desc`, messages.id)
    .limit(RETRIEVAL.candidates)
  return fuseRanks(
    keyword.map((r) => r.message),
    semantic.map((r) => r.message),
    filter.limit,
  )
}

/** Bounded backfill with durable progress. Real-time work is earlier in the queue; batch work is delayed and capped. */
export async function backfillEmbeddings(
  deps: Deps,
  version: string,
  limit = 100,
): Promise<number> {
  return await deps.db.transaction(async (tx) => {
    const [model] = await tx
      .select()
      .from(embeddingModels)
      .where(eq(embeddingModels.version, version))
      .for('update')
    if (!model || model.status === 'retired') throw new AppError('NOT_FOUND', 'Model not staged')
    const rows = await tx
      .select({ id: messages.id, version: messages.contentVersion })
      .from(messages)
      .where(
        and(
          model.backfillCursor ? gt(messages.id, model.backfillCursor) : undefined,
          isNotNull(messages.body),
          isNull(messages.recalledAt),
          isNull(messages.deletedAt),
          eq(messages.status, 'sent'),
          sql`${messages.kind} <> 'system'`,
          sql`char_length(${messages.body}) >= 4`,
        ),
      )
      .orderBy(asc(messages.id))
      .limit(Math.min(100, limit))
    for (const row of rows)
      await enqueueWork(tx, deps, {
        kind: 'embedding',
        dedupeKey: `embedding:${row.id}:${row.version}:${version}`,
        entityId: row.id,
        entityVersion: row.version,
        payload: {
          modelVersion: version,
          dimension: model.dimension,
          target: 'message',
          backfill: true,
        },
        availableAt: new Date(deps.clock.now().getTime() + 5000),
      })
    if (rows.at(-1))
      await tx
        .update(embeddingModels)
        .set({ backfillCursor: rows.at(-1)?.id })
        .where(eq(embeddingModels.version, version))
    return rows.length
  })
}
