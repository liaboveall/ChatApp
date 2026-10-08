import type {
  AgentApproval,
  AgentEffect,
  AgentRun,
  ApprovalPreview,
  ConversationRef,
  ScheduleTime,
} from '@chatapp/contracts'
import { Check, Pencil, X } from 'lucide-react'
import { useId, useState } from 'react'
import { MessageBody } from '@/components/markdown/message-body.tsx'
import { Button } from '@/components/ui/button.tsx'
import { describeError } from '@/lib/error-messages.ts'
import { showToast } from '@/lib/toast.ts'
import { useTime } from '@/lib/use-time.ts'
import { m } from '@/paraglide/messages.js'
import { decideApproval, undoMemory, undoReminder } from './api.ts'

export function offsetText(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  const total = Math.abs(minutes)
  return `${sign}${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

export function conversationLabel(ref: ConversationRef | null): string {
  if (!ref) return m.agent_approval_target_gone()
  if (ref.kind === 'dm') return ref.peer?.displayName ?? m.agent_approval_target_gone()
  return ref.kind === 'channel' ? `#${ref.name ?? ''}` : (ref.name ?? '')
}

function titleOf(preview: ApprovalPreview): string {
  switch (preview.tool) {
    case 'send_message':
      return m.agent_approval_send({ target: conversationLabel(preview.conversation) })
    case 'schedule_message':
      return m.agent_approval_schedule({ target: conversationLabel(preview.conversation) })
    case 'create_group':
      return m.agent_approval_group({ name: preview.name })
    case 'invite_members':
      return m.agent_approval_invite({ target: conversationLabel(preview.conversation) })
    case 'create_reminder':
      return m.agent_approval_reminder()
    case 'cancel_reminder':
      return m.agent_approval_cancel_reminder()
    case 'cancel_scheduled_message':
      return m.agent_approval_cancel_scheduled()
    case 'remember':
      return m.agent_approval_remember()
    case 'forget':
      return m.agent_approval_forget()
  }
}

/** The text field a person may change before approving, if this kind of request has one. */
function editableText(preview: ApprovalPreview): { field: string; value: string } | null {
  switch (preview.tool) {
    case 'send_message':
    case 'schedule_message':
      return { field: 'body', value: preview.body }
    case 'create_reminder':
      return { field: 'text', value: preview.text }
    case 'create_group':
      return { field: 'name', value: preview.name }
    case 'remember':
      return { field: 'content', value: preview.content }
    default:
      return null
  }
}

function TimeBlock({
  time,
  choice,
  onChoose,
  pending,
}: {
  time: ScheduleTime
  choice: number | undefined
  onChoose: (offset: number) => void
  pending: boolean
}) {
  const { locale } = useTime()
  const name = useId()
  const local = time.localDateTime.replace('T', ' ')
  if (time.chosen)
    return (
      <p className="approval__time">
        {m.agent_approval_time({
          local,
          zone: time.timezone,
          offset: offsetText(time.chosen.offsetMinutes),
        })}
      </p>
    )
  // A repeated local time: only the person can say which of the two they mean (AT-37).
  return (
    <fieldset className="approval__choose" disabled={!pending}>
      <legend>{m.agent_approval_choose_time()}</legend>
      {time.candidates.map((candidate) => (
        <label key={candidate.at}>
          <input
            type="radio"
            name={name}
            checked={choice === candidate.offsetMinutes}
            onChange={() => onChoose(candidate.offsetMinutes)}
          />
          {local}{' '}
          {m.agent_approval_time_option({
            offset: offsetText(candidate.offsetMinutes),
            utc: new Date(candidate.at).toLocaleString(locale, { timeZone: 'UTC' }),
          })}
        </label>
      ))}
    </fieldset>
  )
}

function Preview({
  preview,
  choice,
  onChoose,
  pending,
}: {
  preview: ApprovalPreview
  choice: number | undefined
  onChoose: (offset: number) => void
  pending: boolean
}) {
  switch (preview.tool) {
    case 'send_message':
      return (
        <blockquote className="approval__body">
          <MessageBody text={preview.body} />
        </blockquote>
      )
    case 'schedule_message':
      return (
        <>
          <TimeBlock time={preview.time} choice={choice} onChoose={onChoose} pending={pending} />
          <blockquote className="approval__body">
            <MessageBody text={preview.body} />
          </blockquote>
        </>
      )
    case 'create_reminder':
      return (
        <>
          <TimeBlock time={preview.time} choice={choice} onChoose={onChoose} pending={pending} />
          <blockquote className="approval__body">{preview.text}</blockquote>
        </>
      )
    case 'remember':
      return (
        <>
          <blockquote className="approval__body">{preview.content}</blockquote>
          <p>
            {preview.privacyClass === 'byok_private'
              ? m.settings_memory_private()
              : m.settings_memory_site()}
          </p>
        </>
      )
    case 'create_group':
    case 'invite_members':
      return (
        <>
          {preview.members.length ? (
            <p>
              {m.agent_approval_members({
                names: preview.members.map((p) => p.displayName).join('、'),
              })}
            </p>
          ) : null}
          {preview.unavailable.length ? (
            <p className="approval__warning">
              {m.agent_approval_unavailable({ names: preview.unavailable.join('、') })}
            </p>
          ) : null}
        </>
      )
    default:
      return null
  }
}

function outcomeOf(approval: AgentApproval, effect: AgentEffect | undefined): string {
  if (approval.status === 'pending') return ''
  if (approval.status === 'expired') return m.agent_approval_expired()
  if (approval.status === 'rejected')
    return approval.reason?.startsWith('invalid:')
      ? m.agent_approval_invalid({ reason: approval.reason.slice('invalid:'.length) })
      : approval.reason === 'rejected'
        ? m.agent_approval_rejected()
        : m.agent_approval_closed()
  const status = effect?.result.status
  const done =
    status === 'remembered'
      ? m.agent_effect_remembered()
      : status === 'forgotten'
        ? m.agent_effect_forgotten()
        : status === 'sent'
          ? m.agent_effect_sent()
          : status === 'scheduled'
            ? m.agent_effect_scheduled()
            : status === 'created'
              ? m.agent_effect_created()
              : status === 'invited'
                ? m.agent_effect_invited({
                    count: Array.isArray(effect?.result.added) ? effect.result.added.length : 0,
                  })
                : status === 'cancelled'
                  ? m.agent_effect_cancelled()
                  : status === 'failed'
                    ? m.agent_effect_failed({ reason: String(effect?.result.error ?? '') })
                    : ''
  const decided = approval.required
    ? approval.edited
      ? m.agent_approval_approved_edited()
      : m.agent_approval_approved()
    : m.agent_approval_automatic()
  return done ? `${decided} · ${done}` : decided
}

/**
 * One request of the assistant (docs/02 section 6): what it would do, where, and the full content. A pending one that
 * needs the caller shows how long it stays valid and the three choices; a decided one shows what happened.
 */
export function ApprovalCard({
  approval,
  run,
  effect,
}: {
  approval: AgentApproval
  run: AgentRun
  effect: AgentEffect | undefined
}) {
  const { locale, timeZone } = useTime()
  const conversationId = run.conversationId ?? ''
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [undone, setUndone] = useState(false)
  const [choice, setChoice] = useState<number>()
  const preview = approval.preview
  const editable = preview ? editableText(preview) : null
  const [text, setText] = useState(editable?.value ?? '')
  const pending = approval.status === 'pending'
  const needsChoice =
    preview &&
    (preview.tool === 'schedule_message' || preview.tool === 'create_reminder') &&
    preview.time.chosen === null
  const decide = async (decision: 'approve' | 'reject') => {
    if (busy) return
    setBusy(true)
    try {
      const edited: Record<string, unknown> = {}
      if (decision === 'approve' && editing && editable && text !== editable.value)
        edited[editable.field] = text
      if (decision === 'approve' && choice !== undefined) edited.offsetMinutes = choice
      await decideApproval(approval, conversationId, {
        decision,
        expectedStateVersion: approval.stateVersion,
        ...(Object.keys(edited).length ? { editedArgs: edited } : {}),
      })
      setEditing(false)
    } catch (error) {
      showToast(describeError(error))
    } finally {
      setBusy(false)
    }
  }
  const undo = async (reminderId: string) => {
    setBusy(true)
    try {
      if ((await undoReminder(reminderId, conversationId)) !== null) {
        setUndone(true)
        showToast(m.agent_effect_undone())
      }
    } catch (error) {
      showToast(describeError(error))
    } finally {
      setBusy(false)
    }
  }
  const reminderId =
    approval.toolName === 'create_reminder' &&
    effect?.result.status === 'scheduled' &&
    typeof effect.result.reminderId === 'string'
      ? effect.result.reminderId
      : null
  const memoryId =
    effect?.result.status === 'remembered' && typeof effect.result.memoryId === 'string'
      ? effect.result.memoryId
      : null
  return (
    <section
      className="approval glass-lite squircle"
      data-status={approval.status}
      aria-label={preview ? titleOf(preview) : approval.toolName}
    >
      {pending && approval.required ? (
        <b className="approval__badge">{m.agent_approval_title()}</b>
      ) : null}
      <h4 className="approval__title">{preview ? titleOf(preview) : approval.toolName}</h4>
      {preview && !editing ? (
        <Preview preview={preview} choice={choice} onChoose={setChoice} pending={pending} />
      ) : null}
      {editing && editable ? (
        <textarea
          className="input"
          aria-label={m.agent_approval_edit_label()}
          value={text}
          rows={4}
          maxLength={5000}
          onChange={(event) => setText(event.target.value)}
        />
      ) : null}
      {pending && approval.required ? (
        <>
          <small>
            {m.agent_approval_expires({
              time: new Date(approval.expiresAt).toLocaleString(locale, { timeZone }),
            })}
          </small>
          <div className="agent-controls">
            <Button
              size="sm"
              icon={Check}
              busy={busy}
              disabled={Boolean(needsChoice) && choice === undefined}
              onClick={() => void decide('approve')}
            >
              {editing ? m.agent_approval_save_approve() : m.agent_approval_approve()}
            </Button>
            {editable && !editing ? (
              <Button kind="tinted" size="sm" icon={Pencil} onClick={() => setEditing(true)}>
                {m.agent_approval_edit()}
              </Button>
            ) : null}
            <Button
              kind="plain"
              size="sm"
              icon={X}
              busy={busy}
              onClick={() => void decide('reject')}
            >
              {m.agent_approval_reject()}
            </Button>
          </div>
        </>
      ) : (
        <p role="status" className="approval__outcome">
          {undone ? m.agent_effect_undone() : outcomeOf(approval, effect)}
        </p>
      )}
      {reminderId && !undone ? (
        <Button kind="plain" size="sm" busy={busy} onClick={() => void undo(reminderId)}>
          {m.agent_effect_undo_reminder()}
        </Button>
      ) : null}
      {memoryId && !undone ? (
        <Button
          kind="plain"
          size="sm"
          busy={busy}
          onClick={async () => {
            setBusy(true)
            try {
              if ((await undoMemory(memoryId, conversationId)) !== null) {
                setUndone(true)
                showToast(m.agent_effect_undone())
              }
            } catch (error) {
              showToast(describeError(error))
            } finally {
              setBusy(false)
            }
          }}
        >
          {m.agent_effect_undo_memory()}
        </Button>
      ) : null}
    </section>
  )
}
