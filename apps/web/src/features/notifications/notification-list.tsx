import type { Notification } from '@chatapp/contracts'
import { useNavigate } from '@tanstack/react-router'
import { AtSign, BellRing, CornerUpLeft, Flag, Gauge, Info, Sparkles } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { markNoticesRead, refreshNoticesForClick } from '@/app/notifications.ts'
import { engine } from '@/app/sync.ts'
import { Icon } from '@/components/ui/icon.tsx'
import { useAgent } from '@/features/agent/store.ts'
import { cx } from '@/lib/cx.ts'
import { useNotices } from '@/lib/notifications/store.ts'
import { type NoticeTarget, noticeLine, noticeTarget } from '@/lib/notifications/text.ts'
import { relativeTime } from '@/lib/time-format.ts'
import { useTime } from '@/lib/use-time.ts'
import { m } from '@/paraglide/messages.js'
import { noticeWords } from './use-notice-words.ts'

const GLYPH = {
  mention: AtSign,
  reply: CornerUpLeft,
  approval_requested: Sparkles,
  reminder: BellRing,
  budget_alert: Gauge,
  report_opened: Flag,
} as const

type NotificationListProps = {
  items: readonly Notification[]
  /** Called after a click has been handled, so the panel can close. */
  onNavigate?: () => void
  onOpenSettings?: (section: 'assistant') => void
}

/** The entries as rows; a click marks the entry read and goes to where it happened. */
export function NotificationList({ items, onNavigate, onOpenSettings }: NotificationListProps) {
  const navigate = useNavigate()
  const { locale, now } = useTime()
  const words = noticeWords()
  const clicks = useRef(0)
  useEffect(
    () => () => {
      clicks.current += 1
    },
    [],
  )

  const go = (target: NoticeTarget): void => {
    if (target.kind === 'conversation') {
      // The same jump the search uses: the conversation opens at that message.
      if (target.seq !== null) {
        useAgent.setState((s) => ({
          jumps: { ...s.jumps, [target.conversationId]: target.seq ?? 0 },
        }))
      }
      void navigate({ to: '/c/$conversationId', params: { conversationId: target.conversationId } })
    } else if (target.kind === 'settings') {
      onOpenSettings?.(target.section)
    }
    onNavigate?.()
  }

  const open = (entry: Notification, target: NoticeTarget): void => {
    const mine = ++clicks.current
    if (target.kind !== 'none') {
      if (entry.readAt === null) void markNoticesRead({ ids: [entry.id] })
      go(target)
      return
    }
    const ticket = engine.ticket(null)
    void (async () => {
      if (!(await refreshNoticesForClick()) || !engine.isCurrent(ticket) || mine !== clicks.current)
        return
      // Read the store again in this turn: a source may have been invalidated even after the awaited read finished.
      const current = useNotices.getState().items.find((item) => item.id === entry.id)
      if (!current) return
      if (current.readAt === null) void markNoticesRead({ ids: [current.id] })
      go(noticeTarget(current))
    })()
  }

  return (
    <ul className="notices__list" aria-label={m.notice_title()}>
      {items.map((entry) => {
        const line = noticeLine(entry, words)
        const target = noticeTarget(entry)
        const unread = entry.readAt === null
        const glyph =
          entry.data && 'available' in entry.data && entry.data.available === false
            ? Info
            : GLYPH[entry.type]
        return (
          <li key={entry.id}>
            <button
              type="button"
              className={cx('notice focus-inset', unread && 'notice--unread')}
              onClick={() => open(entry, target)}
            >
              <span className="notice__glyph" aria-hidden="true">
                <Icon icon={glyph} size={16} />
              </span>
              <span className="notice__text">
                <span className="notice__title">
                  {unread ? <span className="sr-only">{m.notice_unread()}: </span> : null}
                  {line.title}
                </span>
                {line.detail ? <span className="notice__detail">{line.detail}</span> : null}
              </span>
              <time className="notice__time" dateTime={entry.createdAt}>
                {relativeTime(entry.createdAt, now(), locale)}
              </time>
              {unread ? <span className="notice__dot" aria-hidden="true" /> : null}
            </button>
          </li>
        )
      })}
    </ul>
  )
}
