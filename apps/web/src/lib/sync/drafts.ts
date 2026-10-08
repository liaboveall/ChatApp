/**
 * What the person has typed and not sent, per conversation (D-154). In memory only: it survives switching conversations but
 * not a reload (M6 adds offline storage) and is emptied with the account.
 */
import { create } from 'zustand'
import { registerConversationReset, registerStoreReset } from './stores.ts'

type DraftState = { byConversation: Record<string, string>; previews: Record<string, boolean> }

export const useDrafts = create<DraftState>()(() => ({ byConversation: {}, previews: {} }))

export const draftOf = (state: DraftState, conversationId: string): string =>
  state.byConversation[conversationId] ?? ''

export function setDraft(conversationId: string, text: string): void {
  useDrafts.setState((state) => {
    if (text === '') {
      if (!(conversationId in state.byConversation)) return state
      const { [conversationId]: _gone, ...rest } = state.byConversation
      const { [conversationId]: _preview, ...previews } = state.previews
      return { byConversation: rest, previews }
    }
    return { byConversation: { ...state.byConversation, [conversationId]: text } }
  })
}

export function setDraftPreview(conversationId: string, preview: boolean): void {
  useDrafts.setState((state) => ({ previews: { ...state.previews, [conversationId]: preview } }))
}

registerStoreReset(() => useDrafts.setState({ byConversation: {}, previews: {} }))
registerConversationReset((conversationId) => setDraft(conversationId, ''))
