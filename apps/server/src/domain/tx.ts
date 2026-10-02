import type { Db, Tx } from '@chatapp/db'
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
