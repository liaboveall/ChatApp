import type { Me } from '@chatapp/contracts'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { Archive, Compass, Hash, MessageCircle, Plus, Search, Settings, Users } from 'lucide-react'
import { Avatar } from '@/components/ui/avatar.tsx'
import { IconButton } from '@/components/ui/button.tsx'
import { Icon } from '@/components/ui/icon.tsx'
import { Menu, MenuItem } from '@/components/ui/menu.tsx'
import type { NewKind } from '@/features/conversations/new-conversation-dialog.tsx'
import { SidebarList } from '@/features/conversations/sidebar-list.tsx'
import { keyLabel } from '@/lib/platform.ts'
import { m } from '@/paraglide/messages.js'

type SidebarProps = {
  me: Pick<Me, 'id' | 'username' | 'displayName' | 'avatarUrl'>
  onOpenPalette: () => void
  onOpenSettings: (section: 'appearance' | 'account') => void
  onCreate: (kind: NewKind) => void
}

/**
 * Search field, the conversation list and the signed-in user's card. Every part of the card is a real control: the name
 * opens the account settings, the gear opens the settings.
 */
export function Sidebar({ me, onOpenPalette, onOpenSettings, onCreate }: SidebarProps) {
  const navigate = useNavigate()
  const path = useRouterState({ select: (state) => state.location.pathname })
  const currentId = /^\/c\/([0-9a-f-]{36})$/i.exec(path)?.[1]
  return (
    <>
      <div className="sidebar__top">
        <button
          type="button"
          className="search search--plate focus-inset"
          aria-label={m.shell_search_aria()}
          aria-keyshortcuts="Control+K Meta+K"
          onClick={onOpenPalette}
        >
          <Icon icon={Search} size={16} />
          <span className="search__text">{m.shell_search_placeholder()}</span>
          <kbd>{keyLabel('mod')} K</kbd>
        </button>
        <Menu
          align="end"
          trigger={<IconButton label={m.sidebar_new()} icon={Plus} aria-haspopup="menu" />}
        >
          <MenuItem icon={Hash} onClick={() => onCreate('channel')}>
            {m.sidebar_new_channel()}
          </MenuItem>
          <MenuItem icon={Users} onClick={() => onCreate('group')}>
            {m.sidebar_new_group()}
          </MenuItem>
          <MenuItem icon={MessageCircle} onClick={() => onCreate('dm')}>
            {m.sidebar_new_dm()}
          </MenuItem>
          <MenuItem icon={Compass} onClick={() => void navigate({ to: '/channels' })}>
            {m.sidebar_browse()}
          </MenuItem>
          <MenuItem icon={Archive} onClick={() => void navigate({ to: '/archived' })}>
            {m.sidebar_archived()}
          </MenuItem>
        </Menu>
      </div>
      <div className="sidebar__scroll scroll">
        <SidebarList meId={me.id} currentId={currentId} />
      </div>
      <div className="sidebar__user">
        <button
          type="button"
          className="sidebar__user-main focus-inset"
          aria-label={m.shell_user_menu({ name: me.displayName })}
          onClick={() => onOpenSettings('account')}
        >
          <Avatar src={me.avatarUrl} name={me.displayName} seed={me.id} size={34} />
          <div>
            <div className="sidebar__user-name">{me.displayName}</div>
            <div className="sidebar__user-status">@{me.username}</div>
          </div>
        </button>
        <IconButton
          label={m.shell_settings()}
          icon={Settings}
          shortcut={['mod', ',']}
          onClick={() => onOpenSettings('appearance')}
        />
      </div>
    </>
  )
}
