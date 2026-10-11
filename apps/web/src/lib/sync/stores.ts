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

/**
 * Why a conversation's part goes: `forgotten`, the conversation is gone for me (left, removed, no access, a snapshot without
 * it); `membership`, I am in it under a different membership now (left and joined again while away).
 */
export type ConversationResetReason = 'forgotten' | 'membership'

type ConversationReset = (conversationId: string, reason: ConversationResetReason) => void
const conversationResets = new Set<ConversationReset>()

/**
 * The same for what one conversation holds: the stores that keep something per conversation (drafts, unsent messages, a
 * reply or an edit in progress, who is typing) register how to drop one conversation's part. The engine calls
 * `clearConversationStores` whenever the membership the person held in it ends, by any route (left, removed, a different
 * membership read from the server), so a store that keeps something per conversation is dropped from one place and a new
 * one only has to register here (D-171, SEC-34). The one exception is the person's own plain text that was waiting for the
 * network, which a new membership keeps for them to send again or delete (the send queue, D-205).
 */
export function registerConversationReset(reset: ConversationReset): () => void {
  conversationResets.add(reset)
  return () => {
    conversationResets.delete(reset)
  }
}

export function clearConversationStores(
  conversationId: string,
  reason: ConversationResetReason = 'forgotten',
): void {
  for (const reset of conversationResets) reset(conversationId, reason)
}
