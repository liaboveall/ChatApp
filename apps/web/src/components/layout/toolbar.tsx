import {
  ChevronRight,
  Command,
  Ellipsis,
  Keyboard,
  Menu as MenuIcon,
  Settings,
  Sparkles,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { IconButton } from '@/components/ui/button.tsx'
import { Icon } from '@/components/ui/icon.tsx'
import { Menu, MenuItem } from '@/components/ui/menu.tsx'
import { Tooltip } from '@/components/ui/tooltip.tsx'
import { keyLabel } from '@/lib/platform.ts'
import { m } from '@/paraglide/messages.js'

type ToolbarProps = {
  title: string
  subtitle?: string | null
  /** What stands before the title: the app icon, or the avatar of the open conversation. */
  avatar: ReactNode
  /** Opens the conversation's details; undefined when there is no conversation open. */
  onToggleDetails?: () => void
  detailsOpen?: boolean
  assistantOpen: boolean
  onToggleAssistant: () => void
  onOpenDrawer: () => void
  onOpenPalette: () => void
  onOpenSettings: () => void
  onOpenShortcuts: () => void
}

/**
 * What floats at the top of the main area (docs/02 section 3): a capsule with the open conversation's picture and name,
 * and a capsule of tools. The strip between them is not a surface. The name is the way into the conversation's details:
 * the whole capsule is the button, named for what it opens, and its chevron turns while the details are open.
 */
export function Toolbar({
  title,
  subtitle,
  avatar,
  onToggleDetails,
  detailsOpen,
  assistantOpen,
  onToggleAssistant,
  onOpenDrawer,
  onOpenPalette,
  onOpenSettings,
  onOpenShortcuts,
}: ToolbarProps) {
  const mod = keyLabel('mod')
  const who = (
    <>
      {avatar}
      <span className="toolbar__text">
        <span className="toolbar__title">
          <span className="truncate">{title}</span>
        </span>
        {subtitle ? <span className="toolbar__sub">{subtitle}</span> : null}
      </span>
    </>
  )
  return (
    <header className="toolbar">
      <IconButton
        label={m.shell_open_menu()}
        icon={MenuIcon}
        variant="plate"
        className="toolbar__menu-btn"
        onClick={onOpenDrawer}
      />
      {onToggleDetails ? (
        <Tooltip content={m.toolbar_members()}>
          <button
            type="button"
            className="toolbar__who glass-text"
            aria-label={m.toolbar_members()}
            // The button is named for what it opens; which conversation it is about is its description.
            aria-description={subtitle ? `${title}, ${subtitle}` : title}
            aria-pressed={detailsOpen === true}
            onClick={onToggleDetails}
          >
            {who}
            <Icon icon={ChevronRight} size={16} className="toolbar__chevron" />
          </button>
        </Tooltip>
      ) : (
        <div className="toolbar__who glass-text">{who}</div>
      )}
      <div className="toolbar__actions glass-clear">
        <IconButton
          label={m.shell_assistant_panel()}
          icon={Sparkles}
          shortcut={['mod', 'J']}
          aria-pressed={assistantOpen}
          onClick={onToggleAssistant}
        />
        <Menu
          align="end"
          trigger={<IconButton label={m.shell_more()} icon={Ellipsis} aria-haspopup="menu" />}
        >
          <MenuItem icon={Command} hint={`${mod} K`} onClick={onOpenPalette}>
            {m.shell_menu_palette()}
          </MenuItem>
          <MenuItem icon={Settings} hint={`${mod} ,`} onClick={onOpenSettings}>
            {m.shell_settings()}
          </MenuItem>
          <MenuItem icon={Keyboard} hint={`${mod} /`} onClick={onOpenShortcuts}>
            {m.shell_menu_shortcuts()}
          </MenuItem>
        </Menu>
      </div>
    </header>
  )
}
