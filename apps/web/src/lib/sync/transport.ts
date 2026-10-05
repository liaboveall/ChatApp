/**
 * The HTTP calls the sync engine makes by itself (docs/05 section 3 and 4.5). Every answer is validated against the
 * contract; the interface exists so that the engine's tests can drive it with a fake that answers in the order the test
 * chooses.
 */
import {
  type ChangesQuery,
  type Conversation,
  type ConversationChangesResponse,
  type ConversationListResponse,
  conversationChangesResponseSchema,
  conversationListResponseSchema,
  conversationSchema,
  type MessagesQuery,
  type MessagesResponse,
  messagesResponseSchema,
  type SyncHeadsResponse,
  syncHeadsResponseSchema,
  type UserChangesResponse,
  userChangesResponseSchema,
} from '@chatapp/contracts'
import { api } from '../api.ts'

export interface SyncTransport {
  listConversations(signal?: AbortSignal): Promise<ConversationListResponse>
  getConversation(id: string, signal?: AbortSignal): Promise<Conversation>
  listMessages(id: string, query: MessagesQuery, signal?: AbortSignal): Promise<MessagesResponse>
  conversationChanges(
    id: string,
    query: ChangesQuery,
    signal?: AbortSignal,
  ): Promise<ConversationChangesResponse>
  userChanges(query: ChangesQuery, signal?: AbortSignal): Promise<UserChangesResponse>
  syncHeads(signal?: AbortSignal): Promise<SyncHeadsResponse>
  markRead(id: string, seq: number, signal?: AbortSignal): Promise<Conversation>
}

function withQuery(path: string, query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams()
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) params.set(name, String(value))
  }
  const text = params.toString()
  return text === '' ? path : `${path}?${text}`
}

export const httpTransport: SyncTransport = {
  listConversations: (signal) =>
    api('/api/conversations', { schema: conversationListResponseSchema, signal }),
  getConversation: (id, signal) =>
    api(`/api/conversations/${id}`, { schema: conversationSchema, signal }),
  listMessages: (id, query, signal) =>
    api(withQuery(`/api/conversations/${id}/messages`, query), {
      schema: messagesResponseSchema,
      signal,
    }),
  conversationChanges: (id, query, signal) =>
    api(withQuery(`/api/conversations/${id}/changes`, query), {
      schema: conversationChangesResponseSchema,
      signal,
    }),
  userChanges: (query, signal) =>
    api(withQuery('/api/me/changes', query), { schema: userChangesResponseSchema, signal }),
  syncHeads: (signal) => api('/api/sync/heads', { schema: syncHeadsResponseSchema, signal }),
  markRead: (id, seq, signal) =>
    api(`/api/conversations/${id}/read`, {
      method: 'POST',
      json: { seq },
      schema: conversationSchema,
      signal,
    }),
}
