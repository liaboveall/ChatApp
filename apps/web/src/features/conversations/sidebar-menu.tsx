/**
 * The menu of a sidebar row (docs/01 section 4.4): one menu for the whole list, opened at a point or an element, from a
 * right click or from the keyboard on the focused row (Shift+F10 or the Menu key). It carries the person's own settings
 * for the conversation (pin, mute), marking as read, hiding a direct message and leaving. Closing it returns the focus to
 * the row it was opened on.
 */
import { Menu as BaseMenu } from '@base-ui/react/menu'
import type { Conversation } from '@chatapp/contracts'
import { useNavigate, useParams } from '@tanstack/react-router'
import { Bell, BellOff, CheckCheck, EyeOff, LogOut, Pin, PinOff } from 'lucide-react'
import { useState } from 'react'
import { engine } from '@/app/sync.ts'
import { MenuItem } from '@/components/ui/menu.tsx'
import { ApiError } from '@/lib/api.ts'
import { showToast } from '@/lib/toast.ts'
import { m } from '@/paraglide/messages.js'
import { inspectorError } from '../inspector/errors.ts'
import { LeaveDialog } from '../inspector/leave-dialog.tsx'
import { patchMyState } from './api.ts'
import { sidebarMenuActions } from './sidebar-menu-actions.ts'

type Anchor = Element | { getBoundingClientRect: () => DOMRect }

export type SidebarMenuTarget = {
  conversation: Conversation
  unread: number
  muted: boolean
  anchor: Anchor
}

export function SidebarMenu({
  target,
  onClose,
}: {
  target: SidebarMenuTarget | null
  onClose: () => void
}) {
  const navigate = useNavigate()
  const openId = useParams({ strict: false }).conversationId
  const [leaving, setLeaving] = useState<Conversation | null>(null)
  const conversation = target?.conversation
  const actions =
    target === null ? null : sidebarMenuActions(target.conversation, target.unread, target.muted)

  const change = async (
    request: Parameters<typeof patchMyState>[1],
    after?: () => void,
  ): Promise<void> => {
    if (conversation === undefined) return
    try {
      await patchMyState(conversation.id, request)
      after?.()
    } catch (error) {
      if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
        void engine.refreshConversation(conversation.id)
      }
      showToast(inspectorError(error))
    }
  }
  const version = conversation?.me?.version ?? 0

  return (
    <>
      <BaseMenu.Root open={target !== null} onOpenChange={(open) => !open && onClose()}>
        <BaseMenu.Portal>
          <BaseMenu.Positioner
            anchor={target?.anchor ?? null}
            side="bottom"
            align="start"
            sideOffset={6}
            className="positioner"
          >
            <BaseMenu.Popup
              className="menu glass-text squircle"
              finalFocus={() =>
                conversation === undefined
                  ? true
                  : (document.querySelector<HTMLElement>(
                      `[data-conversation-id="${conversation.id}"]`,
                    ) ?? true)
              }
            >
              {conversation !== undefined && actions !== null ? (
                <>
                  <MenuItem
                    icon={actions.pin === 'pin' ? Pin : PinOff}
                    onClick={() =>
                      void change({
                        expectedViewerVersion: version,
                        pinned: actions.pin === 'pin',
                      })
                    }
                  >
                    {actions.pin === 'pin' ? m.sidebar_menu_pin() : m.sidebar_menu_unpin()}
                  </MenuItem>
                  <MenuItem
                    icon={actions.mute === 'mute' ? BellOff : Bell}
                    onClick={() =>
                      void change({
                        expectedViewerVersion: version,
                        mute: actions.mute === 'mute' ? { mode: 'forever' } : { mode: 'off' },
                      })
                    }
                  >
                    {actions.mute === 'mute' ? m.sidebar_menu_mute() : m.sidebar_menu_unmute()}
                  </MenuItem>
                  {actions.markRead ? (
                    <MenuItem
                      icon={CheckCheck}
                      onClick={() => engine.markRead(conversation.id, conversation.lastSeq)}
                    >
                      {m.sidebar_menu_mark_read()}
                    </MenuItem>
                  ) : null}
                  {actions.hide ? (
                    <MenuItem
                      icon={EyeOff}
                      onClick={() =>
                        void change({ expectedViewerVersion: version, hidden: true }, () => {
                          if (openId === conversation.id) void navigate({ to: '/' })
                        })
                      }
                    >
                      {m.sidebar_menu_hide()}
                    </MenuItem>
                  ) : null}
                  {actions.leave ? (
                    <MenuItem icon={LogOut} danger onClick={() => setLeaving(conversation)}>
                      {m.sidebar_menu_leave()}
                    </MenuItem>
                  ) : null}
                </>
              ) : null}
            </BaseMenu.Popup>
          </BaseMenu.Positioner>
        </BaseMenu.Portal>
      </BaseMenu.Root>
      {leaving !== null ? (
        <LeaveDialog
          conversation={leaving}
          open
          onOpenChange={(open) => !open && setLeaving(null)}
        />
      ) : null}
    </>
  )
}
