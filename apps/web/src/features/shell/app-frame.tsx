import type { Me } from '@chatapp/contracts'
import {
  Keyboard,
  LogOut,
  Monitor,
  Moon,
  Palette,
  PanelRight,
  Sun,
  Ticket,
  User,
} from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { AppShell } from '@/components/layout/app-shell.tsx'
import { Inspector } from '@/components/layout/inspector.tsx'
import { Sidebar } from '@/components/layout/sidebar.tsx'
import { Toolbar } from '@/components/layout/toolbar.tsx'
import { CommandPalette, type PaletteCommand } from '@/features/command-palette/command-palette.tsx'
import { type SettingsSection, SettingsSheet } from '@/features/settings/settings-sheet.tsx'
import { useAppearance } from '@/lib/appearance.ts'
import { PRODUCT_NAME } from '@/lib/product.ts'
import { useShell } from '@/lib/shell-state.ts'
import { useGlobalShortcuts } from '@/lib/shortcuts.ts'
import { m } from '@/paraglide/messages.js'
import { ShortcutsDialog } from './shortcuts-dialog.tsx'

type AppFrameProps = {
  me: Me
  settings: SettingsSection | undefined
  onSettingsChange: (section: SettingsSection | undefined) => void
  onSignOut: () => void
  /** The main panel: the welcome page until conversations arrive with M2. */
  children: ReactNode
}

/**
 * The signed-in shell: sidebar, toolbar, welcome content, Inspector, and the overlays reached by keyboard (command
 * palette, settings, shortcut help). Conversations arrive with M2; until then the main panel is the welcome page.
 */
export function AppFrame({ me, settings, onSettingsChange, onSignOut, children }: AppFrameProps) {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const inspector = useShell((state) => state.inspector)
  const toggleAssistant = useShell((state) => state.toggleAssistant)
  const setDrawer = useShell((state) => state.setDrawer)
  const setTheme = useAppearance((state) => state.set)

  const openSettings = useCallback(
    (section: SettingsSection = 'appearance') => onSettingsChange(section),
    [onSettingsChange],
  )

  const handlers = useMemo(
    () => ({
      palette: () => setPaletteOpen((open) => !open),
      assistant: toggleAssistant,
      settings: () => openSettings(),
      help: () => setHelpOpen((open) => !open),
    }),
    [toggleAssistant, openSettings],
  )
  useGlobalShortcuts(handlers)

  const commands = useMemo<PaletteCommand[]>(() => {
    const go = m.palette_group_go()
    const look = m.palette_group_appearance()
    const account = m.palette_group_account()
    return [
      {
        id: 'settings-appearance',
        group: go,
        icon: Palette,
        label: m.palette_open_appearance(),
        keywords: 'settings appearance theme',
        run: () => openSettings('appearance'),
      },
      {
        id: 'settings-account',
        group: go,
        icon: User,
        label: m.palette_open_account(),
        keywords: 'settings account password passkey devices timezone',
        run: () => openSettings('account'),
      },
      {
        id: 'settings-invites',
        group: go,
        icon: Ticket,
        label: m.palette_open_invites(),
        keywords: 'settings invites invitation',
        run: () => openSettings('invites'),
      },
      {
        id: 'assistant',
        group: go,
        icon: PanelRight,
        label: m.shell_assistant_panel(),
        keys: ['mod', 'J'],
        run: toggleAssistant,
      },
      {
        id: 'shortcuts',
        group: go,
        icon: Keyboard,
        label: m.shell_menu_shortcuts(),
        keys: ['mod', '/'],
        run: () => setHelpOpen(true),
      },
      {
        id: 'theme-light',
        group: look,
        icon: Sun,
        label: m.palette_theme_light(),
        keywords: 'light theme',
        run: () => setTheme('theme', 'light'),
      },
      {
        id: 'theme-dark',
        group: look,
        icon: Moon,
        label: m.palette_theme_dark(),
        keywords: 'dark theme',
        run: () => setTheme('theme', 'dark'),
      },
      {
        id: 'theme-system',
        group: look,
        icon: Monitor,
        label: m.palette_theme_system(),
        keywords: 'system theme auto',
        run: () => setTheme('theme', 'system'),
      },
      {
        id: 'sign-out',
        group: account,
        icon: LogOut,
        label: m.settings_sign_out(),
        keywords: 'sign out logout',
        run: onSignOut,
      },
    ]
  }, [openSettings, toggleAssistant, setTheme, onSignOut])

  return (
    <>
      <AppShell
        sidebar={
          <Sidebar
            me={me}
            onOpenPalette={() => setPaletteOpen(true)}
            onOpenSettings={(section) => openSettings(section)}
          />
        }
        toolbar={
          <Toolbar
            title={PRODUCT_NAME}
            assistantOpen={inspector === 'assistant'}
            onToggleAssistant={toggleAssistant}
            onOpenDrawer={() => setDrawer(true)}
            onOpenPalette={() => setPaletteOpen(true)}
            onOpenSettings={() => openSettings()}
            onOpenShortcuts={() => setHelpOpen(true)}
          />
        }
        inspector={<Inspector />}
      >
        {children}
      </AppShell>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} commands={commands} />
      <ShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} />
      <SettingsSheet
        section={settings}
        me={me}
        onClose={() => onSettingsChange(undefined)}
        onSignOut={onSignOut}
      />
    </>
  )
}

/** Keeps the realtime connection alive while the shell is mounted and nudges it when the page returns or the network does. */
export function useRealtimeBridge(client: {
  start: () => void
  stop: () => void
  nudge: () => void
  setFocus: (focus: { foreground: boolean }) => void
}): void {
  useEffect(() => {
    client.start()
    const onVisibility = (): void => {
      const foreground = document.visibilityState === 'visible'
      client.setFocus({ foreground })
      if (foreground) client.nudge()
    }
    const onOnline = (): void => client.nudge()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onOnline)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onOnline)
      client.stop()
    }
  }, [client])
}
