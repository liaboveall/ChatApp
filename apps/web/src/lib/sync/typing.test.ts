import { beforeEach, describe, expect, test } from 'vitest'
import { applyTyping, nextExpiry, typersOf, useTyping } from './typing.ts'

const C = 'c1'
const ME = 'me'
const event = (userId: string, state: 'start' | 'stop' = 'start') => ({
  conversationId: C,
  userId,
  state,
  expiresInMs: 5000,
})
const read = () => useTyping.getState()

beforeEach(() => useTyping.setState({ byConversation: {} }))

describe('typing', () => {
  test('someone who starts is shown until the moment the hint named', () => {
    applyTyping(event('bea'), ME, 1000)
    expect(typersOf(read(), C, 1000)).toEqual(['bea'])
    expect(typersOf(read(), C, 5999)).toEqual(['bea'])
    expect(typersOf(read(), C, 6000)).toEqual([])
  })

  test('another hint from the same person moves the end of their typing forward', () => {
    applyTyping(event('bea'), ME, 1000)
    applyTyping(event('bea'), ME, 4000)
    expect(typersOf(read(), C, 8000)).toEqual(['bea'])
    expect(typersOf(read(), C, 9000)).toEqual([])
  })

  test('stop removes them at once; stopping someone who was not typing changes nothing', () => {
    applyTyping(event('bea'), ME, 1000)
    applyTyping(event('bea', 'stop'), ME, 1500)
    expect(typersOf(read(), C, 1500)).toEqual([])
    const before = read()
    applyTyping(event('cal', 'stop'), ME, 1600)
    expect(read()).toBe(before)
  })

  test('my own typing, from another device of mine, is not shown to me', () => {
    applyTyping(event(ME), ME, 1000)
    expect(typersOf(read(), C, 1000)).toEqual([])
  })

  test('several people are listed in the order they started', () => {
    applyTyping(event('bea'), ME, 1000)
    applyTyping(event('cal'), ME, 2000)
    expect(typersOf(read(), C, 2500)).toEqual(['bea', 'cal'])
  })

  test('other conversations are separate, and a conversation nobody types in is a stable empty list', () => {
    applyTyping(event('bea'), ME, 1000)
    expect(typersOf(read(), 'other', 1000)).toBe(typersOf(read(), 'another', 1000))
  })

  test('the next expiry tells a screen when to look again', () => {
    expect(nextExpiry(read(), C, 0)).toBeNull()
    applyTyping(event('bea'), ME, 1000)
    applyTyping(event('cal'), ME, 3000)
    expect(nextExpiry(read(), C, 1000)).toBe(6000)
    expect(nextExpiry(read(), C, 6500)).toBe(8000)
    expect(nextExpiry(read(), C, 9000)).toBeNull()
  })
})
