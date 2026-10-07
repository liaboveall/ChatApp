import { expect, test } from 'bun:test'
import { plainMessageText } from './message-text.ts'

const id = '10000000-0000-4000-8000-000000000001'
test('plain outlets resolve names, including repeated and uppercase references, without exposing unknown ids', () => {
  expect(
    plainMessageText(`hi <@user:${id}> <@user:${id.toUpperCase()}>`, (value) =>
      value === id ? 'Renamed' : undefined,
    ),
  ).toBe('hi @Renamed @Renamed')
  expect(plainMessageText(`hi <@user:${id}> <@user:broken>`, () => undefined)).toBe(
    'hi @member @member',
  )
})
test('empty attachment excerpts are worded, whitespace folded and text remains plain', () => {
  expect(plainMessageText('  \n ', () => undefined, 'image')).toBe('[image]')
  expect(plainMessageText(null, () => undefined, 'file')).toBe('[file]')
  expect(plainMessageText('hello\n world <script>', () => undefined, 'file')).toBe(
    'hello world <script>',
  )
})
