import { messageEnvelopeSchema } from '@chatapp/contracts'
import { api } from '@/lib/api.ts'
import { queryClient } from '@/lib/query-client.ts'
import { serverNow } from '@/lib/realtime.ts'
import { setDraft } from '@/lib/sync/drafts.ts'
import { type ForgetReason, SyncEngine } from '@/lib/sync/engine.ts'
import { Outbox } from '@/lib/sync/outbox.ts'
import { clearClientStores } from '@/lib/sync/stores.ts'
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
    // Nothing the person wrote for a conversation they can no longer reach may stay on this device.
    outbox.clearConversation(conversationId)
    setDraft(conversationId, '')
    for (const listener of listeners) listener(conversationId, reason)
  },
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
  onSent: (envelope) => {
    engine.ingestMessage(envelope)
    engine.noteSent(envelope.message.conversationId, envelope.message.seq)
  },
  onAccessError: (conversationId, error) => engine.handleAccessError(conversationId, error),
  membershipOf: (conversationId) => engine.membershipOf(conversationId),
  now: serverNow,
  newId: () => crypto.randomUUID(),
})
