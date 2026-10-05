/**
 * What the screens need to know about the sync layer that is not conversation data itself (D-150): which scope the
 * engine serves (every Query key is built from it), whether the first load is done, which conversations are behind
 * ("not synced", NFR-08), what the person has read locally but the server has not confirmed yet, and where the "new
 * messages" separator of each open conversation sits. Plain data in a zustand store, reset when the engine stops.
 */
import { create } from 'zustand'
import type { SyncScope } from './types.ts'

/** `missing`: the server says there is no such conversation for me (it does not say why, and neither do we). */
export type LoadState = 'loading' | 'ready' | 'error' | 'missing'

export type SyncUi = {
  /** The scope the engine serves, or null while it is stopped or before it started. */
  scope: SyncScope | null
  /** The conversation index is loaded (the sidebar can show its real content). */
  ready: boolean
  /** The first load of the index failed; the screen offers a retry. */
  loadError: boolean
  /** Consecutive failed catch-up rounds per conversation; above 0 the toolbar says "not synced". */
  failures: Record<string, number>
  /** Failed rounds of the personal catch-up. */
  userFailures: number
  /** Per conversation: the first load of its timeline. A missing entry means nothing was asked for yet. */
  timelines: Record<string, LoadState>
  /** Read positions the client asked for and the server has not confirmed: the unread count counts them as read. */
  pendingRead: Record<string, number>
  /** Per open conversation: messages after this `seq` are "new" (the separator sits before the first one). */
  anchors: Record<string, number>
}

export const initialSyncUi = (): SyncUi => ({
  scope: null,
  ready: false,
  loadError: false,
  failures: {},
  userFailures: 0,
  timelines: {},
  pendingRead: {},
  anchors: {},
})

export const useSyncUi = create<SyncUi>()(initialSyncUi)

/** The conversation ids that are currently behind (for the toolbar's "not synced"). */
export const isBehind = (state: SyncUi, conversationId: string): boolean =>
  (state.failures[conversationId] ?? 0) > 0 || state.userFailures > 0

/** Unread count as shown: what the server counts, minus what this client has already read (D-152). */
export function unreadOf(
  lastSeq: number,
  lastReadSeq: number,
  pendingRead: number | undefined,
): number {
  return Math.max(0, lastSeq - Math.max(lastReadSeq, pendingRead ?? 0))
}

function patchRecord<T>(
  record: Record<string, T>,
  id: string,
  value: T | undefined,
): Record<string, T> {
  if (value === undefined) {
    if (!(id in record)) return record
    const { [id]: _removed, ...rest } = record
    return rest
  }
  return record[id] === value ? record : { ...record, [id]: value }
}

export const syncUi = {
  reset: (): void => useSyncUi.setState(initialSyncUi(), true),
  setFailures: (id: string, count: number): void =>
    useSyncUi.setState((s) => ({
      failures: patchRecord(s.failures, id, count > 0 ? count : undefined),
    })),
  setUserFailures: (count: number): void => useSyncUi.setState({ userFailures: count }),
  setTimeline: (id: string, state: LoadState | undefined): void =>
    useSyncUi.setState((s) => ({ timelines: patchRecord(s.timelines, id, state) })),
  setPendingRead: (id: string, seq: number | undefined): void =>
    useSyncUi.setState((s) => ({ pendingRead: patchRecord(s.pendingRead, id, seq) })),
  setAnchor: (id: string, seq: number | undefined): void =>
    useSyncUi.setState((s) => ({ anchors: patchRecord(s.anchors, id, seq) })),
  /** Forgets everything the store keeps about one conversation. */
  forget: (id: string): void =>
    useSyncUi.setState((s) => ({
      failures: patchRecord(s.failures, id, undefined),
      timelines: patchRecord(s.timelines, id, undefined),
      pendingRead: patchRecord(s.pendingRead, id, undefined),
      anchors: patchRecord(s.anchors, id, undefined),
    })),
}
