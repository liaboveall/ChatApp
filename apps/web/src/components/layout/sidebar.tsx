import type { Me } from '@chatapp/contracts'
import { MessagesSquare, Search, Settings } from 'lucide-react'
import { Avatar } from '@/components/ui/avatar.tsx'
import { IconButton } from '@/components/ui/button.tsx'
import { EmptyState } from '@/components/ui/feedback.tsx'
import { Icon } from '@/components/ui/icon.tsx'
import { keyLabel } from '@/lib/platform.ts'
import { m } from '@/paraglide/messages.js'

type SidebarProps = {
  me: Pick<Me, 'id' | 'username' | 'displayName' | 'avatarUrl'>
  onOpenPalette: () => void
  onOpenSettings: (section: 'appearance' | 'account') => void
}

/**
 * Search field, the conversation list (empty until M2) and the signed-in user's card. Every part of the card is a real
 * control: the name opens the account settings, the gear opens the settings.
 */
export function Sidebar({ me, onOpenPalette, onOpenSettings }: SidebarProps) {
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
      </div>
      <div className="sidebar__scroll scroll">
        <EmptyState icon={MessagesSquare} title={m.shell_empty_title()} className="sidebar__empty">
          <span className="sidebar__empty-text">{m.shell_empty_text()}</span>
        </EmptyState>
      </div>
      <div className="sidebar__user">
        <button
          type="button"
          className="sidebar__user-main focus-inset"
          aria-label={m.shell_user_menu({ name: me.displayName })}
          onClick={() => onOpenSettings('account')}
        >
          <Avatar name={me.displayName} seed={me.id} size={34} />
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
