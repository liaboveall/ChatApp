/**
 * The menu of actions on one message (docs/02 section 5, D-154). One menu for the whole timeline, opened at a point or
 * an element: from a right click, from the "more" button of the hover toolbar, or from the keyboard on the focused
 * message (Enter, Shift+F10, the Menu key). Closing it returns the focus to the message it was opened on.
 */

import { Menu as BaseMenu } from '@base-ui/react/menu'
import type { Message } from '@chatapp/contracts'
import { Copy, CornerUpLeft, EyeOff, Pencil, ShieldX, Undo2 } from 'lucide-react'
import { MenuItem } from '@/components/ui/menu.tsx'
import { m } from '@/paraglide/messages.js'
import type { MessageActions } from './eligibility.ts'

type Anchor = Element | { getBoundingClientRect: () => DOMRect }

export type MenuTarget = { message: Message; actions: MessageActions; anchor: Anchor }

export type MessageMenuProps = {
  target: MenuTarget | null
  onClose: () => void
  onReply: (message: Message) => void
  onCopy: (message: Message) => void
  onEdit: (message: Message) => void
  onRecall: (message: Message) => void
  onHide: (message: Message) => void
  onAdminDelete: (message: Message) => void
}

export function MessageMenu({ target, onClose, ...on }: MessageMenuProps) {
  const message = target?.message
  const actions = target?.actions
  return (
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
              message === undefined
                ? true
                : (document.querySelector<HTMLElement>(`[data-message-id="${message.id}"]`) ?? true)
            }
          >
            {message !== undefined && actions !== undefined ? (
              <>
                {actions.reply ? (
                  <MenuItem icon={CornerUpLeft} onClick={() => on.onReply(message)}>
                    {m.action_reply()}
                  </MenuItem>
                ) : null}
                {actions.copy ? (
                  <MenuItem icon={Copy} onClick={() => on.onCopy(message)}>
                    {m.common_copy()}
                  </MenuItem>
                ) : null}
                {actions.edit ? (
                  <MenuItem icon={Pencil} onClick={() => on.onEdit(message)}>
                    {m.action_edit()}
                  </MenuItem>
                ) : null}
                {actions.recall ? (
                  <MenuItem icon={Undo2} onClick={() => on.onRecall(message)}>
                    {m.action_recall()}
                  </MenuItem>
                ) : null}
                {actions.hideForMe ? (
                  <MenuItem icon={EyeOff} danger onClick={() => on.onHide(message)}>
                    {m.action_hide()}
                  </MenuItem>
                ) : null}
                {actions.adminDelete ? (
                  <MenuItem icon={ShieldX} danger onClick={() => on.onAdminDelete(message)}>
                    {m.action_admin_delete()}
                  </MenuItem>
                ) : null}
              </>
            ) : null}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  )
}
