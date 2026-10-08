import { type AgentDelta, type AgentSource, AppError } from '@chatapp/contracts'
import {
  agentApprovals,
  agentContexts,
  agentConversationState,
  agentMemories,
  agentRuns,
  attachments,
  authorizationOrigins,
  conversations,
  type DbOrTx,
  executionDelegations,
  messageHidden,
  messages,
  type Tx,
  userAiKeys,
  users,
} from '@chatapp/db'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { fingerprint } from '../lib/crypto.ts'
import { enforce, loadAccess } from './authorize.ts'
import type { Deps } from './deps.ts'
import type { DelegatedPrincipal } from './principal.ts'
import { accountAllowsSession, lockUsers, type SessionRef, validateSessions } from './sessions.ts'
import { inTransaction } from './tx.ts'

export type AgentRunRow = typeof agentRuns.$inferSelect
export type AgentLease = { id: string; epoch: number }
export const contextChanged = () =>
  new AppError('CONTEXT_CHANGED', 'The context changed; start a new request')
export const staleLease = () => new AppError('CONFLICT', 'The run is no longer active')
export const terminalRun = (run: AgentRunRow): boolean =>
  ['completed', 'failed', 'cancelled'].includes(run.status)

/** Session expiry/sign-out is intentionally absent. The persisted origin, delegation and account remain authoritative. */
export async function lockDelegation(
  tx: Tx,
  deps: Pick<Deps, 'clock' | 'config'>,
  run: AgentRunRow,
  alsoLockUsers: readonly string[] = [],
): Promise<DelegatedPrincipal> {
  // Everyone an effect changes is locked with the caller, in id order, before any other row (docs/03 section 5.1).
  const user = (await lockUsers(tx, [run.userId, ...alsoLockUsers])).find(
    (u) => u.id === run.userId,
  )
  const [reference] = await tx
    .select({ originId: executionDelegations.originId })
    .from(executionDelegations)
    .where(eq(executionDelegations.id, run.delegationId))
  if (!reference)
    throw new AppError('UNAUTHENTICATED', 'Execution authorization is no longer valid')
  const [origin] = await tx
    .select()
    .from(authorizationOrigins)
    .where(eq(authorizationOrigins.id, reference.originId))
    .for('update')
  const [delegation] = await tx
    .select()
    .from(executionDelegations)
    .where(eq(executionDelegations.id, run.delegationId))
    .for('update')
  if (
    !user ||
    !accountAllowsSession(user, deps.clock.now()) ||
    !origin ||
    !delegation ||
    delegation.userId !== user.id ||
    origin.userId !== user.id ||
    delegation.originId !== origin.id ||
    delegation.status !== 'active' ||
    delegation.purpose !== 'agent_run' ||
    delegation.targetId !== run.id ||
    delegation.authEpoch !== user.authEpoch ||
    delegation.restoreEpoch !== deps.config.auth.restoreEpoch ||
    origin.restoreEpoch !== deps.config.auth.restoreEpoch ||
    origin.revokedAt ||
    delegation.expiresAt <= deps.clock.now()
  )
    throw new AppError('UNAUTHENTICATED', 'Execution authorization is no longer valid')
  return {
    kind: 'delegated',
    userId: user.id,
    delegationId: delegation.id,
    originId: origin.id,
    authEpoch: user.authEpoch,
    restoreEpoch: delegation.restoreEpoch,
    role: user.role,
  }
}

export async function lockSourceConversations(
  tx: Tx,
  run: AgentRunRow,
  extras: readonly string[] = [],
): Promise<void> {
  const ids = [
    ...new Set(
      [
        run.conversationId,
        run.contextConversationId,
        ...run.contextManifest.filter((s) => s.type === 'conversation').map((s) => s.id),
        ...extras,
      ].filter((id): id is string => id !== null),
    ),
  ].sort()
  if (ids.length)
    await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(inArray(conversations.id, ids))
      .orderBy(asc(conversations.id))
      .for('update')
}

/** Only a private own-key run may read private own-key content; site runs and shared replies read standard only. */
export const readablePrivacy = (run: Pick<AgentRunRow, 'privacyClass'>) =>
  run.privacyClass === 'byok_private'
    ? (['standard', 'byok_private'] as const)
    : (['standard'] as const)

export async function validateAgentSources(
  tx: DbOrTx,
  deps: Pick<Deps, 'clock' | 'config'>,
  run: AgentRunRow,
  depth = 0,
): Promise<void> {
  if (depth > 8) throw contextChanged()
  if (!run.conversationId) throw contextChanged()
  if (run.keySource === 'site' && (run.keyRevision !== null || run.privacyClass !== 'standard'))
    throw contextChanged()
  if (run.keySource === 'user') {
    // A replaced, removed or rejected key ends the runs pinned to it (D-080); they never continue on another key.
    const [key] = await tx
      .select({ revision: userAiKeys.revision, status: userAiKeys.status })
      .from(userAiKeys)
      .where(eq(userAiKeys.userId, run.userId))
    if (key?.status !== 'active' || key.revision !== run.keyRevision) throw contextChanged()
    if (run.trigger === 'mention' && run.privacyClass !== 'standard') throw contextChanged()
  }
  const allowed: readonly string[] = readablePrivacy(run)
  const [context] = await tx
    .select()
    .from(agentContexts)
    .where(eq(agentContexts.conversationId, run.conversationId))
  if (
    run.trigger !== 'mention' &&
    (!context ||
      context.contextEpoch !== run.contextEpoch ||
      context.keySource !== run.keySource ||
      (context.keyRevision ?? null) !== run.keyRevision ||
      context.privacyClass !== run.privacyClass ||
      context.readScope !== run.readScope)
  )
    throw contextChanged()
  const access = await loadAccess(tx, run.userId, run.conversationId)
  enforce(access, { userId: run.userId, siteRole: 'user' }, 'send_message', deps.clock.now())
  if (access.conversation.membershipVersion !== run.outputMembershipVersion) throw contextChanged()
  if (
    run.trigger === 'mention' &&
    (access.conversation.settings.agentEnabled === false ||
      !['group', 'channel'].includes(access.conversation.kind))
  )
    throw contextChanged()
  for (const source of run.contextManifest) {
    if (source.type === 'conversation') {
      const current = await loadAccess(tx, run.userId, source.id)
      enforce(current, { userId: run.userId, siteRole: 'user' }, 'read_messages', deps.clock.now())
      if (
        !current.member ||
        current.member.membershipId !== source.membershipId ||
        current.member.visibleFromSeq !== source.visibleFromSeq ||
        current.conversation.membershipVersion !== source.membershipVersion
      )
        throw contextChanged()
      if (
        run.readScope === 'current_conversation' &&
        source.id !== run.contextConversationId &&
        source.id !== run.conversationId
      )
        throw contextChanged()
    } else if (source.type === 'message') {
      const [current] = await tx.select().from(messages).where(eq(messages.id, source.id))
      const [hidden] = await tx
        .select({ id: messageHidden.messageId })
        .from(messageHidden)
        .where(and(eq(messageHidden.messageId, source.id), eq(messageHidden.userId, run.userId)))
      const membership = run.contextManifest.find(
        (s) => s.type === 'conversation' && s.id === source.conversationId,
      )
      if (
        !current ||
        hidden ||
        !membership ||
        membership.type !== 'conversation' ||
        current.conversationId !== source.conversationId ||
        current.contentVersion !== source.contentVersion ||
        current.recalledAt ||
        current.deletedAt ||
        !allowed.includes(current.privacyClass) ||
        !allowed.includes(source.privacyClass) ||
        current.seq <= membership.visibleFromSeq ||
        (run.trigger === 'mention' && current.seq <= run.sharedVisibleFromSeq)
      )
        throw contextChanged()
    } else if (source.type === 'user') {
      const [user] = await tx.select().from(users).where(eq(users.id, source.id))
      if (!user || user.deletedAt || user.profileVersion !== source.profileVersion)
        throw contextChanged()
    } else if (source.type === 'summary') {
      const [summary] = await tx
        .select()
        .from(agentConversationState)
        .where(eq(agentConversationState.conversationId, source.id))
      if (
        !summary?.summary ||
        summary.contextEpoch !== source.contextEpoch ||
        summary.summarizedThroughSeq !== source.summarizedThroughSeq ||
        summary.expiresAt.toISOString() !== source.expiresAt ||
        summary.expiresAt <= deps.clock.now() ||
        !allowed.includes(summary.privacyClass) ||
        !allowed.includes(source.privacyClass)
      )
        throw contextChanged()
      await validateAgentSources(
        tx,
        deps,
        { ...run, contextManifest: summary.sourceManifest },
        depth + 1,
      )
    } else if (source.type === 'memory') {
      const [memory] = await tx.select().from(agentMemories).where(eq(agentMemories.id, source.id))
      if (
        run.readScope !== 'all_accessible' ||
        !memory ||
        memory.userId !== run.userId ||
        memory.deletedAt ||
        !memory.content ||
        memory.contentVersion !== source.contentVersion ||
        !allowed.includes(memory.privacyClass) ||
        !allowed.includes(source.privacyClass)
      )
        throw contextChanged()
      await validateAgentSources(
        tx,
        deps,
        { ...run, contextManifest: memory.sourceManifest },
        depth + 1,
      )
    } else {
      const [current] = await tx.select().from(attachments).where(eq(attachments.id, source.id))
      if (
        !current ||
        current.conversationId !== source.conversationId ||
        current.version !== source.version ||
        current.generation !== source.generation ||
        current.status !== 'ready' ||
        !allowed.includes(current.privacyClass) ||
        !allowed.includes(source.privacyClass)
      )
        throw contextChanged()
    }
  }
}

/** All model/tool/output writes enter the same transaction and lock order; the fencing token is never client supplied. */
export async function withAgentLease<T>(
  deps: Pick<Deps, 'db' | 'clock' | 'config'>,
  lease: AgentLease,
  apply: (tx: Tx, run: AgentRunRow, principal: DelegatedPrincipal) => Promise<T>,
  extras: readonly string[] = [],
  alsoLockUsers: readonly string[] = [],
  additionalConversations?: (tx: Tx, run: AgentRunRow) => Promise<readonly string[]>,
): Promise<T> {
  const [peek] = await deps.db.select().from(agentRuns).where(eq(agentRuns.id, lease.id))
  if (!peek) throw staleLease()
  return await inTransaction(deps.db, async (tx) => {
    const principal = await lockDelegation(tx, deps, peek, alsoLockUsers)
    // The owner lock serializes context additions; use its latest manifest before acquiring conversation locks.
    const [current] = await tx.select().from(agentRuns).where(eq(agentRuns.id, lease.id))
    if (!current) throw staleLease()
    const additional = additionalConversations ? await additionalConversations(tx, current) : []
    await lockSourceConversations(tx, current, [...extras, ...additional])
    const [run] = await tx.select().from(agentRuns).where(eq(agentRuns.id, lease.id)).for('update')
    if (
      run?.status !== 'running' ||
      run.leaseEpoch !== lease.epoch ||
      run.cancelRequestedAt ||
      !run.leaseUntil ||
      run.leaseUntil <= deps.clock.now()
    )
      throw staleLease()
    await validateAgentSources(tx, deps, run)
    return await apply(tx, run, principal)
  })
}

/** Content streams require fresh session, recipient membership, source and lease checks for every batch. */
export async function authorizeAgentDelta(
  deps: Pick<Deps, 'db' | 'clock' | 'config'>,
  delta: AgentDelta,
  recipients: readonly (SessionRef & { restoreEpoch: string })[],
): Promise<Set<string>> {
  return await withAgentLease(
    deps,
    { id: delta.runId, epoch: delta.leaseEpoch },
    async (tx, run) => {
      if (
        run.conversationId !== delta.conversationId ||
        run.outputMessageId !== delta.messageId ||
        run.resumeSeq !== delta.resumeSeq
      )
        throw staleLease()
      const [message] = await tx.select().from(messages).where(eq(messages.id, delta.messageId))
      if (
        !message ||
        message.recalledAt ||
        message.deletedAt ||
        !(readablePrivacy(run) as readonly string[]).includes(message.privacyClass) ||
        message.meta.agent?.runId !== run.id ||
        message.meta.agent.resumeSeq !== delta.resumeSeq
      )
        throw staleLease()
      const refs = recipients.filter((r) => r.restoreEpoch === deps.config.auth.restoreEpoch)
      const sessions = await validateSessions(deps, refs)
      const authorized = new Set<string>()
      for (const ref of refs) {
        if (!sessions.has(ref.sessionId)) continue
        const access = await loadAccess(tx, ref.userId, delta.conversationId)
        if (!access.member || message.seq <= access.member.visibleFromSeq) continue
        if (access.conversation.kind === 'agent' && access.conversation.ownerId !== ref.userId)
          continue
        authorized.add(ref.sessionId)
      }
      return authorized
    },
  )
}

export async function addManifest(
  tx: Tx,
  run: AgentRunRow,
  additions: AgentSource[],
): Promise<AgentSource[]> {
  const manifest = [...run.contextManifest]
  for (const source of additions) {
    const existing = manifest.find((s) => s.type === source.type && s.id === source.id)
    if (existing && fingerprint(existing) !== fingerprint(source)) throw contextChanged()
    if (!existing) manifest.push(source)
  }
  if (manifest.length > 2000) throw new AppError('QUOTA_EXCEEDED', 'The context is too large')
  await tx.update(agentRuns).set({ contextManifest: manifest }).where(eq(agentRuns.id, run.id))
  return manifest
}

/** Invoked under a changed conversation's lock. The run's old worker cannot commit after this transaction. */
export async function invalidateConversationRuns(
  tx: DbOrTx,
  deps: Pick<Deps, 'clock'>,
  conversationId: string,
  exceptRunId?: string,
): Promise<void> {
  await tx
    .update(agentConversationState)
    .set({ summary: null, sourceManifest: [] })
    .where(
      sql`(${agentConversationState.conversationId} = ${conversationId}::uuid or ${agentConversationState.sourceManifest} @> ${JSON.stringify([{ type: 'conversation', id: conversationId }])}::text::jsonb)`,
    )
  const cancelled = await tx
    .update(agentRuns)
    .set({
      status: 'cancelled',
      cancelRequestedAt: deps.clock.now(),
      finishedAt: deps.clock.now(),
      leaseEpoch: sql`${agentRuns.leaseEpoch} + 1`,
      leaseUntil: null,
      stateVersion: sql`${agentRuns.stateVersion} + 1`,
      errorCode: 'CONTEXT_CHANGED',
      errorMessage: 'The context changed; start a new request',
    })
    .where(
      and(
        inArray(agentRuns.status, ['queued', 'running', 'awaiting_approval']),
        sql`(${agentRuns.conversationId} = ${conversationId}::uuid or ${agentRuns.contextManifest} @> ${JSON.stringify([{ type: 'conversation', id: conversationId }])}::text::jsonb)`,
        exceptRunId ? sql`${agentRuns.id} <> ${exceptRunId}::uuid` : undefined,
      ),
    )
    .returning({ id: agentRuns.id })
  await closePendingApprovals(
    tx,
    deps,
    cancelled.map((run) => run.id),
    'context_changed',
  )
}

/**
 * Pending decisions of runs that just ended can no longer be taken (docs/04: cancelling turns pending into rejected with
 * a reason). Called in the transaction that ended the runs.
 */
export async function closePendingApprovals(
  tx: DbOrTx,
  deps: Pick<Deps, 'clock'>,
  runIds: readonly string[],
  reason: 'cancelled' | 'context_changed' | 'unauthenticated' | 'expired' | 'failed',
): Promise<void> {
  if (runIds.length === 0) return
  await tx
    .update(agentApprovals)
    .set({
      status: reason === 'expired' ? 'expired' : 'rejected',
      reason,
      decidedAt: deps.clock.now(),
    })
    .where(and(inArray(agentApprovals.runId, [...runIds]), eq(agentApprovals.status, 'pending')))
}
