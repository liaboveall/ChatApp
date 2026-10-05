import { messageEnvelopeSchema } from '@chatapp/contracts'
import { api } from '@/lib/api.ts'
import { queryClient } from '@/lib/query-client.ts'
import { serverNow } from '@/lib/realtime.ts'
import { type ForgetReason, SyncEngine } from '@/lib/sync/engine.ts'
import { Outbox } from '@/lib/sync/outbox.ts'
import { clearClientStores, clearConversationStores } from '@/lib/sync/stores.ts'
import { httpTransport } from '@/lib/sync/transport.ts'

type ForgottenListener = (conversationId: string, reason: ForgetReason) => void
const listeners = new Set<ForgottenListener>()

/** The screen learns that a conversation left the cache (to navigate away and say why). Returns the unsubscribe. */
export function onConversationForgotten(listener: ForgottenListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The one sync engine of this tab (D-150). The session end stops it; the realtime client feeds it. */
export const engine = new SyncEngine({
  queryClient,
  transport: httpTransport,
  onForgotten: (conversationId, reason) => {
    for (const listener of listeners) listener(conversationId, reason)
  },
  // Nothing the person wrote or chose for a conversation under a membership that ended (unsent messages, the draft, a reply
  // or an edit in progress) may stay on this device, whichever way the membership ended (D-171, SEC-34).
  onConversationReset: clearConversationStores,
  onStop: clearClientStores,
})

/** Messages being sent (D-154): the answer goes into the engine's cache like every other answer. */
export const outbox: Outbox = new Outbox({
  send: (conversationId, request) =>
    api(`/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      json: request,
      schema: messageEnvelopeSchema,
    }),
  ticket: (conversationId) => engine.ticket(conversationId),
  onSent: (envelope, ticket) => engine.messageSent(envelope, ticket),
  onAccessError: (conversationId, error, ticket) =>
    engine.handleAccessError(conversationId, error, ticket),
  membershipOf: (conversationId) => engine.membershipOf(conversationId),
  now: serverNow,
  newId: () => crypto.randomUUID(),
})
