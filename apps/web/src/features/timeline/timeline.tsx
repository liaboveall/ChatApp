/**
 * The virtualized timeline of one conversation (D-144, D-151 to D-153). The wiring is the one the V-09 experiment found
 * to hold the reading position to 0 px in all three engines: the list is told it is prepending only in the commit that
 * prepends, it starts at the newest message (or at the "new messages" line) before the first paint, it follows new
 * content only while the reader is at the bottom, and it loads older messages while the reader is still 600 px away from
 * the top. Everything else about the data (windows, versions, catch-up) is the engine's; this component only draws.
 */
import type { Conversation } from '@chatapp/contracts'
import { useQuery } from '@tanstack/react-query'
import {
  type KeyboardEvent,
  type Ref,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { VList, type VListHandle } from 'virtua'
import { engine, outbox } from '@/app/sync.ts'
import { Button } from '@/components/ui/button.tsx'
import { ConfirmDialog } from '@/components/ui/confirm-dialog.tsx'
import { useAppearance } from '@/lib/appearance.ts'
import { meQuery } from '@/lib/queries.ts'
import { serverNow } from '@/lib/realtime.ts'
import { pendingOf, useOutbox } from '@/lib/sync/outbox.ts'
import { displayName } from '@/lib/sync/selectors.ts'
import { useSyncUi } from '@/lib/sync/state.ts'
import type { TimelineWindow, UsersByid } from '@/lib/sync/types.ts'
import { useTime } from '@/lib/use-time.ts'
import { m } from '@/paraglide/messages.js'
import { deleteAsModerator, hideMessage } from '../message-actions/actions.ts'
import { actionsFor } from '../message-actions/eligibility.ts'
import { type MenuTarget, MessageMenu } from '../message-actions/message-menu.tsx'
import { useMessageCommands } from '../message-actions/use-message-commands.ts'
import { MessageAnnouncer } from './announcer.tsx'
import { buildItems, type TimelineItem } from './items.ts'
import { JumpToLatest } from './jump-to-latest.tsx'
import { type RowContext, TimelineRow } from './message-row.tsx'
import { useReadPosition } from './use-read-position.ts'

/** Pixels from the bottom within which the reader counts as "at the bottom". */
const AT_BOTTOM_PX = 8
/** How far from an end the list starts loading the next page. */
const LOAD_NEAR_PX = 600
/** The toolbar and a little air: a row shown "at the top" is placed this far down so it is not under the glass. */
const TOP_CLEARANCE_PX = 72

/** Room kept free under the composer when a row is brought into view (the composer floats over the list). */
const COMPOSER_CLEARANCE_PX = 24
/** How long a jump with the keyboard waits for the row it is going to, to be drawn, before it leaves the focus where it is. */
const FOCUS_WAIT_MS = 2_000

const NO_IDS: ReadonlySet<string> = new Set()

type Row = { kind: 'pad-top' } | { kind: 'pad-bottom' } | { kind: 'item'; item: TimelineItem }

export type TimelineHandle = {
  /** Brings the newest message into view: reads the newest page first if the window had moved away from it. */
  toLatest: () => Promise<void>
}

export type TimelineProps = {
  conversation: Conversation
  window: TimelineWindow
  users: UsersByid
  meId: string
  handleRef?: Ref<TimelineHandle>
}

/** True for the one render in which the list gained or lost rows at its start: the list keeps the reader's place then. */
function useShift(firstKey: string | undefined): boolean {
  const previous = useRef(firstKey)
  const shift = previous.current !== undefined && firstKey !== previous.current
  useLayoutEffect(() => {
    previous.current = firstKey
  })
  return shift
}

export function Timeline({ conversation, window: win, users, meId, handleRef }: TimelineProps) {
  const id = conversation.id
  const handle = useRef<VListHandle>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const loadingOlder = useRef(false)
  const loadingNewer = useRef(false)
  const [olderBusy, setOlderBusy] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const [leftAt, setLeftAt] = useState(0)
  const [placed, setPlaced] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  // The message whose row has the focus: kept drawn while the list scrolls somewhere else (D-153, D-166).
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [flashId, setFlashId] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuTarget | null>(null)
  const commands = useMessageCommands(id)
  const { data: account } = useQuery(meQuery)
  const siteRole = account?.role ?? 'user'
  const pendingJump = useRef<string | null>(null)
  const reduceMotion = useAppearance((state) => state.reduceMotion)
  const paged = useAppearance((state) => state.timelineMode) === 'paged'
  const [status, setStatus] = useState('')
  const { locale, timeZone, now } = useTime()
  const pending = useOutbox((state) => pendingOf(state, id))
  const anchor = useSyncUi((state) => state.anchors[id])

  const built = useMemo(
    () =>
      buildItems({
        window: win,
        pending,
        meId,
        conversation: { kind: conversation.kind, me: conversation.me },
        anchor,
        timeZone,
      }),
    [win, pending, meId, conversation.kind, conversation.me, anchor, timeZone],
  )
  const rows = useMemo<Row[]>(
    () => [
      { kind: 'pad-top' },
      ...built.items.map((item): Row => ({ kind: 'item', item })),
      { kind: 'pad-bottom' },
    ],
    [built],
  )

  const newest = win.messages[win.messages.length - 1]
  const newestId = newest?.id ?? null
  const currentId =
    selected !== null && win.messages.some((m_) => m_.id === selected) ? selected : newestId

  // Always the freshest values for callbacks that outlive a render (scroll handlers, observers, async answers).
  const latest = useRef({ rows, win, newest, paged })
  useLayoutEffect(() => {
    latest.current = { rows, win, newest, paged }
  })

  const toBottom = (smooth = false): void => {
    const count = latest.current.rows.length
    if (count > 0) handle.current?.scrollToIndex(count - 1, { align: 'end', smooth })
  }

  // A feed holds articles (ARIA, and axe insists): where nobody has written yet it is a plain group until the first message.
  const hasMessages = built.items.some((item) => item.type === 'message')
  const shift = useShift(rows[1]?.kind === 'item' ? rows[1].item.key : undefined)

  // Opening: the newest message, or the "new messages" line with the row above it for context, before the first paint.
  useLayoutEffect(() => {
    const list = handle.current
    if (list === null || placed) return
    const unread = rows.findIndex(
      (row) => row.kind === 'item' && row.item.type === 'message' && row.item.firstUnread,
    )
    if (unread > 1 || (unread === 1 && built.leadingUnread)) {
      const above = unread > 1 ? unread - 1 : unread
      // `scrollToIndex` keeps correcting while rows above are measured (their size is only a guess until drawn).
      list.scrollToIndex(above, { align: 'start', offset: -TOP_CLEARANCE_PX })
      stick.current = false
    } else {
      list.scrollToIndex(rows.length - 1, { align: 'end' })
      stick.current = true
    }
    setPlaced(true)
  }, [rows, built.leadingUnread, placed])

  // Content grew (a message, a growing line, a picture) while the reader is at the bottom: stay at the bottom.
  useEffect(() => {
    const inner = wrap.current?.firstElementChild?.firstElementChild
    if (!inner) return
    const observer = new ResizeObserver(() => {
      if (stick.current && !latest.current.win.hasMoreAfter) toBottom()
    })
    observer.observe(inner)
    return () => observer.disconnect()
  })

  const loadOlder = async (): Promise<void> => {
    if (loadingOlder.current || !latest.current.win.hasMoreBefore) return
    loadingOlder.current = true
    setOlderBusy(true)
    const before = latest.current.win.messages.length
    try {
      const loaded = await engine.loadOlder(id)
      // A reader who asked for the page by pressing the button is told it came (nothing moves on screen for them).
      if (loaded && latest.current.paged) {
        const count = (engine.windowOf(id)?.messages.length ?? before) - before
        if (count > 0) setStatus(m.timeline_loaded_older({ count }))
      }
    } finally {
      loadingOlder.current = false
      setOlderBusy(false)
    }
  }

  const loadNewer = async (): Promise<void> => {
    if (loadingNewer.current || !latest.current.win.hasMoreAfter) return
    loadingNewer.current = true
    const before = latest.current.win.messages.length
    try {
      const loaded = await engine.loadNewer(id)
      if (loaded && latest.current.paged) {
        const count = (engine.windowOf(id)?.messages.length ?? before) - before
        if (count > 0) setStatus(m.timeline_loaded_newer({ count }))
      }
    } finally {
      loadingNewer.current = false
    }
  }

  const onScroll = (offset: number): void => {
    const list = handle.current
    if (list === null) return
    const bottom =
      !latest.current.win.hasMoreAfter &&
      offset + list.viewportSize >= list.scrollSize - AT_BOTTOM_PX
    stick.current = bottom
    setAtBottom((was) => {
      if (was && !bottom) setLeftAt(latest.current.newest?.seq ?? 0)
      return bottom
    })
    // Page by page (the screen reader mode): older and newer messages come only when asked for with the buttons.
    if (latest.current.paged) return
    if (offset < LOAD_NEAR_PX) void loadOlder()
    if (list.scrollSize - offset - list.viewportSize < LOAD_NEAR_PX) void loadNewer()
  }

  // A window that does not fill the screen cannot scroll, so no scroll event would ever ask for more.
  useEffect(() => {
    const list = handle.current
    if (list === null || !placed || paged) return
    if (list.scrollSize <= list.viewportSize + LOAD_NEAR_PX) {
      void loadOlder()
      void loadNewer()
    }
  })

  // Jumping to a quoted message that had to be loaded: place it once the new window is on screen.
  useLayoutEffect(() => {
    const target = pendingJump.current
    if (target === null) return
    const index = rows.findIndex(
      (row) => row.kind === 'item' && row.item.type === 'message' && row.item.message.id === target,
    )
    if (index === -1) return
    pendingJump.current = null
    handle.current?.scrollToIndex(index, { align: 'center' })
    setFlashId(target)
  }, [rows])

  useEffect(() => {
    if (flashId === null) return
    const timer = setTimeout(() => setFlashId(null), 1000)
    return () => clearTimeout(timer)
  }, [flashId])

  // ── The keyboard in the feed (D-153): the arrows, Home/End and PageUp/PageDown move the current row, Escape goes to the
  // composer. Only while the row itself has the focus: controls inside a row keep their own keys.
  const bottomClearance = (): number =>
    (document.querySelector<HTMLElement>('.composer-dock')?.offsetHeight ?? 76) +
    COMPOSER_CLEARANCE_PX

  /** Scrolls just enough to have a row fully between the toolbar and the composer. */
  const reveal = (index: number): void => {
    const list = handle.current
    if (list === null) return
    const top = list.getItemOffset(index)
    const size = list.getItemSize(index)
    const band = list.viewportSize - TOP_CLEARANCE_PX - bottomClearance()
    if (top < list.scrollOffset + TOP_CLEARANCE_PX || size > band) {
      list.scrollTo(Math.max(0, top - TOP_CLEARANCE_PX))
    } else if (top + size > list.scrollOffset + list.viewportSize - bottomClearance()) {
      list.scrollTo(top + size - list.viewportSize + bottomClearance())
    }
  }

  const rowIndexOf = (messageId: string): number =>
    latest.current.rows.findIndex(
      (row) =>
        row.kind === 'item' && row.item.type === 'message' && row.item.message.id === messageId,
    )

  /**
   * The message the focus is on its way to, until it lands (the focus moves in the next frame, once the row is drawn).
   * Key presses that arrive before it does, as they will when a held key repeats during a long frame, go on from here
   * instead of all starting from the row that still has the focus; only the last target gets the focus.
   */
  const heading = useRef<string | undefined>(undefined)

  /** Makes a message the current row, brings it into view and puts the focus on it once it is drawn. */
  const focusMessage = (messageId: string, align: 'reveal' | 'top' = 'reveal'): void => {
    heading.current = messageId
    setSelected(messageId)
    const index = rowIndexOf(messageId)
    const list = handle.current
    if (index !== -1 && list !== null) {
      if (align === 'top') list.scrollToIndex(index, { align: 'start', offset: -TOP_CLEARANCE_PX })
      else reveal(index)
    }
    // The row is drawn a frame or two after the list scrolls to it; after a long jump to the top of what is loaded, the page
    // above is read first and the row only settles after that (a request and a commit), so the wait is a couple of seconds
    // and not a count of frames.
    const deadline = performance.now() + FOCUS_WAIT_MS
    const attempt = (): void => {
      if (heading.current !== messageId) return
      const element = wrap.current?.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`)
      element?.focus({ preventScroll: true })
      // A row that has just been drawn after a long jump is hidden by the list until it has been measured, and a hidden
      // element does not take the focus: it is only done when the element has it.
      if (element !== undefined && element !== null && document.activeElement === element) {
        heading.current = undefined
      } else if (performance.now() < deadline) requestAnimationFrame(attempt)
      else heading.current = undefined
    }
    requestAnimationFrame(attempt)
  }

  /** One message up or down; at the edge of what is loaded, the next page is read first. */
  const step = async (fromId: string, direction: -1 | 1): Promise<void> => {
    const at = latest.current.win.messages.findIndex((message) => message.id === fromId)
    const next = latest.current.win.messages[at + direction]
    if (next !== undefined) return focusMessage(next.id)
    const more = direction < 0 ? latest.current.win.hasMoreBefore : latest.current.win.hasMoreAfter
    if (!more) return
    const loaded = await (direction < 0 ? engine.loadOlder(id) : engine.loadNewer(id))
    if (!loaded) return
    const messages = engine.windowOf(id)?.messages ?? []
    const index = messages.findIndex((message) => message.id === fromId)
    const target = messages[index + direction]
    if (index !== -1 && target !== undefined) focusMessage(target.id)
  }

  const edge = async (which: 'first' | 'last'): Promise<void> => {
    if (which === 'last') await toLatest()
    const messages = engine.windowOf(id)?.messages ?? latest.current.win.messages
    const target = which === 'first' ? messages[0] : messages[messages.length - 1]
    if (target !== undefined) focusMessage(target.id, which === 'first' ? 'top' : 'reveal')
  }

  /** About a screenful up or down: the first message row that starts below (or above) what was on screen. */
  const page = (direction: -1 | 1): void => {
    const list = handle.current
    if (list === null) return
    const band = list.viewportSize - TOP_CLEARANCE_PX - bottomClearance()
    const probe =
      direction > 0
        ? list.scrollOffset + TOP_CLEARANCE_PX + band
        : Math.max(0, list.scrollOffset + TOP_CLEARANCE_PX - band)
    const rowsNow = latest.current.rows
    let index = list.findItemIndex(probe)
    const isMessage = (i: number): boolean => {
      const row = rowsNow[i]
      return row?.kind === 'item' && row.item.type === 'message'
    }
    while (index > 0 && index < rowsNow.length - 1 && !isMessage(index)) index += direction
    const row = rowsNow[index]
    if (row?.kind === 'item' && row.item.type === 'message') {
      focusMessage(row.item.message.id, 'top')
    } else {
      void edge(direction > 0 ? 'last' : 'first')
    }
  }

  const onFeedKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const target = event.target
    if (!(target instanceof HTMLElement) || !target.matches('article[data-message-id]')) return
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const messageId = heading.current ?? target.dataset.messageId
    if (messageId === undefined) return
    const handled = ((): boolean => {
      switch (event.key) {
        case 'ArrowUp':
          void step(messageId, -1)
          return true
        case 'ArrowDown':
          void step(messageId, 1)
          return true
        case 'Home':
          void edge('first')
          return true
        case 'End':
          void edge('last')
          return true
        case 'PageUp':
          page(-1)
          return true
        case 'PageDown':
          page(1)
          return true
        case 'Escape':
          document.querySelector<HTMLElement>('.composer__input')?.focus()
          return true
        default:
          return false
      }
    })()
    if (handled) event.preventDefault()
  }

  const toLatest = async (): Promise<void> => {
    const detached = latest.current.win.hasMoreAfter
    if (detached) await engine.backToLatest(id)
    stick.current = true
    setAtBottom(true)
    // The newest page is drawn by a later commit than the one this answer was written in: a scroll before that is a scroll
    // of the old list. So wait (a few frames at most) until the window reaches the newest message, then go to the bottom.
    // A short way down is smooth; from a window that was somewhere else it is an instant move.
    const settle = (frames: number): void => {
      if (latest.current.win.hasMoreAfter && frames < 30) {
        requestAnimationFrame(() => settle(frames + 1))
        return
      }
      toBottom(!reduceMotion && !detached)
    }
    requestAnimationFrame(() => settle(0))
  }
  useImperativeHandle(handleRef, () => ({ toLatest }))

  useReadPosition({
    conversationId: id,
    newestSeq: newest?.seq ?? null,
    attached: !win.hasMoreAfter,
    atBottom,
    placed,
  })

  const jumpTo = async (seq: number, messageId: string): Promise<void> => {
    const outcome = await engine.jumpTo(id, seq)
    if (outcome === 'unavailable') return
    if (outcome === 'in-window') {
      const index = latest.current.rows.findIndex(
        (row) =>
          row.kind === 'item' && row.item.type === 'message' && row.item.message.id === messageId,
      )
      if (index !== -1) handle.current?.scrollToIndex(index, { align: 'center' })
      setFlashId(messageId)
    } else {
      pendingJump.current = messageId
    }
  }

  // Where each message stands among the ones that are loaded; the total is unknown while either end is not reached.
  const positions = useMemo(
    () => new Map(win.messages.map((message, index) => [message.id, index + 1] as const)),
    [win.messages],
  )
  const setSize = win.hasMoreBefore || win.hasMoreAfter ? -1 : win.messages.length

  const context: RowContext = {
    positions,
    setSize,
    meId,
    users,
    locale,
    timeZone,
    now: now(),
    conversationName: displayName(conversation, m.conversation_unnamed()),
    joinedAt: conversation.me?.joinedAt ?? null,
    conversationKind: conversation.kind,
    currentId,
    freshIds: NO_IDS,
    onRetry: (entry) => outbox.retry(entry.clientId, entry.conversationId),
    onDiscard: (entry) => outbox.discard(entry.clientId, entry.conversationId),
    onJump: (replyTo) => void jumpTo(replyTo.seq, replyTo.id),
    onSelect: setSelected,
    flashId,
    actionsOf: (message) =>
      actionsFor({
        message,
        meId,
        conversation: {
          kind: conversation.kind,
          archivedAt: conversation.archivedAt,
          me: conversation.me,
        },
        siteRole,
        now: serverNow(),
      }),
    onMenu: (message, anchor) => {
      const actions = context.actionsOf(message)
      setMenu({ message, actions, anchor })
    },
    onReply: commands.reply,
  }

  // The current row (the one with the tab stop, and the one a jump is heading for) and the row that has the focus: the focus
  // must never fall to the body because a jump scrolled its row out of the window before the target was there to take it.
  const keep = useMemo(
    () =>
      rows.flatMap((row, index) =>
        row.kind === 'item' &&
        row.item.type === 'message' &&
        (row.item.message.id === currentId || row.item.message.id === focusedId)
          ? [index]
          : [],
      ),
    [rows, currentId, focusedId],
  )

  const behind = Math.max(0, conversation.lastSeq - leftAt)

  return (
    <>
      <div
        className={paged ? 'timeline-more' : 'timeline-more sr-only focus-within:not-sr-only'}
        hidden={!win.hasMoreBefore}
      >
        <Button
          kind="glass"
          size="sm"
          busy={olderBusy}
          aria-controls={`feed-${id}`}
          onClick={() => void loadOlder()}
        >
          {m.timeline_load_older()}
        </Button>
      </div>
      {/* The keys of a row are handled where they bubble to: the wrapper adds no box of its own. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move between the articles inside (roving tab stop) */}
      <div
        ref={wrap}
        className="timeline-wrap"
        style={{ display: 'contents' }}
        onKeyDown={onFeedKeyDown}
        onFocus={(event) => {
          const row =
            event.target instanceof Element
              ? event.target.closest('article[data-message-id]')
              : null
          setFocusedId(row?.getAttribute('data-message-id') ?? null)
        }}
        onBlur={(event) => {
          if (
            !(
              event.relatedTarget instanceof Node &&
              event.currentTarget.contains(event.relatedTarget)
            )
          ) {
            setFocusedId(null)
          }
        }}
      >
        <VList
          ref={handle}
          id={`feed-${id}`}
          className="timeline"
          role={hasMessages ? 'feed' : 'group'}
          aria-label={m.timeline_label({
            name: displayName(conversation, m.conversation_unnamed()),
          })}
          aria-busy={olderBusy || undefined}
          data={rows}
          shift={shift}
          // Page by page: everything that is loaded is drawn, so a screen reader reads it in order without gaps.
          bufferSize={paged ? 1_000_000 : LOAD_NEAR_PX}
          keepMounted={keep}
          onScroll={onScroll}
          data-loaded-count={win.messages.length}
        >
          {(row) =>
            row.kind === 'pad-top' ? (
              <div key="pad-top" className="t-pad-top" aria-hidden="true" />
            ) : row.kind === 'pad-bottom' ? (
              <div key="pad-bottom" className="t-pad-bottom" aria-hidden="true" />
            ) : (
              <div key={row.item.key} className="timeline__inner">
                <TimelineRow item={row.item} context={context} />
              </div>
            )
          }
        </VList>
      </div>
      {paged && win.hasMoreAfter ? (
        <div className="timeline-newer">
          <Button kind="glass" size="sm" onClick={() => void loadNewer()}>
            {m.timeline_load_newer()}
          </Button>
        </div>
      ) : null}
      {!atBottom || win.hasMoreAfter ? (
        <JumpToLatest count={behind} onClick={() => void toLatest()} />
      ) : null}
      <div className="sr-only" role="status" aria-live="polite">
        {status}
      </div>
      <MessageAnnouncer window={win} users={users} meId={meId} />
      <MessageMenu
        target={menu}
        onClose={() => setMenu(null)}
        onReply={commands.reply}
        onCopy={(message) => void commands.copy(message)}
        onEdit={commands.edit}
        onRecall={commands.recall}
        onHide={commands.askHide}
        onAdminDelete={commands.askDelete}
      />
      <ConfirmDialog
        open={commands.confirm?.kind === 'hide'}
        onOpenChange={(open) => !open && commands.clearConfirm()}
        title={m.confirm_hide_title()}
        description={m.confirm_hide_text()}
        confirmLabel={m.confirm_hide_action()}
        danger
        onConfirm={() => commands.confirm && void hideMessage(commands.confirm.message)}
      />
      <ConfirmDialog
        open={commands.confirm?.kind === 'delete'}
        onOpenChange={(open) => !open && commands.clearConfirm()}
        title={m.confirm_admin_delete_title()}
        description={m.confirm_admin_delete_text()}
        confirmLabel={m.confirm_admin_delete_action()}
        danger
        onConfirm={() => commands.confirm && void deleteAsModerator(commands.confirm.message)}
      />
    </>
  )
}
