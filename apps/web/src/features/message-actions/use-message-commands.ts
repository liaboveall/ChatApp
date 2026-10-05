import type { Message } from '@chatapp/contracts'
import { useState } from 'react'
import { engine } from '@/app/sync.ts'
import { startEdit, startReply } from '@/lib/sync/compose.ts'
import { draftOf, setDraft, useDrafts } from '@/lib/sync/drafts.ts'
import { showToast } from '@/lib/toast.ts'
import { m } from '@/paraglide/messages.js'
import { recallMessage } from './actions.ts'

const focusComposer = (): void => {
  requestAnimationFrame(() =>
    document.querySelector<HTMLTextAreaElement>('.composer__input')?.focus({ preventScroll: true }),
  )
}

export type Confirm = { kind: 'hide' | 'delete'; message: Message }

/**
 * What choosing an item of the message menu does in the interface: reply and edit change what the composer is doing,
 * copy goes to the clipboard, recall is sent at once, and the two deletions ask first (D-154, docs/02 section 7).
 */
export function useMessageCommands(conversationId: string) {
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  return {
    confirm,
    clearConfirm: () => setConfirm(null),
    reply: (message: Message): void => {
      // A reply and an edit belong to the membership they were started under (D-171): without one there is nothing to start.
      const membershipId = engine.membershipOf(conversationId)
      if (membershipId === undefined) return
      const stash = startReply(conversationId, membershipId, message)
      if (stash !== undefined) setDraft(conversationId, stash)
      focusComposer()
    },
    edit: (message: Message): void => {
      const membershipId = engine.membershipOf(conversationId)
      if (membershipId === undefined) return
      startEdit(
        conversationId,
        membershipId,
        message,
        draftOf(useDrafts.getState(), conversationId),
      )
      setDraft(conversationId, message.body ?? '')
      focusComposer()
    },
    copy: async (message: Message): Promise<void> => {
      try {
        await navigator.clipboard.writeText(message.body ?? '')
        showToast(m.common_copied())
      } catch {
        showToast(m.common_copy_failed())
      }
    },
    recall: (message: Message): void => void recallMessage(message),
    askHide: (message: Message): void => setConfirm({ kind: 'hide', message }),
    askDelete: (message: Message): void => setConfirm({ kind: 'delete', message }),
  }
}
