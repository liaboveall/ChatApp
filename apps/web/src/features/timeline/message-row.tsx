import { assistantText, type Message, type ReplyTo, type UserSummary } from '@chatapp/contracts'
import { AlertCircle, CornerUpLeft, Ellipsis, History } from 'lucide-react'
import { LinkTabIndex } from '@/components/markdown/link-context.ts'
import { MentionContext } from '@/components/markdown/mention-context.ts'
import { MessageBody } from '@/components/markdown/message-body.tsx'
import { Avatar } from '@/components/ui/avatar.tsx'
import { IconButton } from '@/components/ui/button.tsx'
import { Icon } from '@/components/ui/icon.tsx'
import { cx } from '@/lib/cx.ts'
import { messageText } from '@/lib/message-text.ts'
import type { PendingMessage } from '@/lib/sync/outbox.ts'
import { dateTime, exactTime, separatorLabel } from '@/lib/time-format.ts'
import { m } from '@/paraglide/messages.js'
import { AgentRunCard } from '../agent/run-card.tsx'
import { Attachments } from '../attachments/gallery.tsx'
import { hasAny, type MessageActions } from '../message-actions/eligibility.ts'
import type { MessageItem, PendingItem, StartItem, TimelineItem } from './items.ts'
import { systemText } from './system-text.ts'

export type RowContext = {
  /** The place of each message among the loaded ones (1-based), for `aria-posinset`. */
  positions: ReadonlyMap<string, number>
  /** How many messages there are, or -1 while either end of the conversation has not been reached (ARIA feed). */
  setSize: number
  meId: string
  users: Record<string, UserSummary>
  locale: string
  timeZone: string | undefined
  now: number
  /** The conversation's name, for "this is the start of …". */
  conversationName: string
  /** When the person joined (the boundary row). */
  joinedAt: string | null
  conversationKind: 'channel' | 'group' | 'dm' | 'agent'
  /** The row Tab reaches (the roving tab stop of the feed). */
  currentId: string | null
  /** Rows that arrived while the screen was open spring in. */
  freshIds: ReadonlySet<string>
  onRetry: (pending: PendingMessage) => void
  onDiscard: (pending: PendingMessage) => void
  onJump: (replyTo: Extract<ReplyTo, { id: string }>) => void
  onSelect: (id: string) => void
  flashId: string | null
  /** What can be done with a message right now (the rules of `eligibility.ts`, with the server's clock). */
  actionsOf: (message: Message) => MessageActions
  onMenu: (message: Message, anchor: Element | { getBoundingClientRect: () => DOMRect }) => void
  onReply: (message: Message) => void
}

/** A point on the screen as a menu anchor (a right click opens the menu where the pointer is). */
const pointAt = (x: number, y: number): { getBoundingClientRect: () => DOMRect } => ({
  getBoundingClientRect: () => new DOMRect(x, y, 0, 0),
})

/** The three ways in to the menu of a message: right click, and from the keyboard Enter, Shift+F10 or the Menu key. */
function menuHandlers(message: Message, actions: MessageActions, context: RowContext) {
  return {
    onContextMenu: (event: React.MouseEvent<HTMLElement>): void => {
      if (!hasAny(actions)) return
      event.preventDefault()
      context.onMenu(message, pointAt(event.clientX, event.clientY))
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>): void => {
      if (event.target !== event.currentTarget || !hasAny(actions)) return
      if (
        event.key === 'Enter' ||
        event.key === 'ContextMenu' ||
        (event.shiftKey && event.key === 'F10')
      ) {
        event.preventDefault()
        context.onMenu(message, event.currentTarget)
      }
    },
  }
}

const nameOf = (context: RowContext, id: string | null, fallback: string): string => {
  if (id === null) return fallback
  const user = context.users[id]
  if (user === undefined) return fallback
  return user.deleted ? m.user_deleted() : user.displayName
}

function Separators({ item, context }: { item: TimelineItem; context: RowContext }) {
  return (
    <>
      {item.after.unread ? (
        <div className="unread-div" aria-hidden="true">
          {m.timeline_new_messages()}
        </div>
      ) : null}
      {item.after.date ? (
        <div className="date-sep" aria-hidden="true">
          <span>
            {separatorLabel(
              item.after.date,
              context.now,
              context.locale,
              { yesterday: m.time_yesterday() },
              context.timeZone,
            )}
          </span>
        </div>
      ) : null}
    </>
  )
}

function QuoteBar({
  replyTo,
  context,
  tabbable,
}: {
  replyTo: ReplyTo
  context: RowContext
  tabbable: boolean
}) {
  if (!('id' in replyTo)) {
    return (
      <div className="bubble__quote" data-hidden="true">
        <span>{m.quote_unavailable()}</span>
      </div>
    )
  }
  const state = replyTo.state
  if (state !== 'ok') {
    return (
      <div className="bubble__quote" data-hidden="true">
        <span>{state === 'recalled' ? m.quote_recalled() : m.quote_deleted()}</span>
      </div>
    )
  }
  return (
    <button
      type="button"
      className="bubble__quote"
      tabIndex={tabbable ? 0 : -1}
      onClick={() => context.onJump(replyTo)}
    >
      <b>{nameOf(context, replyTo.senderId, m.user_member())}</b>
      <span>{messageText(replyTo.excerpt, context.users, replyTo.attachmentKind)}</span>
    </button>
  )
}

function Notice({ item, context }: { item: MessageItem; context: RowContext }) {
  const message = item.message
  const current = context.currentId === message.id
  const text =
    item.notice === 'system'
      ? systemText(message, {
          name: (id) => nameOf(context, id, m.user_member()),
        })
      : item.notice === 'recalled'
        ? message.senderId === context.meId
          ? m.notice_you_recalled()
          : m.notice_recalled({ name: nameOf(context, message.senderId, m.user_member()) })
        : m.notice_deleted_by_admin()
  return (
    <article
      className="msg-article"
      aria-label={text}
      aria-posinset={context.positions.get(message.id)}
      aria-setsize={context.setSize}
      tabIndex={current ? 0 : -1}
      data-message-id={message.id}
      data-seq={message.seq}
      data-sender="system"
      onFocus={() => context.onSelect(message.id)}
      {...menuHandlers(message, context.actionsOf(message), context)}
    >
      <div className="sys">{text}</div>
    </article>
  )
}

function MessageRow({ item, context }: { item: MessageItem; context: RowContext }) {
  if (item.notice !== null) return <Notice item={item} context={context} />
  const message: Message = item.message
  const current = context.currentId === message.id
  const sender = nameOf(context, message.senderId, m.user_member())
  const user = message.senderId === null ? undefined : context.users[message.senderId]
  const who = item.who === 'me' ? 'out' : 'in'
  const actions = context.actionsOf(message)
  const label = `${sender}, ${exactTime(message.createdAt, context.locale, context.timeZone)}${
    item.firstUnread ? `, ${m.timeline_new_messages()}` : ''
  }`
  return (
    <article
      className="msg-article"
      aria-label={label}
      aria-posinset={context.positions.get(message.id)}
      aria-setsize={context.setSize}
      tabIndex={current ? 0 : -1}
      data-message-id={message.id}
      data-seq={message.seq}
      data-sender={item.who}
      data-first={item.first}
      onFocus={() => context.onSelect(message.id)}
      {...menuHandlers(message, actions, context)}
    >
      {item.showName ? <div className="msg-sender">{sender}</div> : null}
      <div
        className={cx(
          'msg',
          context.flashId === message.id && 'msg--flash',
          context.freshIds.has(message.id) && 'msg--new',
        )}
        data-who={who}
      >
        {who === 'in' && context.conversationKind !== 'dm' ? (
          <div className="msg__avatar">
            {item.showAvatar ? (
              <Avatar
                name={sender}
                src={user?.avatarUrl}
                seed={message.senderId ?? message.id}
                size={28}
                bot={user?.isBot === true}
              />
            ) : null}
          </div>
        ) : null}
        <div className="msg__col">
          <div
            className={cx(
              'bubble',
              who === 'out' ? 'bubble--out' : 'bubble--in',
              !item.first && 'bubble--join-prev',
              !item.last && 'bubble--join-next',
              item.last && 'bubble--tail',
            )}
          >
            {message.meta.reminder ? (
              <span className="bubble__reminder">{m.message_reminder()}</span>
            ) : null}
            {message.replyTo ? (
              <QuoteBar replyTo={message.replyTo} context={context} tabbable={current} />
            ) : null}
            <LinkTabIndex value={current ? undefined : -1}>
              <MentionContext
                value={{ users: context.users, meId: context.meId, valid: message.mentions }}
              >
                <MessageBody
                  text={
                    message.kind === 'agent'
                      ? assistantText(message.body ?? '')
                      : (message.body ?? '')
                  }
                />
              </MentionContext>
            </LinkTabIndex>
            {message.attachments.length ? <Attachments files={message.attachments} /> : null}
            {message.meta.viaAgent ? (
              <span className="bubble__via">{m.message_via_agent()}</span>
            ) : null}
            {message.kind === 'agent' ? (
              <AgentRunCard
                message={message}
                nameOf={(userId) => context.users[userId]?.displayName}
              />
            ) : null}
            {message.editedAt ? (
              <span
                className="bubble__edited"
                title={dateTime(message.editedAt, context.locale, context.timeZone)}
              >
                {m.message_edited()}
              </span>
            ) : null}
          </div>
        </div>
        <time className="msg__time" dateTime={message.createdAt}>
          {exactTime(message.createdAt, context.locale, context.timeZone)}
        </time>
        {hasAny(actions) ? (
          <div className="msg__tools glass-lite">
            {actions.reply ? (
              <IconButton
                label={m.action_reply()}
                icon={CornerUpLeft}
                tooltip={false}
                tabIndex={current ? 0 : -1}
                onClick={() => context.onReply(message)}
              />
            ) : null}
            <IconButton
              label={m.action_more()}
              icon={Ellipsis}
              tooltip={false}
              aria-haspopup="menu"
              tabIndex={current ? 0 : -1}
              onClick={(event) => context.onMenu(message, event.currentTarget)}
            />
          </div>
        ) : null}
      </div>
    </article>
  )
}

function PendingRow({ item, context }: { item: PendingItem; context: RowContext }) {
  const pending = item.pending
  const failed = pending.state === 'failed'
  const quote = pending.quote
  return (
    <article
      className="msg-article"
      aria-label={failed ? m.pending_failed_label() : m.pending_sending_label()}
      aria-busy={failed ? undefined : true}
      tabIndex={-1}
      data-pending={pending.clientId}
      data-sender="me"
      data-first={item.first}
    >
      <div className="msg" data-who="out">
        {failed ? (
          <button
            type="button"
            className="msg__fail"
            aria-label={m.pending_failed_label()}
            onClick={() => context.onRetry(pending)}
          >
            <Icon icon={AlertCircle} size={20} />
          </button>
        ) : null}
        <div className="msg__col">
          <div
            className={cx(
              'bubble bubble--out',
              !failed && 'bubble--sending',
              !item.first && 'bubble--join-prev',
              !item.last && 'bubble--join-next',
              item.last && 'bubble--tail',
            )}
          >
            {quote ? (
              <div className="bubble__quote" data-hidden="true">
                <b>{nameOf(context, quote.senderId, m.user_member())}</b>
                <span>{messageText(quote.excerpt, context.users, quote.attachmentKind)}</span>
              </div>
            ) : null}
            <MessageBody text={pending.body} />
            {pending.attachments?.length ? <Attachments files={pending.attachments} /> : null}
          </div>
        </div>
      </div>
      {failed ? (
        <div className="msg__retry">
          <button
            type="button"
            className="btn btn--plain btn--sm"
            onClick={() => context.onRetry(pending)}
          >
            {m.common_retry()}
          </button>
          <button
            type="button"
            className="btn btn--plain btn--sm"
            onClick={() => context.onDiscard(pending)}
          >
            {m.pending_discard()}
          </button>
        </div>
      ) : null}
    </article>
  )
}

function StartRow({ item, context }: { item: StartItem; context: RowContext }) {
  return (
    <div className="history-boundary">
      <Icon icon={History} size={18} />
      <div>
        {item.boundary === 'joined' && context.joinedAt !== null
          ? m.timeline_joined_boundary({
              time: dateTime(context.joinedAt, context.locale, context.timeZone),
            })
          : context.conversationKind === 'dm'
            ? m.timeline_start_dm({ name: context.conversationName })
            : m.timeline_start({ name: context.conversationName })}
      </div>
    </div>
  )
}

/** One virtualized row of the timeline: the row itself and the separators that hang under it. */
export function TimelineRow({ item, context }: { item: TimelineItem; context: RowContext }) {
  return (
    <div className="t-row" data-key={item.key}>
      {item.type === 'start' ? (
        <StartRow item={item} context={context} />
      ) : item.type === 'message' ? (
        <MessageRow item={item} context={context} />
      ) : (
        <PendingRow item={item} context={context} />
      )}
      <Separators item={item} context={context} />
    </div>
  )
}
