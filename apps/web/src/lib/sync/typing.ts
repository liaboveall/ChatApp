/**
 * Who is typing where (docs/01 section 4.7, docs/05 section 4.4). A `typing` hint says someone started or stopped; it
 * names the moment it expires, so a person who closes the tab never stays "typing". Nothing here is stored beyond memory:
 * typing is a transient signal that only exists between the members who are looking.
 */
import { create } from 'zustand'
import { registerConversationReset, registerStoreReset } from './stores.ts'

type TypingState = {
  /** conversation → person → the moment (ms) their "typing" runs out. */
  byConversation: Record<string, Record<string, number>>
}

export const useTyping = create<TypingState>()(() => ({ byConversation: {} }))

const NOBODY: string[] = []

export type TypingEvent = {
  conversationId: string
  userId: string
  state: 'start' | 'stop'
  expiresInMs: number
}

/** Applies one hint. My own typing (from another device of mine) is never shown to me. */
export function applyTyping(event: TypingEvent, meId: string | undefined, now: number): void {
  if (event.userId === meId) return
  useTyping.setState((state) => {
    const current = state.byConversation[event.conversationId] ?? {}
    if (event.state === 'stop') {
      if (!(event.userId in current)) return state
      const { [event.userId]: _gone, ...rest } = current
      return { byConversation: { ...state.byConversation, [event.conversationId]: rest } }
    }
    return {
      byConversation: {
        ...state.byConversation,
        [event.conversationId]: { ...current, [event.userId]: now + event.expiresInMs },
      },
    }
  })
}

/** The people typing in a conversation at `now`, longest-typing first. */
export function typersOf(state: TypingState, conversationId: string, now: number): string[] {
  const entries = state.byConversation[conversationId]
  if (entries === undefined) return NOBODY
  const live = Object.entries(entries)
    .filter(([, expires]) => expires > now)
    .sort((a, b) => a[1] - b[1])
    .map(([userId]) => userId)
  return live.length === 0 ? NOBODY : live
}

/** The next moment at which someone's "typing" runs out in this conversation (so a screen can look again then). */
export function nextExpiry(state: TypingState, conversationId: string, now: number): number | null {
  const entries = state.byConversation[conversationId]
  if (entries === undefined) return null
  const upcoming = Object.values(entries).filter((expires) => expires > now)
  return upcoming.length === 0 ? null : Math.min(...upcoming)
}

registerStoreReset(() => useTyping.setState({ byConversation: {} }))
registerConversationReset((conversationId) =>
  useTyping.setState((state) => {
    if (!(conversationId in state.byConversation)) return state
    const { [conversationId]: _typing, ...rest } = state.byConversation
    return { byConversation: rest }
  }),
)
