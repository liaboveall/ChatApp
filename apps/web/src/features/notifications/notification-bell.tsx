import { Bell, CheckCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { loadOlderNotices, markNoticesRead, refreshNotices } from '@/app/notifications.ts'
import { Badge } from '@/components/ui/badge.tsx'
import { Button, IconButton } from '@/components/ui/button.tsx'
import { Banner, Skeleton } from '@/components/ui/feedback.tsx'
import { Popover } from '@/components/ui/popover.tsx'
import { useNotices, useUnreadNotices } from '@/lib/notifications/store.ts'
import { m } from '@/paraglide/messages.js'
import { NotificationList } from './notification-list.tsx'

type NotificationBellProps = {
  onOpenSettings: (section: 'assistant') => void
  /** Start open (stories and tests). */
  defaultOpen?: boolean
}

/** The bell of the sidebar's user card: the unread count, and the list of notifications in a panel (docs/02 section 3). */
export function NotificationBell({ onOpenSettings, defaultOpen }: NotificationBellProps) {
  const [open, setOpen] = useState(defaultOpen ?? false)
  const unread = useUnreadNotices()
  const label = unread > 0 ? m.notice_bell_unread({ count: unread }) : m.notice_bell()
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label={m.notice_title()}
      side="top"
      align="start"
      className="notices"
      trigger={
        <IconButton label={label} icon={Bell} className="notice-bell" aria-haspopup="dialog">
          {unread > 0 ? (
            <Badge tone="danger" className="notice-bell__count">
              {unread > 99 ? '99+' : unread}
            </Badge>
          ) : null}
        </IconButton>
      }
    >
      <NotificationPanel
        unread={unread}
        onClose={() => setOpen(false)}
        onOpenSettings={onOpenSettings}
      />
    </Popover>
  )
}

function NotificationPanel({
  unread,
  onClose,
  onOpenSettings,
}: {
  unread: number
  onClose: () => void
  onOpenSettings: (section: 'assistant') => void
}) {
  const state = useNotices()
  // Opening the panel reads the newest page again: the count is exact the moment it is looked at.
  useEffect(() => {
    void refreshNotices()
  }, [])
  return (
    <div className="notices__panel">
      <div className="notices__head">
        <h2 className="notices__title">{m.notice_title()}</h2>
        <Button
          kind="plain"
          size="sm"
          icon={CheckCheck}
          disabled={unread === 0}
          onClick={() => void markNoticesRead({ all: true })}
        >
          {m.notice_mark_all()}
        </Button>
      </div>
      <div className="notices__body scroll">
        {state.items.length > 0 ? (
          <NotificationList
            items={state.items}
            onNavigate={onClose}
            onOpenSettings={(section) => {
              onClose()
              onOpenSettings(section)
            }}
          />
        ) : state.failed ? (
          <div className="notices__state">
            <Banner tone="danger">{m.notice_failed()}</Banner>
            <Button kind="tinted" size="sm" onClick={() => void refreshNotices()}>
              {m.common_retry()}
            </Button>
          </div>
        ) : !state.loaded ? (
          <div className="notices__state" role="status" aria-label={m.notice_loading()}>
            <Skeleton />
            <Skeleton />
            <Skeleton />
          </div>
        ) : (
          <div className="notices__empty">
            <p className="notices__empty-title">{m.notice_empty()}</p>
            <p className="notices__empty-text">{m.notice_empty_text()}</p>
          </div>
        )}
        {state.nextCursor ? (
          <div className="notices__more">
            <Button
              kind="plain"
              size="sm"
              busy={state.loading}
              onClick={() => void loadOlderNotices()}
            >
              {m.notice_older()}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
