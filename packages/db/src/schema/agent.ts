import type { AgentSource } from '@chatapp/contracts'
import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
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
    type: text().$type<'model' | 'tool_call' | 'tool_result' | 'error'>().notNull(),
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
