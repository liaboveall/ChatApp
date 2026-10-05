/**
 * The composer (docs/02 section 3, docs/01 section 4.5, D-154): a floating glass capsule with a growing text field. Enter
 * sends and Shift+Enter breaks the line, except while an input method is composing (the rule is `enter-key.ts`). What was
 * typed and not sent is kept per conversation in memory. Sending is optimistic: the message appears at once as "sending".
 * Up arrow in an empty field edits my last message; a reply or an edit shows a bar above the field and Escape ends it.
 */
import {
  type Conversation,
  LIMITS,
  messageBodySchema,
  truncateCodePoints,
} from '@chatapp/contracts'
import { useQuery } from '@tanstack/react-query'
import { ArrowUp, X } from 'lucide-react'
import {
  type ChangeEvent,
  type KeyboardEvent,
  type RefObject,
  useLayoutEffect,
  useRef,
} from 'react'
import { engine, outbox } from '@/app/sync.ts'
import { IconButton } from '@/components/ui/button.tsx'
import { meQuery } from '@/lib/queries.ts'
import { serverNow } from '@/lib/realtime.ts'
import { endCompose, modeOf, useCompose } from '@/lib/sync/compose.ts'
import { draftOf, setDraft, useDrafts } from '@/lib/sync/drafts.ts'
import { useUsers } from '@/lib/sync/hooks.ts'
import { displayName } from '@/lib/sync/selectors.ts'
import { m } from '@/paraglide/messages.js'
import { editMessage } from '../message-actions/actions.ts'
import { lastEditable } from '../message-actions/eligibility.ts'
import { useMessageCommands } from '../message-actions/use-message-commands.ts'
import type { TimelineHandle } from '../timeline/timeline.tsx'
import { type CompositionState, initialComposition, shouldSend } from './enter-key.ts'
import { useTypingSignal } from './use-typing-signal.ts'

/** From this many code points on, the length is shown. */
const SHOW_COUNT_AT = 4500

const codePoints = (text: string): number => [...text].length

export function Composer({
  conversation,
  timeline,
}: {
  conversation: Conversation
  timeline: RefObject<TimelineHandle | null>
}) {
  const id = conversation.id
  const me = conversation.me
  const draft = useDrafts((state) => draftOf(state, id))
  const mode = useCompose((state) => modeOf(state, id))
  const { data: account } = useQuery(meQuery)
  const commands = useMessageCommands(id)
  const users = useUsers()
  const field = useRef<HTMLTextAreaElement>(null)
  const composition = useRef<CompositionState>(initialComposition())
  useTypingSignal(id, draft)

  // The field grows with its content up to the CSS maximum (40% of the window). Set through CSSOM, which the policy allows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measures whenever the text changes
  useLayoutEffect(() => {
    const element = field.current
    if (element === null) return
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }, [draft])

  const parsed = messageBodySchema.safeParse(draft)
  const length = codePoints(draft)
  const tooLong = length > LIMITS.messageMaxCodePoints
  const canSend = parsed.success && me !== null

  /** Ends a reply or an edit and puts back what was in the field before it (nothing, after a reply). */
  const leaveMode = (): void => {
    const wasEdit = mode?.type === 'edit'
    const stash = endCompose(id)
    if (wasEdit) setDraft(id, stash ?? '')
  }

  const send = async (): Promise<void> => {
    if (!canSend || me === null) return
    if (mode?.type === 'edit') {
      // Nothing changed: just leave the edit.
      if (draft === mode.message.body) return leaveMode()
      if (await editMessage(mode.message, draft)) leaveMode()
      return
    }
    const quote =
      mode?.type === 'reply'
        ? {
            id: mode.message.id,
            seq: mode.message.seq,
            senderId: mode.message.senderId,
            excerpt: truncateCodePoints(mode.message.body ?? '', LIMITS.excerptMaxCodePoints),
            state: 'ok' as const,
          }
        : null
    outbox.enqueue({
      conversationId: id,
      membershipId: me.membershipId,
      body: draft,
      replyToId: mode?.type === 'reply' ? mode.message.id : null,
      quote,
    })
    setDraft(id, '')
    if (mode?.type === 'reply') endCompose(id)
    field.current?.focus()
    void timeline.current?.toLatest()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const native = event.nativeEvent
    const state = composition.current
    if (event.key === 'Escape' && mode !== undefined && !native.isComposing && !state.composing) {
      event.preventDefault()
      leaveMode()
      return
    }
    // Up arrow in an empty field (nothing selected, not composing): change my last message while it can still be changed.
    if (
      event.key === 'ArrowUp' &&
      draft === '' &&
      mode === undefined &&
      !native.isComposing &&
      !state.composing &&
      event.currentTarget.selectionStart === 0 &&
      me !== null
    ) {
      const messages = engine.windowOf(id)?.messages ?? []
      const target = lastEditable(messages, {
        meId: account?.id ?? '',
        conversation: {
          kind: conversation.kind,
          archivedAt: conversation.archivedAt,
          me,
        },
        siteRole: account?.role ?? 'user',
        now: serverNow(),
      })
      if (target !== undefined) {
        event.preventDefault()
        commands.edit(target)
      }
      return
    }
    if (
      shouldSend(
        {
          key: event.key,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          isComposing: native.isComposing,
          keyCode: native.keyCode,
        },
        state,
        performance.now(),
      )
    ) {
      event.preventDefault()
      void send()
    }
  }

  const archived = conversation.archivedAt !== null
  const silenced = me?.silencedUntil != null
  if (archived || silenced) {
    return (
      <div className="composer glass-text squircle">
        <p className="composer__locked" role="status">
          {archived ? m.composer_archived() : m.composer_silenced()}
        </p>
      </div>
    )
  }

  const name = displayName(conversation, m.conversation_unnamed())
  const contextName =
    mode?.type === 'reply'
      ? mode.message.senderId === account?.id
        ? m.preview_you()
        : (users[mode.message.senderId ?? '']?.displayName ?? m.user_member())
      : ''
  return (
    <div className="composer glass-text squircle">
      {mode !== undefined ? (
        <div className="composer__ctx">
          <span className="composer__ctx-bar" aria-hidden="true" />
          <span className="composer__ctx-text">
            {mode.type === 'edit' ? (
              <b>{m.composer_editing()}</b>
            ) : (
              <>
                <b>{m.composer_replying()}</b>
                <span>
                  {contextName === '' ? '' : `${contextName}: `}
                  {mode.message.body ?? ''}
                </span>
              </>
            )}
          </span>
          <IconButton label={m.common_cancel()} icon={X} small onClick={leaveMode} />
        </div>
      ) : null}
      <div className="composer__row">
        <textarea
          ref={field}
          className="composer__input"
          rows={1}
          value={draft}
          aria-label={m.composer_label({ name })}
          placeholder={m.composer_placeholder({ name })}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setDraft(id, event.target.value)}
          onKeyDown={onKeyDown}
          onCompositionStart={() => {
            composition.current = { composing: true, endedAt: composition.current.endedAt }
          }}
          onCompositionEnd={() => {
            composition.current = { composing: false, endedAt: performance.now() }
          }}
        />
        <IconButton
          label={m.composer_send()}
          icon={ArrowUp}
          variant="filled"
          className="composer__send"
          disabled={!canSend}
          tooltip={false}
          onClick={() => void send()}
        />
      </div>
      {length >= SHOW_COUNT_AT ? (
        <div className="composer__hint" data-over={tooLong} role="status">
          {m.composer_count({ count: length, max: LIMITS.messageMaxCodePoints })}
        </div>
      ) : null}
    </div>
  )
}
