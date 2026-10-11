/**
 * The disk side of the offline store (D-205): IndexedDB through `idb-keyval`, in a database of its own. Nothing here throws:
 * a private window, blocked site data and a full disk all come out as "nothing stored", and the page works without it.
 */
import { clear, createStore, delMany, entries, set } from 'idb-keyval'
import { DEFAULT_LIMITS, type Limits, planRetention, type Retention } from './policy.ts'
import {
  type DraftRecord,
  keyOf,
  type QueuedRecord,
  type Stamp,
  type StoredRecord,
} from './records.ts'

/** The few operations the store needs from a key-value database; the tests give it one that lives in memory. */
export type Backend = {
  entries(): Promise<Array<[string, unknown]>>
  set(key: string, value: unknown): Promise<void>
  delete(keys: string[]): Promise<void>
  clear(): Promise<void>
}

const database = () => createStore('chatapp-local', 'records')
let opened: ReturnType<typeof createStore> | undefined

async function quiet<T>(action: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await action()
  } catch {
    return fallback
  }
}

export const idbBackend: Backend = {
  entries: () =>
    quiet(async () => {
      opened ??= database()
      return (await entries(opened)).map(
        ([key, value]) => [String(key), value] as [string, unknown],
      )
    }, []),
  set: (key, value) =>
    quiet(async () => {
      opened ??= database()
      await set(key, value, opened)
    }, undefined),
  delete: (keys) =>
    quiet(async () => {
      opened ??= database()
      await delMany(keys, opened)
    }, undefined),
  clear: () =>
    quiet(async () => {
      opened ??= database()
      await clear(opened)
    }, undefined),
}

export type Loaded = { drafts: DraftRecord[]; queued: QueuedRecord[] }

export class OfflineStore {
  readonly #backend: Backend
  readonly #now: () => number
  readonly #limits: Limits

  constructor(
    backend: Backend = idbBackend,
    now: () => number = Date.now,
    limits: Limits = DEFAULT_LIMITS,
  ) {
    this.#backend = backend
    this.#now = now
    this.#limits = limits
  }

  /**
   * Reads what is on disk for this account and generation, and deletes the rest (other accounts, ended generations, expired
   * and surplus records) without having looked at it. Returns what stays, with the keys it was read from.
   */
  async load(
    who: Stamp,
    current: () => boolean = () => true,
  ): Promise<Loaded & { retention: Retention }> {
    const rows = await this.#backend.entries()
    const empty = { drafts: [], queued: [], retention: { keep: [], drop: [] } }
    if (!current()) return empty
    const retention = planRetention(rows, who, this.#now(), this.#limits)
    if (retention.drop.length > 0) await this.#backend.delete(retention.drop)
    if (!current()) return empty
    const loaded: Loaded = { drafts: [], queued: [] }
    for (const { record } of retention.keep) {
      if (record.kind === 'draft') loaded.drafts.push(record)
      else loaded.queued.push(record)
    }
    return { ...loaded, retention }
  }

  async put(record: StoredRecord, current: () => boolean = () => true): Promise<void> {
    if (!current()) return
    await this.#backend.set(keyOf(record), record)
    // The disk ceiling applies while the page remains open too, not just at the next reload. The account guard is checked
    // after every asynchronous read, before pruning anything belonging to the account now using this browser.
    if (!current()) return
    const rows = await this.#backend.entries()
    if (!current()) return
    const retention = planRetention(rows, record, this.#now(), this.#limits)
    if (retention.drop.length > 0) await this.#backend.delete(retention.drop)
  }

  async remove(keys: string[], current: () => boolean = () => true): Promise<void> {
    if (current() && keys.length > 0) await this.#backend.delete(keys)
  }

  /** Everything, for every account: what a sign-out leaves behind is nothing. */
  async clear(): Promise<void> {
    await this.#backend.clear()
  }
}
