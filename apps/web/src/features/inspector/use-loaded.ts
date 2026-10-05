/**
 * Loads something for the Inspector and loads it again when asked or when its key changes. While it reloads the old
 * answer stays on screen (a list that flickers away and back every time somebody joins is worse than one that is a moment
 * behind), and an answer that arrives for a request that is no longer the latest is dropped.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export type Loaded<T> =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; value: T }

export function useLoaded<T>(
  load: () => Promise<T>,
  /** Changes when what is loaded may have changed (a version from the sync layer); the load runs again. */
  key: string | number,
): { state: Loaded<T>; reload: () => void } {
  const [state, setState] = useState<Loaded<T>>({ status: 'loading' })
  const latest = useRef(load)
  const token = useRef(0)
  useEffect(() => {
    latest.current = load
  })

  const run = useCallback((): void => {
    token.current += 1
    const mine = token.current
    latest.current().then(
      (value) => {
        if (token.current === mine) setState({ status: 'ready', value })
      },
      (error: unknown) => {
        // A failed reload keeps what is already shown; only a first load turns into the error state.
        if (token.current === mine) {
          setState((old) => (old.status === 'ready' ? old : { status: 'error', error }))
        }
      },
    )
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: loads again whenever the key (a version) changes
  useEffect(() => {
    run()
    return () => {
      token.current += 1
    }
  }, [run, key])

  return { state, reload: run }
}
