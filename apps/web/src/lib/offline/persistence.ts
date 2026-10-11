/**
 * Keeping the person's own unsent words across a reload, a crash and a night without a network (docs/03 section 11, D-205).
 * What is kept is what `records.ts` allows and nothing more: drafts, and plain-text messages that wait for the network.
 *
 * The rules that matter:
 *  - nothing is written, and nothing deleted, until what is on disk has been put back (`restore`): an empty page that has just
 *    started must not erase the record of the last visit;
 *  - `restore` runs once the conversation list is known, because only then is the membership of each conversation known, and a
 *    draft or a message written under another membership is not put back as it was;
 *  - a record keeps its own `updatedAt` while it is unchanged, so starting the page does not renew the seven days;
 *  - when the account ends (`disarm`, `forgetOfflineData`) writing stops in the same turn.
 */

import { useCompose } from '../sync/compose.ts'
import { setDraft, useDrafts } from '../sync/drafts.ts'
import type { PendingMessage } from '../sync/outbox.ts'
import { useOutbox } from '../sync/outbox.ts'
import { useSyncUi } from '../sync/state.ts'
import type { SyncScope } from '../sync/types.ts'
import { isStale } from './policy.ts'
import {
  type DraftRecord,
  draftKey,
  keyOf,
  type QueuedRecord,
  queuedKey,
  type Stamp,
  type StoredRecord,
  stampOf,
  TEXT_MAX,
} from './records.ts'
import type { OfflineStore } from './store.ts'

export type PersistenceDeps = {
  store: OfflineStore
  /** Where the unsent messages go back to. */
  outbox: { restore(messages: PendingMessage[]): void }
  /** The scope the sync engine serves now. */
  scope: () => SyncScope | null
  /** The membership held in a conversation now, if any. */
  membershipOf: (conversationId: string) => string | undefined
  now: () => number
  /** A pause after the last change before writing, so typing is not a write per key. */
  debounceMs?: number
}

type Written = { signature: string; updatedAt: number }

/** What a record says apart from when it last changed. */
const signatureOf = (record: StoredRecord): string => {
  const { updatedAt: _when, ...rest } = record
  return JSON.stringify(rest)
}

export class Persistence {
  readonly #deps: PersistenceDeps
  #armed: SyncScope | null = null
  /** What is on disk for the armed account, by key. */
  #written = new Map<string, Written>()
  #timer: ReturnType<typeof setTimeout> | undefined
  #chain: Promise<void> = Promise.resolve()
  #revision = 0

  constructor(deps: PersistenceDeps) {
    this.#deps = deps
  }

  get armed(): boolean {
    return this.#armed !== null
  }

  /** Starts following the stores. Returns the function that stops. */
  watch(): () => void {
    const stops = [
      useDrafts.subscribe(() => this.#changed()),
      useOutbox.subscribe(() => this.#changed()),
      useCompose.subscribe(() => this.#changed()),
      useSyncUi.subscribe((state, before) => {
        if (state.scope !== before.scope) this.#scopeChanged(state.scope)
        // The list is known: drafts typed before that can now be told which membership they belong to.
        else if (state.ready && !before.ready) this.#changed()
      }),
    ]
    return () => {
      for (const stop of stops) stop()
    }
  }

  /**
   * Puts back what the last visit left for this account and generation, then starts keeping the stores on disk. Called when
   * the conversation list of the scope is loaded. A second call for the same scope starts over from disk.
   */
  async restore(scope: SyncScope): Promise<void> {
    this.disarm()
    const revision = this.#revision
    const current = () => this.#revision === revision && this.#deps.scope() === scope
    const who = stampOf(scope)
    const loaded = await this.#deps.store.load(who, current)
    // The account changed, or the session ended, while the disk was being read: none of it is for whoever is here now.
    if (!current()) return

    const now = this.#deps.now()
    const useless: string[] = []
    const written = new Map<string, Written>()

    for (const draft of loaded.drafts) {
      const key = keyOf(draft)
      const membership = this.#deps.membershipOf(draft.conversationId)
      if (membership !== draft.membershipId) {
        // Another membership (or none): what was typed for the old one is not put into the new one (D-171).
        useless.push(key)
        continue
      }
      // Something typed since this page opened is newer than what was kept, and is left alone (it replaces the record).
      if ((useDrafts.getState().byConversation[draft.conversationId] ?? '') === '') {
        setDraft(draft.conversationId, draft.text)
      }
      written.set(key, { signature: signatureOf(draft), updatedAt: draft.updatedAt })
    }

    const back: PendingMessage[] = []
    for (const record of loaded.queued) {
      const key = keyOf(record)
      const membership = this.#deps.membershipOf(record.conversationId)
      if (membership === undefined) {
        // Not in the conversation any more: there is nowhere to show it, and nobody to send it to.
        useless.push(key)
        continue
      }
      const ended = membership !== record.membershipId
      const stale = record.state === 'offline' && isStale(record.createdAt, now)
      const failed = record.state === 'failed' || ended || stale
      back.push({
        clientId: record.clientId,
        conversationId: record.conversationId,
        membershipId: record.membershipId,
        body: record.body,
        // A reply across a membership that ended would quote what the new one may not see.
        replyToId: ended ? null : record.replyToId,
        quote: null,
        createdAt: record.createdAt,
        state: failed ? 'failed' : 'offline',
        error: ended ? 'MEMBERSHIP_CHANGED' : stale ? 'QUEUE_EXPIRED' : record.error,
      })
      written.set(key, { signature: signatureOf(record), updatedAt: record.updatedAt })
    }

    this.#written = written
    this.#armed = scope
    if (useless.length > 0) await this.#deps.store.remove(useless, current)
    if (!current()) return
    this.#deps.outbox.restore(back)
    // What was changed on the way back (a message that became failed) is written at the next look.
    this.#changed()
  }

  /** Stops writing at once; what is on disk stays (a sign-out wipes it separately, see `forgetOfflineData`). */
  disarm(): void {
    this.#revision += 1
    this.#armed = null
    this.#written = new Map()
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
  }

  /** Writes what changed now (the page is being hidden or closed). */
  async flush(): Promise<void> {
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
    this.#chain = this.#chain.then(() => this.#write()).catch(() => undefined)
    await this.#chain
  }

  #changed(): void {
    if (this.#armed === null) return
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void this.flush()
    }, this.#deps.debounceMs ?? 400)
  }

  #scopeChanged(next: SyncScope | null): void {
    const armed = this.#armed
    if (armed === null) return
    if (next === null || next.userId !== armed.userId) {
      this.disarm()
      return
    }
    // The same person under a new login generation (a password change here): the stores stay, and are written under the new
    // stamp; the keys do not carry the generation, so each record is overwritten.
    this.#armed = next
    this.#revision += 1
    this.#written = new Map()
    this.#changed()
  }

  /** What the stores say should be on disk now, by key, and the keys that are not to be touched. */
  #desired(scope: SyncScope): { records: Map<string, StoredRecord>; keep: Set<string> } {
    const who: Stamp = stampOf(scope)
    const records = new Map<string, StoredRecord>()
    const keep = new Set<string>()
    const compose = useCompose.getState().byConversation

    for (const [conversationId, text] of Object.entries(useDrafts.getState().byConversation)) {
      if (text.trim() === '' || text.length > TEXT_MAX) continue
      const key = draftKey(who.userId, conversationId)
      // The field holds the text of a message being edited, not a draft: what was kept stays as it is until the edit ends.
      if (compose[conversationId]?.type === 'edit') {
        keep.add(key)
        continue
      }
      const membershipId = this.#deps.membershipOf(conversationId)
      if (membershipId === undefined) continue
      records.set(
        key,
        this.#stamped(key, {
          kind: 'draft',
          ...who,
          updatedAt: 0,
          conversationId,
          membershipId,
          text,
        }),
      )
    }

    for (const list of Object.values(useOutbox.getState().byConversation)) {
      for (const entry of list) {
        if (
          (entry.attachments?.length ?? 0) > 0 ||
          entry.body.trim() === '' ||
          entry.body.length > TEXT_MAX
        )
          continue
        const key = queuedKey(who.userId, entry.clientId)
        records.set(
          key,
          this.#stamped(key, {
            kind: 'queued',
            ...who,
            updatedAt: 0,
            conversationId: entry.conversationId,
            membershipId: entry.membershipId,
            clientId: entry.clientId,
            body: entry.body,
            replyToId: entry.replyToId,
            createdAt: entry.createdAt,
            // Waiting, being sent and about to be sent are all "not accepted yet": after a reload they wait for the network.
            state: entry.state === 'failed' ? 'failed' : 'offline',
            error: entry.state === 'failed' ? (entry.error ?? 'UNKNOWN').slice(0, 40) : null,
          }),
        )
      }
    }
    return { records, keep }
  }

  /** The record with the time of its last change: the one on disk if nothing changed, now if something did. */
  #stamped<T extends DraftRecord | QueuedRecord>(key: string, record: T): T {
    const before = this.#written.get(key)
    const unchanged = before !== undefined && before.signature === signatureOf(record)
    return { ...record, updatedAt: unchanged ? before.updatedAt : this.#deps.now() }
  }

  async #write(): Promise<void> {
    const scope = this.#armed
    if (scope === null || this.#deps.scope() !== scope) return
    const revision = this.#revision
    const current = () =>
      this.#revision === revision && this.#armed === scope && this.#deps.scope() === scope
    const { records, keep } = this.#desired(scope)
    const puts: Array<[string, StoredRecord]> = []
    for (const [key, record] of records) {
      if (this.#written.get(key)?.signature !== signatureOf(record)) puts.push([key, record])
    }
    const removals = [...this.#written.keys()].filter((key) => !records.has(key) && !keep.has(key))
    for (const [key, record] of puts) {
      // Checked again before each write: the account may have ended while the one before it was being written.
      if (!current()) return
      await this.#deps.store.put(record, current)
      if (!current()) return
      this.#written.set(key, { signature: signatureOf(record), updatedAt: record.updatedAt })
    }
    if (!current()) return
    await this.#deps.store.remove(removals, current)
    for (const key of removals) this.#written.delete(key)
  }
}
