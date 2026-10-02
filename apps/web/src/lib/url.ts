/**
 * The URL fragment carries one-time credentials and invitation codes: it never reaches a server (docs/01 section 4.1,
 * docs/05 section 3.1). The pages read it into memory and take it out of the address bar at once.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'

/**
 * Removes the fragment from the address bar without touching the router: a credential in `#...` must not stay in the
 * history, in screenshots or in shared links. The router's own `replace` would give the history entry a new key and
 * remount the page, so the browser API is used directly.
 */
export function stripFragment(): void {
  if (window.location.hash === '') return
  window.history.replaceState(
    window.history.state,
    '',
    window.location.pathname + window.location.search,
  )
}

function subscribe(notify: () => void): () => void {
  window.addEventListener('hashchange', notify)
  window.addEventListener('popstate', notify)
  return () => {
    window.removeEventListener('hashchange', notify)
    window.removeEventListener('popstate', notify)
  }
}

/** The browser's current fragment (with the leading #). Follows links pasted into a tab that is already open. */
export function useWindowHash(): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.hash,
    () => '',
  )
}

function readKey(hash: string, key: string, isValid: (value: string) => boolean): string | null {
  const found = new URLSearchParams(hash.replace(/^#/, '')).get(key)
  return found !== null && isValid(found) ? found : null
}

/**
 * The value of `key` in the fragment, kept once seen: the first time one arrives it is stored in memory and the
 * fragment is removed from the address bar, so later renders (and a hash that is empty again) still have it.
 * `arrived` becomes true as soon as the page has seen any fragment at all, valid or not, and stays true.
 */
export function useFragmentValue(
  key: string,
  isValid: (value: string) => boolean = () => true,
): { value: string | null; arrived: boolean } {
  const hash = useWindowHash()
  // Read on the first render, not in an effect, so a valid link never flashes an "invalid link" state.
  const [value, setValue] = useState<string | null>(() =>
    readKey(window.location.hash, key, isValid),
  )
  const [arrived, setArrived] = useState(() => window.location.hash.length > 1)
  useEffect(() => {
    const found = readKey(hash, key, isValid)
    if (found !== null) setValue(found)
    if (hash.length > 1) setArrived(true)
    stripFragment()
  }, [hash, key, isValid])
  return { value, arrived }
}
