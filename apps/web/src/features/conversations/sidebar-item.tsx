import type { Conversation } from '@chatapp/contracts'
import { Link } from '@tanstack/react-router'
import { BellOff } from 'lucide-react'
import { usePresenceOf } from '@/app/presence.ts'
import { Avatar } from '@/components/ui/avatar.tsx'
import { Badge } from '@/components/ui/badge.tsx'
import { Icon } from '@/components/ui/icon.tsx'
import { displayName } from '@/lib/sync/selectors.ts'
import type { UsersByid } from '@/lib/sync/types.ts'
import { listTime } from '@/lib/time-format.ts'
import { useTime } from '@/lib/use-time.ts'
import { m } from '@/paraglide/messages.js'
import { presenceLabel } from './presence-text.ts'
import { previewLine } from './preview.ts'
import type { SidebarMenuTarget } from './sidebar-menu.tsx'

type SidebarItemProps = {
  conversation: Conversation
  unread: number
  previewHidden: boolean
  users: UsersByid
  meId: string
  /** The roving tab stop: only one row of the list is reachable with Tab. */
  tabStop: boolean
  onFocus: () => void
  /** Opens the row's menu at a point (right click) or at the row (keyboard). */
  onMenu: (target: SidebarMenuTarget) => void
}

/** Whether the person asked for quiet in this conversation and the time has not run out. */
export function isMuted(conversation: Conversation, now: number): boolean {
  const mute = conversation.me?.mute
  if (mute === undefined) return false
  if (mute.mode === 'forever') return true
  return mute.mode === 'until' && Date.parse(mute.until) > now
}

const unreadLabel = (count: number): string => (count > 99 ? '99+' : String(count))

export function SidebarItem({
  conversation,
  unread,
  previewHidden,
  users,
  meId,
  tabStop,
  onFocus,
  onMenu,
}: SidebarItemProps) {
  const { locale, timeZone, now } = useTime()
  const name = displayName(conversation, m.conversation_unnamed())
  const peer = conversation.dmPeer
  const presence = usePresenceOf(peer?.id)
  const muted = isMuted(conversation, now())
  const pinned = conversation.me?.pinnedAt != null
  const preview = previewHidden
    ? ''
    : previewLine(conversation, users, meId, {
        you: m.preview_you(),
        recalled: m.preview_recalled(),
        deleted: m.preview_deleted(),
        system: m.preview_system(),
        withSender: (sender, text) => m.preview_with_sender({ sender, text }),
      })
  const when =
    conversation.lastMessageAt === null
      ? ''
      : listTime(
          conversation.lastMessageAt,
          now(),
          locale,
          { yesterday: m.time_yesterday() },
          timeZone,
        )
  const label = [
    name,
    unread > 0 ? m.sidebar_item_unread({ count: unread }) : null,
    pinned ? m.sidebar_item_pinned() : null,
    muted ? m.sidebar_item_muted() : null,
  ]
    .filter((part): part is string => part !== null)
    .join(', ')

  return (
    <Link
      to="/c/$conversationId"
      params={{ conversationId: conversation.id }}
      className="s-item focus-inset"
      data-unread={unread > 0 ? 'true' : 'false'}
      data-roving=""
      data-conversation-id={conversation.id}
      tabIndex={tabStop ? 0 : -1}
      aria-label={label}
      onFocus={onFocus}
      onContextMenu={(event) => {
        event.preventDefault()
        const { clientX: x, clientY: y } = event
        onMenu({
          conversation,
          unread,
          muted,
          anchor: { getBoundingClientRect: () => new DOMRect(x, y, 0, 0) },
        })
      }}
      onKeyDown={(event) => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault()
          onMenu({ conversation, unread, muted, anchor: event.currentTarget })
        }
      }}
    >
      <Avatar
        name={name}
        seed={peer?.id ?? conversation.id}
        size={36}
        glyph={conversation.kind === 'channel' ? 'hash' : undefined}
        bot={peer?.isBot === true}
        status={presence?.status}
        statusLabel={presence === undefined ? undefined : presenceLabel(presence.status)}
      />
      <span className="s-item__body">
        <span className="s-item__title">
          <span className="truncate">{name}</span>
        </span>
        <span className="s-item__preview">{preview}</span>
      </span>
      <span className="s-item__meta">
        <span className="s-item__time">
          {muted ? <Icon icon={BellOff} size={16} aria-hidden="true" /> : null}
          <span>{when}</span>
        </span>
        {unread > 0 ? (
          <span className="s-item__badges">
            <Badge tone={muted ? 'muted' : 'accent'}>{unreadLabel(unread)}</Badge>
          </span>
        ) : null}
      </span>
    </Link>
  )
}
