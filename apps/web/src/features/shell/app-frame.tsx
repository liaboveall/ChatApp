import type { Me } from '@chatapp/contracts'
import { useMatches, useNavigate, useParams, useRouter } from '@tanstack/react-router'
import {
  Archive,
  Compass,
  Hash,
  Keyboard,
  LogOut,
  MessageCircle,
  Monitor,
  Moon,
  Palette,
  PanelRight,
  Sun,
  Ticket,
  User,
  Users,
} from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { AppIcon } from '@/components/brand/app-icon.tsx'
import { AppShell } from '@/components/layout/app-shell.tsx'
import { Inspector } from '@/components/layout/inspector.tsx'
import { Sidebar } from '@/components/layout/sidebar.tsx'
import { Toolbar } from '@/components/layout/toolbar.tsx'
import { Avatar } from '@/components/ui/avatar.tsx'
import { CommandPalette, type PaletteCommand } from '@/features/command-palette/command-palette.tsx'
import { neighbourOf } from '@/features/conversations/navigation.ts'
import {
  NewConversationDialog,
  type NewKind,
} from '@/features/conversations/new-conversation-dialog.tsx'
import { presenceLabel } from '@/features/conversations/presence-text.ts'
import { type SettingsSection, SettingsSheet } from '@/features/settings/settings-sheet.tsx'
import { useAppearance } from '@/lib/appearance.ts'
import { PRODUCT_NAME } from '@/lib/product.ts'
import { useChrome } from '@/lib/shell-chrome.ts'
import { useShell } from '@/lib/shell-state.ts'
import { useGlobalShortcuts } from '@/lib/shortcuts.ts'
import { useSidebarGroups } from '@/lib/sync/hooks.ts'
import { displayName, sidebarOrder } from '@/lib/sync/selectors.ts'
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
  const [creating, setCreating] = useState<NewKind | null>(null)
  const navigate = useNavigate()
  const router = useRouter()
  const conversations = useSidebarGroups()
  const inspector = useShell((state) => state.inspector)
  const toggleAssistant = useShell((state) => state.toggleAssistant)
  const setDrawer = useShell((state) => state.setDrawer)
  const setTheme = useAppearance((state) => state.set)
  const setInspector = useShell((state) => state.setInspector)
  const chrome = useChrome((state) => state.content)
  // A screen may fill the panel and scroll inside itself (the conversation does).
  const fill = useMatches({
    select: (matches) => matches.some((match) => match.staticData.layout === 'fill'),
  })

  // In a narrow window the list is a drawer over the page, and wherever it led (a conversation, the directory, the palette's
  // choice) it is in the way once the route has changed. Settings and dialogs change the address search only, not the path.
  useEffect(
    () =>
      router.subscribe('onResolved', ({ pathChanged }) => {
        if (pathChanged) setDrawer(false)
      }),
    [router, setDrawer],
  )

  const openSettings = useCallback(
    (section: SettingsSection = 'appearance') => onSettingsChange(section),
    [onSettingsChange],
  )

  // ⌥↑ / ⌥↓ (and with ⇧ only the unread ones): the order is the sidebar's.
  const currentId = useParams({ strict: false }).conversationId
  const goTo = useCallback(
    (step: 1 | -1, unreadOnly: boolean) => {
      const items = sidebarOrder(conversations).map(({ conversation, unread }) => ({
        id: conversation.id,
        unread: unread > 0,
      }))
      const target = neighbourOf(items, currentId, step, unreadOnly)
      if (target !== undefined) {
        void navigate({ to: '/c/$conversationId', params: { conversationId: target } })
      }
    },
    [conversations, currentId, navigate],
  )

  const handlers = useMemo(
    () => ({
      palette: () => setPaletteOpen((open) => !open),
      assistant: toggleAssistant,
      settings: () => openSettings(),
      help: () => setHelpOpen((open) => !open),
      previous: () => goTo(-1, false),
      next: () => goTo(1, false),
      previousUnread: () => goTo(-1, true),
      nextUnread: () => goTo(1, true),
    }),
    [toggleAssistant, openSettings, goTo],
  )
  useGlobalShortcuts(handlers)

  const commands = useMemo<PaletteCommand[]>(() => {
    const go = m.palette_group_go()
    const look = m.palette_group_appearance()
    const account = m.palette_group_account()
    const chat = m.palette_group_conversations()
    const openConversation = sidebarOrder(conversations).map(({ conversation }): PaletteCommand => {
      const name = displayName(conversation, m.conversation_unnamed())
      return {
        id: `conversation-${conversation.id}`,
        group: chat,
        icon:
          conversation.kind === 'channel'
            ? Hash
            : conversation.kind === 'dm'
              ? MessageCircle
              : Users,
        label: m.palette_open_conversation({ name }),
        keywords: `${name} ${conversation.dmPeer?.username ?? ''}`,
        run: () =>
          void navigate({ to: '/c/$conversationId', params: { conversationId: conversation.id } }),
      }
    })
    return [
      ...openConversation,
      {
        id: 'new-channel',
        group: chat,
        icon: Hash,
        label: m.sidebar_new_channel(),
        keywords: 'new channel create',
        run: () => setCreating('channel'),
      },
      {
        id: 'new-group',
        group: chat,
        icon: Users,
        label: m.sidebar_new_group(),
        keywords: 'new group create',
        run: () => setCreating('group'),
      },
      {
        id: 'new-dm',
        group: chat,
        icon: MessageCircle,
        label: m.sidebar_new_dm(),
        keywords: 'new direct message dm chat',
        run: () => setCreating('dm'),
      },
      {
        id: 'browse-channels',
        group: chat,
        icon: Compass,
        label: m.sidebar_browse(),
        keywords: 'browse channels discover join',
        run: () => void navigate({ to: '/channels' }),
      },
      {
        id: 'archived',
        group: chat,
        icon: Archive,
        label: m.sidebar_archived(),
        keywords: 'archived restore',
        run: () => void navigate({ to: '/archived' }),
      },
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
  }, [openSettings, toggleAssistant, setTheme, onSignOut, conversations, navigate])

  return (
    <>
      <AppShell
        fill={fill}
        sidebar={
          <Sidebar
            me={me}
            onOpenPalette={() => setPaletteOpen(true)}
            onOpenSettings={(section) => openSettings(section)}
            onCreate={setCreating}
          />
        }
        toolbar={
          <Toolbar
            title={chrome?.title ?? PRODUCT_NAME}
            subtitle={chrome?.subtitle ?? null}
            avatar={
              chrome?.avatar ? (
                <Avatar
                  name={chrome.avatar.name}
                  seed={chrome.avatar.seed}
                  size={34}
                  glyph={chrome.avatar.glyph}
                  status={chrome.avatar.status}
                  statusLabel={
                    chrome.avatar.status === undefined
                      ? undefined
                      : presenceLabel(chrome.avatar.status)
                  }
                />
              ) : (
                <AppIcon size={34} />
              )
            }
            onToggleDetails={
              chrome?.members
                ? () => setInspector(inspector === 'details' ? null : 'details')
                : undefined
            }
            detailsOpen={inspector === 'details'}
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
      <NewConversationDialog kind={creating} onOpenChange={(open) => !open && setCreating(null)} />
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
