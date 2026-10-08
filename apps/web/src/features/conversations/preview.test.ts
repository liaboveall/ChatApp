import { describe, expect, test } from 'vitest'
import { makeConversation, makeMessage, makeUser, uuid } from '@/lib/sync/fixtures.ts'
import { previewOf } from '@/lib/sync/merge.ts'
import { type PreviewWords, previewLine } from './preview.ts'

const words: PreviewWords = {
  you: 'You',
  recalled: 'Message recalled',
  deleted: 'Message deleted',
  system: 'System message',
  withSender: (sender, text) => `${sender}: ${text}`,
}
const ME = uuid(1)
const users = { [uuid(2)]: makeUser(2, { displayName: 'Bea' }) }
const line = (patch: Parameters<typeof makeConversation>[1]) =>
  previewLine(makeConversation(10, patch), users, ME, words)
const preview = (
  text: string | null,
  senderId: string | null = uuid(2),
  state: 'ok' | 'recalled' | 'deleted' = 'ok',
  kind: 'user' | 'system' | 'agent' = 'user',
) => ({
  senderId,
  text,
  kind,
  state,
})

describe('previewLine', () => {
  test('is empty before the first message', () => {
    expect(line({ lastMessagePreview: null })).toBe('')
  })

  test('in a group the sender is named, and "You" for my own message', () => {
    expect(line({ kind: 'group', lastMessagePreview: preview('hello') })).toBe('Bea: hello')
    expect(line({ kind: 'group', lastMessagePreview: preview('hello', ME) })).toBe('You: hello')
  })

  test('in a direct message only my own messages carry a name', () => {
    expect(line({ kind: 'dm', lastMessagePreview: preview('hello') })).toBe('hello')
    expect(line({ kind: 'dm', lastMessagePreview: preview('hello', ME) })).toBe('You: hello')
  })

  test('a sender who is not in the dictionary yet is left out rather than guessed', () => {
    expect(line({ kind: 'group', lastMessagePreview: preview('hello', uuid(99)) })).toBe('hello')
  })

  test('line breaks and runs of spaces are folded into one line', () => {
    expect(line({ kind: 'dm', lastMessagePreview: preview('one\n\n  two\tthree') })).toBe(
      'one two three',
    )
  })

  test('a message that is gone, and a system line, are worded, never shown as text', () => {
    expect(line({ lastMessagePreview: preview(null, uuid(2), 'recalled') })).toBe(
      'Message recalled',
    )
    expect(line({ lastMessagePreview: preview(null, uuid(2), 'deleted') })).toBe('Message deleted')
    expect(line({ lastMessagePreview: preview(null, null, 'ok', 'system') })).toBe('System message')
  })
})

test('mention previews use the current dictionary and an unknown person never exposes an id', () => {
  expect(
    line({ kind: 'dm', lastMessagePreview: preview(`hi <@user:${uuid(2)}> <@user:${uuid(99)}>`) }),
  ).toBe('hi @Bea @某位成员')
})
test('an attachment-only preview has a localized label', () => {
  expect(
    line({ kind: 'dm', lastMessagePreview: { ...preview(''), attachmentKind: 'image' } }),
  ).toBe('[图片]')
})

test('an assistant preview reads like the screenshot title and keeps code and escaped stars literal', () => {
  const lastMessagePreview = previewOf(
    makeMessage(1, {
      kind: 'agent',
      senderId: uuid(2),
      body: '**当前会话总结**\n\n- `**literal**` 和 \\*\\*原样\\*\\*',
    }),
  )
  expect(line({ kind: 'group', lastMessagePreview })).toBe(
    'Bea: 当前会话总结 **literal** 和 **原样**',
  )
})

test('Markdown is parsed before resolving names that contain formatting characters', () => {
  const user = makeUser(2, { displayName: '**Bea**' })
  const conversation = makeConversation(10, {
    kind: 'dm',
    lastMessagePreview: previewOf(makeMessage(1, { body: `**请 <@user:${user.id}> 确认**` })),
  })
  expect(previewLine(conversation, { [user.id]: user }, ME, words)).toBe('You: 请 @**Bea** 确认')
})
