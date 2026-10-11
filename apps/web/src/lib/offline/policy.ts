/**
 * How long, and how much, the browser keeps (docs/03 section 11, D-205). Pure: it gets the records that are on disk and says
 * which stay and which go, so every rule is exercised without a browser.
 *
 *  - another account, another login generation or another restore generation: gone, unread;
 *  - a record that does not read as a record of this app: gone;
 *  - a draft, or a message waiting for the person, unchanged for 7 days: gone;
 *  - more than 50 MiB in all: the oldest go first.
 *
 * The 24 hours of the queue are not a retention rule: a message older than that is not deleted but is no longer sent by
 * itself (`isStale`), and stays for the person to send again or delete.
 */
import { LIMITS } from '@chatapp/contracts'
import { keyOf, type Stamp, type StoredRecord, sameStamp, storedRecordSchema } from './records.ts'

const DAY_MS = 24 * 60 * 60 * 1000

export type Kept = { key: string; record: StoredRecord }

export type Retention = {
  keep: Kept[]
  /** The disk keys to delete. */
  drop: string[]
}

export type Limits = { keepMs: number; maxBytes: number }

export const DEFAULT_LIMITS: Limits = {
  keepMs: LIMITS.offlineDraftDays * DAY_MS,
  maxBytes: LIMITS.offlineCacheMaxBytes,
}

/** What a record takes on disk, roughly: two bytes for every UTF-16 code unit of its JSON. */
export const sizeOf = (record: StoredRecord): number => JSON.stringify(record).length * 2

export function planRetention(
  entries: ReadonlyArray<readonly [string, unknown]>,
  who: Stamp,
  now: number,
  limits: Limits = DEFAULT_LIMITS,
): Retention {
  const drop: string[] = []
  const live: Kept[] = []
  for (const [key, value] of entries) {
    const parsed = storedRecordSchema.safeParse(value)
    if (
      !parsed.success ||
      !sameStamp(parsed.data, who) ||
      // The key says whose it is and what it is; a record stored under another key is not trusted.
      keyOf(parsed.data) !== key ||
      now - parsed.data.updatedAt > limits.keepMs
    ) {
      drop.push(key)
      continue
    }
    live.push({ key, record: parsed.data })
  }
  // Over the cap: the oldest change goes first, until what is left fits.
  live.sort((a, b) => b.record.updatedAt - a.record.updatedAt)
  let total = 0
  const keep: Kept[] = []
  for (const entry of live) {
    total += sizeOf(entry.record)
    if (total > limits.maxBytes) drop.push(entry.key)
    else keep.push(entry)
  }
  return { keep, drop }
}

/** A message written this long ago is no longer sent by itself: the person decides (docs/05 section 3.4). */
export const isStale = (createdAt: string, now: number): boolean =>
  now - Date.parse(createdAt) > LIMITS.offlineQueueMaxAgeMs
