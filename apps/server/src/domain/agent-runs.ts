import {
  type AgentContext,
  type AgentRun,
  type AgentRunDetail,
  type AgentRunRequest,
  type AgentSource,
  AppError,
  assistantText,
  LIMITS,
  truncateCodePoints,
} from '@chatapp/contracts'
import {
  agentApprovals,
  agentContexts,
  agentRunOutputs,
  agentRunStates,
  agentRuns,
  agentSteps,
  aiCallAttempts,
  attachments,
  conversationMembers,
  conversations,
  executionDelegations,
  messages,
  type Tx,
  users,
} from '@chatapp/db'
import { and, asc, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import { AI_LIMITS, loadAiConfig } from '../config/ai.ts'
import { fingerprint } from '../lib/crypto.ts'
import {
  type AgentLease,
  type AgentRunRow,
  closePendingApprovals,
  contextChanged,
  invalidateConversationRuns,
  lockDelegation,
  lockSourceConversations,
  staleLease,
  terminalRun,
  validateAgentSources,
  withAgentLease,
} from './agent-access.ts'
import { runDecisions } from './agent-approvals.ts'
import { activeKeyRevision, defaultKeySource } from './ai-keys.ts'
import { lockStorage } from './attachment-common.ts'
import { requireAccess } from './authorize.ts'
import {
  allocateChangeSeq,
  allocateMessageSeq,
  recordMessageChange,
  recordViewerChange,
} from './changes.ts'
import type { Deps } from './deps.ts'
import { assertIdempotencyKey, claimIdempotency, completeIdempotency } from './idempotency.ts'
import { addMembers, countLiveMemberships } from './membership.ts'
import type { SessionPrincipal } from './principal.ts'
import { lockAndRevalidate, lockUsers } from './sessions.ts'
import { inTransaction } from './tx.ts'
import { retireAttachment } from './uploads.ts'
import { enqueueWork } from './work.ts'

export const aiPolicy = (deps: Deps) => deps.config.ai ?? loadAiConfig({ APP_ENV: 'test' })
export const RUN_DELEGATION_MS = 25 * 3_600_000
export function agentRunDto(run: AgentRunRow): AgentRun {
  return {
    id: run.id,
    userId: run.userId,
    trigger: run.trigger,
    conversationId: run.conversationId,
    contextConversationId: run.contextConversationId,
    sourceMessageId: run.sourceMessageId,
    outputMessageId: run.outputMessageId,
    status: run.status,
    mode: run.mode,
    provider: run.provider,
    model: run.model,
    actualModel: run.actualModel,
    keySource: run.keySource,
    privacyClass: run.privacyClass,
    readScope: run.readScope,
    contextEpoch: run.contextEpoch,
    stateVersion: run.stateVersion,
    resumeSeq: run.resumeSeq,
    stepCount: run.stepCount,
    regeneratedFromRunId: run.regeneratedFromRunId,
    hasEffects: run.hasEffects,
    pendingApproval: run.pendingApproval,
    usage: {
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      cachedTokens: run.cachedTokens,
      costUsd: (run.costMicroUsd / 1_000_000).toFixed(6),
    },
    createdAt: run.createdAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    error: run.errorCode
      ? { code: run.errorCode, message: run.errorMessage ?? 'The request could not be completed' }
      : null,
  }
}

async function makeAgentConversation(
  tx: Tx,
  deps: Deps,
  userId: string,
  prompt: string,
  contextId: string | null,
  privateTitle = false,
): Promise<string> {
  const counts = await countLiveMemberships(tx, [userId])
  if ((counts.get(userId) ?? 0) >= LIMITS.maxConversationsPerUser)
    throw new AppError('QUOTA_EXCEEDED', 'You are in as many conversations as allowed')
  const id = deps.newId()
  await tx.insert(conversations).values({
    id,
    kind: 'agent',
    // A title taken from an own-key prompt would carry private content into lists the site assistant can read
    // (docs/06 section 3.1); such conversations start with the neutral name and the person may rename them.
    name:
      (privateTitle
        ? ''
        : truncateCodePoints(
            prompt
              .replace(/<@user:[^>]+>/g, '')
              .replace(/\s+/g, ' ')
              .trim(),
            40,
          )) || deps.config.product.agentDisplayName,
    ownerId: userId,
    createdBy: userId,
    panelForConversationId: contextId,
    createdAt: deps.clock.now(),
    updatedAt: deps.clock.now(),
  })
  await addMembers(
    tx,
    deps,
    { id, kind: 'agent', lastSeq: 0 },
    [{ userId, role: 'owner', addedBy: null }],
    { fromStart: true },
  )
  return id
}

export type AgentSegment = {
  contextEpoch: string
  stateVersion: number
  historyFromSeq: number
  readScope: AgentRunRow['readScope']
  keySource: 'site' | 'user'
  keyRevision: number | null
  privacyClass: 'standard' | 'byok_private'
}

/**
 * The context segment the next private request belongs to (docs/06 section 3.1, D-080). A conversation's first segment
 * takes the person's default source; later ones keep the source they had, follow a replaced own key to its new
 * revision, and change source only by an explicit switch. Any change of scope, source or revision is a new blank epoch
 * and ends the runs of the old one. An own-key segment without a usable key is refused, never moved to the site key.
 */
async function switchContext(
  tx: Tx,
  deps: Deps,
  conversationId: string,
  scope: AgentRunRow['readScope'],
  userId: string,
  explicitSource?: 'site' | 'user',
): Promise<AgentSegment> {
  const [current] = await tx
    .select()
    .from(agentContexts)
    .where(eq(agentContexts.conversationId, conversationId))
  const keySource = explicitSource ?? current?.keySource ?? (await defaultKeySource(tx, userId))
  const keyRevision = keySource === 'user' ? await activeKeyRevision(tx, userId) : null
  if (keySource === 'user' && keyRevision === null)
    throw new AppError('AI_KEY_INVALID', 'Your own key is missing or no longer accepted', {
      details: { reason: 'unavailable' },
    })
  const privacyClass = keySource === 'user' ? 'byok_private' : 'standard'
  if (
    current &&
    current.readScope === scope &&
    current.keySource === keySource &&
    current.privacyClass === privacyClass &&
    current.keyRevision === keyRevision
  )
    return { ...current, keyRevision: current.keyRevision ?? null }
  if (current) await invalidateConversationRuns(tx, deps, conversationId)
  const privacyTransition =
    current && (current.keySource !== keySource || current.keyRevision !== keyRevision)
  const [conversation] = privacyTransition
    ? await tx
        .select({ lastSeq: conversations.lastSeq })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
    : []
  const historyFromSeq = privacyTransition
    ? (conversation?.lastSeq ?? 0)
    : (current?.historyFromSeq ?? 0)
  const epoch = deps.newId()
  const values = {
    contextEpoch: epoch,
    stateVersion: (current?.stateVersion ?? 0) + 1,
    historyFromSeq,
    readScope: scope,
    keySource,
    privacyClass,
    keyRevision,
    updatedAt: deps.clock.now(),
  } as const
  await tx
    .insert(agentContexts)
    .values({ conversationId, ...values })
    .onConflictDoUpdate({ target: agentContexts.conversationId, set: values })
  return {
    contextEpoch: epoch,
    stateVersion: values.stateVersion,
    historyFromSeq,
    readScope: scope,
    keySource,
    keyRevision,
    privacyClass,
  }
}

export async function getAgentContext(
  deps: Deps,
  principal: SessionPrincipal,
  conversationId: string,
): Promise<AgentContext> {
  return await inTransaction(deps.db, async (tx) => {
    const user = await lockAndRevalidate(tx, deps, principal)
    const access = await requireAccess(
      tx,
      { userId: user.id, siteRole: user.role },
      conversationId,
      'read_messages',
      { now: deps.clock.now(), lock: true },
    )
    if (access.conversation.kind !== 'agent' || access.conversation.ownerId !== user.id)
      throw new AppError('NOT_FOUND', 'Conversation not found')
    const [context] = await tx
      .select()
      .from(agentContexts)
      .where(eq(agentContexts.conversationId, conversationId))
    if (!context) throw new AppError('NOT_FOUND', 'Assistant segment not found')
    return {
      conversationId,
      contextEpoch: context.contextEpoch,
      stateVersion: context.stateVersion,
      historyFromSeq: context.historyFromSeq,
      keySource: context.keySource,
      readScope: context.readScope,
    }
  })
}

/**
 * "Use the site allowance for a new request" and its opposite (docs/06 section 14, docs/02 section 6): a blank segment
 * with the chosen source; nothing of the old segment is carried over. Only the owner of the conversation may switch.
 */
export async function switchAgentKeySource(
  deps: Deps,
  principal: SessionPrincipal,
  conversationId: string,
  keySource: 'site' | 'user',
): Promise<AgentContext> {
  return await inTransaction(deps.db, async (tx) => {
    const user = await lockAndRevalidate(tx, deps, principal)
    const access = await requireAccess(
      tx,
      { userId: user.id, siteRole: user.role },
      conversationId,
      'send_message',
      { now: deps.clock.now(), lock: true },
    )
    if (access.conversation.kind !== 'agent' || access.conversation.ownerId !== user.id)
      throw new AppError('NOT_FOUND', 'Conversation not found')
    const [current] = await tx
      .select({ readScope: agentContexts.readScope })
      .from(agentContexts)
      .where(eq(agentContexts.conversationId, conversationId))
    const scope =
      current?.readScope ??
      (access.conversation.panelForConversationId ? 'current_conversation' : 'all_accessible')
    const segment = await switchContext(tx, deps, conversationId, scope, user.id, keySource)
    return {
      conversationId,
      contextEpoch: segment.contextEpoch,
      stateVersion: segment.stateVersion,
      historyFromSeq: segment.historyFromSeq,
      keySource: segment.keySource,
      readScope: segment.readScope,
    }
  })
}

/** Caller already holds the user and output conversation locks; used by HTTP and transactional @Agent creation. */
export async function enqueueRunForSource(
  tx: Tx,
  deps: Deps,
  principal: SessionPrincipal,
  source: typeof messages.$inferSelect,
  options: {
    trigger: AgentRunRow['trigger']
    mode: 'fast' | 'deep'
    scope: AgentRunRow['readScope']
    contextId: string | null
    epoch?: string
    allowRefusal?: boolean
  },
): Promise<AgentRunRow> {
  const now = deps.clock.now()
  const access = await requireAccess(
    tx,
    { userId: principal.userId, siteRole: principal.role },
    source.conversationId,
    'send_message',
    { now },
  )
  if (!access.member) throw new AppError('NOT_FOUND', 'Conversation not found')
  const active = await tx
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(eq(agentRuns.userId, principal.userId), inArray(agentRuns.status, ['queued', 'running'])),
    )
  const pending = await tx
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.userId, principal.userId),
        inArray(agentRuns.status, ['queued', 'running', 'awaiting_approval']),
      ),
    )
  let refusal: string | null = active.length >= 2 || pending.length >= 20 ? 'QUOTA_EXCEEDED' : null
  if (options.trigger === 'mention') {
    const recent = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.conversationId, source.conversationId),
          eq(agentRuns.trigger, 'mention'),
          sql`${agentRuns.createdAt} > ${new Date(now.getTime() - 60_000)}`,
        ),
      )
    if (recent.length >= 6) refusal = 'RATE_LIMITED'
  }
  if (refusal && !options.allowRefusal)
    throw new AppError('QUOTA_EXCEEDED', 'There are too many active requests')
  const [user] = await tx.select().from(users).where(eq(users.id, principal.userId))
  if (!user) throw new AppError('UNAUTHENTICATED', 'Session is no longer valid')
  const id = deps.newId()
  const delegationId = deps.newId()
  // A shared @mention is a public reply: its own segment, the person's default source, standard privacy. A private
  // request belongs to the conversation's current segment (or the one a regeneration must reuse).
  let segment: AgentSegment
  if (options.trigger === 'mention') {
    const keySource = await defaultKeySource(tx, principal.userId)
    segment = {
      contextEpoch: options.epoch ?? deps.newId(),
      stateVersion: 0,
      historyFromSeq: 0,
      readScope: 'current_conversation',
      keySource,
      keyRevision: keySource === 'user' ? await activeKeyRevision(tx, principal.userId) : null,
      privacyClass: 'standard',
    }
    if (keySource === 'user' && segment.keyRevision === null)
      segment = { ...segment, keySource: 'site' }
  } else
    segment = await switchContext(tx, deps, source.conversationId, options.scope, principal.userId)
  if (options.epoch && options.epoch !== segment.contextEpoch) throw contextChanged()
  const epoch = segment.contextEpoch
  const people =
    options.trigger === 'mention'
      ? await tx
          .select({ seq: conversationMembers.visibleFromSeq })
          .from(conversationMembers)
          .where(eq(conversationMembers.conversationId, source.conversationId))
      : []
  const boundary = Math.max(0, ...people.map((p) => p.seq))
  const manifest: AgentSource[] = [
    {
      type: 'conversation',
      id: source.conversationId,
      membershipId: access.member.membershipId,
      membershipVersion: access.conversation.membershipVersion,
      visibleFromSeq: access.member.visibleFromSeq,
    },
    {
      type: 'message',
      id: source.id,
      conversationId: source.conversationId,
      contentVersion: source.contentVersion,
      privacyClass: source.privacyClass,
    },
  ]
  if (
    source.seq <= boundary ||
    (source.privacyClass !== 'standard' && segment.privacyClass !== 'byok_private')
  )
    refusal = 'CONTEXT_CHANGED'
  if (options.contextId && options.contextId !== source.conversationId) {
    const context = await requireAccess(
      tx,
      { userId: principal.userId, siteRole: user.role },
      options.contextId,
      'read_messages',
      { now },
    )
    if (!context.member) throw new AppError('NOT_FOUND', 'Conversation not found')
    manifest.push({
      type: 'conversation',
      id: options.contextId,
      membershipId: context.member.membershipId,
      membershipVersion: context.conversation.membershipVersion,
      visibleFromSeq: context.member.visibleFromSeq,
    })
  }
  const files = await tx.select().from(attachments).where(eq(attachments.messageId, source.id))
  for (const file of files) {
    if (
      file.status !== 'ready' ||
      (file.privacyClass !== 'standard' && segment.privacyClass !== 'byok_private')
    )
      throw contextChanged()
    manifest.push({
      type: 'attachment',
      id: file.id,
      conversationId: source.conversationId,
      version: file.version,
      generation: file.generation,
      privacyClass: file.privacyClass,
    })
  }
  await tx.insert(executionDelegations).values({
    id: delegationId,
    userId: principal.userId,
    originId: principal.originId,
    authEpoch: principal.authEpoch,
    restoreEpoch: principal.restoreEpoch,
    purpose: 'agent_run',
    targetType: 'agent_run',
    targetId: id,
    argsHash: fingerprint({
      conversationId: source.conversationId,
      sourceId: source.id,
      scope: options.scope,
      epoch,
    }),
    // Runs are authorized for 25 hours, so a request approved at the end of its 24-hour window can still finish;
    // approval never extends it (D-079, docs/01 section 7).
    expiresAt: new Date(now.getTime() + RUN_DELEGATION_MS),
    createdAt: now,
  })
  const policy = aiPolicy(deps)
  const own = segment.keySource === 'user'
  const [run] = await tx
    .insert(agentRuns)
    .values({
      id,
      userId: principal.userId,
      delegationId,
      trigger: options.trigger,
      conversationId: source.conversationId,
      contextConversationId: options.contextId,
      sourceMessageId: source.id,
      readScope: options.scope,
      keySource: segment.keySource,
      keyRevision: segment.keyRevision,
      privacyClass: segment.privacyClass,
      mode: options.mode,
      provider: own ? policy.byok.provider : policy.provider,
      model: own ? policy.byok.models[options.mode] : policy.models[options.mode],
      timezone: user.timezone,
      contextEpoch: epoch,
      contextManifest: manifest,
      outputMembershipVersion: access.conversation.membershipVersion,
      sharedVisibleFromSeq: boundary,
      createdAt: now,
      ...(refusal
        ? {
            status: 'failed' as const,
            errorCode: refusal,
            errorMessage: 'The request could not be started',
            finishedAt: now,
          }
        : {}),
    })
    .returning()
  if (!run) throw new Error('run was not created')
  await tx.insert(agentRunStates).values({ runId: id, contextEpoch: epoch, updatedAt: now })
  // The request of a private own-key segment is private too, and so are the files it carries (D-080).
  await tx
    .update(messages)
    .set({
      contextEpoch: epoch,
      ...(segment.privacyClass === 'byok_private' ? { privacyClass: 'byok_private' as const } : {}),
    })
    .where(eq(messages.id, source.id))
  if (segment.privacyClass === 'byok_private')
    await tx
      .update(attachments)
      .set({ privacyClass: 'byok_private', version: sql`${attachments.version} + 1` })
      .where(eq(attachments.messageId, source.id))
  if (!refusal)
    await enqueueWork(tx, deps, {
      kind: 'agent',
      dedupeKey: `agent:${id}:0`,
      entityId: id,
      entityVersion: 0,
    })
  await notifyAgentRun(tx, deps, run)
  return run
}

export async function notifyAgentRun(
  tx: Tx,
  deps: Pick<Deps, 'clock'>,
  run: AgentRunRow,
): Promise<void> {
  await enqueueWork(tx, deps, {
    kind: 'realtime',
    dedupeKey: `ar:${run.id}:${run.stateVersion}`,
    entityId: run.userId,
    entityVersion: run.stateVersion,
    payload: { event: 'agent.run.updated', runId: run.id },
  })
}

export async function createAgentRun(
  deps: Deps,
  principal: SessionPrincipal,
  input: AgentRunRequest,
  idempotencyKey: string,
): Promise<AgentRun> {
  assertIdempotencyKey(idempotencyKey)
  if (input.newConversation && (input.conversationId || input.trigger === 'agent_chat'))
    throw new AppError(
      'VALIDATION_FAILED',
      'A new panel session cannot name an existing conversation',
    )
  return await inTransaction(deps.db, async (tx) => {
    const user = await lockAndRevalidate(tx, deps, principal)
    if (input.timezone !== user.timezone)
      throw new AppError(
        'VALIDATION_FAILED',
        'Save your timezone preference before starting a request',
      )
    if (input.trigger === 'agent_chat' && (input.scope || input.contextConversationId))
      throw new AppError(
        'VALIDATION_FAILED',
        'An assistant conversation uses its own reading scope',
      )
    const claim = await claimIdempotency(
      tx,
      deps,
      {
        actorKey: principal.userId,
        operation: 'agent.create',
        targetKey: 'self',
        key: idempotencyKey,
      },
      fingerprint(input),
    )
    if (claim.status === 'replay')
      return (await ownedAgentRun(tx, deps, principal, claim.resourceId ?? '')).run
    const contextId = input.trigger === 'agent_chat' ? null : (input.contextConversationId ?? null)
    if (input.trigger !== 'agent_chat' && !contextId)
      throw new AppError('VALIDATION_FAILED', 'A panel needs a conversation')
    let conversationId = input.conversationId
    if (contextId)
      await requireAccess(
        tx,
        { userId: user.id, siteRole: user.role },
        contextId,
        'read_messages',
        { now: deps.clock.now(), lock: true },
      )
    if (!conversationId && contextId && !input.newConversation)
      conversationId = (
        await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(
              eq(conversations.ownerId, user.id),
              eq(conversations.panelForConversationId, contextId),
            ),
          )
          .orderBy(sql`${conversations.lastMessageAt} desc nulls last`, desc(conversations.id))
          .limit(1)
      )[0]?.id
    conversationId ??= await makeAgentConversation(
      tx,
      deps,
      user.id,
      input.prompt,
      contextId,
      (await defaultKeySource(tx, user.id)) === 'user',
    )
    const access = await requireAccess(
      tx,
      { userId: user.id, siteRole: user.role },
      conversationId,
      'send_message',
      { now: deps.clock.now(), lock: true },
    )
    if (
      access.conversation.kind !== 'agent' ||
      access.conversation.ownerId !== user.id ||
      access.conversation.panelForConversationId !== contextId
    )
      throw new AppError('NOT_FOUND', 'Conversation not found')
    const scope =
      input.trigger === 'agent_chat' || input.scope === 'all'
        ? 'all_accessible'
        : 'current_conversation'
    const segment = await switchContext(tx, deps, conversationId, scope, user.id)
    const epoch = segment.contextEpoch
    const allocated = await allocateMessageSeq(tx, deps, conversationId)
    const [source] = await tx
      .insert(messages)
      .values({
        id: deps.newId(),
        conversationId,
        ...allocated,
        senderId: user.id,
        kind: 'user',
        body: input.prompt,
        executionSource: 'interactive',
        contextEpoch: epoch,
        createdAt: deps.clock.now(),
      })
      .returning()
    if (!source) throw new Error('source was not created')
    for (const fileId of new Set(input.attachmentIds)) {
      const [file] = await tx
        .select()
        .from(attachments)
        .where(eq(attachments.id, fileId))
        .for('update')
      if (
        !file ||
        file.uploaderId !== user.id ||
        file.messageId ||
        file.status !== 'ready' ||
        file.kind !== 'image' ||
        file.purpose !== 'message' ||
        file.privacyClass !== 'standard' ||
        (file.conversationId && file.conversationId !== conversationId)
      )
        throw new AppError('VALIDATION_FAILED', 'Attachment unavailable')
      await tx
        .update(attachments)
        .set({ messageId: source.id, conversationId, version: sql`${attachments.version} + 1` })
        .where(eq(attachments.id, fileId))
    }
    await recordMessageChange(tx, deps, {
      conversationId,
      messageId: source.id,
      changeSeq: source.changeSeq,
      kind: 'message_created',
    })
    await tx
      .update(conversationMembers)
      .set({ lastReadSeq: source.seq })
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, user.id),
        ),
      )
    if (!access.member) throw new AppError('NOT_FOUND', 'Conversation not found')
    await recordViewerChange(tx, deps, {
      userId: user.id,
      conversationId,
      membershipId: access.member.membershipId,
      state: 'active',
    })
    const run = await enqueueRunForSource(tx, deps, principal, source, {
      trigger: input.trigger,
      mode: input.mode,
      scope,
      contextId,
      epoch,
    })
    await completeIdempotency(tx, claim.id, { type: 'agent_run', id: run.id })
    return agentRunDto(run)
  })
}

export async function ownedAgentRun(
  tx: import('@chatapp/db').DbOrTx,
  deps: Deps,
  principal: SessionPrincipal,
  id: string,
): Promise<AgentRunDetail> {
  const [run] = id
    ? await tx
        .select()
        .from(agentRuns)
        .where(and(eq(agentRuns.id, id), eq(agentRuns.userId, principal.userId)))
    : []
  if (!run?.conversationId) throw new AppError('NOT_FOUND', 'Run not found')
  await requireAccess(
    tx,
    { userId: principal.userId, siteRole: principal.role },
    run.conversationId,
    'read_messages',
    { now: deps.clock.now() },
  )
  const steps = await tx
    .select()
    .from(agentSteps)
    .where(eq(agentSteps.runId, id))
    .orderBy(asc(agentSteps.index))
  let readable = run.contentPurgedAt === null
  if (readable)
    try {
      await validateAgentSources(tx, deps, run)
    } catch (error) {
      if (error instanceof AppError) readable = false
      else throw error
    }
  const decisions = await runDecisions(
    tx,
    deps,
    readable ? run : { ...run, contentPurgedAt: deps.clock.now() },
  )
  return {
    run: agentRunDto(run),
    ...decisions,
    steps: steps.map((step) => ({
      index: step.index,
      type: step.type,
      toolName: step.toolName,
      status: step.status,
      payload: readable ? step.payload : null,
      createdAt: step.createdAt.toISOString(),
    })),
  }
}
export async function getAgentRun(
  deps: Deps,
  principal: SessionPrincipal,
  id: string,
): Promise<AgentRunDetail> {
  return await deps.db.transaction(async (tx) => {
    await lockAndRevalidate(tx, deps, principal)
    return await ownedAgentRun(tx, deps, principal, id)
  })
}

async function finishOutput(
  tx: Tx,
  deps: Deps,
  run: AgentRunRow,
  status: 'sent' | 'failed',
): Promise<void> {
  if (!run.conversationId || !run.outputMessageId) return
  const [message] = await tx.select().from(messages).where(eq(messages.id, run.outputMessageId))
  if (!message || message.meta.agent?.runId !== run.id || message.recalledAt || message.deletedAt)
    return
  const changeSeq = await allocateChangeSeq(tx, deps, run.conversationId)
  await tx
    .update(messages)
    .set({
      status,
      body: message.body === null ? null : assistantText(message.body),
      changeSeq,
      contentVersion: sql`${messages.contentVersion} + 1`,
      streamRevision: sql`${messages.streamRevision} + 1`,
    })
    .where(eq(messages.id, message.id))
  await recordMessageChange(tx, deps, {
    conversationId: run.conversationId,
    messageId: message.id,
    changeSeq,
    kind: 'message_edited',
  })
}

export async function cancelAgentRun(
  deps: Deps,
  principal: SessionPrincipal,
  id: string,
): Promise<AgentRun> {
  return await inTransaction(deps.db, async (tx) => {
    await lockAndRevalidate(tx, deps, principal)
    await ownedAgentRun(tx, deps, principal, id)
    const [peek] = await tx.select().from(agentRuns).where(eq(agentRuns.id, id))
    if (!peek) throw staleLease()
    await lockSourceConversations(tx, peek)
    const [run] = await tx.select().from(agentRuns).where(eq(agentRuns.id, id)).for('update')
    if (!run) throw staleLease()
    if (terminalRun(run)) return agentRunDto(run)
    const [updated] = await tx
      .update(agentRuns)
      .set({
        status: 'cancelled',
        cancelRequestedAt: deps.clock.now(),
        finishedAt: deps.clock.now(),
        leaseEpoch: sql`${agentRuns.leaseEpoch} + 1`,
        leaseUntil: null,
        pendingApproval: false,
        stateVersion: sql`${agentRuns.stateVersion} + 1`,
      })
      .where(eq(agentRuns.id, id))
      .returning()
    await finishOutput(tx, deps, run, 'failed')
    await closePendingApprovals(tx, deps, [run.id], 'cancelled')
    if (!updated) throw staleLease()
    await notifyAgentRun(tx, deps, updated)
    return agentRunDto(updated)
  })
}

export async function claimAgentRun(
  deps: Deps,
  id: string,
): Promise<{ run: AgentRunRow; lease: AgentLease } | null> {
  const [peek] = await deps.db.select().from(agentRuns).where(eq(agentRuns.id, id))
  if (!peek || terminalRun(peek)) return null
  return await inTransaction(deps.db, async (tx) => {
    await lockDelegation(tx, deps, peek)
    await lockSourceConversations(tx, peek)
    const [run] = await tx.select().from(agentRuns).where(eq(agentRuns.id, id)).for('update')
    if (run?.status !== 'queued') return null
    await validateAgentSources(tx, deps, run)
    const now = deps.clock.now()
    const [updated] = await tx
      .update(agentRuns)
      .set({
        status: 'running',
        leaseEpoch: sql`${agentRuns.leaseEpoch} + 1`,
        leaseUntil: new Date(now.getTime() + 30_000),
        heartbeatAt: now,
        startedAt: run.startedAt ?? now,
        stateVersion: sql`${agentRuns.stateVersion} + 1`,
      })
      .where(and(eq(agentRuns.id, id), eq(agentRuns.status, 'queued')))
      .returning()
    if (!updated) return null
    await notifyAgentRun(tx, deps, updated)
    return { run: updated, lease: { id, epoch: updated.leaseEpoch } }
  })
}

export async function heartbeatAgentRun(deps: Deps, lease: AgentLease): Promise<void> {
  await withAgentLease(deps, lease, async (tx, run) => {
    const now = deps.clock.now()
    const elapsed =
      run.elapsedActiveMs +
      Math.max(0, now.getTime() - (run.heartbeatAt?.getTime() ?? now.getTime()))
    if (elapsed >= AI_LIMITS[run.mode].durationMs)
      throw new AppError('QUOTA_EXCEEDED', 'The request time limit was reached')
    await tx
      .update(agentRuns)
      .set({
        leaseUntil: new Date(now.getTime() + 30_000),
        heartbeatAt: now,
        elapsedActiveMs: elapsed,
      })
      .where(eq(agentRuns.id, run.id))
  })
}

export async function ensureAgentOutput(deps: Deps, lease: AgentLease): Promise<string> {
  return await withAgentLease(deps, lease, async (tx, run) => {
    const [existing] = await tx
      .select()
      .from(agentRunOutputs)
      .where(and(eq(agentRunOutputs.runId, run.id), eq(agentRunOutputs.resumeSeq, run.resumeSeq)))
    if (existing?.messageId) return existing.messageId
    if (!run.conversationId) throw contextChanged()
    const [bot] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.username, deps.config.product.agentUsername), eq(users.isBot, true)))
    if (!bot) throw new AppError('CAPACITY_UNAVAILABLE', 'The assistant account is unavailable')
    const id = deps.newId()
    const counters = await allocateMessageSeq(tx, deps, run.conversationId)
    await tx.insert(messages).values({
      id,
      conversationId: run.conversationId,
      ...counters,
      senderId: bot.id,
      kind: 'agent',
      status: 'streaming',
      body: '',
      executionSource: 'system',
      privacyClass: run.privacyClass,
      contextEpoch: run.contextEpoch,
      meta: {
        agent: {
          runId: run.id,
          mode: run.mode,
          keySource: run.keySource,
          resumeSeq: run.resumeSeq,
          streamIndex: 0,
          contextEpoch: run.contextEpoch,
        },
      },
      createdAt: deps.clock.now(),
    })
    await tx.insert(agentRunOutputs).values({
      runId: run.id,
      resumeSeq: run.resumeSeq,
      messageId: id,
      createdAt: deps.clock.now(),
    })
    await tx.update(agentRuns).set({ outputMessageId: id }).where(eq(agentRuns.id, run.id))
    await recordMessageChange(tx, deps, {
      conversationId: run.conversationId,
      messageId: id,
      changeSeq: counters.changeSeq,
      kind: 'message_created',
    })
    return id
  })
}

export async function persistAgentText(
  deps: Deps,
  lease: AgentLease,
  body: string,
  index: number,
  truncated = false,
): Promise<{ messageId: string; revision: number; run: AgentRunRow }> {
  return await withAgentLease(deps, lease, async (tx, run) => {
    if (!run.outputMessageId) throw staleLease()
    const [row] = await tx.select().from(messages).where(eq(messages.id, run.outputMessageId))
    if (
      !row ||
      row.meta.agent?.runId !== run.id ||
      (row.meta.agent.streamIndex ?? 0) >= index ||
      row.deletedAt ||
      row.recalledAt
    )
      throw staleLease()
    const [written] = await tx
      .update(messages)
      .set({
        body: truncateCodePoints(body, 20_000),
        streamRevision: sql`${messages.streamRevision} + 1`,
        meta: { ...row.meta, agent: { ...row.meta.agent, streamIndex: index, truncated } },
      })
      .where(eq(messages.id, row.id))
      .returning({ revision: messages.streamRevision })
    if (!written) throw staleLease()
    return { messageId: row.id, revision: written.revision, run }
  })
}

export async function completeAgentRun(deps: Deps, lease: AgentLease): Promise<void> {
  await withAgentLease(deps, lease, async (tx, run) => {
    await finishOutput(tx, deps, run, 'sent')
    const [updated] = await tx
      .update(agentRuns)
      .set({
        status: 'completed',
        finishedAt: deps.clock.now(),
        leaseUntil: null,
        stateVersion: sql`${agentRuns.stateVersion} + 1`,
      })
      .where(eq(agentRuns.id, run.id))
      .returning()
    await tx
      .update(executionDelegations)
      .set({ status: 'completed' })
      .where(eq(executionDelegations.id, run.delegationId))
    if (updated) await notifyAgentRun(tx, deps, updated)
  })
}

/** Terminal failure must remain possible after a permission loss; it cannot append model content. */
export async function failAgentRun(
  deps: Deps,
  id: string,
  code: string,
  epoch?: number,
): Promise<void> {
  const [peek] = await deps.db.select().from(agentRuns).where(eq(agentRuns.id, id))
  if (!peek) return
  await inTransaction(deps.db, async (tx) => {
    await lockUsers(tx, [peek.userId])
    await lockSourceConversations(tx, peek)
    const [run] = await tx.select().from(agentRuns).where(eq(agentRuns.id, id)).for('update')
    if (!run || terminalRun(run) || (epoch !== undefined && run.leaseEpoch !== epoch)) return
    const [updated] = await tx
      .update(agentRuns)
      .set({
        status: 'failed',
        errorCode: code,
        errorMessage: 'The request could not be completed',
        finishedAt: deps.clock.now(),
        leaseUntil: null,
        pendingApproval: false,
        leaseEpoch: sql`${agentRuns.leaseEpoch} + 1`,
        stateVersion: sql`${agentRuns.stateVersion} + 1`,
      })
      .where(eq(agentRuns.id, id))
      .returning()
    await finishOutput(tx, deps, run, 'failed')
    await closePendingApprovals(tx, deps, [run.id], 'failed')
    if (code === 'CONTEXT_CHANGED' || code === 'UNAUTHENTICATED')
      await tx
        .update(agentRunStates)
        .set({ messages: [], updatedAt: deps.clock.now() })
        .where(eq(agentRunStates.runId, id))
    if (updated) await notifyAgentRun(tx, deps, updated)
  })
}

export async function regenerateAgentRun(
  deps: Deps,
  principal: SessionPrincipal,
  id: string,
  idempotencyKey: string,
): Promise<AgentRun> {
  assertIdempotencyKey(idempotencyKey)
  return await inTransaction(deps.db, async (tx) => {
    await lockAndRevalidate(tx, deps, principal)
    await ownedAgentRun(tx, deps, principal, id)
    const [peek] = await tx.select().from(agentRuns).where(eq(agentRuns.id, id))
    if (!peek) throw new AppError('NOT_FOUND', 'Run not found')
    await lockSourceConversations(tx, peek)
    const [run] = await tx.select().from(agentRuns).where(eq(agentRuns.id, id)).for('update')
    if (!run?.conversationId || !run.sourceMessageId || !run.outputMessageId)
      throw new AppError('CONFLICT', 'There is no reply to replace')
    const claim = await claimIdempotency(
      tx,
      deps,
      {
        actorKey: principal.userId,
        operation: 'agent.regenerate',
        targetKey: id,
        key: idempotencyKey,
      },
      fingerprint({ id }),
    )
    if (claim.status === 'replay')
      return (await ownedAgentRun(tx, deps, principal, claim.resourceId ?? '')).run
    if (!terminalRun(run) || run.hasEffects || run.pendingApproval)
      throw new AppError('CONFLICT', 'This run cannot be regenerated')
    await validateAgentSources(tx, deps, run)
    const [output] = await tx.select().from(messages).where(eq(messages.id, run.outputMessageId))
    const [source] = await tx.select().from(messages).where(eq(messages.id, run.sourceMessageId))
    if (
      !output ||
      !source ||
      output.recalledAt ||
      output.deletedAt ||
      output.meta.agent?.runId !== id
    )
      throw new AppError('CONFLICT', 'This reply was already replaced')
    const [conversation] = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.id, run.conversationId))
    if (conversation?.kind === 'agent') {
      const [latest] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.conversationId, run.conversationId), eq(messages.kind, 'agent')))
        .orderBy(desc(messages.seq))
        .limit(1)
      if (latest?.id !== output.id)
        throw new AppError('CONFLICT', 'Only the latest reply can be regenerated')
    } else if (deps.clock.now().getTime() - output.createdAt.getTime() > 24 * 3_600_000)
      throw new AppError('WINDOW_EXPIRED', 'The reply is too old to regenerate')
    const next = await enqueueRunForSource(tx, deps, principal, source, {
      trigger: run.trigger,
      mode: run.mode,
      scope: run.readScope,
      contextId: run.contextConversationId,
      epoch: run.contextEpoch,
    })
    // Regenerating can never switch the key: a different source or revision needs a new request (docs/06 3.1).
    if (next.keySource !== run.keySource || next.keyRevision !== run.keyRevision)
      throw new AppError('CONTEXT_CHANGED', 'The key changed; start a new request')
    const changeSeq = await allocateChangeSeq(tx, deps, run.conversationId)
    await tx
      .update(messages)
      .set({
        body: '',
        status: 'streaming',
        changeSeq,
        contentVersion: sql`${messages.contentVersion} + 1`,
        streamRevision: sql`${messages.streamRevision} + 1`,
        meta: {
          agent: {
            runId: next.id,
            mode: next.mode,
            keySource: next.keySource,
            resumeSeq: 0,
            streamIndex: 0,
            contextEpoch: next.contextEpoch,
          },
        },
      })
      .where(eq(messages.id, output.id))
    const [bound] = await tx
      .update(agentRuns)
      .set({
        regeneratedFromRunId: run.id,
        outputMessageId: output.id,
        contextManifest: run.contextManifest,
      })
      .where(eq(agentRuns.id, next.id))
      .returning()
    await tx
      .insert(agentRunOutputs)
      .values({ runId: next.id, resumeSeq: 0, messageId: output.id, createdAt: deps.clock.now() })
    await recordMessageChange(tx, deps, {
      conversationId: run.conversationId,
      messageId: output.id,
      changeSeq,
      kind: 'message_edited',
    })
    await completeIdempotency(tx, claim.id, { type: 'agent_run', id: next.id })
    if (!bound) throw new Error('regeneration was not bound')
    return agentRunDto(bound)
  })
}

export async function deleteAgentConversation(
  deps: Deps,
  principal: SessionPrincipal,
  id: string,
): Promise<void> {
  await inTransaction(deps.db, async (tx) => {
    await lockAndRevalidate(tx, deps, principal)
    const access = await requireAccess(
      tx,
      { userId: principal.userId, siteRole: principal.role },
      id,
      'read_messages',
      { lock: true, now: deps.clock.now() },
    )
    if (access.conversation.kind !== 'agent' || access.conversation.ownerId !== principal.userId)
      throw new AppError('FORBIDDEN', 'Only your assistant conversations can be deleted')
    await invalidateConversationRuns(tx, deps, id)
    const runs = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.conversationId, id))
    const ids = runs.map((r) => r.id)
    if (ids.length) {
      await tx
        .update(agentRunStates)
        .set({ messages: [], updatedAt: deps.clock.now() })
        .where(inArray(agentRunStates.runId, ids))
      await tx.update(agentSteps).set({ payload: null }).where(inArray(agentSteps.runId, ids))
      await tx
        .update(agentApprovals)
        .set({ args: null, editedArgs: null, finalArgs: null })
        .where(inArray(agentApprovals.runId, ids))
      await tx
        .update(agentRuns)
        .set({
          contextManifest: [],
          contentPurgedAt: deps.clock.now(),
          sourceMessageId: null,
          outputMessageId: null,
        })
        .where(inArray(agentRuns.id, ids))
    }
    const doomed = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.conversationId, id))
    if (doomed.length)
      await tx
        .update(agentRunOutputs)
        .set({ messageId: null })
        .where(
          inArray(
            agentRunOutputs.messageId,
            doomed.map((m) => m.id),
          ),
        )
    const files = await tx
      .select({ id: attachments.id })
      .from(attachments)
      .where(eq(attachments.conversationId, id))
    if (files.length) {
      await lockStorage(tx)
      for (const file of files) await retireAttachment(tx, deps, file.id)
      await tx
        .update(attachments)
        .set({ conversationId: null })
        .where(eq(attachments.conversationId, id))
    }
    if (!access.member) throw new AppError('NOT_FOUND', 'Conversation not found')
    await recordViewerChange(tx, deps, {
      userId: principal.userId,
      conversationId: id,
      membershipId: access.member.membershipId,
      state: 'removed',
      membershipChanged: true,
    })
    await tx.delete(conversations).where(eq(conversations.id, id))
  })
}

export async function purgeAgentContent(deps: Deps): Promise<number> {
  const expired = await deps.db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        isNull(agentRuns.contentPurgedAt),
        lt(agentRuns.createdAt, new Date(deps.clock.now().getTime() - 30 * 86_400_000)),
      ),
    )
    .limit(500)
  for (const run of expired) {
    await failAgentRun(deps, run.id, 'CONTENT_EXPIRED')
    await deps.db.transaction(async (tx) => {
      await tx
        .update(agentRunStates)
        .set({ messages: [], updatedAt: deps.clock.now() })
        .where(eq(agentRunStates.runId, run.id))
      await tx.update(agentSteps).set({ payload: null }).where(eq(agentSteps.runId, run.id))
      // Approval arguments are run content too; the effect ledger keeps only ids, hashes and codes (docs/04 section 10).
      await tx
        .update(agentApprovals)
        .set({ args: null, editedArgs: null, finalArgs: null })
        .where(eq(agentApprovals.runId, run.id))
      await tx
        .update(agentRuns)
        .set({ contextManifest: [], contentPurgedAt: deps.clock.now() })
        .where(eq(agentRuns.id, run.id))
    })
  }
  return expired.length
}

/** Recover only confirmed calls. A started/unknown attempt prevents automatic re-issue after a crash. */
export async function recoverAgentRuns(deps: Deps): Promise<number> {
  const now = deps.clock.now()
  const expired = await deps.db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.status, 'running'), lt(agentRuns.leaseUntil, now)))
    .limit(200)
  const { resolveAttempt } = await import('./agent-budget.ts')
  for (const candidate of expired) {
    await inTransaction(deps.db, async (tx) => {
      await lockUsers(tx, [candidate.userId])
      await lockSourceConversations(tx, candidate)
      const [run] = await tx
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, candidate.id))
        .for('update')
      if (run?.status !== 'running' || !run.leaseUntil || run.leaseUntil >= now) return
      const attempts = await tx
        .select()
        .from(aiCallAttempts)
        .where(eq(aiCallAttempts.runId, run.id))
      const uncertain = attempts.some((a) => a.status === 'started' || a.status === 'unknown')
      const elapsed =
        run.elapsedActiveMs +
        Math.max(0, now.getTime() - (run.heartbeatAt?.getTime() ?? now.getTime()))
      const [lastModel] = await tx
        .select({ payload: agentSteps.payload })
        .from(agentSteps)
        .where(and(eq(agentSteps.runId, run.id), eq(agentSteps.type, 'model')))
        .orderBy(desc(agentSteps.index))
        .limit(1)
      const payload = lastModel?.payload as { finishReason?: unknown; text?: unknown } | null
      const savedFinal =
        payload?.finishReason === 'stop' &&
        typeof payload.text === 'string' &&
        Boolean(payload.text.trim())
      const exhausted =
        run.resumeSeq >= 15 ||
        (!savedFinal &&
          (elapsed >= AI_LIMITS[run.mode].durationMs || run.stepCount >= AI_LIMITS[run.mode].steps))
      await finishOutput(tx, deps, run, 'failed')
      const [updated] = await tx
        .update(agentRuns)
        .set({
          status: uncertain || exhausted ? 'failed' : 'queued',
          errorCode: uncertain ? 'UNKNOWN_EXECUTION' : exhausted ? 'QUOTA_EXCEEDED' : null,
          errorMessage: uncertain
            ? 'The interrupted request has an unconfirmed usage result'
            : exhausted
              ? 'The run limit was reached'
              : null,
          finishedAt: uncertain || exhausted ? now : null,
          elapsedActiveMs: elapsed,
          leaseEpoch: sql`${agentRuns.leaseEpoch} + 1`,
          leaseUntil: null,
          resumeSeq: run.resumeSeq + 1,
          stateVersion: run.stateVersion + 1,
          outputMessageId: uncertain || exhausted ? run.outputMessageId : null,
        })
        .where(eq(agentRuns.id, run.id))
        .returning()
      if (!updated) return
      if (updated.status === 'queued') {
        await tx
          .update(agentRunStates)
          .set({ resumeSeq: updated.resumeSeq, stateVersion: updated.stateVersion, updatedAt: now })
          .where(eq(agentRunStates.runId, run.id))
        await enqueueWork(tx, deps, {
          kind: 'agent',
          dedupeKey: `agent:${run.id}:${updated.resumeSeq}`,
          entityId: run.id,
          entityVersion: updated.resumeSeq,
        })
      }
      await notifyAgentRun(tx, deps, updated)
    })
  }
  const terminal = await deps.db
    .select()
    .from(agentRuns)
    .where(
      and(
        inArray(agentRuns.status, ['completed', 'failed', 'cancelled']),
        sql`(exists (select 1 from ai_call_attempts a where a.run_id = ${agentRuns.id} and a.status in ('reserved','started')) or exists (select 1 from messages m where m.id = ${agentRuns.outputMessageId} and m.status = 'streaming' and m.meta -> 'agent' ->> 'runId' = ${agentRuns.id}::text))`,
      ),
    )
    .limit(200)
  for (const run of [...expired, ...terminal]) {
    const [current] = await deps.db.select().from(agentRuns).where(eq(agentRuns.id, run.id))
    if (!current || current.status === 'running') continue
    const attempts = await deps.db
      .select()
      .from(aiCallAttempts)
      .where(
        and(
          eq(aiCallAttempts.runId, run.id),
          inArray(aiCallAttempts.status, ['reserved', 'started']),
        ),
      )
    for (const attempt of attempts)
      await resolveAttempt(deps, attempt.id, run.id, {
        status: attempt.status === 'reserved' ? 'released' : 'unknown',
      })
    if (terminalRun(current))
      await inTransaction(deps.db, async (tx) => {
        await lockUsers(tx, [current.userId])
        await lockSourceConversations(tx, current)
        const [fresh] = await tx
          .select()
          .from(agentRuns)
          .where(eq(agentRuns.id, current.id))
          .for('update')
        if (!fresh || !terminalRun(fresh)) return
        const [output] = fresh.outputMessageId
          ? await tx.select().from(messages).where(eq(messages.id, fresh.outputMessageId))
          : []
        if (output?.status === 'streaming') {
          await finishOutput(tx, deps, fresh, fresh.status === 'completed' ? 'sent' : 'failed')
          await notifyAgentRun(tx, deps, fresh)
        }
        if (fresh.errorCode === 'UNAUTHENTICATED' || fresh.errorCode === 'CONTEXT_CHANGED')
          await tx
            .update(agentRunStates)
            .set({ messages: [], updatedAt: now })
            .where(eq(agentRunStates.runId, fresh.id))
      })
  }
  // A lost original work item is repaired from Postgres, independently of BullMQ retention.
  const queued = await deps.db
    .select({ id: agentRuns.id, resumeSeq: agentRuns.resumeSeq })
    .from(agentRuns)
    .where(eq(agentRuns.status, 'queued'))
    .limit(200)
  for (const run of queued)
    await enqueueWork(deps.db, deps, {
      kind: 'agent',
      dedupeKey: `agent:${run.id}:${run.resumeSeq}`,
      entityId: run.id,
      entityVersion: run.resumeSeq,
    })
  return expired.length
}
