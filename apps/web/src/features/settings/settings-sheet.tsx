import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import type { Me } from '@chatapp/contracts'
import { Link } from '@tanstack/react-router'
import {
  Bell,
  Palette,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Ticket,
  User,
  X,
} from 'lucide-react'
import { useEffect, useRef } from 'react'
import { IconButton } from '@/components/ui/button.tsx'
import { useModalFlag } from '@/components/ui/dialog.tsx'
import { Icon } from '@/components/ui/icon.tsx'
import { m } from '@/paraglide/messages.js'
import { AccountSection } from './account-section.tsx'
import { AppearanceSection } from './appearance-section.tsx'
import { AssistantSection } from './assistant-section.tsx'
import { InvitesSection } from './invites-section.tsx'
import { NotificationsSection } from './notifications-section.tsx'

export const SETTINGS_SECTIONS = [
  'appearance',
  'notifications',
  'account',
  'assistant',
  'invites',
] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

const TABS = [
  { id: 'appearance', icon: Palette, label: () => m.settings_tab_appearance() },
  { id: 'notifications', icon: Bell, label: () => m.settings_tab_notifications() },
  { id: 'account', icon: User, label: () => m.settings_tab_account() },
  { id: 'assistant', icon: Sparkles, label: () => m.settings_tab_assistant() },
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
  // On a phone the sections are one row that scrolls sideways: the section the sheet shows has its tab in sight, also
  // when the sheet was opened on it from elsewhere (a link, the command palette) or reached with the keyboard.
  const nav = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (section === undefined) return
    // The popup mounts with the dialog: by the next frame the row exists and has its width.
    const frame = requestAnimationFrame(() =>
      nav.current
        ?.querySelector('[aria-current="page"]')
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' }),
    )
    return () => cancelAnimationFrame(frame)
  }, [section])
  return (
    <BaseDialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="scrim" />
        <BaseDialog.Viewport className="sheet-host">
          <BaseDialog.Popup ref={popup} initialFocus={popup} className="sheet glass-text squircle">
            <div ref={nav} className="sheet__nav">
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
              {/* Not settings, but where settings are explained and (for an administrator) overseen: at the foot. */}
              <div className="sheet__nav-foot">
                <Link to="/privacy" className="sheet__tab" onClick={onClose}>
                  <Icon icon={ShieldCheck} />
                  {m.privacy_title()}
                </Link>
                {me.role === 'admin' ? (
                  <Link to="/admin" className="sheet__tab" onClick={onClose}>
                    <Icon icon={SlidersHorizontal} />
                    {m.admin_title()}
                  </Link>
                ) : null}
              </div>
            </div>
            <div className="sheet__main">
              <div className="sheet__head">
                <h2 className="text-title-2">{current?.label()}</h2>
                <BaseDialog.Close render={<IconButton label={m.common_close()} icon={X} />} />
              </div>
              <div className="sheet__body scroll">
                {section === 'appearance' ? <AppearanceSection /> : null}
                {section === 'notifications' ? <NotificationsSection me={me} /> : null}
                {section === 'account' ? <AccountSection me={me} onSignOut={onSignOut} /> : null}
                {section === 'assistant' ? <AssistantSection me={me} /> : null}
                {section === 'invites' ? <InvitesSection me={me} /> : null}
              </div>
            </div>
          </BaseDialog.Popup>
        </BaseDialog.Viewport>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}
