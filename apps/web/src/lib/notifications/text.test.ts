import type { Notification } from '@chatapp/contracts'
import { describe, expect, test } from 'vitest'
import { type NoticeWords, noticeLine, noticeTarget } from './text.ts'

const words: NoticeWords = {
  mention: ({ name, where }) =>
    where === null ? `${name} mentioned you in a DM` : `${name} mentioned you in ${where}`,
  reply: ({ name, where }) =>
    where === null ? `${name} replied in a DM` : `${name} replied in ${where}`,
  approval: () => 'waiting for approval',
  approvalDone: () => 'request answered',
  reminder: () => 'Reminder',
  budget: ({ percent, period }) => `budget ${percent}% for ${period}`,
  report: () => 'new report',
  unavailable: () => 'source no longer visible',
  withdrawn: () => 'withdrawn',
  attachment: (kind) => `[${kind}]`,
  unnamed: () => 'Unnamed',
}

const base = {
  id: '00000000-0000-4000-8000-000000000001',
  version: 1,
  readAt: null,
  createdAt: '2026-10-09T12:00:00.000Z',
}
const sender = {
  id: 's',
  profileVersion: 1,
  username: 'alice',
  displayName: 'Alice',
  avatarUrl: null,
  isBot: false,
  deleted: false,
}
const group = { id: 'g', kind: 'group' as const, name: 'The Crew' }
const message = (extra = {}) => ({
  id: 'm',
  seq: 7,
  preview: 'hello there',
  recalled: false,
  ...extra,
})

describe('the line of a notification', () => {
  test('a mention in a group names who, where, and shows what was said', () => {
    const entry = {
      ...base,
      type: 'mention',
      data: { available: true, conversation: group, message: message(), sender },
    } as Notification
    expect(noticeLine(entry, words)).toEqual({
      title: 'Alice mentioned you in The Crew',
      detail: 'hello there',
    })
  })

  test('in a direct message there is no name to give', () => {
    const entry = {
      ...base,
      type: 'reply',
      data: {
        available: true,
        conversation: { id: 'd', kind: 'dm', name: null },
        message: message(),
        sender,
      },
    } as Notification
    expect(noticeLine(entry, words).title).toBe('Alice replied in a DM')
  })

  test('a group without a name is called by the fallback', () => {
    const entry = {
      ...base,
      type: 'mention',
      data: { available: true, conversation: { ...group, name: null }, message: message(), sender },
    } as Notification
    expect(noticeLine(entry, words).title).toBe('Alice mentioned you in Unnamed')
  })

  test('a withdrawn message shows the word and never its text', () => {
    const entry = {
      ...base,
      type: 'mention',
      data: {
        available: true,
        conversation: group,
        message: message({ recalled: true, preview: null }),
        sender,
      },
    } as Notification
    expect(noticeLine(entry, words).detail).toBe('withdrawn')
  })

  test("an attachment-only message shows the kind in the reader's words, not the server's placeholder", () => {
    const entry = {
      ...base,
      type: 'mention',
      data: {
        available: true,
        conversation: group,
        message: message({ preview: '[image]', attachmentKind: 'image' }),
        sender,
      },
    } as Notification
    expect(noticeLine(entry, words).detail).toBe('[image]')
    const none = {
      ...entry,
      data: { ...entry.data, message: message({ preview: null }) },
    } as Notification
    expect(noticeLine(none, words).detail).toBeNull()
  })

  test('a source the reader can no longer see says so and carries nothing', () => {
    for (const type of [
      'mention',
      'reply',
      'approval_requested',
      'reminder',
      'report_opened',
    ] as const) {
      const entry = { ...base, type, data: { available: false } } as Notification
      expect(noticeLine(entry, words)).toEqual({ title: 'source no longer visible', detail: null })
      expect(noticeTarget(entry)).toEqual({ kind: 'none' })
    }
  })

  test('the assistant: waiting, then answered', () => {
    const waiting = {
      ...base,
      type: 'approval_requested',
      data: {
        available: true,
        approval: { id: 'a', runId: 'r', status: 'pending', expiresAt: '2026-10-10T00:00:00.000Z' },
        conversationId: 'c',
      },
    } as Notification
    expect(noticeLine(waiting, words).title).toBe('waiting for approval')
    const done = {
      ...waiting,
      data: {
        ...waiting.data,
        approval: { ...(waiting.data as { approval: object }).approval, status: 'approved' },
      },
    } as Notification
    expect(noticeLine(done, words).title).toBe('request answered')
  })

  test('a reminder shows its words; the budget alert names the share and the month', () => {
    const reminder = {
      ...base,
      type: 'reminder',
      data: {
        available: true,
        conversation: { id: 'r', kind: 'agent', name: null },
        message: message({ preview: '交周报' }),
      },
    } as Notification
    expect(noticeLine(reminder, words)).toEqual({ title: 'Reminder', detail: '交周报' })
    const budget = {
      ...base,
      type: 'budget_alert',
      data: { period: '2026-10', percent: 80 },
    } as Notification
    expect(noticeLine(budget, words).title).toBe('budget 80% for 2026-10')
  })
})

describe('where a click goes', () => {
  test('to the message for a mention, a reply and a reminder', () => {
    const mention = {
      ...base,
      type: 'mention',
      data: { available: true, conversation: group, message: message(), sender },
    } as Notification
    expect(noticeTarget(mention)).toEqual({ kind: 'conversation', conversationId: 'g', seq: 7 })
    const reminder = {
      ...base,
      type: 'reminder',
      data: {
        available: true,
        conversation: { id: 'r', kind: 'agent', name: null },
        message: message(),
      },
    } as Notification
    expect(noticeTarget(reminder)).toEqual({ kind: 'conversation', conversationId: 'r', seq: 7 })
  })

  test('to the conversation of the approval, or nowhere when it is gone', () => {
    const entry = {
      ...base,
      type: 'approval_requested',
      data: {
        available: true,
        approval: { id: 'a', runId: 'r', status: 'pending', expiresAt: 'x' },
        conversationId: 'c',
      },
    } as Notification
    expect(noticeTarget(entry)).toEqual({ kind: 'conversation', conversationId: 'c', seq: null })
    const gone = { ...entry, data: { ...entry.data, conversationId: null } } as Notification
    expect(noticeTarget(gone)).toEqual({ kind: 'none' })
  })

  test('the budget alert opens the assistant settings, where the usage is', () => {
    const budget = {
      ...base,
      type: 'budget_alert',
      data: { period: '2026-10', percent: 100 },
    } as Notification
    expect(noticeTarget(budget)).toEqual({ kind: 'settings', section: 'assistant' })
  })
})
