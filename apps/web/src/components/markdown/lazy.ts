/**
 * The Markdown renderer weighs about 800 kB (Shiki, the parser, the entity table), so it is its own chunk: the sign-in
 * pages never load it, and the signed-in app fetches it when the browser is idle (D-145). Screens that show message text
 * wait for it before they build a list, so a row is never drawn as plain text and then redrawn as Markdown with another
 * height, which would move everything under it. A load that fails (the network drops at that moment) is not remembered:
 * the next request asks again, and a screen that is waiting keeps trying until the chunk is there (D-164).
 */
import { useEffect, useState } from 'react'

type Renderer = typeof import('./safe-markdown.tsx').SafeMarkdown

let renderer: Renderer | undefined
let loading: Promise<void> | undefined

/** The languages people paste most. Their grammars are loaded in idle time once the renderer is there (D-162). */
const COMMON_LANGUAGES = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'json',
  'bash',
  'sql',
  'python',
  'html',
  'css',
  'yaml',
  'diff',
]

/** True when the browser knows it is offline: nothing is worth asking for then. */
const isOffline = (): boolean => typeof navigator !== 'undefined' && !navigator.onLine

const whenIdle = (callback: () => void): void => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(callback, { timeout: 2000 })
  else setTimeout(callback, 50)
}

/**
 * One grammar at a time, each in an idle slice, so loading them never makes a frame late. It is a head start and nothing more: it stops for
 * good when the browser is offline (a code block that is shown later loads its own grammar), instead of failing a dozen
 * requests one by one.
 */
function warmGrammars(warm: (language: string) => Promise<void>): void {
  const queue = [...COMMON_LANGUAGES]
  const next = (): void => {
    if (isOffline()) return
    const language = queue.shift()
    if (language === undefined) return
    // The next one once this one is in, and then only when the browser has a moment.
    warm(language)
      .catch(() => undefined)
      .then(() => whenIdle(next))
  }
  whenIdle(next)
}

/** Starts loading the chunk (once, unless a load fails) and resolves when it is there. */
export function loadMarkdown(): Promise<void> {
  loading ??= import('./safe-markdown.tsx').then(
    (module) => {
      renderer = module.SafeMarkdown
      warmGrammars(module.warmHighlighter)
    },
    (error: unknown) => {
      loading = undefined
      throw error
    },
  )
  return loading
}

/** The renderer once the chunk has loaded, otherwise undefined. */
export const markdownRenderer = (): Renderer | undefined => renderer

/** How long a screen waits before it asks again after a failed load. */
export const RETRY_MS = 2000

/** True once the chunk is loaded; asks for it on first use, and again every couple of seconds while it will not come. */
export function useMarkdownReady(): boolean {
  const [ready, setReady] = useState(renderer !== undefined)
  useEffect(() => {
    if (ready) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const attempt = (): void => {
      if (!live) return
      if (isOffline()) {
        // Nothing to ask for until the network is back.
        window.addEventListener('online', attempt, { once: true })
        return
      }
      loadMarkdown().then(
        () => {
          if (live) setReady(true)
        },
        () => {
          if (live) timer = setTimeout(attempt, RETRY_MS)
        },
      )
    }
    attempt()
    return () => {
      live = false
      clearTimeout(timer)
      window.removeEventListener('online', attempt)
    }
  }, [ready])
  return ready
}

/**
 * Asks for the chunk when the browser has nothing better to do (after the signed-in app has appeared). Offline, or after a
 * failure, it is left for the screen that needs the chunk: that one asks again when it can.
 */
export function prefetchMarkdown(): void {
  const start = (): void => {
    if (!isOffline()) void loadMarkdown().catch(() => undefined)
  }
  if (typeof requestIdleCallback === 'function') requestIdleCallback(start, { timeout: 4000 })
  else setTimeout(start, 2000)
}
