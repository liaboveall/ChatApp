import type { AgentSource } from '@chatapp/contracts'
import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  pgSequence,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { jsonbValue } from './json.ts'
import { conversations, executionDelegations, messages, users } from './tables.ts'

const ts = () => timestamp({ withTimezone: true })
const count = () => bigint({ mode: 'number' }).notNull().default(0)
export const agentContexts = pgTable('agent_contexts', {
  conversationId: uuid()
    .primaryKey()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  contextEpoch: uuid().notNull(),
  stateVersion: bigint({ mode: 'number' }).notNull().default(1),
  historyFromSeq: bigint({ mode: 'number' }).notNull().default(0),
  readScope: text().$type<'current_conversation' | 'all_accessible'>().notNull(),
  keySource: text().$type<'site' | 'user'>().notNull().default('site'),
  privacyClass: text().$type<'standard' | 'byok_private'>().notNull().default('standard'),
  keyRevision: bigint({ mode: 'number' }),
  updatedAt: ts().notNull(),
})
export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    delegationId: uuid()
      .notNull()
      .references(() => executionDelegations.id),
    trigger: text().$type<'agent_chat' | 'mention' | 'panel' | 'command'>().notNull(),
    conversationId: uuid().references(() => conversations.id, { onDelete: 'set null' }),
    contextConversationId: uuid().references(() => conversations.id, { onDelete: 'set null' }),
    sourceMessageId: uuid().references(() => messages.id, { onDelete: 'set null' }),
    outputMessageId: uuid().references(() => messages.id, { onDelete: 'set null' }),
    readScope: text().$type<'current_conversation' | 'all_accessible'>().notNull(),
    keySource: text().$type<'site' | 'user'>().notNull().default('site'),
    privacyClass: text().$type<'standard' | 'byok_private'>().notNull().default('standard'),
    keyRevision: bigint({ mode: 'number' }),
    mode: text().$type<'fast' | 'deep'>().notNull(),
    provider: text().notNull(),
    model: text().notNull(),
    actualModel: text(),
    timezone: text().notNull(),
    status: text()
      .$type<'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled'>()
      .notNull()
      .default('queued'),
    regeneratedFromRunId: uuid().references((): AnyPgColumn => agentRuns.id, {
      onDelete: 'set null',
    }),
    stepCount: integer().notNull().default(0),
    inputTokens: count(),
    outputTokens: count(),
    cachedTokens: count(),
    costMicroUsd: count(),
    errorCode: text(),
    errorMessage: text(),
    heartbeatAt: ts(),
    leaseUntil: ts(),
    leaseEpoch: count(),
    resumeSeq: count(),
    cancelRequestedAt: ts(),
    contextEpoch: uuid().notNull(),
    contextManifest: jsonbValue<AgentSource[]>().notNull().default([]),
    outputMembershipVersion: bigint({ mode: 'number' }).notNull(),
    sharedVisibleFromSeq: count(),
    stateVersion: bigint({ mode: 'number' }).notNull().default(1),
    elapsedActiveMs: count(),
    hasEffects: boolean().notNull().default(false),
    pendingApproval: boolean().notNull().default(false),
    contentPurgedAt: ts(),
    createdAt: ts().notNull(),
    startedAt: ts(),
    finishedAt: ts(),
  },
  (t) => [
    index('agent_runs_user_created_idx').on(t.userId, t.createdAt),
    // M5a: the administrators' run list filters by key source (INV-15 decides what a row may reveal).
    index('agent_runs_key_source_created_idx').on(t.keySource, t.createdAt.desc()),
    index('agent_runs_active_idx')
      .on(t.status, t.leaseUntil)
      .where(sql`${t.status} in ('queued', 'running', 'awaiting_approval')`),
    check(
      'agent_runs_status',
      sql`${t.status} in ('queued','running','awaiting_approval','completed','failed','cancelled')`,
    ),
    check(
      'agent_runs_scope',
      sql`${t.readScope} in ('current_conversation','all_accessible') and (${t.trigger} <> 'mention' or ${t.readScope} = 'current_conversation')`,
    ),
    check(
      'agent_runs_counters',
      sql`${t.stepCount} >= 0 and ${t.leaseEpoch} >= 0 and ${t.stateVersion} >= 1 and ${t.inputTokens} >= 0 and ${t.outputTokens} >= 0 and ${t.costMicroUsd} >= 0`,
    ),
  ],
)
export const agentRunStates = pgTable('agent_run_states', {
  runId: uuid()
    .primaryKey()
    .references(() => agentRuns.id, { onDelete: 'cascade' }),
  stateVersion: bigint({ mode: 'number' }).notNull().default(1),
  resumeSeq: count(),
  contextEpoch: uuid().notNull(),
  messages: jsonbValue<unknown[]>().notNull().default([]),
  updatedAt: ts().notNull(),
})
export const agentSteps = pgTable(
  'agent_steps',
  {
    id: uuid().primaryKey(),
    runId: uuid()
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    index: integer().notNull(),
    /** `approval` (M5a) is the stable effect step of one tool call that went through the approval boundary. */
    type: text().$type<'model' | 'tool_call' | 'tool_result' | 'error' | 'approval'>().notNull(),
    toolName: text(),
    status: text().$type<'pending' | 'done' | 'failed'>(),
    payload: jsonbValue<unknown>(),
    inputTokens: count(),
    outputTokens: count(),
    durationMs: count(),
    createdAt: ts().notNull(),
  },
  (t) => [uniqueIndex('agent_steps_run_index_uidx').on(t.runId, t.index)],
)
export const agentRunOutputs = pgTable(
  'agent_run_outputs',
  {
    runId: uuid()
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    resumeSeq: bigint({ mode: 'number' }).notNull(),
    messageId: uuid().references(() => messages.id, { onDelete: 'set null' }),
    createdAt: ts().notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.resumeSeq] })],
)
export const budgetAccounts = pgTable(
  'budget_accounts',
  {
    scope: text().$type<'user_day' | 'site_month'>().notNull(),
    ownerKey: text().notNull(),
    periodStart: text().notNull(),
    limitUnits: bigint({ mode: 'number' }).notNull(),
    reservedUnits: count(),
    settledUnits: count(),
  },
  (t) => [
    primaryKey({ columns: [t.scope, t.ownerKey, t.periodStart] }),
    check(
      'budget_accounts_nonnegative',
      sql`${t.limitUnits} >= 0 and ${t.reservedUnits} >= 0 and ${t.settledUnits} >= 0`,
    ),
  ],
)
export const aiCallAttempts = pgTable(
  'ai_call_attempts',
  {
    id: uuid().primaryKey(),
    runId: uuid()
      .notNull()
      .references(() => agentRuns.id),
    stepIndex: integer().notNull(),
    attemptNo: integer().notNull(),
    keySource: text().$type<'site' | 'user'>().notNull(),
    provider: text().notNull(),
    model: text().notNull(),
    actualModel: text(),
    providerRequestId: text(),
    httpStatus: integer(),
    retryAfterSeconds: integer(),
    status: text().$type<'reserved' | 'started' | 'settled' | 'unknown' | 'released'>().notNull(),
    day: text().notNull(),
    month: text().notNull(),
    priceVersion: text().notNull(),
    inputTokenBound: bigint({ mode: 'number' }).notNull().default(0),
    maxOutputTokens: bigint({ mode: 'number' }).notNull().default(0),
    reservedTokens: bigint({ mode: 'number' }).notNull(),
    reservedCost: bigint({ mode: 'number' }).notNull(),
    actualTokens: bigint({ mode: 'number' }),
    actualCost: bigint({ mode: 'number' }),
    inputTokens: bigint({ mode: 'number' }),
    outputTokens: bigint({ mode: 'number' }),
    cachedTokens: bigint({ mode: 'number' }),
    reasoningTokens: bigint({ mode: 'number' }),
    createdAt: ts().notNull(),
    startedAt: ts(),
    settledAt: ts(),
  },
  (t) => [
    uniqueIndex('ai_attempts_step_uidx').on(t.runId, t.stepIndex, t.attemptNo),
    index('ai_attempts_user_period_idx').on(t.day, t.month),
    check(
      'ai_attempts_status',
      sql`${t.status} in ('reserved','started','settled','unknown','released')`,
    ),
  ],
)
export const aiUsageDaily = pgTable(
  'ai_usage_daily',
  {
    userId: uuid()
      .notNull()
      .references(() => users.id),
    day: text().notNull(),
    keySource: text().$type<'site' | 'user'>().notNull(),
    inputTokens: count(),
    outputTokens: count(),
    cachedTokens: count(),
    costMicroUsd: count(),
    runCount: count(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day, t.keySource] })],
)

/**
 * M5a approvals (docs/04, docs/06 section 5). Every effect tool call crosses this boundary: `required` rows wait for the
 * caller, automatic ones are decided by the server at once, invalid ones are rejected with a reason. The step row is the
 * stable effect index; args are run content and are cleared with it (docs/04 section 10).
 */
export const agentApprovals = pgTable(
  'agent_approvals',
  {
    id: uuid().primaryKey(),
    runId: uuid()
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    stepId: uuid()
      .notNull()
      .references(() => agentSteps.id, { onDelete: 'cascade' }),
    stepIndex: integer().notNull(),
    /** The caller; only they may decide (docs/06 A4). */
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The SDK identifiers that bind the decision to one tool call of the persisted model history. */
    toolCallId: text().notNull(),
    approvalId: text().notNull(),
    toolName: text().notNull(),
    args: jsonbValue<unknown>(),
    editedArgs: jsonbValue<unknown>(),
    /** What the server froze when the call was approved, including resolved times and user ids. */
    finalArgs: jsonbValue<unknown>(),
    argsHash: text(),
    required: boolean().notNull(),
    status: text().$type<'pending' | 'approved' | 'rejected' | 'expired'>().notNull(),
    reason: text(),
    stateVersion: bigint({ mode: 'number' }).notNull(),
    resumeSeq: bigint({ mode: 'number' }).notNull(),
    expiresAt: ts().notNull(),
    decidedAt: ts(),
    createdAt: ts().notNull(),
  },
  (t) => [
    uniqueIndex('agent_approvals_step_uidx').on(t.runId, t.stepId),
    uniqueIndex('agent_approvals_call_uidx').on(t.runId, t.toolCallId),
    index('agent_approvals_user_status_idx').on(t.userId, t.status),
    index('agent_approvals_pending_expiry_idx').on(t.expiresAt).where(sql`${t.status} = 'pending'`),
    check(
      'agent_approvals_status',
      sql`${t.status} in ('pending','approved','rejected','expired')`,
    ),
    check('agent_approvals_decided', sql`(${t.status} = 'pending') = (${t.decidedAt} is null)`),
    check('agent_approvals_frozen', sql`${t.status} <> 'approved' or ${t.argsHash} is not null`),
  ],
)

/** Exactly-once ledger of same-database effects (INV-10, D-037): one row per stable effect step, ids and codes only. */
export const agentEffects = pgTable(
  'agent_effects',
  {
    runId: uuid()
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    stepIndex: integer().notNull(),
    toolName: text().notNull(),
    argsHash: text().notNull(),
    entityType: text(),
    entityId: uuid(),
    result: jsonbValue<Record<string, unknown>>().notNull().default({}),
    createdAt: ts().notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.stepIndex] })],
)

const taskStatus = () =>
  text().$type<'scheduled' | 'sent' | 'cancelled' | 'failed'>().notNull().default('scheduled')

/**
 * Reminders and scheduled messages (M5a, docs/04). The instant is UTC; the local reading it was agreed in stays beside it
 * so a later time zone change shows differently but never moves the task (INV-30). Content is cleared on cancel and
 * 30 days after the end; the row keeps ids, state and the error code.
 */
export const reminders = pgTable(
  'reminders',
  {
    id: uuid().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    conversationId: uuid().references(() => conversations.id, { onDelete: 'set null' }),
    text: text(),
    remindAt: ts().notNull(),
    scheduledTimezone: text().notNull(),
    scheduledLocalTime: text().notNull(),
    scheduledOffsetMinutes: integer().notNull(),
    status: taskStatus(),
    privacyClass: text().$type<'standard' | 'byok_private'>().notNull().default('standard'),
    createdByRunId: uuid().references(() => agentRuns.id, { onDelete: 'set null' }),
    /** Child delegation bound to this task; null only after the terminal delegation was purged. */
    delegationId: uuid().references(() => executionDelegations.id, { onDelete: 'set null' }),
    sentMessageId: uuid().references(() => messages.id, { onDelete: 'set null' }),
    errorCode: text(),
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdAt: ts().notNull(),
    finishedAt: ts(),
    contentPurgedAt: ts(),
  },
  (t) => [
    index('reminders_due_idx').on(t.remindAt).where(sql`${t.status} = 'scheduled'`),
    index('reminders_user_created_idx').on(t.userId, t.createdAt),
    check('reminders_status', sql`${t.status} in ('scheduled','sent','cancelled','failed')`),
    check(
      'reminders_text',
      sql`(${t.text} is null and ${t.status} <> 'scheduled') or (${t.text} is not null and char_length(${t.text}) between 1 and 1000)`,
    ),
    check('reminders_finished', sql`(${t.status} = 'scheduled') = (${t.finishedAt} is null)`),
    check('reminders_privacy', sql`${t.privacyClass} in ('standard','byok_private')`),
  ],
)

export const scheduledMessages = pgTable(
  'scheduled_messages',
  {
    id: uuid().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    conversationId: uuid().references(() => conversations.id, { onDelete: 'set null' }),
    body: text(),
    sendAt: ts().notNull(),
    scheduledTimezone: text().notNull(),
    scheduledLocalTime: text().notNull(),
    scheduledOffsetMinutes: integer().notNull(),
    status: taskStatus(),
    createdByRunId: uuid().references(() => agentRuns.id, { onDelete: 'set null' }),
    delegationId: uuid().references(() => executionDelegations.id, { onDelete: 'set null' }),
    sentMessageId: uuid().references(() => messages.id, { onDelete: 'set null' }),
    errorCode: text(),
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdAt: ts().notNull(),
    finishedAt: ts(),
    contentPurgedAt: ts(),
  },
  (t) => [
    index('scheduled_messages_due_idx').on(t.sendAt).where(sql`${t.status} = 'scheduled'`),
    index('scheduled_messages_user_created_idx').on(t.userId, t.createdAt),
    check(
      'scheduled_messages_status',
      sql`${t.status} in ('scheduled','sent','cancelled','failed')`,
    ),
    check(
      'scheduled_messages_body',
      sql`(${t.body} is null and ${t.status} <> 'scheduled') or (${t.body} is not null and char_length(${t.body}) between 1 and 5000)`,
    ),
    check(
      'scheduled_messages_finished',
      sql`(${t.status} = 'scheduled') = (${t.finishedAt} is null)`,
    ),
  ],
)

/** Globally increasing key revisions: a key removed and added again never matches a run pinned to the old one. */
export const userAiKeyRevisions = pgSequence('user_ai_key_revisions')

/**
 * A member's own DeepSeek key (M5a, SEC-26). AES-256-GCM under AI_KEY_ENCRYPTION_KEY, authenticated with the owner and
 * revision; plaintext exists only in the request that saves it and in the worker that calls the fixed endpoint.
 */
export const userAiKeys = pgTable(
  'user_ai_keys',
  {
    userId: uuid()
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text().$type<'deepseek'>().notNull(),
    keyCiphertext: text().notNull(),
    keyNonce: text().notNull(),
    keyVersion: smallint().notNull(),
    revision: bigint({ mode: 'number' }).notNull(),
    keyLast4: text().notNull(),
    status: text().$type<'active' | 'invalid'>().notNull(),
    /** Why a key stopped working: `invalid` or `insufficient_balance`; rate limiting never marks a key. */
    invalidReason: text(),
    lastVerifiedAt: ts(),
    createdAt: ts().notNull(),
    updatedAt: ts().notNull(),
  },
  (t) => [
    check('user_ai_keys_provider', sql`${t.provider} = 'deepseek'`),
    check('user_ai_keys_status', sql`${t.status} in ('active','invalid')`),
    check('user_ai_keys_last4', sql`char_length(${t.keyLast4}) = 4`),
  ],
)
