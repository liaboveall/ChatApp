import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { setUnreadInTitle, useDocumentTitle, usePageTitle } from './page-title.ts'

afterEach(() => setUnreadInTitle(0))

describe('the document title', () => {
  test('a page sets its own title', () => {
    renderHook(() => usePageTitle('Sign in'))
    expect(document.title).toBe('Sign in · ChatApp')
    renderHook(() => usePageTitle(undefined))
    expect(document.title).toBe('ChatApp')
  })

  test('the unread count goes in front, capped at 99+, and leaves with the news', () => {
    renderHook(() => usePageTitle('Project team'))
    setUnreadInTitle(3)
    expect(document.title).toBe('(3) Project team · ChatApp')
    setUnreadInTitle(250)
    expect(document.title).toBe('(99+) Project team · ChatApp')
    setUnreadInTitle(0)
    expect(document.title).toBe('Project team · ChatApp')
  })

  test('a page change keeps the count', () => {
    setUnreadInTitle(2)
    renderHook(() => usePageTitle('Settings'))
    expect(document.title).toBe('(2) Settings · ChatApp')
  })

  test('what the installed app shows in its own title bar follows the title as it changes', () => {
    renderHook(() => usePageTitle('Project team'))
    const shown = renderHook(() => useDocumentTitle())
    expect(shown.result.current).toBe('Project team · ChatApp')
    act(() => setUnreadInTitle(4))
    expect(shown.result.current).toBe('(4) Project team · ChatApp')
  })
})
