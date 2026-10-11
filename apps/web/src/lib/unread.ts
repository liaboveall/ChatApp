/**
 * The number the title bar and the app icon show (docs/01 section 4.8, M6): everything unread in the conversations the
 * sidebar lists, leaving out those switched off and those muted right now. The server counts the same set for the badge
 * of a push (`unreadForBadge`), so a closed window and an open one agree.
 */
import type { Conversation } from '@chatapp/contracts'
import { isListed } from './sync/selectors.ts'
import { unreadOf } from './sync/state.ts'
import type { ConversationIndex } from './sync/types.ts'

export function mutedNow(
  mute: Conversation['me'] extends infer M ? (M extends { mute: infer U } ? U : never) : never,
  now: number,
): boolean {
  if (mute.mode === 'forever') return true
  return mute.mode === 'until' && Date.parse(mute.until) > now
}

export function unreadTotal(
  index: ConversationIndex,
  pendingRead: Record<string, number>,
  now: number,
): number {
  let total = 0
  for (const conversation of Object.values(index.byId)) {
    const me = conversation.me
    if (me === null || !isListed(conversation)) continue
    if (me.notifyLevel === 'none' || mutedNow(me.mute, now)) continue
    total += unreadOf(conversation.lastSeq, me.lastReadSeq, pendingRead[conversation.id])
  }
  return total
}

type BadgeNavigator = Navigator & {
  setAppBadge?: (count?: number) => Promise<void>
  clearAppBadge?: () => Promise<void>
}

/** Shows the count on the installed app's icon where the browser can (Badging API); anywhere else this does nothing. */
export function showAppBadge(count: number): void {
  try {
    const target = navigator as BadgeNavigator
    const done = count > 0 ? target.setAppBadge?.(count) : target.clearAppBadge?.()
    void done?.catch(() => undefined)
  } catch {
    // No Badging API: the title still says it.
  }
}
