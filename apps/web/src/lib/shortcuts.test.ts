import { describe, expect, test } from 'vitest'
import { matchShortcut } from './shortcuts.ts'

type Init = Partial<Parameters<typeof matchShortcut>[0]>
const press = (key: string, init: Init = {}) => ({
  key,
  code: '',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  defaultPrevented: false,
  ...init,
})

describe('matchShortcut', () => {
  test('Ctrl is the modifier on Windows and Linux, Command on Apple platforms', () => {
    expect(matchShortcut(press('k', { ctrlKey: true }), false)).toBe('palette')
    expect(matchShortcut(press('k', { metaKey: true }), false)).toBeNull()
    expect(matchShortcut(press('k', { metaKey: true }), true)).toBe('palette')
    expect(matchShortcut(press('k', { ctrlKey: true }), true)).toBeNull()
  })

  test('the four shortcuts of docs/02 section 7 that exist in M1', () => {
    const ctrl = { ctrlKey: true }
    expect(matchShortcut(press('K', ctrl), false)).toBe('palette') // Caps Lock
    expect(matchShortcut(press('j', ctrl), false)).toBe('assistant')
    expect(matchShortcut(press(',', ctrl), false)).toBe('settings')
    expect(matchShortcut(press('/', ctrl), false)).toBe('help')
    expect(matchShortcut(press('x', ctrl), false)).toBeNull()
  })

  test('extra modifiers make it a different shortcut', () => {
    expect(matchShortcut(press('k', { ctrlKey: true, shiftKey: true }), false)).toBeNull()
    expect(matchShortcut(press('k', { ctrlKey: true, altKey: true }), false)).toBeNull()
    expect(matchShortcut(press('k', { ctrlKey: true, metaKey: true }), false)).toBeNull()
  })

  test('nothing fires while an input method is composing, or when something else already handled the key', () => {
    expect(matchShortcut(press('k', { ctrlKey: true, isComposing: true }), false)).toBeNull()
    expect(matchShortcut(press('k', { ctrlKey: true, defaultPrevented: true }), false)).toBeNull()
  })

  test('⌥ and ⌥⇧ with the up and down arrows move through the conversations', () => {
    const alt = { altKey: true }
    expect(matchShortcut(press('ArrowUp', alt), false)).toBe('previous')
    expect(matchShortcut(press('ArrowDown', alt), false)).toBe('next')
    expect(matchShortcut(press('ArrowUp', { ...alt, shiftKey: true }), false)).toBe(
      'previousUnread',
    )
    expect(matchShortcut(press('ArrowDown', { ...alt, shiftKey: true }), false)).toBe('nextUnread')
    // Apple platforms report the arrows the same way.
    expect(matchShortcut(press('ArrowDown', alt), true)).toBe('next')
  })

  test('the arrows alone, with ⌘/Ctrl, or with AltGr are not navigation', () => {
    expect(matchShortcut(press('ArrowUp'), false)).toBeNull()
    expect(matchShortcut(press('ArrowUp', { shiftKey: true }), false)).toBeNull()
    expect(matchShortcut(press('ArrowUp', { ctrlKey: true }), false)).toBeNull()
    expect(matchShortcut(press('ArrowUp', { altKey: true, ctrlKey: true }), false)).toBeNull()
    expect(matchShortcut(press('ArrowUp', { altKey: true, metaKey: true }), true)).toBeNull()
    expect(matchShortcut(press('ArrowUp', { altKey: true, isComposing: true }), false)).toBeNull()
  })

  test('on a layout without Latin letters the physical key decides, on a Latin layout the letter does', () => {
    // Russian layout: Ctrl+K sends key "л" on the physical K key.
    expect(matchShortcut(press('л', { ctrlKey: true, code: 'KeyK' }), false)).toBe('palette')
    // Dvorak: the physical K key types "t"; that is Ctrl+T, not the palette.
    expect(matchShortcut(press('t', { ctrlKey: true, code: 'KeyK' }), false)).toBeNull()
  })
})
