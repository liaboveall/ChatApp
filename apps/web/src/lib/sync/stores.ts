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

const conversationResets = new Set<(conversationId: string) => void>()

/**
 * The same for what one conversation holds: the stores that keep something per conversation (drafts, unsent messages, a
 * reply or an edit in progress, who is typing) register how to drop one conversation's part. The engine calls
 * `clearConversationStores` whenever the membership the person held in it ends, by any route (left, removed, a different
 * membership read from the server), so a store that keeps something per conversation is dropped from one place and a new
 * one only has to register here (D-171, SEC-34).
 */
export function registerConversationReset(reset: (conversationId: string) => void): () => void {
  conversationResets.add(reset)
  return () => {
    conversationResets.delete(reset)
  }
}

export function clearConversationStores(conversationId: string): void {
  for (const reset of conversationResets) reset(conversationId)
}
