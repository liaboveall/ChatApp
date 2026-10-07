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
  UPLOAD_LIMITS,
} from '@chatapp/contracts'
import { useQuery } from '@tanstack/react-query'
import { ArrowUp, Paperclip, Smile, X } from 'lucide-react'
import {
  type ChangeEvent,
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { engine, forScreen, outbox } from '@/app/sync.ts'
import { IconButton } from '@/components/ui/button.tsx'
import { api } from '@/lib/api.ts'
import { describeError } from '@/lib/error-messages.ts'
import { messageText } from '@/lib/message-text.ts'
import { meQuery } from '@/lib/queries.ts'
import { serverNow } from '@/lib/realtime.ts'
import { endCompose, liveTarget, modeOf, useCompose } from '@/lib/sync/compose.ts'
import { draftOf, setDraft, useDrafts } from '@/lib/sync/drafts.ts'
import { useTimelineWindow, useUsers } from '@/lib/sync/hooks.ts'
import { displayName } from '@/lib/sync/selectors.ts'
import {
  addUpload,
  clearUploads,
  removeUpload,
  updateUpload,
  uploadsOf,
  useUploads,
} from '@/lib/sync/uploads.ts'
import { showToast } from '@/lib/toast.ts'
import { m } from '@/paraglide/messages.js'
import { uploadFile } from '../attachments/upload.ts'
import { saveEdit } from '../message-actions/actions.ts'
import { lastEditable } from '../message-actions/eligibility.ts'
import { useMessageCommands } from '../message-actions/use-message-commands.ts'
import type { TimelineHandle } from '../timeline/timeline.tsx'
import { type CompositionState, initialComposition, shouldSend } from './enter-key.ts'
import { MentionPicker } from './mention-picker.tsx'
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
  const uploads = useUploads((state) => uploadsOf(state, id))
  const picker = useRef<HTMLInputElement>(null)
  const [emoji, setEmoji] = useState(false)
  const [caret, setCaret] = useState(0)
  const listId = useId()
  const [activeMention, setActiveMention] = useState<string | undefined>()
  const [dismissedMention, setDismissedMention] = useState<string | null>(null)
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
  const canSend =
    (parsed.success ||
      (mode?.type !== 'edit' &&
        draft.trim() === '' &&
        uploads.some((entry) => entry.status === 'ready'))) &&
    me !== null &&
    uploads.every((entry) => entry.status === 'ready') &&
    !tooLong
  const mention = /(?:^|\s)@([^\s@<>]*)$/.exec(draft.slice(0, caret))
  const addFiles = (files: File[]): void => {
    if (mode?.type === 'edit') return
    if (uploadsOf(useUploads.getState(), id).length + files.length > 10) {
      showToast(m.media_too_many())
      return
    }
    for (const file of files) {
      if (
        file.size > UPLOAD_LIMITS.fileBytes ||
        (['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'].includes(file.type) &&
          file.size > UPLOAD_LIMITS.imageBytes)
      ) {
        showToast(m.media_too_large())
        continue
      }
      const entry = addUpload(id, file)
      void uploadFile(
        file,
        { purpose: 'message', name: file.name, conversationId: id },
        entry.controller.signal,
        (percent) =>
          updateUpload(id, entry.id, {
            percent,
            status: percent === 100 ? 'processing' : 'uploading',
          }),
        (uploadId) => updateUpload(id, entry.id, { uploadId }),
      )
        .then((attachment) => {
          if (attachment) updateUpload(id, entry.id, { status: 'ready', attachment })
        })
        .catch((error) =>
          updateUpload(id, entry.id, { status: 'failed', error: describeError(error) }),
        )
    }
  }
  const discardUpload = (entryId: string): void => {
    const entry = uploadsOf(useUploads.getState(), id).find((item) => item.id === entryId)
    removeUpload(id, entryId)
    if (entry?.uploadId)
      void forScreen(id, () => api(`/api/uploads/${entry.uploadId}`, { method: 'DELETE' })).catch(
        () => undefined,
      )
  }
  const insert = (text: string, start = field.current?.selectionStart ?? draft.length): void => {
    const end = field.current?.selectionEnd ?? start
    setDraft(id, draft.slice(0, start) + text + draft.slice(end))
    const ticket = engine.ticket(id)
    requestAnimationFrame(() => {
      if (!engine.isCurrent(ticket)) return
      field.current?.focus()
      field.current?.setSelectionRange(start + text.length, start + text.length)
      setCaret(start + text.length)
    })
  }

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
            excerpt: truncateCodePoints(
              messageText(target.body, users, target.attachments[0]?.kind),
              LIMITS.excerptMaxCodePoints,
            ),
            attachmentKind: target.attachments[0]?.kind ?? null,
            state: 'ok' as const,
          }
        : null
    outbox.enqueue({
      conversationId: id,
      membershipId: me.membershipId,
      body: draft,
      attachments: uploads.flatMap((entry) => (entry.attachment ? [entry.attachment] : [])),
      replyToId: quote?.id ?? null,
      quote,
    })
    clearUploads(id)
    setDraft(id, '')
    if (mode?.type === 'reply') endCompose(id, me.membershipId, mode.serial)
    field.current?.focus()
    void timeline.current?.toLatest()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.defaultPrevented) return
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
    // biome-ignore lint/a11y/noStaticElementInteractions: file drop augments the keyboard-accessible attachment button
    <div
      className="composer glass-text squircle"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault()
      }}
      onDrop={(event) => {
        event.preventDefault()
        addFiles([...event.dataTransfer.files])
      }}
    >
      <input
        ref={picker}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-label={m.media_attach()}
        onChange={(event) => {
          addFiles([...(event.target.files ?? [])])
          event.target.value = ''
        }}
      />
      {uploads.length ? (
        <div className="upload-drafts">
          {uploads.map((entry) => (
            <div className="upload-draft" key={entry.id}>
              <span>{entry.file.name}</span>
              {entry.status === 'uploading' ? (
                <progress max={100} value={entry.percent} aria-label={entry.file.name} />
              ) : null}
              <small role="status">
                {entry.status === 'uploading'
                  ? m.media_uploading({ percent: entry.percent })
                  : entry.status === 'processing'
                    ? m.media_processing()
                    : entry.status === 'failed'
                      ? (entry.error ?? m.media_failed())
                      : '✓'}
              </small>
              {entry.status === 'failed' ? (
                <button
                  type="button"
                  onClick={() => {
                    discardUpload(entry.id)
                    addFiles([entry.file])
                  }}
                >
                  {m.common_retry()}
                </button>
              ) : null}
              <IconButton
                small
                icon={X}
                label={m.common_cancel()}
                onClick={() => discardUpload(entry.id)}
              />
            </div>
          ))}
        </div>
      ) : null}
      {mention && dismissedMention !== `${draft}:${caret}` ? (
        <MentionPicker
          conversationId={id}
          membershipVersion={conversation.membershipVersion}
          query={mention[1] ?? ''}
          listId={listId}
          active={setActiveMention}
          dismiss={() => setDismissedMention(`${draft}:${caret}`)}
          choose={(user) => insert(`<@user:${user.id}> `, caret - (mention[1]?.length ?? 0) - 1)}
        />
      ) : null}
      {emoji ? (
        <fieldset className="emoji-picker" aria-label={m.media_emoji()}>
          {[
            '😀',
            '😂',
            '🥰',
            '😎',
            '🤔',
            '😢',
            '🎉',
            '❤️',
            '👍',
            '🙏',
            '🔥',
            '✅',
            '👀',
            '🚀',
            '🍀',
            '💡',
            '😊',
            '😍',
            '😭',
            '🤣',
            '😅',
            '🙃',
            '🫠',
            '🫡',
            '🤩',
            '🥳',
            '😴',
            '😤',
            '💪',
            '👏',
            '🤝',
            '👋',
            '✌️',
            '🙌',
            '🤞',
            '🫶',
            '👎',
            '💯',
            '❌',
            '⚠️',
            '⭐',
            '🌟',
            '✨',
            '🌈',
            '☀️',
            '🌙',
            '🌸',
            '🌻',
            '🐱',
            '🐶',
            '🐼',
            '🦊',
            '🍎',
            '🍕',
            '🍰',
            '☕',
            '🍻',
            '🎂',
            '🎁',
            '🎈',
            '🏆',
            '⚽',
            '🎮',
            '🎵',
            '💻',
            '📱',
            '📷',
            '📚',
            '📝',
            '📌',
            '🔗',
            '🔒',
            '💬',
            '💤',
            '💔',
            '🧡',
          ].map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                insert(value)
                setEmoji(false)
              }}
            >
              {value}
            </button>
          ))}
        </fieldset>
      ) : null}
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
                  {messageText(shown?.body, users, shown?.attachments[0]?.kind)}
                </span>
              </>
            )}
          </span>
          <IconButton label={m.common_cancel()} icon={X} small onClick={leaveMode} />
        </div>
      ) : null}
      <div className="composer__row">
        <IconButton
          label={m.media_attach()}
          icon={Paperclip}
          disabled={mode?.type === 'edit'}
          onClick={() => picker.current?.click()}
        />
        <IconButton
          label={m.media_emoji()}
          icon={Smile}
          aria-expanded={emoji}
          onClick={() => setEmoji(!emoji)}
        />
        <textarea
          ref={field}
          className="composer__input"
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-controls={activeMention ? listId : undefined}
          aria-activedescendant={activeMention}
          rows={1}
          value={draft}
          aria-label={m.composer_label({ name })}
          placeholder={m.composer_placeholder({ name })}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
            setDraft(id, event.target.value)
            setDismissedMention(null)
            setCaret(event.target.selectionStart)
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onPaste={(event) => {
            if (event.clipboardData.files.length) {
              event.preventDefault()
              addFiles([...event.clipboardData.files])
            }
          }}
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
