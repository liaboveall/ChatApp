/**
 * Who is told about what (docs/01 section 4.8, AT-22). The rules are one pure function so the truth table can be read, and
 * tested, row by row; everything that needs the database (who the recipients are, what they set) is gathered by the
 * callers and passed in.
 *
 *   event                                  all      mentions   none / muted
 *   -------------------------------------  -------  ---------  -------------
 *   ordinary message by a person           push     -          -
 *   mention of me, reply to me             push     push       -
 *   approval waiting, my reminder          push *   push *     -   (* the assistant switch)
 *   system line, edit, assistant output    nothing at all
 *
 * The account's push switch beats every row. The in-site centre keeps mentions, replies, approvals and reminders whatever
 * the level, because it is where one looks things up, not what interrupts (docs/01 section 4.8).
 */
import type { NotifyLevel } from '@chatapp/contracts'

export type NotifyEvent = 'plain' | 'mention' | 'reply' | 'approval' | 'reminder'

export type NotifyPreferences = {
  /** The account's master switch for browser push (`settings.pushEnabled`, on unless turned off). */
  pushEnabled: boolean
  /** Pushes about the assistant (`settings.pushAssistant`, on unless turned off). */
  assistantEnabled: boolean
  /** The level the person chose for the conversation the event belongs to. */
  level: NotifyLevel
  /** A mute is in force right now (forever, or until a time that has not come). */
  muted: boolean
}

export type NotifyDecision = {
  /** Keep an entry in the in-site centre. */
  site: boolean
  /** Send a browser push. */
  push: boolean
}

export function decideNotification(event: NotifyEvent, who: NotifyPreferences): NotifyDecision {
  const site = event !== 'plain'
  if (!who.pushEnabled || who.muted || who.level === 'none') return { site, push: false }
  switch (event) {
    case 'plain':
      return { site, push: who.level === 'all' }
    case 'mention':
    case 'reply':
      return { site, push: true }
    case 'approval':
    case 'reminder':
      return { site, push: who.assistantEnabled }
  }
}

/** A mute that is in force at `now`: forever, or limited and not yet over (a lapsed one is just "off", docs/01 section 4.8). */
export function isMuted(
  member: { muteMode: 'off' | 'until' | 'forever'; mutedUntil: Date | null },
  now: Date,
): boolean {
  if (member.muteMode === 'forever') return true
  return member.muteMode === 'until' && member.mutedUntil !== null && member.mutedUntil > now
}

/** The account-level settings that govern push, read from `users.settings` with their defaults. */
export function pushSettingsOf(settings: Record<string, unknown>): {
  pushEnabled: boolean
  assistantEnabled: boolean
  preview: boolean
} {
  return {
    pushEnabled: settings.pushEnabled !== false,
    assistantEnabled: settings.pushAssistant !== false,
    preview: settings.pushPreview === true,
  }
}
