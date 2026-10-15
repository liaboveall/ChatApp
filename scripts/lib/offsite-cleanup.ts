import type { ConditionalStore } from '../../apps/server/src/storage/conditional.ts'

/** Only an isolated, UUID-owned admission namespace may be enumerated and removed. Never accepts a bucket root. */
export async function cleanupOffsiteRun(store: ConditionalStore, prefix: string): Promise<void> {
  if (
    !/^m7-(admission|journal-admission|recovery|restic|credential-rotation)\/[a-f0-9-]{36}\/$/.test(
      prefix,
    )
  )
    throw new Error('offsite cleanup ownership required')
  const keys: string[] = [],
    cursors = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await store.list(prefix, cursor)
    if (page.keys.some((key) => !key.startsWith(prefix)))
      throw new Error('offsite cleanup ownership violation')
    keys.push(...page.keys)
    cursor = page.cursor
    if (cursor) {
      if (cursors.has(cursor)) throw new Error('offsite cleanup pagination loop')
      cursors.add(cursor)
    }
  } while (cursor)
  for (const key of new Set(keys)) await store.delete(key)
  if ((await store.list(prefix)).keys.length) throw new Error('offsite cleanup incomplete')
}
