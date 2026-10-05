/**
 * What a screen reader is told about new messages (docs/02 section 7): only for the conversation that is open, and
 * several messages that arrive close together become one announcement instead of a stream. Pure: the selection of what
 * is new and the wording of the batch are plain functions, the timing is the component's.
 */
import type { Message } from '@chatapp/contracts'

export type Incoming = { sender: string; text: string }

export type AnnounceWords = {
  one: (sender: string, text: string) => string
  many: (count: number, sender: string, text: string) => string
}

/** At most this many characters of a message are read out. */
export const ANNOUNCE_MAX_CHARS = 140

/** A line of text a reader can take in: white space collapsed, and cut at a character boundary with an ellipsis. */
export function shorten(text: string, max = ANNOUNCE_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const chars = [...flat]
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('')}…`
}

/** The messages worth announcing that arrived after `afterSeq`: other people's, with text, not system lines. */
export function incomingAfter(
  messages: readonly Message[],
  afterSeq: number,
  meId: string,
  nameOf: (senderId: string | null) => string,
): Incoming[] {
  return messages.flatMap((message) => {
    if (message.seq <= afterSeq) return []
    if (message.senderId === meId || message.kind === 'system') return []
    if (message.body === null || message.recalledAt !== null || message.deletedAt !== null)
      return []
    return [{ sender: nameOf(message.senderId), text: message.body }]
  })
}

/** One sentence for a batch: the message itself when there is one, a count and the latest when there are several. */
export function announcementOf(batch: readonly Incoming[], words: AnnounceWords): string {
  const last = batch[batch.length - 1]
  if (last === undefined) return ''
  const text = shorten(last.text)
  return batch.length === 1
    ? words.one(last.sender, text)
    : words.many(batch.length, last.sender, text)
}
