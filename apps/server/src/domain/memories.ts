/** Personal memories, explicit consent and source validation (D-051, D-080, AT-29/35). */
import {
  type AgentMemory,
  type AgentSource,
  AppError,
  memoryContentSchema,
} from '@chatapp/contracts'
import {
  agentConversationState,
  agentMemories,
  agentRuns,
  type DbOrTx,
  embeddingModels,
  memoryEmbeddings,
  messages,
  type Tx,
} from '@chatapp/db'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  type AgentRunRow,
  closePendingApprovals,
  lockSourceConversations,
  readablePrivacy,
  validateAgentSources,
} from './agent-access.ts'
import { writeAudit } from './audit.ts'
import type { Deps } from './deps.ts'
import { enqueueMemoryEmbedding, RETRIEVAL } from './embeddings.ts'
import type { SessionPrincipal } from './principal.ts'
import { lockAndRevalidate } from './sessions.ts'

export const hasMemoryIntent = (prompt: string): boolean => {
  if (
    /(?:不要|不必|不用|别|不想).{0,8}(?:记住|记下|记一下|保存)|\b(?:do not|don[’']t|never)\s+(?:remember|save)\b/i.test(
      prompt,
    )
  )
    return false
  const request = prompt.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|`[^`]*`/g, '')
  return /(?:^|[。！？!?.\n；;，,]\s*)(?:(?:请|帮我|请帮我)\s*)?(?:记住|记一下|记下|别忘了)|(?:^|[.!?\n]\s*)(?:(?:please\s+)?remember\b|don[’']t forget\s+(?:that|to)\b)/i.test(
    request.trim(),
  )
}
/** Expired summaries lose their plaintext and provenance even if the conversation is never opened again. */
export async function purgeExpiredSummaries(deps: Deps): Promise<number> {
  const rows = await deps.db.execute<{ conversation_id: string }>(sql`
    delete from agent_conversation_state where conversation_id in (
      select conversation_id from agent_conversation_state
      where expires_at <= ${deps.clock.now()} order by expires_at limit 100
    ) returning conversation_id
  `)
  return rows.length
}
type Row = typeof agentMemories.$inferSelect
export const memoryDto = (row: Row): AgentMemory => ({
  id: row.id,
  content: row.content,
  source: row.source,
  privacyClass: row.privacyClass,
  contentVersion: row.contentVersion,
  createdByRunId: row.createdByRunId,
  createdAt: row.createdAt.toISOString(),
  deletedAt: row.deletedAt?.toISOString() ?? null,
})

export async function listMemories(
  deps: Deps,
  principal: SessionPrincipal,
): Promise<AgentMemory[]> {
  return await deps.db.transaction(async (tx) => {
    await lockAndRevalidate(tx, deps, principal)
    return (
      await tx
        .select()
        .from(agentMemories)
        .where(and(eq(agentMemories.userId, principal.userId), isNull(agentMemories.deletedAt)))
        .orderBy(desc(agentMemories.createdAt))
    ).map(memoryDto)
  })
}
/** Called under the owner's lock; the effect ledger transaction owns agent-created memories. */
export async function insertMemory(
  tx: Tx,
  deps: Deps,
  input: { userId: string; content: string; allowSite?: boolean; run?: AgentRunRow },
): Promise<Row> {
  const content = memoryContentSchema.parse(input.content)
  const [{ total } = { total: 0 }] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(agentMemories)
    .where(and(eq(agentMemories.userId, input.userId), isNull(agentMemories.deletedAt)))
  if (total >= 200) throw new AppError('QUOTA_EXCEEDED', 'At most 200 personal memories')
  if (input.run && input.run.readScope !== 'all_accessible')
    throw new AppError('FORBIDDEN', 'Memory requires all accessible scope')
  const privacyClass = input.run?.privacyClass ?? (input.allowSite ? 'standard' : 'byok_private')
  const [row] = await tx
    .insert(agentMemories)
    .values({
      id: deps.newId(),
      userId: input.userId,
      content,
      source: input.run ? 'agent' : 'user',
      createdByRunId: input.run?.id ?? null,
      privacyClass,
      sourceManifest: input.run?.contextManifest.filter((s) => s.type !== 'summary') ?? [],
      siteConsentAt: input.allowSite ? deps.clock.now() : null,
      createdAt: deps.clock.now(),
    })
    .returning()
  if (!row) throw new Error('memory not inserted')
  await enqueueMemoryEmbedding(tx, deps, row.id)
  return row
}
export async function addMemory(
  deps: Deps,
  principal: SessionPrincipal,
  input: { content: string; allowSite: boolean },
): Promise<AgentMemory> {
  return await deps.db.transaction(async (tx) => {
    await lockAndRevalidate(tx, deps, principal)
    const row = await insertMemory(tx, deps, { userId: principal.userId, ...input })
    await writeAudit(tx, {
      actorId: principal.userId,
      action: 'memory.created',
      targetType: 'agent_memory',
      targetId: row.id,
      metadata: { privacyClass: row.privacyClass },
    })
    return memoryDto(row)
  })
}
/** A consent change/delete fences runs and clears summaries in the same transaction; no old context is reused. */
async function invalidateMemoryRuns(
  tx: Tx,
  deps: Deps,
  userId: string,
  id: string,
  exceptRunId?: string,
): Promise<void> {
  const affected = await tx
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.userId, userId),
        inArray(agentRuns.status, ['queued', 'running', 'awaiting_approval']),
        sql`${agentRuns.contextManifest} @> ${JSON.stringify([{ type: 'memory', id }])}::text::jsonb`,
        exceptRunId ? sql`${agentRuns.id} <> ${exceptRunId}::uuid` : undefined,
      ),
    )
  // Lock all conversations in sorted order before fencing runs.
  const ids = [
    ...new Set(
      affected
        .flatMap((r) => [
          r.conversationId,
          r.contextConversationId,
          ...r.contextManifest.filter((s) => s.type === 'conversation').map((s) => s.id),
        ])
        .filter((v): v is string => v !== null),
    ),
  ]
  // A forget effect prelocks this set under the owner lock before acquiring its own run lock.
  if (affected[0] && !exceptRunId) await lockSourceConversations(tx, affected[0], ids)
  const ended = await tx
    .update(agentRuns)
    .set({
      status: 'cancelled',
      cancelRequestedAt: deps.clock.now(),
      finishedAt: deps.clock.now(),
      leaseUntil: null,
      leaseEpoch: sql`${agentRuns.leaseEpoch}+1`,
      stateVersion: sql`${agentRuns.stateVersion}+1`,
      pendingApproval: false,
      errorCode: 'CONTEXT_CHANGED',
      errorMessage: 'Memory changed; start a new request',
    })
    .where(
      inArray(
        agentRuns.id,
        affected.map((r) => r.id),
      ),
    )
    .returning({ id: agentRuns.id })
  await closePendingApprovals(
    tx,
    deps,
    ended.map((r) => r.id),
    'context_changed',
  )
  await tx
    .update(agentConversationState)
    .set({ summary: null, sourceManifest: [] })
    .where(
      sql`${agentConversationState.sourceManifest} @> ${JSON.stringify([{ type: 'memory', id }])}::text::jsonb`,
    )
}
export async function memorySourceConversations(
  tx: Tx,
  userId: string,
  id: string,
): Promise<string[]> {
  const rows = await tx
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.userId, userId),
        inArray(agentRuns.status, ['queued', 'running', 'awaiting_approval']),
        sql`${agentRuns.contextManifest} @> ${JSON.stringify([{ type: 'memory', id }])}::text::jsonb`,
      ),
    )
  return [
    ...new Set(
      rows
        .flatMap((r) => [
          r.conversationId,
          r.contextConversationId,
          ...r.contextManifest.filter((s) => s.type === 'conversation').map((s) => s.id),
        ])
        .filter((v): v is string => v !== null),
    ),
  ]
}
export async function deleteMemoryRow(
  tx: Tx,
  deps: Deps,
  userId: string,
  id: string,
  exceptRunId?: string,
): Promise<Row> {
  const [row] = await tx
    .select()
    .from(agentMemories)
    .where(and(eq(agentMemories.id, id), eq(agentMemories.userId, userId)))
  if (!row) throw new AppError('NOT_FOUND', 'Memory not found')
  if (row.deletedAt) return row
  await invalidateMemoryRuns(tx, deps, userId, id, exceptRunId)
  await tx.delete(memoryEmbeddings).where(eq(memoryEmbeddings.memoryId, id))
  const [updated] = await tx
    .update(agentMemories)
    .set({
      content: null,
      embedding: null,
      deletedAt: deps.clock.now(),
      contentVersion: sql`${agentMemories.contentVersion}+1`,
    })
    .where(eq(agentMemories.id, id))
    .returning()
  if (!updated) throw new Error('memory vanished')
  return updated
}
export async function deleteMemory(
  deps: Deps,
  principal: SessionPrincipal,
  id: string,
): Promise<AgentMemory> {
  return await deps.db.transaction(async (tx) => {
    await lockAndRevalidate(tx, deps, principal)
    const row = await deleteMemoryRow(tx, deps, principal.userId, id)
    await writeAudit(tx, {
      actorId: principal.userId,
      action: 'memory.deleted',
      targetType: 'agent_memory',
      targetId: id,
    })
    return memoryDto(row)
  })
}
export async function setMemoryPrivacy(
  deps: Deps,
  principal: SessionPrincipal,
  id: string,
  input: { allowSite: boolean; expectedContentVersion: number },
): Promise<AgentMemory> {
  return await deps.db.transaction(async (tx) => {
    await lockAndRevalidate(tx, deps, principal)
    const [row] = await tx
      .select()
      .from(agentMemories)
      .where(
        and(
          eq(agentMemories.id, id),
          eq(agentMemories.userId, principal.userId),
          isNull(agentMemories.deletedAt),
        ),
      )
    if (!row) throw new AppError('NOT_FOUND', 'Memory not found')
    if (row.contentVersion !== input.expectedContentVersion)
      throw new AppError('VERSION_CONFLICT', 'Memory changed')
    // Derived private memories retain their private provenance. Consent only applies to manually added content.
    if (
      input.allowSite &&
      row.source === 'agent' &&
      (row.privacyClass === 'byok_private' ||
        row.sourceManifest.some((s) => 'privacyClass' in s && s.privacyClass === 'byok_private'))
    )
      throw new AppError(
        'FORBIDDEN',
        'Add this content manually to share it with the site assistant',
      )
    const privacyClass = input.allowSite ? 'standard' : 'byok_private'
    if (row.privacyClass === privacyClass) return memoryDto(row)
    await invalidateMemoryRuns(tx, deps, principal.userId, id)
    await tx.delete(memoryEmbeddings).where(eq(memoryEmbeddings.memoryId, id))
    const [updated] = await tx
      .update(agentMemories)
      .set({
        privacyClass,
        siteConsentAt: input.allowSite ? deps.clock.now() : null,
        contentVersion: sql`${agentMemories.contentVersion}+1`,
        embedding: null,
      })
      .where(eq(agentMemories.id, id))
      .returning()
    if (!updated) throw new Error('memory vanished')
    await enqueueMemoryEmbedding(tx, deps, id)
    await writeAudit(tx, {
      actorId: principal.userId,
      action: 'memory.privacy_changed',
      targetType: 'agent_memory',
      targetId: id,
      metadata: { privacyClass, contentVersion: updated.contentVersion },
    })
    return memoryDto(updated)
  })
}
/** Invalid provenance means no injection. Threshold and count apply after privacy and current-version checks. */
export async function recallMemories(
  db: DbOrTx,
  deps: Deps,
  run: AgentRunRow,
  vector: number[],
): Promise<{ data: AgentMemory[]; sources: AgentSource[] }> {
  if (run.readScope !== 'all_accessible') throw new AppError('FORBIDDEN', 'Memories are personal')
  if (!deps.embeddings) return { data: [], sources: [] }
  const [model] = await db
    .select()
    .from(embeddingModels)
    .where(
      and(
        eq(embeddingModels.version, deps.embeddings.modelVersion),
        eq(embeddingModels.status, 'active'),
        eq(embeddingModels.dimension, deps.embeddings.dimension),
      ),
    )
  if (!model)
    throw new AppError('CAPACITY_UNAVAILABLE', 'Local memory index has not been activated')
  const distance = sql<number>`${memoryEmbeddings.embedding}::vector(${sql.raw(String(model.dimension))}) <=> ${JSON.stringify(vector)}::vector(${sql.raw(String(model.dimension))})`
  const rows = await db
    .select({ memory: agentMemories, distance })
    .from(agentMemories)
    .innerJoin(
      memoryEmbeddings,
      and(
        eq(memoryEmbeddings.memoryId, agentMemories.id),
        eq(memoryEmbeddings.contentVersion, agentMemories.contentVersion),
        eq(memoryEmbeddings.modelVersion, deps.embeddings.modelVersion),
      ),
    )
    .where(
      and(
        eq(agentMemories.userId, run.userId),
        isNull(agentMemories.deletedAt),
        inArray(agentMemories.privacyClass, [...readablePrivacy(run)]),
        sql`${distance} <= ${1 - RETRIEVAL.memoryThreshold}`,
      ),
    )
    .orderBy(distance)
    .limit(50)
  const data: AgentMemory[] = [],
    sources: AgentSource[] = []
  for (const { memory } of rows) {
    try {
      await validateAgentSources(db, deps, { ...run, contextManifest: memory.sourceManifest })
    } catch (error) {
      if (
        error instanceof AppError &&
        ['CONTEXT_CHANGED', 'FORBIDDEN', 'NOT_FOUND'].includes(error.code)
      )
        continue
      throw error
    }
    data.push(memoryDto(memory))
    sources.push(...memory.sourceManifest, {
      type: 'memory',
      id: memory.id,
      contentVersion: memory.contentVersion,
      privacyClass: memory.privacyClass,
    })
    if (data.length === 5) break
  }
  return { data, sources }
}
export async function rememberNeedsApproval(db: DbOrTx, run: AgentRunRow): Promise<boolean> {
  const [source] = run.sourceMessageId
    ? await db
        .select({ body: messages.body })
        .from(messages)
        .where(eq(messages.id, run.sourceMessageId))
    : []
  return !hasMemoryIntent(source?.body ?? '')
}
