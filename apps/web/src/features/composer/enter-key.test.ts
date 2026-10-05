import { describe, expect, test } from 'vitest'
import {
  COMPOSITION_END_GRACE_MS,
  type CompositionState,
  type EnterKeyEvent,
  initialComposition,
  shouldSend,
} from './enter-key.ts'

const enter = (patch: Partial<EnterKeyEvent> = {}): EnterKeyEvent => ({
  key: 'Enter',
  shiftKey: false,
  isComposing: false,
  keyCode: 13,
  ...patch,
})
const idle = initialComposition()

describe('shouldSend', () => {
  test('a plain Enter sends', () => {
    expect(shouldSend(enter(), idle, 1000)).toBe(true)
  })

  test('Shift+Enter is a new line, not a send', () => {
    expect(shouldSend(enter({ shiftKey: true }), idle, 1000)).toBe(false)
  })

  test('other keys never send', () => {
    expect(shouldSend(enter({ key: 'a', keyCode: 65 }), idle, 1000)).toBe(false)
  })

  test('Enter held with Alt, Ctrl or Meta is left to the browser', () => {
    for (const modifier of ['altKey', 'ctrlKey', 'metaKey'] as const) {
      expect(shouldSend(enter({ [modifier]: true }), idle, 1000), modifier).toBe(false)
    }
  })

  test('while a composition is going on, Enter only confirms the candidate (Chromium: isComposing, key code 229)', () => {
    expect(shouldSend(enter({ isComposing: true }), idle, 1000)).toBe(false)
    expect(shouldSend(enter({ keyCode: 229 }), idle, 1000)).toBe(false)
  })

  test('the composition flag from compositionstart/compositionend counts as well', () => {
    const composing: CompositionState = { composing: true, endedAt: Number.NEGATIVE_INFINITY }
    expect(shouldSend(enter(), composing, 1000)).toBe(false)
  })

  test('Safari: the confirming Enter arrives right after compositionend and must not send', () => {
    const justEnded: CompositionState = { composing: false, endedAt: 1000 }
    expect(shouldSend(enter(), justEnded, 1000)).toBe(false)
    expect(shouldSend(enter(), justEnded, 1000 + COMPOSITION_END_GRACE_MS - 1)).toBe(false)
  })

  test('a later Enter, a person pressing it on purpose, sends again', () => {
    const ended: CompositionState = { composing: false, endedAt: 1000 }
    expect(shouldSend(enter(), ended, 1000 + COMPOSITION_END_GRACE_MS)).toBe(true)
    expect(shouldSend(enter(), ended, 5000)).toBe(true)
  })
})
