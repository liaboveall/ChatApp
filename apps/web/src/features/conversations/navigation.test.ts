import { describe, expect, test } from 'vitest'
import { neighbourOf } from './navigation.ts'

const list = (spec: string) =>
  spec.split(' ').map((entry) => ({ id: entry.replace('*', ''), unread: entry.endsWith('*') }))

describe('neighbourOf', () => {
  test('moves one place and wraps at both ends', () => {
    const items = list('a b c')
    expect(neighbourOf(items, 'a', 1, false)).toBe('b')
    expect(neighbourOf(items, 'c', 1, false)).toBe('a')
    expect(neighbourOf(items, 'a', -1, false)).toBe('c')
    expect(neighbourOf(items, 'b', -1, false)).toBe('a')
  })

  test('without a current conversation forward starts at the top and back at the bottom', () => {
    const items = list('a b c')
    expect(neighbourOf(items, undefined, 1, false)).toBe('a')
    expect(neighbourOf(items, undefined, -1, false)).toBe('c')
    // A conversation that is not in the list (a channel I only look at) counts as none.
    expect(neighbourOf(items, 'zzz', 1, false)).toBe('a')
  })

  test('the unread ones only: skips what is read, wraps, and does not return the current one while others exist', () => {
    const items = list('a b* c d*')
    expect(neighbourOf(items, 'a', 1, true)).toBe('b')
    expect(neighbourOf(items, 'b', 1, true)).toBe('d')
    expect(neighbourOf(items, 'd', 1, true)).toBe('b')
    expect(neighbourOf(items, 'b', -1, true)).toBe('d')
    expect(neighbourOf(items, 'c', -1, true)).toBe('b')
  })

  test('nowhere to go: an empty list, no unread, or only the current one', () => {
    expect(neighbourOf([], 'a', 1, false)).toBeUndefined()
    expect(neighbourOf(list('a b'), 'a', 1, true)).toBeUndefined()
    expect(neighbourOf(list('a*'), 'a', 1, true)).toBeUndefined()
    expect(neighbourOf(list('a'), 'a', 1, false)).toBeUndefined()
  })

  test('with no current conversation the current one is not excluded: an unread one at the top is found', () => {
    expect(neighbourOf(list('a* b'), undefined, 1, true)).toBe('a')
    expect(neighbourOf(list('a b*'), undefined, -1, true)).toBe('b')
  })
})
