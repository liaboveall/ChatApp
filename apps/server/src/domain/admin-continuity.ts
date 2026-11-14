/** All operations that remove an administrator serialize before acquiring user locks. */
import { AppError } from '@chatapp/contracts'
import { deletionLocks, type Tx, users } from '@chatapp/db'
import { and, eq, isNull, ne, sql } from 'drizzle-orm'
import { accountAllowsSessionWhere } from './sessions.ts'

export async function lockAdminRoles(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('chatapp.admin.roles'))`)
}

/** A frozen account is already committed to deletion, even before the journal is reachable. */
export async function requireAdminSuccessor(tx: Tx, departingId: string, now: Date): Promise<void> {
  const [other] = await tx
    .select({ id: users.id })
    .from(users)
    .leftJoin(
      deletionLocks,
      and(eq(deletionLocks.targetType, 'user'), eq(deletionLocks.targetId, users.id)),
    )
    .where(
      and(
        eq(users.role, 'admin'),
        accountAllowsSessionWhere(now),
        ne(users.id, departingId),
        isNull(deletionLocks.operationId),
      ),
    )
    .limit(1)
  if (!other)
    throw new AppError('CONFLICT', 'At least one active verified administrator is required', {
      details: { reason: 'admin_successor_required' },
    })
}
