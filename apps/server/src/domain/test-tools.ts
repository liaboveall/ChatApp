/**
 * Helpers that only the test environment reaches (docs/08 section 4, D-155). Their one caller is
 * `http/routes/test.ts`, which is registered ONLY when APP_ENV=test (SEC-29); the production start-up self-check refuses
 * to boot if any `/api/test/*` route exists. They live in domain/ because http/ may not touch tables (docs/03 section 3).
 */
import { AppError } from '@chatapp/contracts'
import { messages } from '@chatapp/db'
import { eq, sql } from 'drizzle-orm'
import type { Deps } from './deps.ts'

/**
 * Makes a message `ms` milliseconds older by moving its `created_at` back. Time-window rules (the 2-minute recall, the
 * 24-hour edit) read `created_at`, so a browser test can get an expired message without waiting and without moving any
 * clock (a moved API clock would not move the worker's, and everything scheduled between them would drift).
 */
export async function ageMessage(
  deps: Deps,
  messageId: string,
  ms: number,
): Promise<{ createdAt: string }> {
  const [row] = await deps.db
    .update(messages)
    .set({ createdAt: sql`${messages.createdAt} - (${ms}::bigint * interval '1 millisecond')` })
    .where(eq(messages.id, messageId))
    .returning({ createdAt: messages.createdAt })
  if (!row) throw new AppError('NOT_FOUND', 'Message not found')
  return { createdAt: row.createdAt.toISOString() }
}
