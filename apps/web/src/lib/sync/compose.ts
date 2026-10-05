/**
 * What the composer is doing besides plain writing (D-154): answering one message (a reply) or changing one of my own
 * (an edit). Per conversation, in memory. Editing sets the field aside: what was typed before comes back when the edit
 * ends, so starting an edit never costs the person their draft.
 *
 * It belongs to the membership it was started under (D-171, SEC-34): it is dropped with the conversation's other stores
 * when that membership ends, and a mode started under another membership is never read, so the quoted message (which the
 * membership that came after may not see) and the stash of an edit cannot show up after leaving and joining again.
 */
import type { Message } from '@chatapp/contracts'
import { create } from 'zustand'
import { registerConversationReset, registerStoreReset } from './stores.ts'
import type { TimelineWindow } from './types.ts'

export type ComposeMode =
  | { type: 'reply'; message: Message; membershipId: string }
  | { type: 'edit'; message: Message; stash: string; membershipId: string }

type ComposeState = { byConversation: Record<string, ComposeMode> }

export const useCompose = create<ComposeState>()(() => ({ byConversation: {} }))

/** The mode in progress for a conversation, as the membership held now: one from another membership is not there. */
export const modeOf = (
  state: ComposeState,
  conversationId: string,
  membershipId: string | undefined,
): ComposeMode | undefined => {
  const mode = state.byConversation[conversationId]
  return mode !== undefined && mode.membershipId === membershipId ? mode : undefined
}

function put(conversationId: string, mode: ComposeMode | undefined): void {
  useCompose.setState((state) => {
    const { [conversationId]: _old, ...rest } = state.byConversation
    return { byConversation: mode === undefined ? rest : { ...rest, [conversationId]: mode } }
  })
}

/** What is in progress now under this membership (what an earlier membership left behind does not count). */
function current(conversationId: string, membershipId: string): ComposeMode | undefined {
  return modeOf(useCompose.getState(), conversationId, membershipId)
}

/** Answer a message. An edit in progress is left first (its stash is returned for the caller to put back). */
export function startReply(
  conversationId: string,
  membershipId: string,
  message: Message,
): string | undefined {
  const previous = current(conversationId, membershipId)
  put(conversationId, { type: 'reply', message, membershipId })
  return previous?.type === 'edit' ? previous.stash : undefined
}

/** Change one of my messages; `draft` is what is in the field now, kept for when the edit ends. */
export function startEdit(
  conversationId: string,
  membershipId: string,
  message: Message,
  draft: string,
): void {
  const previous = current(conversationId, membershipId)
  put(conversationId, {
    type: 'edit',
    message,
    stash: previous?.type === 'edit' ? previous.stash : draft,
    membershipId,
  })
}

/**
 * Ends reply or edit; returns what the field should hold again (the stashed draft after an edit, if it is the one of this
 * membership: a stash an earlier membership left behind is thrown away, not handed back).
 */
export function endCompose(conversationId: string, membershipId: string): string | undefined {
  const previous = current(conversationId, membershipId)
  put(conversationId, undefined)
  return previous?.type === 'edit' ? previous.stash : undefined
}

/**
 * The message a reply or an edit stands on, as the window holds it *now* (D-171): the quoted text follows an edit, and a
 * message that was recalled, deleted or hidden since is not a target any more (the server refuses a reply to it, and an
 * edit of it is meaningless), so the answer is null and the mode should end. A message the window does not hold (scrolled
 * out of it) cannot be told about, and the copy taken when the mode began stands in for it.
 */
export function liveTarget(mode: ComposeMode, window: TimelineWindow | undefined): Message | null {
  const { message } = mode
  if (window === undefined) return message
  if (message.id in window.hidden || message.id in window.gone) return null
  let low = 0
  let high = window.messages.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const held = window.messages[middle]
    if (held === undefined) break
    if (held.seq === message.seq) {
      if (held.id !== message.id) return message
      return held.recalledAt !== null || held.deletedAt !== null ? null : held
    }
    if (held.seq < message.seq) low = middle + 1
    else high = middle - 1
  }
  return message
}

registerStoreReset(() => useCompose.setState({ byConversation: {} }))
registerConversationReset((conversationId) => put(conversationId, undefined))
