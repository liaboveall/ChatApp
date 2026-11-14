import type { Db, Tx } from '@chatapp/db'
import { sql } from 'drizzle-orm'
import { isRetryableTransactionError } from '../lib/pg-error.ts'

/**
 * Runs `fn` in a transaction and retries the whole transaction on deadlock or serialization failure
 * (docs/03 section 5.1: bounded retries, never report success before commit).
 */
export async function inTransaction<T>(
  db: Db,
  fn: (tx: Tx) => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await db.transaction(fn)
    } catch (error) {
      lastError = error
      if (!isRetryableTransactionError(error) || attempt === attempts) throw error
      await new Promise((resolve) => setTimeout(resolve, 10 * attempt + Math.random() * 20))
    }
  }
  throw lastError
}

/**
 * Runs work that is not database work (object storage, the offsite journal) while a transaction stays open around it,
 * usually to hold an advisory lock.
 *
 * The database client closes any connection that carried no traffic for 30 seconds, whether or not a transaction is
 * open on it. The transaction then fails, its lock is gone while the work it guarded is still running, and every
 * statement that was queued behind that connection fails at the same moment. A small query at intervals keeps the
 * connection in use for as long as the work takes. The server-side idle limit of such a transaction is lifted
 * separately by its owner (`set local idle_in_transaction_session_timeout = 0`).
 */
export async function keepAlive<T>(tx: Tx, work: () => Promise<T>, everyMs = 10_000): Promise<T> {
  let beating = false
  const timer = setInterval(() => {
    if (beating) return
    beating = true
    // A failure here is the transaction's own failure and surfaces where its owner next uses it.
    void Promise.resolve(tx.execute(sql`select 1`))
      .catch(() => undefined)
      .finally(() => {
        beating = false
      })
  }, everyMs)
  try {
    return await work()
  } finally {
    clearInterval(timer)
  }
}
