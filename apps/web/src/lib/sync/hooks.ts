/**
 * React reading of the sync layer (D-150). The cache is read with `useSyncExternalStore` on the query cache instead of
 * `useQuery`: nothing here may fetch, retry or garbage-collect on its own, the engine alone decides what to read, and a
 * hook that only reads is the plain statement of that. A snapshot is the cached object itself, so a component re-renders
 * exactly when the engine wrote a different object under the key.
 */
import type { Conversation } from '@chatapp/contracts'
import { hashKey, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { syncKeys } from './keys.ts'
import { type SidebarGroup, sidebarGroups } from './selectors.ts'
import { type SyncUi, useSyncUi } from './state.ts'
import type { ConversationIndex, SyncScope, TimelineWindow, UsersByid } from './types.ts'

const EMPTY_INDEX: ConversationIndex = { byId: {}, removed: {}, previewHidden: {} }
const EMPTY_USERS: UsersByid = {}

/**
 * Reads one key of the cache and re-renders when the engine writes to it. Only events of *this* key wake it: the cache
 * also announces every observer another component creates while it renders (`useQuery`), and answering those would
 * update this component in the middle of someone else's render, which React rightly refuses.
 */
function useCached<T>(key: readonly unknown[] | null): T | undefined {
  const client = useQueryClient()
  const hash = key === null ? null : hashKey(key)
  const subscribe = useCallback(
    (notify: () => void) =>
      client.getQueryCache().subscribe((event) => {
        if (hash === null || event.query.queryHash !== hash) return
        if (event.type === 'added' || event.type === 'updated' || event.type === 'removed') notify()
      }),
    [client, hash],
  )
  return useSyncExternalStore(subscribe, () =>
    key === null ? undefined : client.getQueryData<T>(key),
  )
}

export const useSyncScope = (): SyncScope | null => useSyncUi((state) => state.scope)

/** The sidebar and the conversation screen wait for this before they show anything but a placeholder. */
export const useSyncReady = (): boolean => useSyncUi((state) => state.ready)

export function useConversationIndex(): ConversationIndex {
  const scope = useSyncScope()
  return (
    useCached<ConversationIndex>(scope === null ? null : syncKeys.conversations(scope)) ??
    EMPTY_INDEX
  )
}

export function useConversation(id: string): Conversation | undefined {
  return useConversationIndex().byId[id]
}

export function useUsers(): UsersByid {
  const scope = useSyncScope()
  return useCached<UsersByid>(scope === null ? null : syncKeys.users(scope)) ?? EMPTY_USERS
}

/** The window of a conversation as I am a member of it now; undefined while there is none. */
export function useTimelineWindow(id: string): TimelineWindow | undefined {
  const scope = useSyncScope()
  const membershipId = useConversation(id)?.me?.membershipId
  return useCached<TimelineWindow>(
    scope === null || membershipId === undefined
      ? null
      : syncKeys.timeline(scope, id, membershipId),
  )
}

/** The groups of the sidebar, recomputed only when the index or a claimed read position changes. */
export function useSidebarGroups(): SidebarGroup[] {
  const index = useConversationIndex()
  const pendingRead = useSyncUi((state: SyncUi) => state.pendingRead)
  return useMemo(() => sidebarGroups(index, pendingRead), [index, pendingRead])
}
