/**
 * What happens when the person picks an action on a message (docs/05 section 3.4). Each one is a write over HTTP; the
 * answer is merged into the cache like every other answer (D-150). Editing and recalling are not optimistic: they have
 * conditions the server decides (the version I edited from, the time window), so the screen changes with the answer
 * (D-154). Failures are worded here; losing access to the conversation is the engine's business.
 */
import {
  type EditMessageRequest,
  type Message,
  messageEnvelopeSchema,
  okResponseSchema,
} from '@chatapp/contracts'
import { engine } from '@/app/sync.ts'
import { ApiError, api } from '@/lib/api.ts'
import { describeError } from '@/lib/error-messages.ts'
import { type EditMode, settleEdit } from '@/lib/sync/compose.ts'
import type { RequestTicket } from '@/lib/sync/types.ts'
import { showToast } from '@/lib/toast.ts'
import { m } from '@/paraglide/messages.js'

type Kind = 'edit' | 'recall' | 'hide' | 'delete'

/**
 * Every write below takes its ticket before the request goes out and hands it back with the answer or the failure: if the
 * account or the membership changed meanwhile, the engine drops both (D-171).
 */
function fail(message: Message, kind: Kind, error: unknown, ticket: RequestTicket): void {
  if (engine.handleAccessError(message.conversationId, error, ticket)) return
  if (error instanceof ApiError) {
    if (error.code === 'WINDOW_EXPIRED') {
      showToast(kind === 'edit' ? m.action_edit_expired() : m.action_recall_expired())
      return
    }
    if (error.code === 'VERSION_CONFLICT') {
      showToast(m.action_edit_conflict())
      void engine.refreshConversation(message.conversationId)
      return
    }
  }
  showToast(describeError(error))
}

/**
 * Returns the version the change made when the server accepted it *and this page took the answer*; null otherwise: it was
 * refused (the failure is worded here), or the answer came for an account or a membership that is not the one here any
 * more (the engine drops it, and so does everything that would follow from it: nothing is finished on this screen, D-173).
 * The change itself may well have happened on the server then, and reaches this page through the log like any other.
 */
export async function editMessage(message: Message, body: string): Promise<Message | null> {
  const request: EditMessageRequest = { body, expectedChangeSeq: message.changeSeq }
  const ticket = engine.ticket(message.conversationId)
  try {
    const envelope = await api(`/api/messages/${message.id}`, {
      method: 'PATCH',
      json: request,
      schema: messageEnvelopeSchema,
    })
    return engine.ingestMessage(envelope, ticket) ? envelope.message : null
  } catch (error) {
    fail(message, 'edit', error, ticket)
    return null
  }
}

/**
 * Saves the edit the composer is in. Once the answer is taken, the edit that was saved is finished (what was set aside
 * goes back into the field), but only if it is still the one in progress and the field still holds what was sent: that is
 * decided against the stores as they are when the answer comes, never against what the screen held when the save went out,
 * which is the screen of an account, a membership or an edit that may be gone (D-173).
 */
export async function saveEdit(mode: EditMode, body: string): Promise<void> {
  const saved = await editMessage(mode.message, body)
  if (saved !== null) settleEdit(mode, body, saved)
}

export async function recallMessage(message: Message): Promise<void> {
  const ticket = engine.ticket(message.conversationId)
  try {
    engine.ingestMessage(
      await api(`/api/messages/${message.id}/recall`, {
        method: 'POST',
        json: {},
        schema: messageEnvelopeSchema,
      }),
      ticket,
    )
  } catch (error) {
    fail(message, 'recall', error, ticket)
  }
}

/** "Delete for me": gone from my view at once, on every device of mine through my own log. */
export async function hideMessage(message: Message): Promise<void> {
  const ticket = engine.ticket(message.conversationId)
  try {
    await api(`/api/messages/${message.id}/hide`, {
      method: 'POST',
      json: {},
      schema: okResponseSchema,
    })
    engine.applyHidden(message.conversationId, message.id, ticket)
  } catch (error) {
    fail(message, 'hide', error, ticket)
  }
}

/** A moderator removes a message for everybody; the new version (cleared, "deleted by an administrator") arrives through the log. */
export async function deleteAsModerator(message: Message): Promise<void> {
  const ticket = engine.ticket(message.conversationId)
  try {
    await api(`/api/messages/${message.id}`, { method: 'DELETE', schema: okResponseSchema })
  } catch (error) {
    fail(message, 'delete', error, ticket)
  }
}
