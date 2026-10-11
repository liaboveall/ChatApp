import { useEffect, useSyncExternalStore } from 'react'
import { PRODUCT_NAME } from './product.ts'

let base = PRODUCT_NAME
let unread = 0
const watchers = new Set<() => void>()

function apply(): void {
  const count = unread > 99 ? '99+' : String(unread)
  document.title = unread > 0 ? `(${count}) ${base}` : base
  for (const watcher of watchers) watcher()
}

const watch = (watcher: () => void): (() => void) => {
  watchers.add(watcher)
  return () => {
    watchers.delete(watcher)
  }
}

/** The document title as it is now: the installed app draws it itself when the browser does not (the title bar, M6). */
export function useDocumentTitle(): string {
  return useSyncExternalStore(watch, () => document.title)
}

/** The unread count in front of the title ("(3) Project team · ChatApp"), so a hidden tab says there is news (M6). */
export function setUnreadInTitle(count: number): void {
  if (count === unread) return
  unread = count
  apply()
}

/** Sets the document title ("Sign in · ChatApp"); every page has its own, which screen readers announce on navigation. */
export function usePageTitle(title: string | undefined): void {
  useEffect(() => {
    base = title ? `${title} · ${PRODUCT_NAME}` : PRODUCT_NAME
    apply()
  }, [title])
}
