import {
  ChevronRight,
  Command,
  Ellipsis,
  Keyboard,
  Menu as MenuIcon,
  Settings,
  Sparkles,
} from 'lucide-react'
import { type ReactNode, useRef } from 'react'
import { IconButton } from '@/components/ui/button.tsx'
import { Icon } from '@/components/ui/icon.tsx'
import { Menu, MenuItem } from '@/components/ui/menu.tsx'
import { Tooltip } from '@/components/ui/tooltip.tsx'
import { keyLabel } from '@/lib/platform.ts'
import { useFluidWidth } from '@/lib/use-fluid-width.ts'
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
 *
 * Going from one conversation to another, the capsule is the same pane of glass: it flows to the width of the new name
 * while the name and the picture take the place of the old ones (docs/02 section 4.5).
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
  // The capsule is a button where there is a conversation to look into, and a plain box where there is none: whichever
  // is on screen is the one that changes shape.
  const button = useRef<HTMLButtonElement>(null)
  const box = useRef<HTMLDivElement>(null)
  useFluidWidth(
    onToggleDetails ? button : box,
    `${onToggleDetails ? 'button' : 'box'}\n${title}\n${subtitle ?? ''}`,
  )
  const who = (
    <>
      <span className="toolbar__face" key={`face:${title}`}>
        {avatar}
      </span>
      <span className="toolbar__text">
        <span className="toolbar__title" key={title}>
          <span className="truncate">{title}</span>
        </span>
        {/* Keyed by the conversation, not by its own words: "last seen" is reworded every minute, where it stands. */}
        {subtitle ? (
          <span className="toolbar__sub" key={`sub:${title}`}>
            {subtitle}
          </span>
        ) : null}
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
            ref={button}
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
        <div ref={box} className="toolbar__who glass-text">
          {who}
        </div>
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
