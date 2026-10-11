/**
 * Forgetting what the browser kept for the account (D-070, D-205, SEC-34). A sign-out, a lost session and a sign-out in
 * another tab all end here: the writers are told first, in the same turn, so that nothing is written after the wipe, and then
 * the database is emptied for every account.
 */
import { idbBackend } from './store.ts'

const listeners = new Set<() => void>()

/** Registers what must stop at once when the account is forgotten. Returns the function that removes it again. */
export function onForgetOffline(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The account is gone from this browser. Never throws; the emptying itself is not waited for. */
export function forgetOfflineData(): void {
  for (const listener of listeners) listener()
  void idbBackend.clear()
}
