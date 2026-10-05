/**
 * The client stores that hold conversation data outside the query cache (drafts, unsent messages, typing, presence)
 * register how to empty themselves here. The sync engine calls `clearClientStores` when it stops (the session ended or the
 * account changed), so nothing of one account's conversations is still in memory for the next (D-070, SEC-34).
 */
const resets = new Set<() => void>()

/** Registers the reset of a store; returns the function that removes it again (tests). */
export function registerStoreReset(reset: () => void): () => void {
  resets.add(reset)
  return () => {
    resets.delete(reset)
  }
}

export function clearClientStores(): void {
  for (const reset of resets) reset()
}
