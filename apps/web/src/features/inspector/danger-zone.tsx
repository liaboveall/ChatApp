/**
 * Leaving and archiving (docs/01 section 4.4). Leaving asks first (`LeaveDialog`); an owner who is not alone has to hand the
 * conversation over first (the server refuses otherwise, so the button says why it waits), and an owner who is alone
 * archives it by leaving. Archiving is for the owner and for site administrators and takes the conversation out of
 * everyone's list until it is restored from "Archived".
 */
import type { Conversation } from '@chatapp/contracts'
import { useNavigate } from '@tanstack/react-router'
import { Archive, LogOut } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { ConfirmDialog } from '@/components/ui/confirm-dialog.tsx'
import { displayName } from '@/lib/sync/selectors.ts'
import { showToast } from '@/lib/toast.ts'
import { m } from '@/paraglide/messages.js'
import { archiveConversation } from '../conversations/api.ts'
import { inspectorError } from './errors.ts'
import { canLeave, LeaveDialog } from './leave-dialog.tsx'
import type { ConversationPermissions } from './permissions.ts'

export function DangerZone({
  conversation,
  permissions,
}: {
  conversation: Conversation
  permissions: ConversationPermissions
}) {
  const navigate = useNavigate()
  const [asking, setAsking] = useState<'leave' | 'archive' | null>(null)
  const name = displayName(conversation, m.conversation_unnamed())
  const ownerMustHandOver = permissions.leave && !canLeave(conversation)

  if (!permissions.leave && !permissions.archive) return null

  const archive = async (): Promise<void> => {
    try {
      // Null: the person who asked is not here any more (D-174); the name of the conversation is not for them.
      if ((await archiveConversation(conversation.id)) === null) return
      showToast(m.inspector_archived_toast({ name }))
      void navigate({ to: '/' })
    } catch (error) {
      showToast(inspectorError(error))
    }
  }

  return (
    <section className="dsec dsec--danger" aria-labelledby="danger-title">
      <h2 id="danger-title" className="dsec__title">
        {m.inspector_danger_title()}
      </h2>
      {permissions.leave ? (
        <div className="dsec__row dsec__row--stack">
          <Button
            kind="tinted"
            danger
            icon={LogOut}
            disabled={ownerMustHandOver}
            onClick={() => setAsking('leave')}
          >
            {m.inspector_leave()}
          </Button>
          {ownerMustHandOver ? (
            <span className="dsec__note">{m.inspector_leave_owner_blocked()}</span>
          ) : null}
        </div>
      ) : null}
      {permissions.archive ? (
        <div className="dsec__row dsec__row--stack">
          <Button kind="tinted" danger icon={Archive} onClick={() => setAsking('archive')}>
            {m.inspector_archive()}
          </Button>
          <span className="dsec__note">{m.inspector_archive_help()}</span>
        </div>
      ) : null}
      <LeaveDialog
        conversation={conversation}
        open={asking === 'leave'}
        onOpenChange={(open) => !open && setAsking(null)}
      />
      <ConfirmDialog
        open={asking === 'archive'}
        onOpenChange={(open) => !open && setAsking(null)}
        title={m.inspector_archive_title({ name })}
        description={m.inspector_archive_text()}
        confirmLabel={m.inspector_archive_action()}
        danger
        onConfirm={() => void archive()}
      />
    </section>
  )
}
