/**
 * The one line under a conversation's name in the sidebar (docs/02 section 3): what the last message said, who said it
 * where that matters, or a word for a message that is gone. Pure: the words arrive as arguments so the rule is exercised
 * directly, in both languages.
 */
import type { Conversation, UserSummary } from '@chatapp/contracts'

export type PreviewWords = {
  /** "You" as the start of "You: hello". */
  you: string
  recalled: string
  deleted: string
  system: string
  /** `{name}: {text}` or `You: {text}`, worded per language. */
  withSender: (sender: string, text: string) => string
}

export function previewLine(
  conversation: Pick<Conversation, 'kind' | 'lastMessagePreview'>,
  users: Record<string, UserSummary>,
  meId: string,
  words: PreviewWords,
): string {
  const preview = conversation.lastMessagePreview
  if (preview === null) return ''
  if (preview.state === 'recalled') return words.recalled
  if (preview.state === 'deleted') return words.deleted
  if (preview.kind === 'system' || preview.text === null) return words.system
  const text = preview.text.replace(/\s+/g, ' ').trim()
  if (preview.senderId === meId) return words.withSender(words.you, text)
  if (conversation.kind === 'dm' || preview.senderId === null) return text
  const sender = users[preview.senderId]
  return sender === undefined ? text : words.withSender(sender.displayName, text)
}
