import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { conversations, messages, users } from './tables.ts'

export const reports = pgTable(
  'reports',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),
    messageId: uuid().references(() => messages.id, { onDelete: 'set null' }),
    conversationId: uuid().references(() => conversations.id, { onDelete: 'set null' }),
    reporterId: uuid().references(() => users.id, { onDelete: 'set null' }),
    /** Frozen visibility boundary: reporting cannot grant admins access to the reporter's unseen earlier history. */
    visibleFromSeq: bigint({ mode: 'number' }).notNull(),
    reason: text().$type<'spam' | 'abuse' | 'illegal' | 'other'>().notNull(),
    details: text(),
    status: text().$type<'open' | 'resolved' | 'dismissed'>().notNull().default('open'),
    handledBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    handledAt: timestamp({ withTimezone: true }),
    resolutionNote: text(),
    version: integer().notNull().default(1),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('reports_message_reporter').on(t.messageId, t.reporterId),
    index('reports_status_created').on(t.status, t.createdAt),
    check('reports_reason', sql`${t.reason} in ('spam','abuse','illegal','other')`),
    check('reports_status', sql`${t.status} in ('open','resolved','dismissed')`),
    check(
      'reports_bounds',
      sql`${t.version} >= 1 and ${t.visibleFromSeq} >= 0 and (${t.details} is null or length(${t.details}) <= 1000) and (${t.resolutionNote} is null or length(${t.resolutionNote}) <= 1000)`,
    ),
  ],
)
