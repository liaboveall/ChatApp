import { describe, expect, test } from 'vitest'
import { formatMark, toggleMark } from './format-keys.ts'

const key = (
  name: string,
  mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {},
) => ({ key: name, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods })

describe('formatMark', () => {
  test('Ctrl+B, Ctrl+I and Ctrl+Shift+X on Windows and Linux', () => {
    expect(formatMark(key('b', { ctrlKey: true }), false)).toBe('**')
    expect(formatMark(key('I', { ctrlKey: true }), false)).toBe('*')
    expect(formatMark(key('X', { ctrlKey: true, shiftKey: true }), false)).toBe('~~')
  })

  test('the Command key on a Mac, where Ctrl+B moves the caret', () => {
    expect(formatMark(key('b', { metaKey: true }), true)).toBe('**')
    expect(formatMark(key('b', { ctrlKey: true }), true)).toBeNull()
    expect(formatMark(key('b', { metaKey: true }), false)).toBeNull()
  })

  test('other keys and other chords are left alone', () => {
    expect(formatMark(key('b'), false)).toBeNull()
    expect(formatMark(key('k', { ctrlKey: true }), false)).toBeNull()
    expect(formatMark(key('b', { ctrlKey: true, altKey: true }), false)).toBeNull()
    expect(formatMark(key('b', { ctrlKey: true, shiftKey: true }), false)).toBeNull()
    expect(formatMark(key('x', { ctrlKey: true }), false)).toBeNull()
    expect(formatMark(key('b', { ctrlKey: true, metaKey: true }), false)).toBeNull()
  })
})

describe('toggleMark', () => {
  test('wraps the selection and keeps the same words selected', () => {
    expect(toggleMark({ text: 'say hello now', start: 4, end: 9 }, '**')).toEqual({
      text: 'say **hello** now',
      start: 6,
      end: 11,
    })
  })

  test('with nothing selected the caret stands between the marks', () => {
    expect(toggleMark({ text: 'abc', start: 3, end: 3 }, '~~')).toEqual({
      text: 'abc~~~~',
      start: 5,
      end: 5,
    })
  })

  test('takes the marks off again, whether they are around the selection or in it', () => {
    expect(toggleMark({ text: 'say **hello** now', start: 6, end: 11 }, '**')).toEqual({
      text: 'say hello now',
      start: 4,
      end: 9,
    })
    expect(toggleMark({ text: 'say **hello** now', start: 4, end: 13 }, '**')).toEqual({
      text: 'say hello now',
      start: 4,
      end: 9,
    })
  })

  test('italic inside bold is added, not mistaken for the bold marks', () => {
    expect(toggleMark({ text: '**word**', start: 2, end: 6 }, '*')).toEqual({
      text: '***word***',
      start: 3,
      end: 7,
    })
    expect(toggleMark({ text: '**word**', start: 0, end: 8 }, '*')).toEqual({
      text: '***word***',
      start: 1,
      end: 9,
    })
    expect(toggleMark({ text: '*word*', start: 1, end: 5 }, '*')).toEqual({
      text: 'word',
      start: 0,
      end: 4,
    })
  })

  test('works on Chinese text and at the ends of the field', () => {
    expect(toggleMark({ text: '周五上线', start: 0, end: 4 }, '**')).toEqual({
      text: '**周五上线**',
      start: 2,
      end: 6,
    })
  })
})
