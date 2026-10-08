import { ChevronDown, MessagesSquare } from 'lucide-react'
import { type KeyboardEvent, useMemo, useState } from 'react'
import { usePresenceWatch } from '@/app/presence.ts'
import { engine } from '@/app/sync.ts'
import { Button } from '@/components/ui/button.tsx'
import { EmptyState } from '@/components/ui/feedback.tsx'
import { Icon } from '@/components/ui/icon.tsx'
import { useShell } from '@/lib/shell-state.ts'
import { useSidebarGroups, useUsers } from '@/lib/sync/hooks.ts'
import { type SidebarGroupKey, sidebarOrder } from '@/lib/sync/selectors.ts'
import { useSyncUi } from '@/lib/sync/state.ts'
import { m } from '@/paraglide/messages.js'
import { SidebarItem } from './sidebar-item.tsx'
import { SidebarMenu, type SidebarMenuTarget } from './sidebar-menu.tsx'

const groupTitle = (key: SidebarGroupKey): string => {
  switch (key) {
    case 'pinned':
      return m.sidebar_group_pinned()
    case 'channel':
      return m.sidebar_group_channels()
    case 'group':
      return m.sidebar_group_groups()
    case 'dm':
      return m.sidebar_group_dms()
    case 'agent':
      return m.agent_chats()
  }
}

/**
 * The conversations of the sidebar: pinned first, then channels, groups and direct messages. One row is the tab stop of
 * the whole list and the arrow keys move between rows (docs/02 section 7); each group folds, remembered on this device.
 */
export function SidebarList({ meId, currentId }: { meId: string; currentId: string | undefined }) {
  const ready = useSyncUi((state) => state.ready)
  const loadError = useSyncUi((state) => state.loadError)
  const groups = useSidebarGroups()
  const users = useUsers()
  const folded = useShell((state) => state.folded)
  const toggleFolded = useShell((state) => state.toggleFolded)
  const [roving, setRoving] = useState<string | null>(null)
  const [menu, setMenu] = useState<SidebarMenuTarget | null>(null)
  // The people on the other end of direct messages: their status shows on the avatar.
  const peers = useMemo(
    () =>
      sidebarOrder(groups).flatMap((item) =>
        item.conversation.kind === 'dm' && item.conversation.dmPeer
          ? [item.conversation.dmPeer.id]
          : [],
      ),
    [groups],
  )
  usePresenceWatch(peers, 1)

  const visible = useMemo(
    () =>
      sidebarOrder(groups.filter((group) => !(group.key in folded))).map(
        (item) => item.conversation.id,
      ),
    [groups, folded],
  )
  // The tab stop: the row the person last focused, else the open conversation, else the first row.
  const tabStopId =
    (roving !== null && visible.includes(roving) ? roving : null) ??
    (currentId !== undefined && visible.includes(currentId) ? currentId : null) ??
    visible[0] ??
    null

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
    if (!keys.includes(event.key) || event.altKey || event.metaKey || event.ctrlKey) return
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-roving]')]
    const at = rows.indexOf(document.activeElement as HTMLElement)
    if (at === -1) return
    event.preventDefault()
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? rows.length - 1
          : Math.min(rows.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))
    rows[next]?.focus()
  }

  if (!ready) {
    return loadError ? (
      <EmptyState icon={MessagesSquare} title={m.sidebar_load_failed()} className="sidebar__empty">
        <Button kind="tinted" size="sm" onClick={() => void engine.reload()}>
          {m.common_retry()}
        </Button>
      </EmptyState>
    ) : (
      <p className="sidebar__loading" role="status">
        {m.common_loading()}
      </p>
    )
  }

  if (groups.length === 0) {
    return (
      <EmptyState icon={MessagesSquare} title={m.shell_empty_title()} className="sidebar__empty">
        <span className="sidebar__empty-text">{m.shell_empty_text()}</span>
      </EmptyState>
    )
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move between the links inside (roving tab stop); the links are the interactive elements
    <div onKeyDown={onKeyDown}>
      {groups.map((group) => {
        const open = !(group.key in folded)
        return (
          <section className="s-section" key={group.key} aria-label={groupTitle(group.key)}>
            <div className="s-section__head">
              <button
                type="button"
                className="s-section__toggle focus-inset"
                aria-expanded={open}
                onClick={() => toggleFolded(group.key)}
              >
                <Icon icon={ChevronDown} size={16} />
                <span>{groupTitle(group.key)}</span>
              </button>
            </div>
            {open ? (
              <ul className="s-list">
                {group.items.map((item) => (
                  <li key={item.conversation.id}>
                    <SidebarItem
                      conversation={item.conversation}
                      unread={item.unread}
                      previewHidden={item.previewHidden}
                      users={users}
                      meId={meId}
                      tabStop={item.conversation.id === tabStopId}
                      onFocus={() => setRoving(item.conversation.id)}
                      onMenu={setMenu}
                    />
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        )
      })}
      <SidebarMenu target={menu} onClose={() => setMenu(null)} />
    </div>
  )
}
