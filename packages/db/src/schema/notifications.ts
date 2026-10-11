/**
 * In-site notifications and browser push subscriptions (docs/04 section 6, M6). A notification stores identifiers and
 * times, never message text: what is shown is projected from the live data when it is read.
 */
import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { notificationType } from './enums.ts'
import { jsonbValue } from './json.ts'
import { sessions, users } from './tables.ts'

const ts = () => timestamp({ withTimezone: true })

export const notifications = pgTable(
  'notifications',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: notificationType().notNull(),
    /** Resource ids and times only (docs/04 section 6): conversationId, messageId, senderId, runId, approvalId ... */
    data: jsonbValue<Record<string, string | number | null>>().notNull().default({}),
    /** One entry per cause and person: deriving the same message or run twice finds the row that is there. */
    dedupeKey: text().notNull(),
    readAt: ts(),
    /** Moves with every change of the entry (read state); a client keeps the newer one (docs/05 section 2). */
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('notifications_user_dedupe_uidx').on(t.userId, t.dedupeKey),
    index('notifications_user_created_idx').on(
      t.userId,
      sql`${t.createdAt} desc`,
      sql`${t.id} desc`,
    ),
    index('notifications_user_unread_idx').on(t.userId).where(sql`${t.readAt} is null`),
    index('notifications_created_idx').on(t.createdAt),
    check('notifications_version_positive', sql`${t.version} >= 1`),
  ],
)

export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The sign-in the subscription was made under; when that session ends the subscription goes with it (D-038). */
    sessionId: uuid()
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** The push service's address for one browser installation; unique across all accounts. */
    endpoint: text().notNull(),
    /** A random id the browser made for itself: the proof that a new sign-in on the same browser may take the endpoint over. */
    installationId: uuid().notNull(),
    /** Moves when the endpoint passes to another session or account; queued pushes remember the one they were made for. */
    bindingVersion: bigint({ mode: 'number' }).notNull().default(1),
    p256dh: text().notNull(),
    auth: text().notNull(),
    /** Raw `User-Agent` of the subscribing request, cut short; only a label made from it is ever shown. */
    userAgent: text(),
    createdAt: ts().notNull().defaultNow(),
    lastSuccessAt: ts(),
    failureCount: integer().notNull().default(0),
  },
  (t) => [
    uniqueIndex('push_subscriptions_endpoint_uidx').on(t.endpoint),
    index('push_subscriptions_user_idx').on(t.userId),
    index('push_subscriptions_session_idx').on(t.sessionId),
    check('push_subscriptions_counters', sql`${t.bindingVersion} >= 1 and ${t.failureCount} >= 0`),
  ],
)
