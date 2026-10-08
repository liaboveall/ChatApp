import {
  type AgentReadToolName,
  type AgentSource,
  AppError,
  agentReadToolSchemas as agentToolSchemas,
} from '@chatapp/contracts'
import {
  agentConversationState,
  agentRunStates,
  agentRuns,
  agentSteps,
  attachments,
  conversationMembers,
  conversations,
  messages,
  type Tx,
  users,
} from '@chatapp/db'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { agentSourceTime } from '../lib/agent-source-time.ts'
import {
  type AgentLease,
  type AgentRunRow,
  addManifest,
  contextChanged,
  readablePrivacy,
  validateAgentSources,
  withAgentLease,
} from './agent-access.ts'
import { enforce, loadAccess } from './authorize.ts'
import type { Deps } from './deps.ts'
import { embedQuery, hybridMessages } from './embeddings.ts'
import { recallMemories } from './memories.ts'
import type { MessageRow } from './messages.ts'
import { findVisibleMessages } from './search.ts'
import { toUserSummary } from './users.ts'

async function eligibleConversations(deps: Deps, lease: AgentLease): Promise<string[]> {
  const [run] = await deps.db.select().from(agentRuns).where(eq(agentRuns.id, lease.id))
  if (!run) throw contextChanged()
  if (run.readScope === 'current_conversation')
    return [
      ...new Set(
        [run.contextConversationId, run.conversationId].filter((id): id is string => id !== null),
      ),
    ]
  return (
    await deps.db
      .select({ id: conversationMembers.conversationId })
      .from(conversationMembers)
      .where(eq(conversationMembers.userId, run.userId))
  ).map((r) => r.id)
}

async function conversationSource(
  tx: Tx,
  deps: Deps,
  run: AgentRunRow,
  id: string,
): Promise<AgentSource> {
  if (
    run.readScope === 'current_conversation' &&
    id !== run.contextConversationId &&
    id !== run.conversationId
  )
    throw new AppError('FORBIDDEN', 'The resource is outside this reading scope')
  const access = await loadAccess(tx, run.userId, id)
  enforce(access, { userId: run.userId, siteRole: 'user' }, 'read_messages', deps.clock.now())
  if (!access.member) throw new AppError('NOT_FOUND', 'Conversation not found')
  return {
    type: 'conversation',
    id,
    membershipId: access.member.membershipId,
    membershipVersion: access.conversation.membershipVersion,
    visibleFromSeq: access.member.visibleFromSeq,
  }
}

/** No HTTP projection/quote can smuggle a second source into model input. Every returned byte has a manifest entry. */
type ToolMessage = {
  id: string
  conversationId: string
  seq: number
  sender: string
  username: string | null
  createdAt: string
  createdAtLocal: string
  body: string | null
  attachments: {
    id: string
    kind: typeof attachments.$inferSelect.kind
    name: string | null
    mime: string
  }[]
}
async function toolMessages(
  tx: Tx,
  deps: Deps,
  run: AgentRunRow,
  rows: MessageRow[],
): Promise<{ data: ToolMessage[]; sources: AgentSource[] }> {
  const sources: AgentSource[] = []
  const data: ToolMessage[] = []
  const conversationIds = [...new Set(rows.map((r) => r.conversationId))]
  for (const id of conversationIds) sources.push(await conversationSource(tx, deps, run, id))
  const people = rows.flatMap((r) => (r.senderId ? [r.senderId] : []))
  const senders = people.length
    ? await tx
        .select({
          id: users.id,
          name: users.name,
          username: users.username,
          profileVersion: users.profileVersion,
        })
        .from(users)
        .where(inArray(users.id, people))
    : []
  const files = rows.length
    ? await tx
        .select()
        .from(attachments)
        .where(
          and(
            inArray(
              attachments.messageId,
              rows.map((r) => r.id),
            ),
            eq(attachments.status, 'ready'),
            inArray(attachments.privacyClass, [...readablePrivacy(run)]),
          ),
        )
    : []
  const allowed: readonly string[] = readablePrivacy(run)
  for (const row of rows) {
    if (!allowed.includes(row.privacyClass)) throw contextChanged()
    // Private assistant history carries all transitive sources, including messages from other conversations.
    if (row.kind === 'agent') {
      const originalId = row.meta.agent?.runId
      const [original] = originalId
        ? await tx.select().from(agentRuns).where(eq(agentRuns.id, originalId))
        : []
      if (
        original?.status !== 'completed' ||
        original.contentPurgedAt ||
        !allowed.includes(original.privacyClass) ||
        (row.conversationId === run.conversationId && row.contextEpoch !== run.contextEpoch)
      )
        continue
      if (
        run.readScope === 'current_conversation' &&
        original.contextManifest.some(
          (s) =>
            s.type === 'conversation' &&
            s.id !== run.contextConversationId &&
            s.id !== run.conversationId,
        )
      )
        continue
      // A fresh run rebuilds history from currently valid entries; an obsolete derived answer cannot poison every later request.
      try {
        await validateAgentSources(tx, deps, { ...run, contextManifest: original.contextManifest })
      } catch (error) {
        if (
          error instanceof AppError &&
          ['CONTEXT_CHANGED', 'NOT_FOUND', 'FORBIDDEN'].includes(error.code)
        )
          continue
        throw error
      }
      sources.push(...original.contextManifest)
    }
    sources.push({
      type: 'message',
      id: row.id,
      conversationId: row.conversationId,
      contentVersion: row.contentVersion,
      privacyClass: row.privacyClass,
    })
    const rowFiles = files.filter((f) => f.messageId === row.id)
    for (const file of rowFiles)
      sources.push({
        type: 'attachment',
        id: file.id,
        conversationId: row.conversationId,
        version: file.version,
        generation: file.generation,
        privacyClass: file.privacyClass,
      })
    const sender = senders.find((s) => s.id === row.senderId)
    if (sender) sources.push({ type: 'user', id: sender.id, profileVersion: sender.profileVersion })
    data.push({
      id: row.id,
      conversationId: row.conversationId,
      seq: row.seq,
      sender: sender?.name ?? '系统',
      username: sender?.username ?? null,
      createdAt: row.createdAt.toISOString(),
      createdAtLocal: agentSourceTime(row.createdAt, run.timezone),
      body: row.body,
      attachments: rowFiles.map((f) => ({
        id: f.id,
        kind: f.kind,
        name: f.originalName,
        mime: f.mime,
      })),
    })
  }
  return { data, sources }
}

export async function executeAgentTool(
  deps: Deps,
  lease: AgentLease,
  name: AgentReadToolName,
  raw: unknown,
): Promise<unknown> {
  const parsed = agentToolSchemas[name].safeParse(raw)
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', 'Invalid tool arguments')
  const allowed = await eligibleConversations(deps, lease)
  let vector: number[] | null = null
  if (name === 'semantic_search_messages' || name === 'recall_memories') {
    await withAgentLease(deps, lease, async () => {})
    vector = await embedQuery(deps, (parsed.data as { query: string }).query)
  }
  // Tools may discover transitive manifests in earlier answers. Lock all currently accessible conversations in id order.
  const extras = (
    await deps.db
      .select({ id: conversationMembers.conversationId })
      .from(conversationMembers)
      .innerJoin(agentRuns, eq(agentRuns.userId, conversationMembers.userId))
      .where(eq(agentRuns.id, lease.id))
  ).map((r) => r.id)
  return await withAgentLease(
    deps,
    lease,
    async (tx, run) => {
      let result: unknown
      let sources: AgentSource[] = []
      const args = parsed.data
      const excludeMessageIds = [run.sourceMessageId, run.outputMessageId].filter(
        (id): id is string => id !== null,
      )
      if (name === 'read_conversation' || name === 'read_unread') {
        const input =
          name === 'read_conversation'
            ? agentToolSchemas.read_conversation.parse(args)
            : agentToolSchemas.read_unread.parse(args)
        const id = input.conversationId ?? run.contextConversationId ?? run.conversationId
        if (!id) throw new AppError('NOT_FOUND', 'Conversation not found')
        await conversationSource(tx, deps, run, id)
        const [membership] = await tx
          .select()
          .from(conversationMembers)
          .where(
            and(
              eq(conversationMembers.userId, run.userId),
              eq(conversationMembers.conversationId, id),
            ),
          )
        const rows = await findVisibleMessages(tx, run.userId, {
          conversationIds: [id],
          siteInput: run.privacyClass !== 'byok_private',
          shared: run.trigger === 'mention',
          limit: name === 'read_unread' ? 300 : 'limit' in input ? input.limit : 30,
          beforeSeq: 'beforeSeq' in input ? input.beforeSeq : undefined,
          afterSeq: name === 'read_unread' ? membership?.lastReadSeq : undefined,
          order: 'seq',
          excludeMessageIds,
        })
        const projected = await toolMessages(tx, deps, run, rows.reverse())
        result = projected.data
        sources = projected.sources
      } else if (name === 'search_messages') {
        const input = agentToolSchemas.search_messages.parse(args)
        const ids =
          input.conversationIds ??
          allowed.filter(
            (id) =>
              run.readScope === 'all_accessible' ||
              id === run.contextConversationId ||
              id === run.conversationId,
          )
        for (const id of ids) await conversationSource(tx, deps, run, id)
        const rows = await findVisibleMessages(tx, run.userId, {
          ...input,
          conversationIds: ids,
          siteInput: run.privacyClass !== 'byok_private',
          shared: run.trigger === 'mention',
          excludeMessageIds,
        })
        const projected = await toolMessages(tx, deps, run, rows)
        result = projected.data
        sources = projected.sources
      } else if (name === 'semantic_search_messages') {
        const input = agentToolSchemas.semantic_search_messages.parse(args)
        const ids =
          input.conversationIds ??
          allowed.filter(
            (id) =>
              run.readScope === 'all_accessible' ||
              id === run.contextConversationId ||
              id === run.conversationId,
          )
        for (const id of ids) await conversationSource(tx, deps, run, id)
        const rows = await hybridMessages(tx, deps, run.userId, input.query, vector ?? [], {
          conversationIds: ids,
          siteInput: run.privacyClass !== 'byok_private',
          shared: run.trigger === 'mention',
          excludeMessageIds,
          limit: input.limit,
        })
        const projected = await toolMessages(tx, deps, run, rows)
        result = projected.data
        sources = projected.sources
      } else if (name === 'recall_memories') {
        const recalled = await recallMemories(tx, deps, run, vector ?? [])
        result = recalled.data
        sources = recalled.sources
      } else if (name === 'get_message') {
        const input = agentToolSchemas.get_message.parse(args)
        const [target] = await findVisibleMessages(tx, run.userId, {
          conversationIds: allowed,
          messageId: input.messageId,
          siteInput: run.privacyClass !== 'byok_private',
          shared: run.trigger === 'mention',
          limit: 1,
          excludeMessageIds,
        })
        if (!target) throw new AppError('NOT_FOUND', 'Message not found')
        const surrounding = (
          await findVisibleMessages(tx, run.userId, {
            conversationIds: [target.conversationId],
            afterSeq: Math.max(0, target.seq - 6),
            beforeSeq: target.seq + 6,
            siteInput: run.privacyClass !== 'byok_private',
            shared: run.trigger === 'mention',
            limit: 11,
            order: 'seq',
            excludeMessageIds,
          })
        ).sort((a, b) => a.seq - b.seq)
        const projected = await toolMessages(tx, deps, run, surrounding)
        result = projected.data
          .sort((a, b) => (a.id === target.id ? -1 : b.id === target.id ? 1 : a.seq - b.seq))
          .map((message) => {
            const points = [...(message.body ?? '')]
            const focus = message.id === target.id
            const offset = focus ? input.bodyOffset : 0
            const limit = focus ? input.bodyLimit : 200
            return {
              ...message,
              body: points.slice(offset, offset + limit).join(''),
              bodyRange: {
                offset,
                length: Math.min(limit, Math.max(0, points.length - offset)),
                total: points.length,
              },
            }
          })
        sources = projected.sources
      } else if (name === 'list_conversations') {
        if (run.readScope !== 'all_accessible')
          throw new AppError('FORBIDDEN', 'This tool requires all accessible conversations')
        const input = agentToolSchemas.list_conversations.parse(args)
        const rows = await tx
          .select({ conversation: conversations, member: conversationMembers })
          .from(conversations)
          .innerJoin(conversationMembers, eq(conversationMembers.conversationId, conversations.id))
          .where(
            and(
              eq(conversationMembers.userId, run.userId),
              isNull(conversations.archivedAt),
              isNull(conversationMembers.hiddenAt),
              isNull(conversations.panelForConversationId),
            ),
          )
        const filtered = rows.filter(
          (r) =>
            (!input.kind || r.conversation.kind === input.kind) &&
            (!input.unreadOnly || r.conversation.lastSeq > r.member.lastReadSeq),
        )
        for (const row of filtered)
          sources.push(await conversationSource(tx, deps, run, row.conversation.id))
        result = filtered.map((r) => ({
          id: r.conversation.id,
          kind: r.conversation.kind,
          name: r.conversation.name,
          unread: Math.max(0, r.conversation.lastSeq - r.member.lastReadSeq),
        }))
      } else if (name === 'list_members') {
        const { conversationId } = agentToolSchemas.list_members.parse(args)
        sources.push(await conversationSource(tx, deps, run, conversationId))
        const rows = await tx
          .select({ user: users, role: conversationMembers.role })
          .from(conversationMembers)
          .innerJoin(users, eq(users.id, conversationMembers.userId))
          .where(eq(conversationMembers.conversationId, conversationId))
        result = rows.map((r) => ({ ...toUserSummary(r.user), role: r.role }))
        sources.push(
          ...rows.map((r) => ({
            type: 'user' as const,
            id: r.user.id,
            profileVersion: r.user.profileVersion,
          })),
        )
      } else {
        const input = agentToolSchemas.get_user_profile.parse(args)
        const [user] = await tx
          .select()
          .from(users)
          .where(
            input.userId ? eq(users.id, input.userId) : eq(users.username, input.username ?? ''),
          )
        if (!user || user.deletedAt || user.isBot) throw new AppError('NOT_FOUND', 'User not found')
        result = { ...toUserSummary(user), bio: user.bio }
        sources.push({ type: 'user', id: user.id, profileVersion: user.profileVersion })
      }
      const manifest = await addManifest(tx, run, sources)
      await validateAgentSources(tx, deps, { ...run, contextManifest: manifest })
      await appendAgentStep(tx, deps, run, 'tool_call', { arguments: args }, name, 'done')
      await appendAgentStep(tx, deps, run, 'tool_result', result, name)
      return result
    },
    extras,
  )
}

export async function appendAgentStep(
  tx: Tx,
  deps: Pick<Deps, 'clock' | 'newId'>,
  run: Pick<AgentRunRow, 'id'>,
  type: 'model' | 'tool_call' | 'tool_result' | 'error' | 'approval',
  payload: unknown,
  toolName: string | null = null,
  status: 'pending' | 'done' | 'failed' | null = null,
): Promise<{ id: string; index: number }> {
  const [head] = await tx
    .select({ index: agentSteps.index })
    .from(agentSteps)
    .where(eq(agentSteps.runId, run.id))
    .orderBy(desc(agentSteps.index))
    .limit(1)
  const text = JSON.stringify(payload)
  const display =
    Buffer.byteLength(text) > 32_000
      ? { truncated: true, preview: Array.from(text).slice(0, 4000).join('') }
      : payload
  const id = deps.newId()
  const index = (head?.index ?? -1) + 1
  await tx.insert(agentSteps).values({
    id,
    runId: run.id,
    index,
    type,
    toolName,
    status,
    payload: display,
    createdAt: deps.clock.now(),
  })
  return { id, index }
}

/** Denied model attempts remain reviewable; an expired authority cannot write even an error step. */
export async function recordAgentToolFailure(
  deps: Deps,
  lease: AgentLease,
  name: string,
  input: unknown,
  code: string,
): Promise<void> {
  await withAgentLease(deps, lease, async (tx, run) => {
    await appendAgentStep(tx, deps, run, 'tool_call', { arguments: input }, name, 'failed')
    await appendAgentStep(tx, deps, run, 'tool_result', { error: code }, name, 'failed')
  })
}

export async function buildAgentContext(
  deps: Deps,
  lease: AgentLease,
): Promise<{
  prompt: string
  history: unknown[]
  images: { id: string; key: string; mime: string }[]
  run: AgentRunRow
  continuation: unknown[]
  finalText: string | null
}> {
  const extras = await eligibleConversations(deps, lease)
  let memoryVector: number[] | null = null
  const [peek] = await deps.db.select().from(agentRuns).where(eq(agentRuns.id, lease.id))
  if (peek?.readScope === 'all_accessible' && deps.embeddings) {
    await withAgentLease(deps, lease, async () => {})
    const [input] = peek.sourceMessageId
      ? await deps.db
          .select({ body: messages.body })
          .from(messages)
          .where(eq(messages.id, peek.sourceMessageId))
      : []
    if (input?.body) {
      try {
        memoryVector = await embedQuery(deps, input.body.slice(0, 200))
      } catch (error) {
        if (!(error instanceof AppError && error.code === 'CAPACITY_UNAVAILABLE')) throw error
      }
    }
  }
  return await withAgentLease(
    deps,
    lease,
    async (tx, run) => {
      const [source] = run.sourceMessageId
        ? await tx.select().from(messages).where(eq(messages.id, run.sourceMessageId))
        : []
      if (!source?.body) throw contextChanged()
      const ids = [
        ...new Set(
          [run.contextConversationId, run.conversationId].filter((id): id is string => id !== null),
        ),
      ]
      const allRows: MessageRow[] = []
      for (const id of ids) {
        const rows = await findVisibleMessages(tx, run.userId, {
          conversationIds: [id],
          limit: 30,
          siteInput: run.privacyClass !== 'byok_private',
          shared: run.trigger === 'mention',
          beforeSeq: id === source.conversationId ? source.seq : undefined,
          order: 'seq',
        })
        allRows.push(
          ...rows
            .reverse()
            .filter(
              (r) =>
                id !== run.conversationId ||
                run.trigger === 'mention' ||
                r.contextEpoch === run.contextEpoch,
            ),
        )
      }
      const projected = await toolMessages(tx, deps, run, allRows)
      let recalled: Awaited<ReturnType<typeof recallMemories>> = { data: [], sources: [] }
      if (memoryVector) {
        try {
          recalled = await recallMemories(tx, deps, run, memoryVector)
        } catch (error) {
          // A staged/unavailable local index must not prevent ordinary chat from using its visible history.
          if (!(error instanceof AppError && error.code === 'CAPACITY_UNAVAILABLE')) throw error
        }
      }
      const summaries: { trust: 'untrusted'; summary: string }[] = []
      // Private conversation only. Extractive rolling summaries carry their complete transitive provenance.
      if (run.trigger !== 'mention' && run.conversationId) {
        const [saved] = await tx
          .select()
          .from(agentConversationState)
          .where(eq(agentConversationState.conversationId, run.conversationId))
        if (
          saved?.summary &&
          saved.contextEpoch === run.contextEpoch &&
          saved.keySource === run.keySource &&
          saved.privacyClass === run.privacyClass &&
          saved.expiresAt > deps.clock.now()
        ) {
          try {
            await validateAgentSources(tx, deps, { ...run, contextManifest: saved.sourceManifest })
            summaries.push({ trust: 'untrusted', summary: saved.summary })
            projected.sources.push(...saved.sourceManifest)
          } catch (error) {
            if (
              !(
                error instanceof AppError &&
                ['CONTEXT_CHANGED', 'FORBIDDEN', 'NOT_FOUND'].includes(error.code)
              )
            )
              throw error
            await tx
              .update(agentConversationState)
              .set({ summary: null, sourceManifest: [] })
              .where(eq(agentConversationState.conversationId, run.conversationId))
          }
        }
        const boundary = Math.min(
          ...allRows.filter((r) => r.conversationId === run.conversationId).map((r) => r.seq),
        )
        if (
          Number.isFinite(boundary) &&
          boundary > 1 &&
          (!saved ||
            saved.contextEpoch !== run.contextEpoch ||
            saved.summarizedThroughSeq < boundary - 1)
        ) {
          const older = (
            await findVisibleMessages(tx, run.userId, {
              conversationIds: [run.conversationId],
              beforeSeq: boundary,
              after: new Date(deps.clock.now().getTime() - 30 * 86400000).toISOString(),
              siteInput: run.privacyClass !== 'byok_private',
              limit: 48,
              order: 'seq',
            })
          )
            .reverse()
            .filter((r) => r.contextEpoch === run.contextEpoch)
          const view = await toolMessages(tx, deps, run, older)
          if (view.data.length) {
            const summary = view.data
              .map(
                (r) =>
                  `${r.createdAtLocal} ${r.sender}: ${[...(r.body ?? '')].slice(0, 200).join('')}`,
              )
              .join('\n')
            const values = {
              contextEpoch: run.contextEpoch,
              keySource: run.keySource,
              privacyClass: run.privacyClass,
              sourceManifest: view.sources,
              summary,
              summarizedThroughSeq: boundary - 1,
              expiresAt: new Date(deps.clock.now().getTime() + 30 * 86400000),
              updatedAt: deps.clock.now(),
            }
            await tx
              .insert(agentConversationState)
              .values({ conversationId: run.conversationId, ...values })
              .onConflictDoUpdate({ target: agentConversationState.conversationId, set: values })
            summaries.splice(0, summaries.length, { trust: 'untrusted', summary })
            projected.sources.push(...view.sources)
          }
        }
      }
      if (summaries.length && run.conversationId) {
        const [current] = await tx
          .select()
          .from(agentConversationState)
          .where(eq(agentConversationState.conversationId, run.conversationId))
        if (current)
          projected.sources.push({
            type: 'summary',
            id: run.conversationId,
            contextEpoch: current.contextEpoch,
            summarizedThroughSeq: current.summarizedThroughSeq,
            expiresAt: current.expiresAt.toISOString(),
            privacyClass: current.privacyClass,
          })
      }
      const imageRows = await tx
        .select()
        .from(attachments)
        .where(
          and(
            inArray(attachments.messageId, [source.id, ...allRows.map((r) => r.id)]),
            eq(attachments.kind, 'image'),
            eq(attachments.status, 'ready'),
            inArray(attachments.privacyClass, [...readablePrivacy(run)]),
          ),
        )
        .orderBy(desc(attachments.createdAt))
        .limit(4)
      const images = imageRows
        .filter((f) => f.variants.preview && f.conversationId)
        .map((f) => ({
          id: f.id,
          key: f.variants.preview?.key ?? '',
          mime: f.variants.preview?.mime ?? 'image/webp',
        }))
      const manifest = await addManifest(tx, run, [
        ...projected.sources,
        ...recalled.sources,
        ...imageRows
          .filter((f) => f.conversationId)
          .map((f) => ({
            type: 'attachment' as const,
            id: f.id,
            conversationId: f.conversationId ?? '',
            version: f.version,
            generation: f.generation,
            privacyClass: f.privacyClass,
          })),
      ])
      await validateAgentSources(tx, deps, { ...run, contextManifest: manifest })
      const [bot] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, deps.config.product.agentUsername))
      const [state] = await tx.select().from(agentRunStates).where(eq(agentRunStates.runId, run.id))
      const [lastModel] = await tx
        .select()
        .from(agentSteps)
        .where(and(eq(agentSteps.runId, run.id), eq(agentSteps.type, 'model')))
        .orderBy(desc(agentSteps.index))
        .limit(1)
      const payload = lastModel?.payload as { finishReason?: unknown; text?: unknown } | null
      return {
        prompt: bot ? source.body.replaceAll(`<@user:${bot.id}>`, '').trim() : source.body,
        history: [
          ...summaries,
          ...(recalled.data.length
            ? [{ trust: 'untrusted', personalMemories: recalled.data }]
            : []),
          ...projected.data,
        ],
        images,
        run: { ...run, contextManifest: manifest },
        continuation: run.resumeSeq > 0 ? (state?.messages.slice(1) ?? []) : [],
        finalText:
          run.resumeSeq > 0 &&
          payload?.finishReason === 'stop' &&
          typeof payload.text === 'string' &&
          payload.text.trim().length > 0
            ? payload.text
            : null,
      }
    },
    extras,
  )
}

export async function saveAgentModelStep(
  deps: Deps,
  lease: AgentLease,
  step: { messages: unknown[]; finishReason: string; text: string },
): Promise<void> {
  await withAgentLease(deps, lease, async (tx, run) => {
    await tx
      .update(agentRunStates)
      .set({
        messages: JSON.parse(
          JSON.stringify(step.messages, (_, value: unknown) =>
            value instanceof Uint8Array ? '[processed image reloaded on resume]' : value,
          ),
        ),
        stateVersion: sql`${agentRunStates.stateVersion} + 1`,
        updatedAt: deps.clock.now(),
      })
      .where(eq(agentRunStates.runId, run.id))
    await appendAgentStep(tx, deps, run, 'model', {
      finishReason: step.finishReason,
      text: step.text,
    })
    await tx
      .update(agentRuns)
      .set({
        stepCount: sql`${agentRuns.stepCount} + 1`,
        stateVersion: sql`${agentRuns.stateVersion} + 1`,
      })
      .where(eq(agentRuns.id, run.id))
  })
}
