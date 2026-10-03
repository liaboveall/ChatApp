/**
 * System messages (docs/01 section 4.5): "X joined", "X left", "X was removed", "renamed", "ownership passed". They are
 * ordinary messages with no sender, written in the transaction of the event they describe, and they never move anyone's
 * read position (INV-28). Groups record all of them; channels skip joins and leaves, which only show in the member list,
 * so a busy channel does not scroll away (D-129); direct messages have none.
 */
import type { ConversationKind, SystemEvent } from '@chatapp/contracts'
import { type DbOrTx, messages } from '@chatapp/db'
import { allocateMessageSeq, recordMessageChange } from './changes.ts'
import type { Deps } from './deps.ts'

export function recordsSystemMessage(kind: ConversationKind, type: SystemEvent['type']): boolean {
  if (kind === 'group') return true
  if (kind === 'channel') return type !== 'member_joined' && type !== 'member_left'
  return false
}

/** Appends the message if this kind of conversation records the event. The caller holds the conversation lock. */
export async function appendSystemMessage(
  tx: DbOrTx,
  deps: Pick<Deps, 'clock' | 'newId'>,
  conversation: { id: string; kind: ConversationKind },
  event: SystemEvent,
): Promise<void> {
  if (!recordsSystemMessage(conversation.kind, event.type)) return
  const { seq, changeSeq } = await allocateMessageSeq(tx, deps, conversation.id)
  const id = deps.newId()
  await tx.insert(messages).values({
    id,
    conversationId: conversation.id,
    seq,
    changeSeq,
    senderId: null,
    kind: 'system',
    status: 'sent',
    body: null,
    executionSource: 'system',
    meta: { system: event },
    createdAt: deps.clock.now(),
  })
  await recordMessageChange(tx, deps, {
    conversationId: conversation.id,
    messageId: id,
    changeSeq,
    kind: 'message_created',
  })
}
