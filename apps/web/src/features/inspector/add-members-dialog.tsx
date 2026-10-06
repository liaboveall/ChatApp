/**
 * Adding people to a channel or a group (docs/05 section 3.3). The people are chosen with the picker; the answer says who
 * was added and who was skipped and why (banned, already in, unavailable, no room), and a skipped person is never
 * silently dropped: the dialog stays open with the list until the person has read it.
 */
import {
  type AddMembersResponse,
  type Conversation,
  LIMITS,
  type UserSummary,
} from '@chatapp/contracts'
import { useState } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { Dialog } from '@/components/ui/dialog.tsx'
import { Banner } from '@/components/ui/feedback.tsx'
import { showToast } from '@/lib/toast.ts'
import { m } from '@/paraglide/messages.js'
import { addMembers } from '../conversations/api.ts'
import { UserPicker } from '../conversations/user-picker.tsx'
import { inspectorError } from './errors.ts'
import { nameOf } from './person.ts'

type Skip = AddMembersResponse['skipped'][number]

const skipText = (skip: Skip, name: string): string => {
  switch (skip.reason) {
    case 'banned':
      return m.inspector_skip_banned({ name })
    case 'already_member':
      return m.inspector_skip_already({ name })
    case 'limit_reached':
      return m.inspector_skip_limit({ name })
    case 'unavailable':
      return m.inspector_skip_unavailable({ name })
  }
}

function Form({
  conversation,
  onClose,
  onDone,
}: {
  conversation: Conversation
  onClose: () => void
  onDone: () => void
}) {
  const [people, setPeople] = useState<UserSummary[]>([])
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [result, setResult] = useState<{ added: number; skipped: Skip[] } | null>(null)

  const submit = async (): Promise<void> => {
    if (people.length === 0 || busy) return
    setBusy(true)
    setProblem(null)
    try {
      const response = await addMembers(conversation.id, { userIds: people.map((u) => u.id) })
      // Null: the person who asked, or the membership it was about, is not here any more (D-174); nothing follows.
      if (response === null) {
        setBusy(false)
        return
      }
      onDone()
      if (response.skipped.length === 0) {
        showToast(m.inspector_add_done({ count: response.added.length }))
        onClose()
        return
      }
      setResult({ added: response.added.length, skipped: response.skipped })
    } catch (error) {
      setProblem(inspectorError(error))
    }
    setBusy(false)
  }

  if (result !== null) {
    const names = new Map(people.map((user) => [user.id, nameOf(user)]))
    return (
      <div className="dialog-form">
        <p role="status">
          {result.added > 0
            ? m.inspector_add_done({ count: result.added })
            : m.inspector_add_none()}
        </p>
        <ul className="skipped">
          {result.skipped.map((skip) => (
            <li key={skip.userId}>{skipText(skip, names.get(skip.userId) ?? m.user_member())}</li>
          ))}
        </ul>
        <div className="dialog__actions">
          <Button kind="filled" onClick={onClose}>
            {m.common_done()}
          </Button>
        </div>
      </div>
    )
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
      <UserPicker
        label={m.inspector_add_pick()}
        multiple
        selected={people}
        onChange={setPeople}
        max={LIMITS.addMembersMax}
      />
      <div className="dialog__actions">
        <Button kind="plain" onClick={onClose}>
          {m.common_cancel()}
        </Button>
        <Button type="submit" kind="filled" busy={busy} disabled={people.length === 0}>
          {m.inspector_add_action()}
        </Button>
      </div>
    </form>
  )
}

export function AddMembersDialog({
  conversation,
  open,
  onOpenChange,
  onDone,
}: {
  conversation: Conversation
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Something was added: the list reloads. */
  onDone: () => void
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.inspector_add_title()}
      className="dialog--form"
    >
      {open ? (
        <Form conversation={conversation} onClose={() => onOpenChange(false)} onDone={onDone} />
      ) : null}
    </Dialog>
  )
}
