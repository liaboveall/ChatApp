/**
 * How the bubble of a message is drawn (docs/02 section 5): as a bubble, as bare pictures, or as large emoji. Pure, so
 * the rule is exercised directly.
 */
import type { Message } from '@chatapp/contracts'

/** One to three emoji and nothing else: such a message is drawn large and without a bubble. */
const EMOJI_ONLY =
  /^(?:\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*|\p{Regional_Indicator}{2}){1,3}$/u

/** How the bubble of a message is drawn: as a bubble, as bare pictures, or as large emoji. */
export function bubbleShape(message: Message): 'bubble' | 'media' | 'emoji' {
  if (message.kind !== 'user' || message.replyTo !== null || message.meta.reminder) return 'bubble'
  const body = (message.body ?? '').trim()
  if (body === '') {
    return message.attachments.length > 0 &&
      message.attachments.every((file) => file.kind === 'image')
      ? 'media'
      : 'bubble'
  }
  return message.attachments.length === 0 && EMOJI_ONLY.test(body) ? 'emoji' : 'bubble'
}
