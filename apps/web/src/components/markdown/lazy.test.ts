import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** The loader keeps module-level state, so every test starts from a fresh copy of it. */
const fresh = async (): Promise<typeof import('./lazy.ts')> => {
  vi.resetModules()
  return import('./lazy.ts')
}

const working = (): void => {
  vi.doMock('./safe-markdown.tsx', () => ({
    SafeMarkdown: () => null,
    warmHighlighter: async () => undefined,
  }))
}

describe('loading the Markdown chunk (D-164)', () => {
  afterEach(() => {
    vi.doUnmock('./safe-markdown.tsx')
    vi.unstubAllGlobals()
  })

  it('loads once and hands out the renderer', async () => {
    working()
    const lazy = await fresh()
    expect(lazy.markdownRenderer()).toBeUndefined()
    await lazy.loadMarkdown()
    expect(lazy.markdownRenderer()).toBeTypeOf('function')
    // The second request is the same load, not another one.
    expect(lazy.loadMarkdown()).toBe(lazy.loadMarkdown())
  })

  it('does not remember a failed load: the next request asks again', async () => {
    vi.doMock('./safe-markdown.tsx', () => {
      throw new Error('the network dropped')
    })
    const lazy = await fresh()
    await expect(lazy.loadMarkdown()).rejects.toThrow()
    expect(lazy.markdownRenderer()).toBeUndefined()

    working()
    vi.resetModules()
    await lazy.loadMarkdown()
    expect(lazy.markdownRenderer()).toBeTypeOf('function')
  })

  it('a screen that waits keeps asking while the chunk will not come, and stops when it has it', async () => {
    vi.useFakeTimers()
    try {
      let attempts = 0
      vi.doMock('./safe-markdown.tsx', () => {
        attempts += 1
        if (attempts < 3) throw new Error('the network dropped')
        return { SafeMarkdown: () => null, warmHighlighter: async () => undefined }
      })
      const lazy = await fresh()
      const { result } = renderHook(() => lazy.useMarkdownReady())
      expect(result.current).toBe(false)
      await act(() => vi.advanceTimersByTimeAsync(0))
      expect(attempts).toBe(1)
      await act(() => vi.advanceTimersByTimeAsync(lazy.RETRY_MS))
      expect(attempts).toBe(2)
      expect(result.current).toBe(false)
      await act(() => vi.advanceTimersByTimeAsync(lazy.RETRY_MS))
      expect(attempts).toBe(3)
      expect(result.current).toBe(true)
      await act(() => vi.advanceTimersByTimeAsync(10 * lazy.RETRY_MS))
      expect(attempts).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a screen that waits does not ask while the browser is offline, and asks when it is back', async () => {
    let attempts = 0
    vi.doMock('./safe-markdown.tsx', () => {
      attempts += 1
      return { SafeMarkdown: () => null, warmHighlighter: async () => undefined }
    })
    vi.stubGlobal('navigator', { onLine: false })
    const lazy = await fresh()
    const { result } = renderHook(() => lazy.useMarkdownReady())
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
    expect(attempts).toBe(0)
    expect(result.current).toBe(false)

    vi.stubGlobal('navigator', { onLine: true })
    await act(async () => {
      window.dispatchEvent(new Event('online'))
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(attempts).toBe(1)
    expect(result.current).toBe(true)
  })

  it('warms the common grammars one at a time, and not at all while offline', async () => {
    vi.useFakeTimers()
    try {
      const warmed: string[] = []
      vi.doMock('./safe-markdown.tsx', () => ({
        SafeMarkdown: () => null,
        warmHighlighter: async (language: string) => {
          warmed.push(language)
        },
      }))
      vi.stubGlobal('requestIdleCallback', undefined)
      vi.stubGlobal('navigator', { onLine: true })
      const lazy = await fresh()
      await lazy.loadMarkdown()
      await vi.advanceTimersByTimeAsync(60)
      expect(warmed).toEqual(['ts'])
      await vi.advanceTimersByTimeAsync(110)
      expect(warmed).toEqual(['ts', 'tsx', 'js'])

      vi.stubGlobal('navigator', { onLine: false })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(warmed).toEqual(['ts', 'tsx', 'js'])
    } finally {
      vi.useRealTimers()
    }
  })
})
