import type { DeletionIntent } from '@chatapp/contracts'
import { sql } from 'drizzle-orm'
import {
  bigint,
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
import { users } from './tables.ts'

const ts = () => timestamp({ withTimezone: true })
export const deletionOperations = pgTable(
  'deletion_operations',
  {
    id: uuid().primaryKey(),
    actorId: uuid().references(() => users.id),
    action: text().$type<DeletionIntent['action']>().notNull(),
    targetKey: text().notNull(),
    intent: jsonbValue<DeletionIntent>().notNull(),
    requestHash: text().notNull(),
    version: bigint({ mode: 'number' }).notNull().default(1),
    status: text().$type<'prepared' | 'journaled' | 'applied' | 'failed'>().notNull(),
    journalEpoch: uuid(),
    journalSeq: bigint({ mode: 'number' }),
    journalHash: text(),
    createdAt: ts().notNull(),
    appliedAt: ts(),
  },
  (t) => [
    uniqueIndex('deletion_operations_actor_action_target').on(t.actorId, t.action, t.targetKey),
    uniqueIndex('deletion_operations_system_action_target')
      .on(t.action, t.targetKey)
      .where(sql`${t.actorId} is null`),
    uniqueIndex('deletion_operations_journal_seq').on(t.journalSeq),
    index('deletion_operations_pending').on(t.status, t.createdAt),
    check(
      'deletion_operations_state',
      sql`${t.status} in ('prepared','journaled','applied','failed')`,
    ),
    check(
      'deletion_operations_journal_complete',
      sql`(${t.journalSeq} is null and ${t.journalHash} is null and ${t.journalEpoch} is null and ${t.status} in ('prepared','failed')) or (${t.journalSeq} > 0 and ${t.journalHash} ~ '^[a-f0-9]{64}$' and ${t.journalEpoch} is not null and ${t.status} in ('journaled','applied'))`,
    ),
    check(
      'deletion_operations_applied',
      sql`(${t.status} = 'applied') = (${t.appliedAt} is not null)`,
    ),
  ],
)
export const deletionLocks = pgTable(
  'deletion_locks',
  {
    targetType: text()
      .$type<'message' | 'memory' | 'conversation' | 'attachment' | 'user'>()
      .notNull(),
    targetId: uuid().notNull(),
    operationId: uuid()
      .notNull()
      .references(() => deletionOperations.id),
  },
  (t) => [
    primaryKey({ columns: [t.targetType, t.targetId] }),
    index('deletion_locks_operation').on(t.operationId),
  ],
)
export const deletionJournalState = pgTable(
  'deletion_journal_state',
  {
    id: integer().primaryKey().default(1),
    appliedSeq: bigint({ mode: 'number' }).notNull().default(0),
    appliedHash: text().notNull().default('0'.repeat(64)),
    updatedAt: ts().notNull(),
  },
  (t) => [
    check(
      'deletion_journal_state_singleton',
      sql`${t.id} = 1 and ${t.appliedSeq} >= 0 and ${t.appliedHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
)
