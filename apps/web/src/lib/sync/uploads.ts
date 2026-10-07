/** Upload drafts live under the same account and membership lifecycle as message drafts (SEC-34). */
import type { Attachment } from '@chatapp/contracts'
import { create } from 'zustand'
import { registerConversationReset, registerStoreReset } from './stores.ts'
export type DraftUpload = {
  id: string
  file: File
  controller: AbortController
  percent: number
  status: 'uploading' | 'processing' | 'ready' | 'failed'
  error?: string
  uploadId?: string
  attachment?: Attachment
}
type UploadState = { byConversation: Record<string, DraftUpload[]> }
const EMPTY: DraftUpload[] = []
export const useUploads = create<UploadState>(() => ({ byConversation: {} }))
export const uploadsOf = (state: UploadState, id: string) => state.byConversation[id] ?? EMPTY
export function addUpload(conversationId: string, file: File): DraftUpload {
  const entry: DraftUpload = {
    id: crypto.randomUUID(),
    file,
    controller: new AbortController(),
    percent: 0,
    status: 'uploading',
  }
  useUploads.setState((state) => ({
    byConversation: {
      ...state.byConversation,
      [conversationId]: [...uploadsOf(state, conversationId), entry],
    },
  }))
  return entry
}
export function updateUpload(
  conversationId: string,
  id: string,
  patch: Partial<DraftUpload>,
): void {
  useUploads.setState((state) => {
    const list = state.byConversation[conversationId]
    if (!list?.some((item) => item.id === id && !item.controller.signal.aborted)) return state
    return {
      byConversation: {
        ...state.byConversation,
        [conversationId]: list.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      },
    }
  })
}
export function removeUpload(conversationId: string, id: string): void {
  const list = uploadsOf(useUploads.getState(), conversationId)
  list.find((item) => item.id === id)?.controller.abort()
  useUploads.setState((state) => ({
    byConversation: {
      ...state.byConversation,
      [conversationId]: list.filter((item) => item.id !== id),
    },
  }))
}
export function clearUploads(conversationId: string): void {
  for (const entry of uploadsOf(useUploads.getState(), conversationId)) entry.controller.abort()
  useUploads.setState((state) => {
    const { [conversationId]: _old, ...rest } = state.byConversation
    return { byConversation: rest }
  })
}
registerConversationReset(clearUploads)
registerStoreReset(() => {
  for (const id of Object.keys(useUploads.getState().byConversation)) clearUploads(id)
})
