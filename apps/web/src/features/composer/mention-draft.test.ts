import { expect, test } from 'vitest'
import { editMentionDraft, mentionDraft, rawDraftOffset } from './mention-draft.ts'

const alice = '00000000-0000-4000-8000-000000000001'
const bob = '00000000-0000-4000-8000-000000000002'
const token = `<@user:${alice}>`
const names = (id: string) => (id === alice ? 'Alice Chen' : '助手')
const edit = (raw: string, next: string) => editMentionDraft(raw, mentionDraft(raw, names), next)

test('names with spaces and emoji are readable, while identities stay in the draft', () => {
  expect(mentionDraft(`早上好 ${token} 😀 <@user:${bob}>`, names).text).toBe(
    '早上好 @Alice Chen 😀 @助手',
  )
  expect(edit(`${token} `, '@Alice Chen 总结计划')).toBe(`${token} 总结计划`)
})
test('edits before and after multiple mentions retain their exact IDs', () => {
  const raw = `${token} 和 <@user:${bob}> 讨论`
  expect(edit(raw, '请 @Alice Chen 和 @助手 讨论')).toBe(`请 ${raw}`)
  expect(edit(raw, '@Alice Chen 以及 @助手 讨论')).toBe(`${token} 以及 <@user:${bob}> 讨论`)
})
test('editing or backspacing part of a name turns it into ordinary text', () => {
  expect(edit(`${token} `, '@Alice Che ')).toBe('@Alice Che ')
  expect(edit(`${token} `, '@Alice XChen ')).toBe('@Alice XChen ')
  expect(edit(`${token} `, 'Alice Chen ')).toBe('Alice Chen ')
})
test('deleting a mention or a selection crossing it cannot leave a partial internal token', () => {
  expect(edit(`你好 ${token} 请看`, '你好 请看')).toBe('你好 请看')
  expect(edit(`你好 ${token} 请看`, '你请看')).toBe('你请看')
})
test('two people with the same display name are never resolved by name', () => {
  const raw = `${token} <@user:${bob}>`
  const view = mentionDraft(raw, () => 'Alex')
  expect(editMentionDraft(raw, view, '@Alex @Alex 请回复')).toBe(`${raw} 请回复`)
  expect(editMentionDraft(raw, view, '@Alex @Alec')).toBe(`${token} @Alec`)
})
test('a typed name is ordinary text and only a selected mention has an identity', () => {
  expect(edit(`${token} `, '@Alice Chen @助手')).toBe(`${token} @助手`)
})
test('caret offsets map between readable text and the wire format', () => {
  const view = mentionDraft(`😀 ${token} hello`, names)
  expect(rawDraftOffset(view, 3, 'start')).toBe(3)
  expect(rawDraftOffset(view, 7, 'start')).toBe(3)
  expect(rawDraftOffset(view, 7, 'end')).toBe(3 + token.length)
  expect(rawDraftOffset(view, 14, 'end')).toBe(3 + token.length)
  expect(rawDraftOffset(view, view.text.length, 'end')).toBe(`😀 ${token} hello`.length)
})
test('replacing the whole input and pasting across a mention do not preserve an unintended recipient', () => {
  expect(edit(`${token} 请回复`, '新消息')).toBe('新消息')
  expect(edit(`${token} 请回复`, '@Alice ChenX 请回复')).toBe('@Alice ChenX 请回复')
  expect(edit(`${token} 请回复`, '@AliceChen 请回复')).toBe('@AliceChen 请回复')
})
