/**
 * What the composer is doing besides plain writing (D-154): answering one message (a reply) or changing one of my own
 * (an edit). Per conversation, in memory. Editing sets the field aside: what was typed before comes back when the edit
 * ends, so starting an edit never costs the person their draft.
 */
import type { Message } from '@chatapp/contracts'
import { create } from 'zustand'
import { registerStoreReset } from './stores.ts'

export type ComposeMode =
  | { type: 'reply'; message: Message }
  | { type: 'edit'; message: Message; stash: string }

type ComposeState = { byConversation: Record<string, ComposeMode> }

export const useCompose = create<ComposeState>()(() => ({ byConversation: {} }))

export const modeOf = (state: ComposeState, conversationId: string): ComposeMode | undefined =>
  state.byConversation[conversationId]

function put(conversationId: string, mode: ComposeMode | undefined): void {
  useCompose.setState((state) => {
    const { [conversationId]: _old, ...rest } = state.byConversation
    return { byConversation: mode === undefined ? rest : { ...rest, [conversationId]: mode } }
  })
}

/** Answer a message. An edit in progress is left first (its stash is returned for the caller to put back). */
export function startReply(conversationId: string, message: Message): string | undefined {
  const previous = useCompose.getState().byConversation[conversationId]
  put(conversationId, { type: 'reply', message })
  return previous?.type === 'edit' ? previous.stash : undefined
}

/** Change one of my messages; `draft` is what is in the field now, kept for when the edit ends. */
export function startEdit(conversationId: string, message: Message, draft: string): void {
  const previous = useCompose.getState().byConversation[conversationId]
  put(conversationId, {
    type: 'edit',
    message,
    stash: previous?.type === 'edit' ? previous.stash : draft,
  })
}

/** Ends reply or edit; returns what the field should hold again (the stashed draft after an edit). */
export function endCompose(conversationId: string): string | undefined {
  const previous = useCompose.getState().byConversation[conversationId]
  put(conversationId, undefined)
  return previous?.type === 'edit' ? previous.stash : undefined
}

registerStoreReset(() => useCompose.setState({ byConversation: {} }))
