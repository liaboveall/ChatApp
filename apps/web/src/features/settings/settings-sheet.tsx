import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import type { Me } from '@chatapp/contracts'
import { Link } from '@tanstack/react-router'
import { Palette, Ticket, User, X } from 'lucide-react'
import { useRef } from 'react'
import { IconButton } from '@/components/ui/button.tsx'
import { useModalFlag } from '@/components/ui/dialog.tsx'
import { Icon } from '@/components/ui/icon.tsx'
import { m } from '@/paraglide/messages.js'
import { AccountSection } from './account-section.tsx'
import { AppearanceSection } from './appearance-section.tsx'
import { InvitesSection } from './invites-section.tsx'

export const SETTINGS_SECTIONS = ['appearance', 'account', 'invites'] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

const TABS = [
  { id: 'appearance', icon: Palette, label: () => m.settings_tab_appearance() },
  { id: 'account', icon: User, label: () => m.settings_tab_account() },
  { id: 'invites', icon: Ticket, label: () => m.settings_tab_invites() },
] as const

type SettingsSheetProps = {
  /** The open section, or undefined when the sheet is closed. */
  section: SettingsSection | undefined
  me: Me
  onClose: () => void
  onSignOut: () => void
}

/** Settings as a glass sheet over the app. Its state is the URL (`?settings=account`), so Back closes it. */
export function SettingsSheet({ section, me, onClose, onSignOut }: SettingsSheetProps) {
  const open = section !== undefined
  useModalFlag(open)
  // Focus the sheet itself rather than its first tab: a ring on "Appearance" would suggest it needs attention.
  const popup = useRef<HTMLDivElement>(null)
  const current = TABS.find((tab) => tab.id === section)
  return (
    <BaseDialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="scrim" />
        <BaseDialog.Viewport className="sheet-host">
          <BaseDialog.Popup ref={popup} initialFocus={popup} className="sheet glass-text squircle">
            <div className="sheet__nav">
              <BaseDialog.Title>{m.settings_title()}</BaseDialog.Title>
              <nav aria-label={m.settings_title()} className="contents">
                {TABS.map((tab) => (
                  <Link
                    key={tab.id}
                    to="."
                    search={(previous: Record<string, unknown>) => ({
                      ...previous,
                      settings: tab.id,
                    })}
                    replace
                    className="sheet__tab"
                    aria-current={tab.id === section ? 'page' : undefined}
                  >
                    <Icon icon={tab.icon} />
                    {tab.label()}
                  </Link>
                ))}
              </nav>
            </div>
            <div className="sheet__main">
              <div className="sheet__head">
                <h2 className="text-title-2">{current?.label()}</h2>
                <BaseDialog.Close render={<IconButton label={m.common_close()} icon={X} />} />
              </div>
              <div className="sheet__body scroll">
                {section === 'appearance' ? <AppearanceSection /> : null}
                {section === 'account' ? <AccountSection me={me} onSignOut={onSignOut} /> : null}
                {section === 'invites' ? <InvitesSection me={me} /> : null}
              </div>
            </div>
          </BaseDialog.Popup>
        </BaseDialog.Viewport>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}
