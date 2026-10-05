import type { PresenceEntry } from '@chatapp/contracts'
import { useEffect } from 'react'
import { presenceWatch } from '@/app/realtime.ts'
import { usePresence } from '@/lib/sync/presence.ts'

/**
 * Follow the online status of the people a screen shows while it is mounted (docs/05 section 4.3). `priority` decides who
 * is dropped first when more than 200 people are wanted at once: the open conversation outranks the sidebar.
 */
export function usePresenceWatch(userIds: readonly string[], priority: number): void {
  const key = userIds.join(',')
  useEffect(
    () => presenceWatch.want({ userIds: key === '' ? [] : key.split(','), priority }),
    [key, priority],
  )
}

/** What the server last said of a person; undefined until it has answered for them. */
export function usePresenceOf(userId: string | null | undefined): PresenceEntry | undefined {
  return usePresence((state) => (userId == null ? undefined : state.byUser[userId]))
}
