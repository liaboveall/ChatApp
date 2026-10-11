/** WebKit reports a fetch from a document being replaced as a JavaScript error even when its rejection is handled. */
export type ReloadInterval = { from: number; committed: number | null }

export function isWebKitReloadCancellation(input: {
  engine: string
  origin: string
  stack: string | undefined
  at: number
  reloads: readonly ReloadInterval[]
}): boolean {
  const { engine, origin, stack, at, reloads } = input
  if (
    engine !== 'webkit' ||
    !reloads.some(
      (reload) => at >= reload.from && (reload.committed === null || at < reload.committed),
    )
  )
    return false
  const url = /^Fetch API cannot load (https?:\/\/\S+) due to access control checks\.(?:\n|$)/.exec(
    stack ?? '',
  )?.[1]
  if (!url) return false
  try {
    const resource = new URL(url)
    return resource.origin === origin && resource.pathname.startsWith('/api/')
  } catch {
    return false
  }
}
