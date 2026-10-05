/**
 * The choices offered for durations (docs/05 sections 3.3): how long a person is silenced, how long a conversation is
 * muted, how long a group link lasts and how often it may be used. Fixed lists of plain values: the dialogs word them,
 * the server checks them again (a silence or a mute must end in the future and within a year).
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export const SILENCE_CHOICES = ['10m', '1h', '1d', '7d', '30d'] as const
export type SilenceChoice = (typeof SILENCE_CHOICES)[number]

const SILENCE_MS: Record<SilenceChoice, number> = {
  '10m': 10 * MINUTE,
  '1h': HOUR,
  '1d': DAY,
  '7d': 7 * DAY,
  '30d': 30 * DAY,
}

/** The end of a silence of this length starting now (a finite instant, as the server requires). */
export const silenceUntil = (choice: SilenceChoice, now: number): string =>
  new Date(now + SILENCE_MS[choice]).toISOString()

/** The mutes offered. A running mute that ends at a given time shows as `until` (see `muteSelection`) but is never offered as new. */
export const MUTE_CHOICES = ['off', '1h', '8h', '1d', '7d', 'forever'] as const
export type MuteChoice = (typeof MUTE_CHOICES)[number]

const MUTE_MS: Record<'1h' | '8h' | '1d' | '7d', number> = {
  '1h': HOUR,
  '8h': 8 * HOUR,
  '1d': DAY,
  '7d': 7 * DAY,
}

export type MuteSetting = { mode: 'off' } | { mode: 'forever' } | { mode: 'until'; until: string }

export const muteFromChoice = (choice: MuteChoice, now: number): MuteSetting => {
  if (choice === 'off') return { mode: 'off' }
  if (choice === 'forever') return { mode: 'forever' }
  return { mode: 'until', until: new Date(now + MUTE_MS[choice]).toISOString() }
}

/** What the mute select shows for the setting: `until` that has already passed counts as off. */
export function muteSelection(mute: MuteSetting, now: number): MuteChoice | 'until' {
  if (mute.mode === 'off') return 'off'
  if (mute.mode === 'forever') return 'forever'
  return Date.parse(mute.until) > now ? 'until' : 'off'
}

export const INVITE_DAYS = [1, 7, 30, 90] as const
export const INVITE_DEFAULT_DAYS = 7
/** null is "no limit". */
export const INVITE_USES = [null, 1, 10, 100] as const
export type InviteUses = (typeof INVITE_USES)[number]

/** The link a created invitation is shared as. The code stays after the `#`, so it never reaches a server log (D-045). */
export const inviteLink = (origin: string, code: string): string => `${origin}/join#${code}`

export type InviteState = 'active' | 'revoked' | 'expired' | 'used_up'

export function inviteState(
  invite: { revokedAt: string | null; expiresAt: string; maxUses: number | null; useCount: number },
  now: number,
): InviteState {
  if (invite.revokedAt !== null) return 'revoked'
  if (Date.parse(invite.expiresAt) <= now) return 'expired'
  if (invite.maxUses !== null && invite.useCount >= invite.maxUses) return 'used_up'
  return 'active'
}
