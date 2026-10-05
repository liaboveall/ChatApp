/**
 * The three dialogs that start a conversation (docs/01 section 4.4): a channel (a name, a description), a group (a name,
 * a description, people to begin with) and a direct message (one person). The form is its own component, mounted only
 * while the dialog is open, so every opening starts empty. The idempotency key follows the body of the request: pressing
 * the button twice sends the same request twice and gets one conversation (docs/05 section 1).
 */
import { type Conversation, conversationNameSchema, type UserSummary } from '@chatapp/contracts'
import { useNavigate } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { Dialog } from '@/components/ui/dialog.tsx'
import { Banner } from '@/components/ui/feedback.tsx'
import { TextAreaField, TextField } from '@/components/ui/fields.tsx'
import { ApiError, newIdempotencyKey } from '@/lib/api.ts'
import { describeError } from '@/lib/error-messages.ts'
import { m } from '@/paraglide/messages.js'
import { createConversation, openDm } from './api.ts'
import { UserPicker } from './user-picker.tsx'

export type NewKind = 'channel' | 'group' | 'dm'

const title = (kind: NewKind): string =>
  kind === 'channel'
    ? m.new_channel_title()
    : kind === 'group'
      ? m.new_group_title()
      : m.new_dm_title()

function Form({ kind, onDone }: { kind: NewKind; onDone: (conversation: Conversation) => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [people, setPeople] = useState<UserSummary[]>([])
  const [busy, setBusy] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const memberKey = people.map((user) => user.id).join(',')
  // A different body is a different request: it gets its own key.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key follows the whole body of the request
  const key = useMemo(() => newIdempotencyKey(), [kind, name, description, memberKey])

  const nameOk = conversationNameSchema.safeParse(name).success
  const ready = kind === 'dm' ? people.length === 1 : nameOk

  const submit = async (): Promise<void> => {
    if (!ready || busy) return
    setBusy(true)
    setNameError(null)
    setProblem(null)
    try {
      const conversation =
        kind === 'dm'
          ? await openDm(people[0]?.id ?? '')
          : await createConversation(
              {
                kind,
                name,
                ...(description.trim() === '' ? {} : { description: description.trim() }),
                ...(kind === 'group' && people.length > 0
                  ? { memberIds: people.map((u) => u.id) }
                  : {}),
              },
              key,
            )
      onDone(conversation)
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && kind === 'channel') {
        setNameError(m.new_conversation_name_taken())
      } else if (error instanceof ApiError && error.field === 'name') {
        setNameError(m.new_conversation_name_invalid())
      } else if (error instanceof ApiError && error.code === 'QUOTA_EXCEEDED') {
        setProblem(m.new_conversation_limit())
      } else {
        setProblem(describeError(error))
      }
      setBusy(false)
    }
  }

  return (
    <form
      className="dialog-form"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      {problem !== null ? <Banner tone="danger">{problem}</Banner> : null}
      {kind !== 'dm' ? (
        <>
          <TextField
            label={m.new_conversation_name()}
            value={name}
            onChange={(event) => setName(event.target.value)}
            error={nameError}
            maxLength={200}
            autoComplete="off"
            // The first control takes the focus when the dialog opens.
          />
          <TextAreaField
            label={m.new_conversation_description()}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={500}
          />
        </>
      ) : null}
      {kind !== 'channel' ? (
        <UserPicker
          label={kind === 'dm' ? m.new_dm_pick() : m.new_group_pick()}
          multiple={kind === 'group'}
          selected={people}
          onChange={setPeople}
          max={100}
        />
      ) : null}
      <div className="dialog__actions">
        <Button type="submit" kind="filled" busy={busy} disabled={!ready}>
          {kind === 'dm' ? m.new_dm_action() : m.new_conversation_create()}
        </Button>
      </div>
    </form>
  )
}

export function NewConversationDialog({
  kind,
  onOpenChange,
}: {
  /** null: closed. */
  kind: NewKind | null
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  return (
    <Dialog
      open={kind !== null}
      onOpenChange={onOpenChange}
      title={kind === null ? '' : title(kind)}
      className="dialog--form"
    >
      {kind !== null ? (
        <Form
          kind={kind}
          onDone={(conversation) => {
            onOpenChange(false)
            void navigate({ to: '/c/$conversationId', params: { conversationId: conversation.id } })
          }}
        />
      ) : null}
    </Dialog>
  )
}
