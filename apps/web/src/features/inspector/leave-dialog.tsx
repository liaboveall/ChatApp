/**
 * The question before leaving a channel or a group (docs/01 section 4.4), shared by the Inspector and the sidebar menu. It
 * says what leaving means for coming back; an owner who is alone is told that leaving archives the conversation. On
 * success the person goes home (the engine has already taken the conversation out of the cache).
 */
import type { Conversation } from '@chatapp/contracts'
import { useNavigate } from '@tanstack/react-router'
import { ConfirmDialog } from '@/components/ui/confirm-dialog.tsx'
import { displayName } from '@/lib/sync/selectors.ts'
import { showToast } from '@/lib/toast.ts'
import { m } from '@/paraglide/messages.js'
import { leaveConversation } from '../conversations/api.ts'
import { inspectorError } from './errors.ts'

/** Leaving is open to everybody who is in a channel or a group, except an owner who still has company (the server refuses). */
export function canLeave(conversation: Conversation): boolean {
  const me = conversation.me
  if (me === null || (conversation.kind !== 'channel' && conversation.kind !== 'group'))
    return false
  return !(me.role === 'owner' && conversation.memberCount > 1)
}

export function LeaveDialog({
  conversation,
  open,
  onOpenChange,
}: {
  conversation: Conversation
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const name = displayName(conversation, m.conversation_unnamed())
  const alone = conversation.me?.role === 'owner' && conversation.memberCount <= 1
  const leave = async (): Promise<void> => {
    try {
      await leaveConversation(conversation.id)
      void navigate({ to: '/' })
    } catch (error) {
      showToast(inspectorError(error))
    }
  }
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={alone ? m.inspector_leave_alone_title({ name }) : m.inspector_leave_title({ name })}
      description={
        alone
          ? m.inspector_leave_alone_text()
          : conversation.kind === 'channel'
            ? m.inspector_leave_text_channel()
            : m.inspector_leave_text_group()
      }
      confirmLabel={alone ? m.inspector_leave_alone_action() : m.inspector_leave_action()}
      danger
      onConfirm={() => void leave()}
    />
  )
}
