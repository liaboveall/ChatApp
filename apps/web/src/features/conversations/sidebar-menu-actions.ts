/**
 * What the menu of a sidebar row offers (docs/01 section 4.4): the same settings the Inspector has for the person
 * themselves — pin, mute — plus marking as read, hiding a direct message and leaving. Pure: a conversation in, a set of
 * choices out, so the menu only has to draw it.
 */
import type { Conversation } from '@chatapp/contracts'

export type SidebarMenuActions = {
  /** What choosing the pin item does: pin it, or take the pin away. */
  pin: 'pin' | 'unpin'
  /** Mute until I turn it off, or lift a mute that is running. */
  mute: 'mute' | 'unmute'
  markRead: boolean
  /** A direct message can be hidden, never left. */
  hide: boolean
  /** A channel or a group can be left (the owner only when alone: the Inspector explains why not otherwise). */
  leave: boolean
}

export function sidebarMenuActions(
  conversation: Conversation,
  unread: number,
  muted: boolean,
): SidebarMenuActions | null {
  const me = conversation.me
  if (me === null) return null
  const managed = conversation.kind === 'channel' || conversation.kind === 'group'
  return {
    pin: me.pinnedAt !== null ? 'unpin' : 'pin',
    mute: muted ? 'unmute' : 'mute',
    markRead: unread > 0,
    hide: conversation.kind === 'dm',
    leave: managed && !(me.role === 'owner' && conversation.memberCount > 1),
  }
}
