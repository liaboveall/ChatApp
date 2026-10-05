/**
 * What the person has typed and not sent, per conversation (D-154). In memory only: it survives switching conversations but
 * not a reload (M6 adds offline storage) and is emptied with the account.
 */
import { create } from 'zustand'
import { registerStoreReset } from './stores.ts'

type DraftState = { byConversation: Record<string, string> }

export const useDrafts = create<DraftState>()(() => ({ byConversation: {} }))

export const draftOf = (state: DraftState, conversationId: string): string =>
  state.byConversation[conversationId] ?? ''

export function setDraft(conversationId: string, text: string): void {
  useDrafts.setState((state) => {
    if (text === '') {
      if (!(conversationId in state.byConversation)) return state
      const { [conversationId]: _gone, ...rest } = state.byConversation
      return { byConversation: rest }
    }
    return { byConversation: { ...state.byConversation, [conversationId]: text } }
  })
}

registerStoreReset(() => useDrafts.setState({ byConversation: {} }))
