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
import { showToast } from '@/lib/toast.ts'
import { m } from '@/paraglide/messages.js'

type Kind = 'edit' | 'recall' | 'hide' | 'delete'

function fail(message: Message, kind: Kind, error: unknown): void {
  if (engine.handleAccessError(message.conversationId, error)) return
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

/** Returns whether the change was accepted (the composer leaves edit mode only then). */
export async function editMessage(message: Message, body: string): Promise<boolean> {
  const request: EditMessageRequest = { body, expectedChangeSeq: message.changeSeq }
  try {
    const envelope = await api(`/api/messages/${message.id}`, {
      method: 'PATCH',
      json: request,
      schema: messageEnvelopeSchema,
    })
    engine.ingestMessage(envelope)
    return true
  } catch (error) {
    fail(message, 'edit', error)
    return false
  }
}

export async function recallMessage(message: Message): Promise<void> {
  try {
    engine.ingestMessage(
      await api(`/api/messages/${message.id}/recall`, {
        method: 'POST',
        json: {},
        schema: messageEnvelopeSchema,
      }),
    )
  } catch (error) {
    fail(message, 'recall', error)
  }
}

/** "Delete for me": gone from my view at once, on every device of mine through my own log. */
export async function hideMessage(message: Message): Promise<void> {
  try {
    await api(`/api/messages/${message.id}/hide`, {
      method: 'POST',
      json: {},
      schema: okResponseSchema,
    })
    engine.applyHidden(message.conversationId, message.id)
  } catch (error) {
    fail(message, 'hide', error)
  }
}

/** A moderator removes a message for everybody; the new version (cleared, "deleted by an administrator") arrives through the log. */
export async function deleteAsModerator(message: Message): Promise<void> {
  try {
    await api(`/api/messages/${message.id}`, { method: 'DELETE', schema: okResponseSchema })
  } catch (error) {
    fail(message, 'delete', error)
  }
}
