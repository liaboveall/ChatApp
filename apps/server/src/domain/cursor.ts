/**
 * Pagination and sync cursors (docs/05 section 4.5, D-126). A cursor is signed, so a client can hand it back but cannot
 * invent or edit one, and it names everything it was issued for: who asked (user, auth epoch, restore epoch), what
 * (conversation and membership), where the scan stands and where it ends. A cursor presented under any other
 * circumstance is not an error to explain: it is a reason to start over, and `decodeCursor` just returns null.
 */
import { LIMITS } from '@chatapp/contracts'
import { signPayload, verifyPayload } from '../lib/crypto.ts'
import type { Deps } from './deps.ts'
import type { SessionPrincipal } from './principal.ts'

/** Scan of one conversation's change log: `a` is the last entry already scanned, `t` the fixed upper bound. */
export type ConversationCursor = {
  k: 'cc'
  u: string
  ae: number
  re: string
  c: string
  m: string
  a: number
  t: number
  x: number
}

/** Scan of one user's change log. */
export type UserCursor = {
  k: 'uc'
  u: string
  ae: number
  re: string
  a: number
  t: number
  x: number
}

/** A page position in the member list, bound to the membership version the first page was read at. */
export type MembersCursor = {
  k: 'mem'
  u: string
  c: string
  v: number
  o: [number, string, string]
  x: number
}

/** A page position in channel discovery; `q` is the normalized query it belongs to. */
export type ChannelsCursor = { k: 'chn'; u: string; q: string; o: [string, string]; x: number }

type AnyCursor = ConversationCursor | UserCursor | MembersCursor | ChannelsCursor

export function encodeCursor(deps: Pick<Deps, 'config'>, cursor: AnyCursor): string {
  return signPayload(deps.config.auth.cursorKey, cursor)
}

/**
 * The cursor if its signature and expiry hold and it was issued for this very person and kind, otherwise null. Callers
 * compare the remaining fields (conversation, membership, epochs) against the present state themselves.
 */
export function decodeCursor<K extends AnyCursor['k']>(
  deps: Pick<Deps, 'config' | 'clock'>,
  token: string,
  kind: K,
  principal: Pick<SessionPrincipal, 'userId'>,
): Extract<AnyCursor, { k: K }> | null {
  const payload = verifyPayload(deps.config.auth.cursorKey, token)
  if (payload === null || typeof payload !== 'object') return null
  const cursor = payload as Partial<AnyCursor>
  if (cursor.k !== kind || cursor.u !== principal.userId) return null
  if (typeof cursor.x !== 'number' || cursor.x <= deps.clock.now().getTime()) return null
  return cursor as Extract<AnyCursor, { k: K }>
}

export const cursorExpiry = (deps: Pick<Deps, 'clock'>): number =>
  deps.clock.now().getTime() + LIMITS.changesCursorTtlMs
