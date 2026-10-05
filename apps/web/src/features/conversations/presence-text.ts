import type { PresenceEntry } from '@chatapp/contracts'
import { relativeTime } from '@/lib/time-format.ts'
import { m } from '@/paraglide/messages.js'

export type PresenceWords = {
  online: string
  away: string
  offline: string
  /** "Last seen {when}". */
  lastSeen: (when: string) => string
}

/** What the toolbar says under a direct message's name: online, away, or when the person was last here. */
export function presenceText(
  entry: PresenceEntry | undefined,
  now: number,
  locale: string,
  words: PresenceWords,
): string | null {
  if (entry === undefined) return null
  if (entry.status === 'online') return words.online
  if (entry.status === 'away') return words.away
  return entry.lastSeenAt === null
    ? words.offline
    : words.lastSeen(relativeTime(entry.lastSeenAt, now, locale))
}

/** The words for the status dot on an avatar, for assistive technology (the dot is a picture, its meaning is this). */
export const presenceLabel = (status: PresenceEntry['status']): string =>
  status === 'online'
    ? m.presence_online()
    : status === 'away'
      ? m.presence_away()
      : m.presence_offline()
