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
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react'
import { engine, outbox } from '@/app/sync.ts'
import { IconButton } from '@/components/ui/button.tsx'
import { meQuery } from '@/lib/queries.ts'
import { serverNow } from '@/lib/realtime.ts'
import { endCompose, liveTarget, modeOf, useCompose } from '@/lib/sync/compose.ts'
import { draftOf, setDraft, useDrafts } from '@/lib/sync/drafts.ts'
import { useTimelineWindow, useUsers } from '@/lib/sync/hooks.ts'
import { displayName } from '@/lib/sync/selectors.ts'
import { m } from '@/paraglide/messages.js'
import { saveEdit } from '../message-actions/actions.ts'
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
  const membershipId = me?.membershipId
  const draft = useDrafts((state) => draftOf(state, id))
  const stored = useCompose((state) => modeOf(state, id, membershipId))
  const win = useTimelineWindow(id)
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

  // The message a reply or an edit stands on is read from the timeline as it is now: the quoted text follows an edit, and
  // one that was recalled, deleted or hidden since is no target any more, so the mode ends (D-171).
  const target = stored === undefined ? undefined : liveTarget(stored, win)
  const mode = target === null ? undefined : stored
  const parsed = messageBodySchema.safeParse(draft)
  const length = codePoints(draft)
  const tooLong = length > LIMITS.messageMaxCodePoints
  const canSend = parsed.success && me !== null

  /**
   * Ends this reply or edit and puts back what was in the field before it (nothing, after a reply). It names the one it
   * ends: when another was started since, or the membership is another one, nothing is ended and the field is not touched.
   */
  const leaveMode = (): void => {
    if (stored === undefined) return
    const stash = endCompose(id, stored.membershipId, stored.serial)
    if (stash !== undefined) setDraft(id, stash)
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: ends the mode once, when its target is gone
  useEffect(() => {
    if (stored !== undefined && target === null) leaveMode()
  }, [stored, target])

  const send = async (): Promise<void> => {
    if (!canSend || me === null) return
    if (mode?.type === 'edit') {
      // Nothing changed: just leave the edit.
      if (draft === mode.message.body) return leaveMode()
      // The answer comes after this render has been replaced, and maybe after this screen is gone, so what it finishes is
      // not decided here: the edit that went out and the text that was sent are named, and the stores are asked (D-173).
      await saveEdit(mode, draft)
      return
    }
    const quote =
      mode?.type === 'reply' && target !== undefined && target !== null
        ? {
            id: target.id,
            seq: target.seq,
            senderId: target.senderId,
            excerpt: truncateCodePoints(target.body ?? '', LIMITS.excerptMaxCodePoints),
            state: 'ok' as const,
          }
        : null
    outbox.enqueue({
      conversationId: id,
      membershipId: me.membershipId,
      body: draft,
      replyToId: quote?.id ?? null,
      quote,
    })
    setDraft(id, '')
    if (mode?.type === 'reply') endCompose(id, me.membershipId, mode.serial)
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
  const shown = target ?? undefined
  const contextName =
    mode?.type === 'reply' && shown !== undefined
      ? shown.senderId === account?.id
        ? m.preview_you()
        : (users[shown.senderId ?? '']?.displayName ?? m.user_member())
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
                  {shown?.body ?? ''}
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
