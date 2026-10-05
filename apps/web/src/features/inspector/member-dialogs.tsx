/**
 * The questions the member menu asks before it acts (docs/01 section 5): how long to silence, whether to remove, whether to
 * ban and why, whether to hand the conversation over. Each is its own small form, mounted only while its dialog is open,
 * so every opening starts fresh. They do not know how the call is made: `run` is given by the list, which words the
 * answer, and says whether it worked.
 */
import type { Conversation, Member } from '@chatapp/contracts'
import { useState } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { ConfirmDialog } from '@/components/ui/confirm-dialog.tsx'
import { Dialog } from '@/components/ui/dialog.tsx'
import { SelectField, TextField } from '@/components/ui/fields.tsx'
import { serverNow } from '@/lib/realtime.ts'
import { m } from '@/paraglide/messages.js'
import { banMember, patchMember, removeMember, transferOwnership } from '../conversations/api.ts'
import { nameOf } from './person.ts'
import { SILENCE_CHOICES, type SilenceChoice, silenceUntil } from './presets.ts'

export type MemberDialog =
  | { kind: 'silence'; member: Member }
  | { kind: 'remove'; member: Member }
  | { kind: 'ban'; member: Member }
  | { kind: 'transfer'; member: Member }

/** Does the call and shows its result; true when it worked (then the dialog closes). */
export type Run = (call: () => Promise<unknown>, success: string) => Promise<boolean>

const silenceLabel = (choice: SilenceChoice): string => {
  switch (choice) {
    case '10m':
      return m.inspector_silence_10m()
    case '1h':
      return m.inspector_silence_1h()
    case '1d':
      return m.inspector_silence_1d()
    case '7d':
      return m.inspector_silence_7d()
    case '30d':
      return m.inspector_silence_30d()
  }
}

function SilenceForm({
  conversation,
  member,
  run,
  onClose,
}: {
  conversation: Conversation
  member: Member
  run: Run
  onClose: () => void
}) {
  const [choice, setChoice] = useState<SilenceChoice>('1h')
  const [busy, setBusy] = useState(false)
  const name = nameOf(member.user)
  const submit = async (): Promise<void> => {
    setBusy(true)
    const done = await run(
      () =>
        patchMember(conversation.id, member.user.id, {
          silencedUntil: silenceUntil(choice, serverNow()),
        }),
      m.inspector_toast_silenced({ name }),
    )
    if (done) onClose()
    else setBusy(false)
  }
  return (
    <form
      className="dialog-form"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <SelectField
        label={m.inspector_silence_for()}
        value={choice}
        onChange={(event) => setChoice(event.target.value as SilenceChoice)}
      >
        {SILENCE_CHOICES.map((value) => (
          <option key={value} value={value}>
            {silenceLabel(value)}
          </option>
        ))}
      </SelectField>
      <div className="dialog__actions">
        <Button kind="plain" onClick={onClose}>
          {m.common_cancel()}
        </Button>
        <Button type="submit" kind="filled" busy={busy}>
          {m.inspector_silence_action()}
        </Button>
      </div>
    </form>
  )
}

function BanForm({
  conversation,
  member,
  run,
  onClose,
}: {
  conversation: Conversation
  member: Member
  run: Run
  onClose: () => void
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const name = nameOf(member.user)
  const submit = async (): Promise<void> => {
    setBusy(true)
    const trimmed = reason.trim()
    const done = await run(
      () =>
        banMember(conversation.id, {
          userId: member.user.id,
          ...(trimmed === '' ? {} : { reason: trimmed }),
        }),
      m.inspector_toast_banned({ name }),
    )
    if (done) onClose()
    else setBusy(false)
  }
  return (
    <form
      className="dialog-form"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <TextField
        label={m.inspector_ban_reason()}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        maxLength={200}
        autoComplete="off"
      />
      <div className="dialog__actions">
        <Button kind="plain" onClick={onClose}>
          {m.common_cancel()}
        </Button>
        <Button type="submit" kind="filled" danger busy={busy}>
          {m.inspector_ban_action()}
        </Button>
      </div>
    </form>
  )
}

export function MemberDialogs({
  dialog,
  conversation,
  run,
  onClose,
}: {
  dialog: MemberDialog | null
  conversation: Conversation
  run: Run
  onClose: () => void
}) {
  const member = dialog?.member
  const name = member === undefined ? '' : nameOf(member.user)
  const isChannel = conversation.kind === 'channel'
  return (
    <>
      <Dialog
        open={dialog?.kind === 'silence'}
        onOpenChange={(open) => !open && onClose()}
        title={m.inspector_silence_title({ name })}
        description={m.inspector_silence_text()}
        className="dialog--form"
      >
        {dialog?.kind === 'silence' ? (
          <SilenceForm
            conversation={conversation}
            member={dialog.member}
            run={run}
            onClose={onClose}
          />
        ) : null}
      </Dialog>
      <Dialog
        open={dialog?.kind === 'ban'}
        onOpenChange={(open) => !open && onClose()}
        title={m.inspector_ban_title({ name })}
        description={m.inspector_ban_text()}
        className="dialog--form"
      >
        {dialog?.kind === 'ban' ? (
          <BanForm conversation={conversation} member={dialog.member} run={run} onClose={onClose} />
        ) : null}
      </Dialog>
      <ConfirmDialog
        open={dialog?.kind === 'remove'}
        onOpenChange={(open) => !open && onClose()}
        title={m.inspector_remove_title({ name })}
        description={
          isChannel
            ? m.inspector_remove_text_channel({ name })
            : m.inspector_remove_text_group({ name })
        }
        confirmLabel={m.inspector_remove_action()}
        danger
        onConfirm={() => {
          if (member === undefined) return
          void run(
            () => removeMember(conversation.id, member.user.id),
            m.inspector_toast_removed({ name }),
          )
        }}
      />
      <ConfirmDialog
        open={dialog?.kind === 'transfer'}
        onOpenChange={(open) => !open && onClose()}
        title={m.inspector_transfer_title({ name })}
        description={m.inspector_transfer_text({ name })}
        confirmLabel={m.inspector_transfer_action()}
        onConfirm={() => {
          if (member === undefined) return
          void run(
            () => transferOwnership(conversation.id, { userId: member.user.id }),
            m.inspector_toast_transferred({ name }),
          )
        }}
      />
    </>
  )
}
