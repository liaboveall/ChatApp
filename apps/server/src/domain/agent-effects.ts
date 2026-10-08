/**
 * What the assistant may do besides reading (M5a; docs/06 sections 4.2 and 5.2, D-037, INV-10, A4, A13, A14).
 *
 * `prepareEffect` answers, for one tool call, what it would do: checked against the run's reading scope and the
 * caller's current rights, with times read in the run's zone without guessing. It decides whether the person must
 * approve and freezes the exact arguments that would run. `executeEffect` runs one approved effect exactly once: the
 * business write, the `agent_effects` row and `has_effects` commit together under the run lease and the full lock
 * order; a retry finds the row and returns the same result. A refusal at that moment (the person was silenced, the
 * group archived) is recorded as the call's result instead, so a later retry cannot make it happen after all.
 */
import {
  type AgentEffectToolName,
  AppError,
  agentEffectToolSchemas,
  type ScheduleTime,
} from '@chatapp/contracts'
import {
  agentApprovals,
  agentEffects,
  agentMemories,
  agentRuns,
  conversationMembers,
  type DbOrTx,
  messages,
  reminders,
  scheduledMessages,
  type Tx,
  users,
} from '@chatapp/db'
import { and, eq, inArray } from 'drizzle-orm'
import type { z } from 'zod'
import { fingerprint, uuidV5 } from '../lib/crypto.ts'
import { readLocalTime } from '../lib/local-time.ts'
import { type AgentLease, type AgentRunRow, staleLease, withAgentLease } from './agent-access.ts'
import { appendAgentStep } from './agent-tools.ts'
import { enforce, loadAccess } from './authorize.ts'
import { insertConversation } from './conversations.ts'
import type { Deps } from './deps.ts'
import { addPeople } from './members.ts'
import {
  deleteMemoryRow,
  insertMemory,
  memorySourceConversations,
  rememberNeedsApproval,
} from './memories.ts'
import { directPeerOf, normalizeBody, visibleTo, writeMessage } from './messages.ts'
import type { DelegatedPrincipal } from './principal.ts'
import { accountAllowsSession } from './sessions.ts'
import {
  cancelTaskRow,
  createReminderTask,
  createScheduledMessageTask,
  futureTaskCount,
  TASK_LIMITS,
  taskTimeProblem,
} from './tasks.ts'

type Args<T extends AgentEffectToolName> = z.infer<(typeof agentEffectToolSchemas)[T]>

/** The arguments an effect runs with once approved: ids instead of names, UTC instants beside the local reading. */
export type EffectFinal =
  | { tool: 'send_message'; conversationId: string; body: string; replyToId: string | null }
  | {
      tool: 'schedule_message'
      conversationId: string
      body: string
      at: string
      localDateTime: string
      timezone: string
      offsetMinutes: number
    }
  | { tool: 'create_group'; name: string; memberIds: string[]; memberUsernames: string[] }
  | { tool: 'invite_members'; conversationId: string; userIds: string[]; usernames: string[] }
  | {
      tool: 'create_reminder'
      text: string
      at: string
      localDateTime: string
      timezone: string
      offsetMinutes: number
      conversationId: string | null
    }
  | { tool: 'cancel_reminder'; id: string }
  | { tool: 'cancel_scheduled_message'; id: string }
  | { tool: 'remember'; content: string }
  | { tool: 'forget'; memoryId: string }

export type PreparedEffect =
  | { kind: 'ready'; final: EffectFinal; required: boolean }
  /** A repeated local time: only the person may pick one of the two instants (docs/06 section 4.2). */
  | { kind: 'choose'; time: ScheduleTime }
  | { kind: 'invalid'; code: string }

export type EffectActor = { userId: string; role: 'user' | 'admin' }

/** The hash an approval freezes; execution recomputes it from the stored arguments and refuses on any difference. */
export const effectHash = (final: EffectFinal): string => fingerprint({ v: 1, final })

/** Tools whose effect reaches other people always need the caller's own decision (docs/06 principle 4, A4). */
const ALWAYS_REQUIRED = new Set<AgentEffectToolName>([
  'send_message',
  'schedule_message',
  'create_group',
  'invite_members',
])

const invalid = (code: string): PreparedEffect => ({ kind: 'invalid', code })

/**
 * Where the run may act: a run limited to the current conversation acts only there (A2), a full-scope run wherever the
 * person may. Never into an assistant conversation.
 */
async function targetProblem(
  db: DbOrTx,
  deps: Pick<Deps, 'clock'>,
  run: AgentRunRow,
  actor: EffectActor,
  conversationId: string,
  action: 'send_message' | 'add_members' | 'read_messages',
): Promise<string | null> {
  if (run.readScope === 'current_conversation' && conversationId !== run.contextConversationId)
    return 'OUT_OF_SCOPE'
  try {
    const access = await loadAccess(db, actor.userId, conversationId)
    enforce(access, { userId: actor.userId, siteRole: actor.role }, action, deps.clock.now())
    if (!access.member) return 'NOT_FOUND'
    if (access.conversation.kind === 'agent') return 'NOT_ALLOWED_TARGET'
    return null
  } catch (error) {
    if (error instanceof AppError) return error.code
    throw error
  }
}

type TimeReading =
  | { kind: 'ok'; time: ScheduleTime; at: Date; offsetMinutes: number }
  | { kind: 'choose'; time: ScheduleTime }
  | { kind: 'invalid'; code: string }

/**
 * Reads a wall-clock time in the run's zone. The model's offset may only confirm an exact reading; a repeated time
 * always waits for the person's choice (`chosenOffset`), even if the model named an offset (docs/06 section 4.2).
 */
export function readScheduleTime(
  input: { localDateTime: string; timezone: string; offsetMinutes?: number },
  runTimezone: string,
  /** null only reads (approval cards); a date also refuses past and too distant times. */
  now: Date | null,
  chosenOffset?: number,
): TimeReading {
  if (input.timezone !== runTimezone) return { kind: 'invalid', code: 'TIMEZONE_MISMATCH' }
  const reading = readLocalTime(input.localDateTime, input.timezone)
  if (reading.kind === 'invalid') return { kind: 'invalid', code: 'INVALID_TIME' }
  if (reading.kind === 'nonexistent') return { kind: 'invalid', code: 'TIME_DOES_NOT_EXIST' }
  const candidates = reading.kind === 'exact' ? [reading.candidate] : reading.candidates
  const listed = candidates.map((c) => ({
    at: c.instant.toISOString(),
    offsetMinutes: c.offsetMinutes,
  }))
  let chosen = reading.kind === 'exact' ? reading.candidate : undefined
  if (reading.kind === 'exact') {
    for (const offset of [input.offsetMinutes, chosenOffset])
      if (offset !== undefined && offset !== reading.candidate.offsetMinutes)
        return { kind: 'invalid', code: 'OFFSET_MISMATCH' }
  } else if (chosenOffset !== undefined) {
    chosen = candidates.find((c) => c.offsetMinutes === chosenOffset)
    if (!chosen) return { kind: 'invalid', code: 'OFFSET_MISMATCH' }
  }
  const base = { localDateTime: input.localDateTime, timezone: input.timezone, candidates: listed }
  if (!chosen) return { kind: 'choose', time: { ...base, chosen: null } }
  const problem = now ? taskTimeProblem(chosen.instant, now) : null
  if (problem) return { kind: 'invalid', code: problem }
  return {
    kind: 'ok',
    at: chosen.instant,
    offsetMinutes: chosen.offsetMinutes,
    time: {
      ...base,
      chosen: { at: chosen.instant.toISOString(), offsetMinutes: chosen.offsetMinutes },
    },
  }
}

/** Active, human accounts by username, in the order asked; the rest are reported as unavailable. */
export async function resolveUsernames(
  db: DbOrTx,
  deps: Pick<Deps, 'clock'>,
  usernames: readonly string[],
  excludeId: string,
): Promise<{ ids: string[]; unavailable: string[] }> {
  const wanted = [...new Set(usernames)]
  const rows = wanted.length
    ? await db.select().from(users).where(inArray(users.username, wanted))
    : []
  const now = deps.clock.now()
  const ids: string[] = []
  const unavailable: string[] = []
  for (const name of wanted) {
    const row = rows.find((r) => r.username === name)
    if (row && row.id !== excludeId && accountAllowsSession(row, now)) ids.push(row.id)
    else unavailable.push(name)
  }
  return { ids, unavailable }
}

/**
 * What one tool call would do now. `decided`: the person's own decision is being validated (their chosen offset may
 * settle a repeated time); otherwise these are the model's arguments.
 */
export async function prepareEffect(
  db: DbOrTx,
  deps: Pick<Deps, 'clock'>,
  run: AgentRunRow,
  actor: EffectActor,
  tool: string,
  raw: unknown,
  options: { decided?: boolean } = {},
): Promise<PreparedEffect> {
  if (!Object.hasOwn(agentEffectToolSchemas, tool)) return invalid('UNSUPPORTED_TOOL')
  const name = tool as AgentEffectToolName
  const parsed = agentEffectToolSchemas[name].safeParse(raw)
  if (!parsed.success) return invalid('INVALID_ARGUMENTS')
  const now = deps.clock.now()
  const required = ALWAYS_REQUIRED.has(name)
  switch (name) {
    case 'send_message': {
      const a = parsed.data as Args<'send_message'>
      const problem = await targetProblem(db, deps, run, actor, a.conversationId, 'send_message')
      if (problem) return invalid(problem)
      if (a.replyToId) {
        const [member] = await db
          .select({ visibleFromSeq: conversationMembers.visibleFromSeq })
          .from(conversationMembers)
          .where(
            and(
              eq(conversationMembers.conversationId, a.conversationId),
              eq(conversationMembers.userId, actor.userId),
            ),
          )
        const [target] = member
          ? await db
              .select()
              .from(messages)
              .where(
                and(
                  eq(messages.id, a.replyToId),
                  visibleTo(
                    db,
                    { userId: actor.userId, visibleFromSeq: member.visibleFromSeq },
                    a.conversationId,
                  ),
                ),
              )
          : []
        if (!target || target.kind === 'system' || target.recalledAt || target.deletedAt)
          return invalid('REPLY_UNAVAILABLE')
      }
      return {
        kind: 'ready',
        required,
        final: {
          tool: name,
          conversationId: a.conversationId,
          body: normalizeBody(a.body),
          replyToId: a.replyToId ?? null,
        },
      }
    }
    case 'schedule_message': {
      const a = parsed.data as Args<'schedule_message'>
      const problem = await targetProblem(db, deps, run, actor, a.conversationId, 'send_message')
      if (problem) return invalid(problem)
      const time = readScheduleTime(
        a,
        run.timezone,
        now,
        options.decided ? a.offsetMinutes : undefined,
      )
      if (time.kind === 'invalid') return invalid(time.code)
      if (time.kind === 'choose') return { kind: 'choose', time: time.time }
      if ((await futureTaskCount(db, actor.userId)) >= TASK_LIMITS.maxFuturePerUser)
        return invalid('TASK_LIMIT')
      return {
        kind: 'ready',
        required,
        final: {
          tool: name,
          conversationId: a.conversationId,
          body: normalizeBody(a.body),
          at: time.at.toISOString(),
          localDateTime: a.localDateTime,
          timezone: a.timezone,
          offsetMinutes: time.offsetMinutes,
        },
      }
    }
    case 'create_group': {
      const a = parsed.data as Args<'create_group'>
      const people = await resolveUsernames(db, deps, a.memberUsernames, actor.userId)
      return {
        kind: 'ready',
        required,
        final: {
          tool: name,
          name: a.name,
          memberIds: people.ids,
          memberUsernames: a.memberUsernames,
        },
      }
    }
    case 'invite_members': {
      const a = parsed.data as Args<'invite_members'>
      const problem = await targetProblem(db, deps, run, actor, a.conversationId, 'add_members')
      if (problem) return invalid(problem)
      const people = await resolveUsernames(db, deps, a.usernames, actor.userId)
      if (people.ids.length === 0) return invalid('USERS_NOT_FOUND')
      return {
        kind: 'ready',
        required,
        final: {
          tool: name,
          conversationId: a.conversationId,
          userIds: people.ids,
          usernames: a.usernames,
        },
      }
    }
    case 'create_reminder': {
      const a = parsed.data as Args<'create_reminder'>
      if (a.conversationId) {
        const problem = await targetProblem(db, deps, run, actor, a.conversationId, 'read_messages')
        if (problem) return invalid(problem)
      }
      const time = readScheduleTime(
        a,
        run.timezone,
        now,
        options.decided ? a.offsetMinutes : undefined,
      )
      if (time.kind === 'invalid') return invalid(time.code)
      // An ordinary reminder only affects the person and runs at once; a repeated time needs their choice first.
      if (time.kind === 'choose') return { kind: 'choose', time: time.time }
      if ((await futureTaskCount(db, actor.userId)) >= TASK_LIMITS.maxFuturePerUser)
        return invalid('TASK_LIMIT')
      return {
        kind: 'ready',
        required: false,
        final: {
          tool: name,
          text: a.text,
          at: time.at.toISOString(),
          localDateTime: a.localDateTime,
          timezone: a.timezone,
          offsetMinutes: time.offsetMinutes,
          conversationId: a.conversationId ?? null,
        },
      }
    }
    case 'cancel_reminder':
    case 'cancel_scheduled_message': {
      const a = parsed.data as Args<'cancel_reminder'>
      const table = name === 'cancel_reminder' ? reminders : scheduledMessages
      const [row] = await db.select({ userId: table.userId }).from(table).where(eq(table.id, a.id))
      if (!row || row.userId !== actor.userId) return invalid('NOT_FOUND')
      return { kind: 'ready', required: false, final: { tool: name, id: a.id } }
    }
    case 'remember': {
      if (run.readScope !== 'all_accessible') return invalid('OUT_OF_SCOPE')
      const a = parsed.data as Args<'remember'>
      return {
        kind: 'ready',
        required: await rememberNeedsApproval(db, run),
        final: { tool: name, content: a.content },
      }
    }
    case 'forget': {
      if (run.readScope !== 'all_accessible') return invalid('OUT_OF_SCOPE')
      const a = parsed.data as Args<'forget'>
      const [memory] = await db
        .select({ userId: agentMemories.userId, privacyClass: agentMemories.privacyClass })
        .from(agentMemories)
        .where(eq(agentMemories.id, a.memoryId))
      if (
        !memory ||
        memory.userId !== actor.userId ||
        (run.privacyClass === 'standard' && memory.privacyClass !== 'standard')
      )
        return invalid('NOT_FOUND')
      return { kind: 'ready', required: false, final: { tool: name, memoryId: a.memoryId } }
    }
  }
}

type StoredResult = Record<string, string | number | boolean | null | string[]>

/** What the model is told: the stored ids and codes, plus the content the person approved (which is theirs). */
export function modelResult(final: EffectFinal, stored: Record<string, unknown>): unknown {
  if (stored.status === 'failed') return stored
  switch (final.tool) {
    case 'send_message':
      return { ...stored, sentBody: final.body }
    case 'schedule_message':
      return { ...stored, body: final.body, localDateTime: final.localDateTime }
    case 'create_reminder':
      return { ...stored, text: final.text, localDateTime: final.localDateTime }
    case 'create_group':
      return { ...stored, name: final.name }
    default:
      return stored
  }
}

/** Rows the effect changes beyond the run's own: destination conversations and the people it adds or writes to. */
async function effectLocks(
  deps: Pick<Deps, 'db'>,
  userId: string,
  final: EffectFinal,
): Promise<{ conversations: string[]; users: string[] }> {
  switch (final.tool) {
    case 'send_message': {
      const peer = await directPeerOf(deps.db, userId, final.conversationId)
      return { conversations: [final.conversationId], users: peer ? [peer] : [] }
    }
    case 'schedule_message':
      return { conversations: [final.conversationId], users: [] }
    case 'create_group':
      return { conversations: [], users: final.memberIds }
    case 'invite_members':
      return { conversations: [final.conversationId], users: final.userIds }
    default:
      return { conversations: [], users: [] }
  }
}

async function applyEffect(
  tx: Tx,
  deps: Deps,
  run: AgentRunRow,
  principal: DelegatedPrincipal,
  final: EffectFinal,
  stepIndex: number,
  argsHash: string,
): Promise<{ entityType: string | null; entityId: string | null; result: StoredResult }> {
  const actor = { userId: principal.userId, role: principal.role }
  switch (final.tool) {
    case 'send_message': {
      const written = await writeMessage(
        tx,
        deps,
        actor,
        final.conversationId,
        {
          // Deterministic per effect step: even a retry that bypassed the ledger would land on the same message.
          clientId: uuidV5(`${run.id}:${stepIndex}`),
          body: final.body,
          replyToId: final.replyToId,
        },
        { executionSource: 'agent_effect', meta: { viaAgent: { runId: run.id } } },
      )
      return {
        entityType: 'message',
        entityId: written.row.id,
        result: {
          status: 'sent',
          messageId: written.row.id,
          conversationId: final.conversationId,
        },
      }
    }
    case 'schedule_message': {
      const row = await createScheduledMessageTask(tx, deps, principal, {
        conversationId: final.conversationId,
        body: final.body,
        at: new Date(final.at),
        localDateTime: final.localDateTime,
        timezone: final.timezone,
        offsetMinutes: final.offsetMinutes,
        runId: run.id,
        argsHash,
      })
      return {
        entityType: 'scheduled_message',
        entityId: row.id,
        result: { status: 'scheduled', scheduledMessageId: row.id, at: final.at },
      }
    }
    case 'create_group': {
      const created = await insertConversation(
        tx,
        deps,
        principal.userId,
        { kind: 'group', name: final.name, description: null, memberIds: final.memberIds },
        { skipUnavailable: true },
      )
      return {
        entityType: 'conversation',
        entityId: created.id,
        result: {
          status: 'created',
          conversationId: created.id,
          added: created.added,
          skipped: created.skipped.map((s) => s.userId),
        },
      }
    }
    case 'invite_members': {
      const added = await addPeople(tx, deps, actor, final.conversationId, final.userIds, {
        // A private run is not cancelled by the change it made itself; a shared one is, so the new members never
        // receive a continuation derived from what came before them (D-197).
        exceptRunId: run.trigger === 'mention' ? undefined : run.id,
      })
      if (run.trigger !== 'mention') {
        const manifest = run.contextManifest.map((source) =>
          source.type === 'conversation' && source.id === final.conversationId
            ? { ...source, membershipVersion: added.membershipVersion }
            : source,
        )
        await tx
          .update(agentRuns)
          .set({ contextManifest: manifest })
          .where(eq(agentRuns.id, run.id))
      }
      return {
        entityType: 'conversation',
        entityId: final.conversationId,
        result: {
          status: 'invited',
          conversationId: final.conversationId,
          added: added.added.map((u) => u.id),
          skipped: added.skipped.map((s) => s.userId),
        },
      }
    }
    case 'create_reminder': {
      const row = await createReminderTask(tx, deps, principal, {
        text: final.text,
        conversationId: final.conversationId,
        privacyClass: run.privacyClass,
        at: new Date(final.at),
        localDateTime: final.localDateTime,
        timezone: final.timezone,
        offsetMinutes: final.offsetMinutes,
        runId: run.id,
        argsHash,
      })
      return {
        entityType: 'reminder',
        entityId: row.id,
        result: { status: 'scheduled', reminderId: row.id, at: final.at },
      }
    }
    case 'cancel_reminder':
    case 'cancel_scheduled_message': {
      const kind = final.tool === 'cancel_reminder' ? 'reminder' : 'scheduled_message'
      const row = await cancelTaskRow(tx, deps, principal.userId, kind, final.id)
      return {
        entityType: kind,
        entityId: row.id,
        result: {
          status: row.status === 'cancelled' ? 'cancelled' : `already_${row.status}`,
          id: row.id,
        },
      }
    }
    case 'remember': {
      const memory = await insertMemory(tx, deps, {
        userId: run.userId,
        content: final.content,
        run,
      })
      return {
        entityType: 'memory',
        entityId: memory.id,
        result: { status: 'remembered', memoryId: memory.id },
      }
    }
    case 'forget': {
      await deleteMemoryRow(tx, deps, run.userId, final.memoryId, run.id)
      return {
        entityType: 'memory',
        entityId: final.memoryId,
        result: { status: 'forgotten', memoryId: final.memoryId },
      }
    }
  }
}

/**
 * Runs the effect of one approved call exactly once (INV-10). Locks: the caller and everyone the effect writes to,
 * the origin and delegation, every source and destination conversation, the run, then the approval row. Returns what
 * the model is told.
 */
export async function executeEffect(
  deps: Deps,
  lease: AgentLease,
  approvalId: string,
): Promise<unknown> {
  const [peek] = await deps.db
    .select()
    .from(agentApprovals)
    .where(eq(agentApprovals.id, approvalId))
  if (!peek?.finalArgs) throw staleLease()
  const final = peek.finalArgs as EffectFinal
  const locks = await effectLocks(deps, peek.userId, final)
  // The step and the decision are durable here and the effect has not happened (the first crash point of docs/08).
  await deps.faultPoint?.('effect.before')
  const result = await withAgentLease(
    deps,
    lease,
    async (tx, run, principal) => {
      const [done] = await tx
        .select()
        .from(agentEffects)
        .where(and(eq(agentEffects.runId, run.id), eq(agentEffects.stepIndex, peek.stepIndex)))
      if (done) return modelResult(final, done.result)
      const [approval] = await tx
        .select()
        .from(agentApprovals)
        .where(eq(agentApprovals.id, approvalId))
        .for('update')
      if (
        !approval ||
        approval.runId !== run.id ||
        approval.status !== 'approved' ||
        !approval.finalArgs ||
        approval.argsHash !== effectHash(approval.finalArgs as EffectFinal)
      )
        throw staleLease()
      let outcome: Awaited<ReturnType<typeof applyEffect>>
      let failed = false
      try {
        // A savepoint, so a refusal rolls back the attempted write while the refusal itself is still recorded.
        outcome = await tx.transaction((inner) =>
          applyEffect(
            inner,
            deps,
            run,
            principal,
            final,
            approval.stepIndex,
            approval.argsHash ?? '',
          ),
        )
      } catch (error) {
        if (!(error instanceof AppError)) throw error
        failed = true
        outcome = {
          entityType: null,
          entityId: null,
          result: { status: 'failed', error: error.code },
        }
      }
      await tx.insert(agentEffects).values({
        runId: run.id,
        stepIndex: approval.stepIndex,
        toolName: approval.toolName,
        argsHash: approval.argsHash ?? '',
        entityType: outcome.entityType,
        entityId: outcome.entityId,
        result: outcome.result,
        createdAt: deps.clock.now(),
      })
      if (!failed)
        await tx.update(agentRuns).set({ hasEffects: true }).where(eq(agentRuns.id, run.id))
      await appendAgentStep(
        tx,
        deps,
        run,
        'tool_result',
        outcome.result,
        approval.toolName,
        failed ? 'failed' : 'done',
      )
      return modelResult(final, outcome.result)
    },
    locks.conversations,
    locks.users,
    final.tool === 'forget'
      ? (tx, run) => memorySourceConversations(tx, run.userId, final.memoryId)
      : undefined,
  )
  // The effect committed and nothing has been reported yet (the second crash point).
  await deps.faultPoint?.('effect.after')
  return result
}
