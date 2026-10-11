/** WebKit reports a fetch from a document being replaced as a JavaScript error even when its rejection is handled. */
export type DocumentReplacementInterval = {
  from: number
  committed: number | null
  document?: boolean
}

export function isWebKitDocumentCancellation(input: {
  engine: string
  origin: string
  stack: string | undefined
  at: number
  replacements: readonly DocumentReplacementInterval[]
}): boolean {
  const { engine, origin, stack, at, replacements } = input
  if (
    engine !== 'webkit' ||
    !replacements.some(
      (replacement) =>
        replacement.document !== false &&
        at >= replacement.from &&
        (replacement.committed === null || at < replacement.committed),
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
