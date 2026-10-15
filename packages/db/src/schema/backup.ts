import { sql } from 'drizzle-orm'
import { bigint, check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const backupRuns = pgTable(
  'backup_runs',
  {
    id: uuid().primaryKey(),
    epoch: uuid().notNull(),
    status: text().$type<'copying' | 'uploading' | 'succeeded' | 'failed'>().notNull(),
    startedAt: timestamp({ withTimezone: true }).notNull(),
    snapshotAt: timestamp({ withTimezone: true }),
    leaseUntil: timestamp({ withTimezone: true }).notNull(),
    manifestKey: text(),
    manifestHash: text(),
    objectCount: bigint({ mode: 'number' }),
    journalAppliedSeq: bigint({ mode: 'number' }),
    journalAppliedHash: text(),
    offsiteVerifiedAt: timestamp({ withTimezone: true }),
    lastError: text(),
  },
  (t) => [
    index('backup_runs_barrier').on(t.status, t.leaseUntil),
    check('backup_runs_state', sql`${t.status} in ('copying','uploading','succeeded','failed')`),
    check('backup_runs_lease_bound', sql`${t.leaseUntil} <= ${t.startedAt} + interval '2 hours'`),
    check(
      'backup_runs_verified_success',
      sql`${t.status} <> 'succeeded' or (${t.manifestKey} is not null and ${t.manifestHash} ~ '^[a-f0-9]{64}$' and ${t.offsiteVerifiedAt} is not null and ${t.journalAppliedSeq} >= 0 and ${t.journalAppliedHash} ~ '^[a-f0-9]{64}$')`,
    ),
  ],
)
