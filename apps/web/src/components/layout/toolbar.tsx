import { Command, Ellipsis, Keyboard, Menu as MenuIcon, Settings, Sparkles } from 'lucide-react'
import { AppIcon } from '@/components/brand/app-icon.tsx'
import { IconButton } from '@/components/ui/button.tsx'
import { Menu, MenuItem } from '@/components/ui/menu.tsx'
import { keyLabel } from '@/lib/platform.ts'
import { m } from '@/paraglide/messages.js'

type ToolbarProps = {
  title: string
  subtitle?: string
  assistantOpen: boolean
  onToggleAssistant: () => void
  onOpenDrawer: () => void
  onOpenPalette: () => void
  onOpenSettings: () => void
  onOpenShortcuts: () => void
}

/** Top glass bar of the main panel: title on the left, the assistant-panel toggle and the more menu on the right. */
export function Toolbar({
  title,
  subtitle,
  assistantOpen,
  onToggleAssistant,
  onOpenDrawer,
  onOpenPalette,
  onOpenSettings,
  onOpenShortcuts,
}: ToolbarProps) {
  const mod = keyLabel('mod')
  return (
    <header className="toolbar">
      <IconButton
        label={m.shell_open_menu()}
        icon={MenuIcon}
        className="toolbar__menu-btn"
        onClick={onOpenDrawer}
      />
      <div className="toolbar__who">
        <AppIcon size={34} />
        <span className="grid min-w-0">
          <span className="toolbar__title">
            <span className="truncate">{title}</span>
          </span>
          {subtitle ? <span className="toolbar__sub">{subtitle}</span> : null}
        </span>
      </div>
      <div className="toolbar__actions">
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
