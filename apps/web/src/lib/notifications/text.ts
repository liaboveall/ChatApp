/**
 * The words of a notification entry, as pure functions of the entry (docs/02, M6): what happened, where, and what to show
 * under it. The entry says nothing the reader may not see; `available: false` is worded generically and carries no names.
 */
import type { Notification, NotificationConversation } from '@chatapp/contracts'

export type NoticeWords = {
  /** `where` is the conversation's name, or null for a direct message. */
  mention: (input: { name: string; where: string | null }) => string
  reply: (input: { name: string; where: string | null }) => string
  approval: () => string
  approvalDone: () => string
  reminder: () => string
  budget: (input: { percent: number; period: string }) => string
  report: () => string
  unavailable: () => string
  withdrawn: () => string
  attachment: (kind: 'image' | 'video' | 'audio' | 'file') => string
  /** A conversation without a name of its own. */
  unnamed: () => string
}

export type NoticeLine = {
  /** The headline: who did what, or what is waiting. */
  title: string
  /** Under it: a piece of the message, or nothing. */
  detail: string | null
}

const whereOf = (conversation: NotificationConversation, words: NoticeWords): string | null =>
  conversation.kind === 'dm' ? null : (conversation.name ?? words.unnamed())

/** A piece of the message to show: the text, the placeholder of an attachment, or nothing once withdrawn. */
function messageDetail(
  message: {
    preview: string | null
    attachmentKind?: 'image' | 'video' | 'audio' | 'file'
    recalled: boolean
  },
  words: NoticeWords,
): string | null {
  if (message.recalled) return words.withdrawn()
  if (
    message.preview !== null &&
    message.preview !== '' &&
    !/^\[(image|video|audio|file)\]$/.test(message.preview)
  ) {
    return message.preview
  }
  return message.attachmentKind ? words.attachment(message.attachmentKind) : null
}

export function noticeLine(entry: Notification, words: NoticeWords): NoticeLine {
  switch (entry.type) {
    case 'mention':
    case 'reply': {
      if (!entry.data.available) return { title: words.unavailable(), detail: null }
      const input = {
        name: entry.data.sender.displayName,
        where: whereOf(entry.data.conversation, words),
      }
      return {
        title: entry.type === 'mention' ? words.mention(input) : words.reply(input),
        detail: messageDetail(entry.data.message, words),
      }
    }
    case 'approval_requested':
      if (!entry.data.available) return { title: words.unavailable(), detail: null }
      return {
        title: entry.data.approval.status === 'pending' ? words.approval() : words.approvalDone(),
        detail: null,
      }
    case 'reminder':
      if (!entry.data.available) return { title: words.unavailable(), detail: null }
      return { title: words.reminder(), detail: messageDetail(entry.data.message, words) }
    case 'budget_alert':
      return {
        title: words.budget({ percent: entry.data.percent, period: entry.data.period }),
        detail: null,
      }
    case 'report_opened':
      return { title: entry.data.available ? words.report() : words.unavailable(), detail: null }
  }
}

export type NoticeTarget =
  | { kind: 'conversation'; conversationId: string; seq: number | null }
  | { kind: 'settings'; section: 'assistant' }
  | { kind: 'none' }

/** Where a click on the entry goes: the message, the conversation, or nowhere when the source is no longer the reader's. */
export function noticeTarget(entry: Notification): NoticeTarget {
  switch (entry.type) {
    case 'mention':
    case 'reply':
      return entry.data.available
        ? {
            kind: 'conversation',
            conversationId: entry.data.conversation.id,
            seq: entry.data.message.seq,
          }
        : { kind: 'none' }
    case 'reminder':
      return entry.data.available
        ? {
            kind: 'conversation',
            conversationId: entry.data.conversation.id,
            seq: entry.data.message.seq,
          }
        : { kind: 'none' }
    case 'approval_requested':
      return entry.data.available && entry.data.conversationId
        ? { kind: 'conversation', conversationId: entry.data.conversationId, seq: null }
        : { kind: 'none' }
    case 'budget_alert':
      return { kind: 'settings', section: 'assistant' }
    case 'report_opened':
      return { kind: 'none' }
  }
}
