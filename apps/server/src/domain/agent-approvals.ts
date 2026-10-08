/**
 * The approval boundary of the assistant (M5a; docs/06 sections 5.1-5.2, docs/04 agent_approvals, D-061, A4, V-02).
 *
 * Every effect tool call ends the model step as an SDK approval request. The runtime registers each request here: the
 * server decides whether the caller must approve it (anything that reaches other people, and reminders at a repeated
 * local time), whether it is automatic (their own reminders and cancellations) or invalid (out of scope, no rights,
 * a time that does not exist). A pending request pauses the run in the same transaction that finishes the current
 * reply segment; the caller's decision, the queued run, the next resume segment and its work intent commit together.
 * When every request is decided the runtime answers them itself: approved effects run once through the effect ledger
 * and their real results go back to the model with the decision (the SDK never executes an effect).
 */
import {
  type AgentApproval,
  type AgentApprovalDecision,
  AppError,
  type ApprovalPreview,
  agentEffectToolSchemas,
  assistantText,
  type ScheduleTime,
  truncateCodePoints,
} from '@chatapp/contracts'
import {
  agentApprovals,
  agentEffects,
  agentRunStates,
  agentRuns,
  agentSteps,
  type DbOrTx,
  executionDelegations,
  messages,
} from '@chatapp/db'
import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm'
import {
  type AgentLease,
  type AgentRunRow,
  closePendingApprovals,
  lockDelegation,
  lockSourceConversations,
  staleLease,
  terminalRun,
  withAgentLease,
} from './agent-access.ts'
import {
  type EffectFinal,
  effectHash,
  executeEffect,
  prepareEffect,
  readScheduleTime,
  resolveUsernames,
} from './agent-effects.ts'
import { agentRunDto, notifyAgentRun } from './agent-runs.ts'
import { appendAgentStep } from './agent-tools.ts'
import { allocateChangeSeq, recordMessageChange } from './changes.ts'
import { conversationRefFor } from './conversation-refs.ts'
import type { Deps } from './deps.ts'
import type { SessionPrincipal } from './principal.ts'
import { lockAndRevalidate, lockUsers } from './sessions.ts'
import { inTransaction } from './tx.ts'
import { loadUserSummaries } from './users.ts'
import { enqueueWork } from './work.ts'

export const APPROVAL_TTL_MS = 24 * 3_600_000

export type ApprovalRequest = {
  approvalId: string
  toolCallId: string
  toolName: string
  input: unknown
}
type ApprovalRow = typeof agentApprovals.$inferSelect

function parts(message: unknown): { type?: unknown; [key: string]: unknown }[] {
  if (!message || typeof message !== 'object' || !('content' in message)) return []
  const content = (message as { content: unknown }).content
  return Array.isArray(content) ? (content as { type?: unknown; [key: string]: unknown }[]) : []
}

/**
 * Requests of the last assistant message that no later tool message answers: what a resumed or recovered run must
 * settle before the model may continue. Pure, so recovery from any persisted history is testable.
 */
export function unansweredRequests(history: readonly unknown[]): ApprovalRequest[] {
  let last = -1
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i] as { role?: unknown } | null
    if (message?.role === 'assistant') {
      last = i
      break
    }
  }
  if (last < 0) return []
  const assistant = parts(history[last])
  const answered = new Set<string>()
  for (const message of history.slice(last + 1))
    for (const part of parts(message))
      if (part.type === 'tool-approval-response' && typeof part.approvalId === 'string')
        answered.add(part.approvalId)
  const requests: ApprovalRequest[] = []
  for (const part of assistant) {
    if (part.type !== 'tool-approval-request') continue
    const approvalId = part.approvalId
    const toolCallId = part.toolCallId
    if (typeof approvalId !== 'string' || typeof toolCallId !== 'string') continue
    if (answered.has(approvalId)) continue
    const call = assistant.find((p) => p.type === 'tool-call' && p.toolCallId === toolCallId)
    if (!call || typeof call.toolName !== 'string') continue
    requests.push({ approvalId, toolCallId, toolName: call.toolName, input: call.input })
  }
  return requests
}

/** The card's view, rebuilt with the caller's current access on every read (docs/02 section 6). */
async function previewOf(
  db: DbOrTx,
  deps: Pick<Deps, 'clock'>,
  approval: ApprovalRow,
  timezone: string,
): Promise<ApprovalPreview | null> {
  const now = deps.clock.now()
  const ref = (id: string | null | undefined) =>
    conversationRefFor(db, approval.userId, id ?? null, now)
  const final = approval.finalArgs as EffectFinal | null
  const raw = approval.editedArgs ?? approval.args
  const tool = approval.toolName
  if (!(tool in agentEffectToolSchemas)) return null
  const parsed = agentEffectToolSchemas[tool as keyof typeof agentEffectToolSchemas].safeParse(raw)
  const time = (input: {
    localDateTime: string
    timezone: string
    offsetMinutes?: number
  }): ScheduleTime => {
    if (final && 'at' in final)
      return {
        localDateTime: final.localDateTime,
        timezone: final.timezone,
        candidates: [{ at: final.at, offsetMinutes: final.offsetMinutes }],
        chosen: { at: final.at, offsetMinutes: final.offsetMinutes },
      }
    const reading = readScheduleTime(input, timezone, null)
    return reading.kind === 'invalid'
      ? {
          localDateTime: input.localDateTime,
          timezone: input.timezone,
          candidates: [],
          chosen: null,
        }
      : reading.time
  }
  if (!parsed.success) return null
  const args = parsed.data as Record<string, unknown>
  switch (tool) {
    case 'send_message':
      return {
        tool,
        conversation: await ref(args.conversationId as string),
        body: final?.tool === tool ? final.body : (args.body as string),
      }
    case 'schedule_message':
      return {
        tool,
        conversation: await ref(args.conversationId as string),
        body: final?.tool === tool ? final.body : (args.body as string),
        time: time(args as { localDateTime: string; timezone: string; offsetMinutes?: number }),
      }
    case 'create_group':
    case 'invite_members': {
      const usernames = (
        tool === 'create_group' ? args.memberUsernames : args.usernames
      ) as string[]
      const resolved = await resolveUsernames(db, deps, usernames, approval.userId)
      const ids =
        final && 'memberIds' in final
          ? final.memberIds
          : final && 'userIds' in final
            ? final.userIds
            : resolved.ids
      const summaries = await loadUserSummaries(db, ids)
      const members = ids.flatMap((id) => {
        const summary = summaries.get(id)
        return summary ? [summary] : []
      })
      return tool === 'create_group'
        ? { tool, name: args.name as string, members, unavailable: resolved.unavailable }
        : {
            tool,
            conversation: await ref(args.conversationId as string),
            members,
            unavailable: resolved.unavailable,
          }
    }
    case 'create_reminder':
      return {
        tool,
        text: args.text as string,
        time: time(args as { localDateTime: string; timezone: string; offsetMinutes?: number }),
        conversation: await ref(args.conversationId as string | undefined),
      }
    case 'cancel_reminder':
    case 'cancel_scheduled_message':
      return { tool, targetId: args.id as string }
    case 'remember':
      return {
        tool,
        content: args.content as string,
        privacyClass:
          (
            await db
              .select({ privacyClass: agentRuns.privacyClass })
              .from(agentRuns)
              .where(eq(agentRuns.id, approval.runId))
          )[0]?.privacyClass ?? 'byok_private',
      }
    case 'forget':
      return { tool, targetId: args.memoryId as string }
    default:
      return null
  }
}

export async function approvalDto(
  db: DbOrTx,
  deps: Pick<Deps, 'clock'>,
  approval: ApprovalRow,
  run: Pick<AgentRunRow, 'timezone' | 'contentPurgedAt'>,
): Promise<AgentApproval> {
  return {
    id: approval.id,
    runId: approval.runId,
    toolName: approval.toolName,
    status: approval.status,
    reason: approval.reason,
    required: approval.required,
    preview: run.contentPurgedAt ? null : await previewOf(db, deps, approval, run.timezone),
    edited: approval.editedArgs !== null,
    stateVersion: approval.stateVersion,
    resumeSeq: approval.resumeSeq,
    stepIndex: approval.stepIndex,
    expiresAt: approval.expiresAt.toISOString(),
    decidedAt: approval.decidedAt?.toISOString() ?? null,
    createdAt: approval.createdAt.toISOString(),
  }
}

/** The approvals and effects of one run for its owner's detail view. */
export async function runDecisions(
  db: DbOrTx,
  deps: Pick<Deps, 'clock'>,
  run: AgentRunRow,
): Promise<{ approvals: AgentApproval[]; effects: import('@chatapp/contracts').AgentEffect[] }> {
  const rows = await db
    .select()
    .from(agentApprovals)
    .where(eq(agentApprovals.runId, run.id))
    .orderBy(asc(agentApprovals.stepIndex))
  const effects = await db
    .select()
    .from(agentEffects)
    .where(eq(agentEffects.runId, run.id))
    .orderBy(asc(agentEffects.stepIndex))
  const approvals: AgentApproval[] = []
  for (const row of rows) approvals.push(await approvalDto(db, deps, row, run))
  return {
    approvals,
    effects: effects.map((e) => ({
      stepIndex: e.stepIndex,
      toolName: e.toolName,
      entityType: e.entityType,
      entityId: e.entityId,
      result: e.result,
      createdAt: e.createdAt.toISOString(),
    })),
  }
}

/**
 * Registers the run's open requests and pauses it when one waits for the caller. In one transaction: the approval
 * steps and rows, the reply segment finished with "waiting for approval", the run moved to `awaiting_approval` with a
 * new lease epoch (the current worker can commit nothing more), and the hint. Already registered requests are kept,
 * so a recovered run registers nothing twice.
 */
export async function registerApprovalRequests(
  deps: Deps,
  lease: AgentLease,
  requests: readonly ApprovalRequest[],
  segmentText: string,
): Promise<{ waiting: boolean }> {
  return await withAgentLease(deps, lease, async (tx, run, principal) => {
    const now = deps.clock.now()
    const [delegation] = await tx
      .select({ expiresAt: executionDelegations.expiresAt })
      .from(executionDelegations)
      .where(eq(executionDelegations.id, run.delegationId))
    const expiresAt = new Date(
      Math.min(
        now.getTime() + APPROVAL_TTL_MS,
        delegation?.expiresAt.getTime() ?? now.getTime() + APPROVAL_TTL_MS,
      ),
    )
    for (const request of requests) {
      const [known] = await tx
        .select({ id: agentApprovals.id })
        .from(agentApprovals)
        .where(
          and(eq(agentApprovals.runId, run.id), eq(agentApprovals.toolCallId, request.toolCallId)),
        )
      if (known) continue
      const prepared = await prepareEffect(
        tx,
        deps,
        run,
        { userId: run.userId, role: principal.role },
        request.toolName,
        request.input,
      )
      const pending = prepared.kind === 'choose' || (prepared.kind === 'ready' && prepared.required)
      const step = await appendAgentStep(
        tx,
        deps,
        run,
        'approval',
        { toolCallId: request.toolCallId, arguments: request.input },
        request.toolName,
        pending ? 'pending' : prepared.kind === 'invalid' ? 'failed' : 'done',
      )
      const decision: Pick<
        typeof agentApprovals.$inferInsert,
        'status' | 'reason' | 'decidedAt' | 'finalArgs' | 'argsHash'
      > = pending
        ? { status: 'pending' }
        : prepared.kind === 'invalid'
          ? { status: 'rejected', reason: `invalid:${prepared.code}`, decidedAt: now }
          : {
              status: 'approved',
              finalArgs: prepared.final,
              argsHash: effectHash(prepared.final),
              decidedAt: now,
            }
      await tx.insert(agentApprovals).values({
        id: deps.newId(),
        runId: run.id,
        stepId: step.id,
        stepIndex: step.index,
        userId: run.userId,
        toolCallId: request.toolCallId,
        approvalId: request.approvalId,
        toolName: request.toolName,
        args: (request.input ?? null) as unknown,
        required: pending,
        stateVersion: run.stateVersion,
        resumeSeq: run.resumeSeq,
        expiresAt,
        createdAt: now,
        ...decision,
      })
    }
    const [open] = await tx
      .select({ id: agentApprovals.id })
      .from(agentApprovals)
      .where(and(eq(agentApprovals.runId, run.id), eq(agentApprovals.status, 'pending')))
      .limit(1)
    if (!open) return { waiting: false }
    await finishWaitingSegment(tx, deps, run, segmentText)
    const elapsed =
      run.elapsedActiveMs +
      Math.max(0, now.getTime() - (run.heartbeatAt?.getTime() ?? now.getTime()))
    const [paused] = await tx
      .update(agentRuns)
      .set({
        status: 'awaiting_approval',
        pendingApproval: true,
        leaseUntil: null,
        heartbeatAt: null,
        elapsedActiveMs: elapsed,
        leaseEpoch: sql`${agentRuns.leaseEpoch} + 1`,
        stateVersion: sql`${agentRuns.stateVersion} + 1`,
      })
      .where(eq(agentRuns.id, run.id))
      .returning()
    if (paused) await notifyAgentRun(tx, deps, paused)
    return { waiting: true }
  })
}

/** The current reply segment ends where the run pauses; the next segment after the decision is a new reply (D-051). */
async function finishWaitingSegment(
  tx: import('@chatapp/db').Tx,
  deps: Pick<Deps, 'clock'>,
  run: AgentRunRow,
  text: string,
): Promise<void> {
  if (!run.conversationId || !run.outputMessageId) return
  const [message] = await tx.select().from(messages).where(eq(messages.id, run.outputMessageId))
  if (!message || message.meta.agent?.runId !== run.id || message.recalledAt || message.deletedAt)
    return
  const changeSeq = await allocateChangeSeq(tx, deps, run.conversationId)
  await tx
    .update(messages)
    .set({
      status: 'sent',
      body: truncateCodePoints(assistantText(text), 20_000),
      changeSeq,
      contentVersion: sql`${messages.contentVersion} + 1`,
      streamRevision: sql`${messages.streamRevision} + 1`,
      meta: {
        ...message.meta,
        agent: {
          ...message.meta.agent,
          streamIndex: (message.meta.agent.streamIndex ?? 0) + 1,
          awaitingApproval: { userId: run.userId },
        },
      },
    })
    .where(eq(messages.id, message.id))
  await recordMessageChange(tx, deps, {
    conversationId: run.conversationId,
    messageId: message.id,
    changeSeq,
    kind: 'message_edited',
  })
}

/**
 * Answers decided requests: approved effects run once (each in its own effect transaction), refusals become denials
 * with their reason, and the answering tool message is appended to the persisted history before the model sees it.
 */
export async function answerApprovalRequests(
  deps: Deps,
  lease: AgentLease,
  requests: readonly ApprovalRequest[],
): Promise<{ role: 'tool'; content: unknown[] } | 'waiting'> {
  const rows = await deps.db
    .select()
    .from(agentApprovals)
    .where(
      and(
        eq(agentApprovals.runId, lease.id),
        inArray(
          agentApprovals.toolCallId,
          requests.map((r) => r.toolCallId),
        ),
      ),
    )
  const content: unknown[] = []
  for (const request of requests) {
    const row = rows.find((r) => r.toolCallId === request.toolCallId)
    if (!row) throw staleLease()
    if (row.status === 'pending') return 'waiting'
    if (row.status === 'approved') {
      const output = await executeEffect(deps, lease, row.id)
      content.push(
        { type: 'tool-approval-response', approvalId: request.approvalId, approved: true },
        {
          type: 'tool-result',
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          output: { type: 'json', value: { trust: 'untrusted', ...(output as object) } },
        },
      )
    } else {
      const reason = row.reason ?? row.status
      content.push(
        {
          type: 'tool-approval-response',
          approvalId: request.approvalId,
          approved: false,
          reason,
        },
        {
          type: 'tool-result',
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          output: { type: 'execution-denied', reason },
        },
      )
    }
  }
  const message = { role: 'tool' as const, content }
  await withAgentLease(deps, lease, async (tx, run) => {
    await tx
      .update(agentRunStates)
      .set({
        messages: sql`${agentRunStates.messages} || ${JSON.stringify([message])}::text::jsonb`,
        stateVersion: sql`${agentRunStates.stateVersion} + 1`,
        updatedAt: deps.clock.now(),
      })
      .where(eq(agentRunStates.runId, run.id))
  })
  return message
}

const decisionError = (code: 'CONFLICT' | 'VALIDATION_FAILED', message: string, reason: string) =>
  new AppError(code, message, { details: { reason } })

/**
 * The caller decides one pending request (docs/05: state CAS). An approval validates the arguments again (the person
 * may have changed them; a repeated local time needs their choice), freezes them with their hash, and when it was the
 * last open request moves the run to `queued` with the next resume segment and its work intent in the same transaction.
 */
export async function decideApproval(
  deps: Deps,
  principal: SessionPrincipal,
  id: string,
  input: AgentApprovalDecision,
): Promise<{ approval: AgentApproval; run: import('@chatapp/contracts').AgentRun }> {
  const missing = () => new AppError('NOT_FOUND', 'Approval not found')
  const [peekApproval] = await deps.db
    .select()
    .from(agentApprovals)
    .where(and(eq(agentApprovals.id, id), eq(agentApprovals.userId, principal.userId)))
  if (!peekApproval) throw missing()
  const [peekRun] = await deps.db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, peekApproval.runId))
  if (!peekRun) throw missing()
  const result = await inTransaction(deps.db, async (tx) => {
    const user = await lockAndRevalidate(tx, deps, principal)
    if (!terminalRun(peekRun))
      try {
        await lockDelegation(tx, deps, peekRun)
      } catch (error) {
        // The run's own authority ended (not the caller's session): the request can no longer be decided.
        if (error instanceof AppError && error.code === 'UNAUTHENTICATED')
          throw decisionError(
            'CONFLICT',
            'The request can no longer be decided',
            'authorization_ended',
          )
        throw error
      }
    await lockSourceConversations(tx, peekRun)
    const [run] = await tx
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, peekRun.id))
      .for('update')
    const [approval] = await tx
      .select()
      .from(agentApprovals)
      .where(eq(agentApprovals.id, id))
      .for('update')
    if (!run || !approval || approval.userId !== principal.userId) throw missing()
    const now = deps.clock.now()
    if (approval.status !== 'pending')
      throw decisionError('CONFLICT', 'This request was already decided', approval.status)
    if (approval.stateVersion !== input.expectedStateVersion)
      throw new AppError('VERSION_CONFLICT', 'The request changed; reload it', {
        details: { stateVersion: approval.stateVersion },
      })
    if (run.status !== 'awaiting_approval' || approval.resumeSeq !== run.resumeSeq)
      throw decisionError('CONFLICT', 'The run is no longer waiting', run.status)
    if (approval.expiresAt <= now) {
      await expireRun(tx, deps, run)
      return null
    }
    if (input.decision === 'reject') {
      await tx
        .update(agentApprovals)
        .set({ status: 'rejected', reason: 'rejected', decidedAt: now })
        .where(eq(agentApprovals.id, id))
    } else {
      // A change names only the fields the person edited; the result is validated as a whole by the strict schema.
      const edited =
        input.editedArgs === undefined
          ? null
          : {
              ...(approval.args && typeof approval.args === 'object' ? approval.args : {}),
              ...input.editedArgs,
            }
      const prepared = await prepareEffect(
        tx,
        deps,
        run,
        { userId: user.id, role: user.role },
        approval.toolName,
        edited ?? approval.args,
        { decided: true },
      )
      if (prepared.kind === 'invalid')
        throw decisionError(
          'VALIDATION_FAILED',
          'These arguments cannot be approved',
          prepared.code,
        )
      if (prepared.kind === 'choose')
        throw decisionError(
          'VALIDATION_FAILED',
          'Choose which of the two times you mean',
          'CHOOSE_TIME',
        )
      await tx
        .update(agentApprovals)
        .set({
          status: 'approved',
          editedArgs: edited,
          finalArgs: prepared.final,
          argsHash: effectHash(prepared.final),
          decidedAt: now,
        })
        .where(eq(agentApprovals.id, id))
    }
    await tx
      .update(agentSteps)
      .set({ status: input.decision === 'approve' ? 'done' : 'failed' })
      .where(eq(agentSteps.id, approval.stepId))
    const [open] = await tx
      .select({ id: agentApprovals.id })
      .from(agentApprovals)
      .where(and(eq(agentApprovals.runId, run.id), eq(agentApprovals.status, 'pending')))
      .limit(1)
    const [updated] = await tx
      .update(agentRuns)
      .set(
        open
          ? { stateVersion: sql`${agentRuns.stateVersion} + 1` }
          : {
              status: 'queued',
              pendingApproval: false,
              resumeSeq: run.resumeSeq + 1,
              outputMessageId: null,
              stateVersion: sql`${agentRuns.stateVersion} + 1`,
            },
      )
      .where(eq(agentRuns.id, run.id))
      .returning()
    if (!updated) throw staleLease()
    if (!open) {
      await tx
        .update(agentRunStates)
        .set({ resumeSeq: updated.resumeSeq, updatedAt: now })
        .where(eq(agentRunStates.runId, run.id))
      // A new work id per resume segment: a retained job of an earlier segment cannot block it (D-061).
      await enqueueWork(tx, deps, {
        kind: 'agent',
        dedupeKey: `agent:${run.id}:${updated.resumeSeq}`,
        entityId: run.id,
        entityVersion: updated.resumeSeq,
      })
    }
    await notifyAgentRun(tx, deps, updated)
    const [after] = await tx.select().from(agentApprovals).where(eq(agentApprovals.id, id))
    if (!after) throw missing()
    return { approval: await approvalDto(tx, deps, after, updated), run: agentRunDto(updated) }
  })
  // Expiration must commit before returning the refusal; throwing inside the transaction would undo it.
  if (!result) throw decisionError('CONFLICT', 'The request has expired', 'expired')
  return result
}

/** Ends a waiting run whose decision window closed: pending requests expire, the run is cancelled (docs/06 5.1). */
async function expireRun(
  tx: import('@chatapp/db').Tx,
  deps: Pick<Deps, 'clock'>,
  run: AgentRunRow,
): Promise<void> {
  if (terminalRun(run)) return
  const now = deps.clock.now()
  const [ended] = await tx
    .update(agentRuns)
    .set({
      status: 'cancelled',
      cancelRequestedAt: now,
      finishedAt: now,
      pendingApproval: false,
      leaseUntil: null,
      leaseEpoch: sql`${agentRuns.leaseEpoch} + 1`,
      stateVersion: sql`${agentRuns.stateVersion} + 1`,
      errorCode: 'APPROVAL_EXPIRED',
      errorMessage: 'The approval request expired',
    })
    .where(eq(agentRuns.id, run.id))
    .returning()
  await closePendingApprovals(tx, deps, [run.id], 'expired')
  if (ended) await notifyAgentRun(tx, deps, ended)
}

/** Reconciliation (every minute, from Postgres): requests past their deadline expire and their run is cancelled. */
export async function expireApprovals(deps: Deps): Promise<number> {
  const due = await deps.db
    .select({ runId: agentApprovals.runId, userId: agentApprovals.userId })
    .from(agentApprovals)
    .where(
      and(eq(agentApprovals.status, 'pending'), lte(agentApprovals.expiresAt, deps.clock.now())),
    )
    .limit(200)
  const runs = [...new Map(due.map((d) => [d.runId, d])).values()]
  for (const item of runs) {
    const [peek] = await deps.db.select().from(agentRuns).where(eq(agentRuns.id, item.runId))
    if (!peek) continue
    await inTransaction(deps.db, async (tx) => {
      await lockUsers(tx, [item.userId])
      await lockSourceConversations(tx, peek)
      const [run] = await tx
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, item.runId))
        .for('update')
      if (!run) return
      const [open] = await tx
        .select({ id: agentApprovals.id })
        .from(agentApprovals)
        .where(
          and(
            eq(agentApprovals.runId, run.id),
            eq(agentApprovals.status, 'pending'),
            lte(agentApprovals.expiresAt, deps.clock.now()),
          ),
        )
        .limit(1)
      if (!open) return
      if (terminalRun(run)) await closePendingApprovals(tx, deps, [run.id], 'expired')
      else await expireRun(tx, deps, run)
    })
  }
  return runs.length
}

/** Pending (or other) requests of the caller, newest first, for the approvals list. */
export async function listApprovals(
  deps: Deps,
  principal: SessionPrincipal,
  status: AgentApproval['status'],
): Promise<AgentApproval[]> {
  const rows = await deps.db
    .select({ approval: agentApprovals, run: agentRuns })
    .from(agentApprovals)
    .innerJoin(agentRuns, eq(agentRuns.id, agentApprovals.runId))
    .where(and(eq(agentApprovals.userId, principal.userId), eq(agentApprovals.status, status)))
    .orderBy(desc(agentApprovals.createdAt))
    .limit(100)
  const items: AgentApproval[] = []
  for (const row of rows) items.push(await approvalDto(deps.db, deps, row.approval, row.run))
  return items
}
