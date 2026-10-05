import type { Message } from '@chatapp/contracts'
import { describe, expect, test } from 'vitest'
import { makeMessage, recalled, uuid } from '@/lib/sync/fixtures.ts'
import type { PendingMessage } from '@/lib/sync/outbox.ts'
import { emptyWindow, windowFromPage } from '@/lib/sync/window.ts'
import { type BuildInput, buildItems, type MessageItem } from './items.ts'

const ME = uuid(1)
const BEA = uuid(2)
const CAL = uuid(3)
const MIN = 60_000
const T0 = Date.parse('2026-10-04T08:00:00.000Z')
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString()

const msg = (seq: number, at: number, sender: string | null = BEA, patch: Partial<Message> = {}) =>
  makeMessage(seq, { senderId: sender, createdAt: iso(at), ...patch })

function build(
  messages: Message[],
  options: Partial<BuildInput> & { hasMoreBefore?: boolean; hasMoreAfter?: boolean } = {},
) {
  const { hasMoreBefore = false, hasMoreAfter = false, ...rest } = options
  return buildItems({
    window: windowFromPage(uuid(500), uuid(700), { messages, hasMoreBefore, hasMoreAfter }),
    pending: [],
    meId: ME,
    conversation: { kind: 'group', me: { visibleFromSeq: 0 } },
    anchor: undefined,
    timeZone: 'UTC',
    ...rest,
  })
}

const rowsOf = (built: ReturnType<typeof build>) =>
  built.items.filter((item): item is MessageItem => item.type === 'message')

const pending = (
  clientId: string,
  at: number,
  patch: Partial<PendingMessage> = {},
): PendingMessage => ({
  clientId,
  conversationId: uuid(500),
  membershipId: uuid(700),
  body: 'draft',
  replyToId: null,
  quote: null,
  createdAt: iso(at),
  state: 'sending',
  error: null,
  ...patch,
})

describe('the start of the timeline', () => {
  test('is there only when nothing older is left, as "the beginning" or as the boundary of when I joined', () => {
    expect(build([msg(1, 0)]).items[0]).toMatchObject({ type: 'start', boundary: 'beginning' })
    expect(
      build([msg(5, 0)], { conversation: { kind: 'group', me: { visibleFromSeq: 4 } } }).items[0],
    ).toMatchObject({ type: 'start', boundary: 'joined' })
    expect(build([msg(5, 0)], { hasMoreBefore: true }).items[0]?.type).toBe('message')
  })

  test('an empty conversation is just the start', () => {
    const built = buildItems({
      window: emptyWindow(uuid(500), uuid(700)),
      pending: [],
      meId: ME,
      conversation: { kind: 'group', me: { visibleFromSeq: 0 } },
      anchor: undefined,
    })
    expect(built.items.map((i) => i.type)).toEqual(['start'])
  })
})

describe('time separators', () => {
  test('the first message always has one above it, carried by the start row', () => {
    const built = build([msg(1, 0)])
    expect(built.items[0]?.after.date).toBe(iso(0))
  })

  test('a gap of more than an hour, or a new day, gets one under the row above; shorter gaps do not', () => {
    const built = build([msg(1, 0), msg(2, 59 * MIN), msg(3, 59 * MIN + 61 * MIN)])
    const [a, b, c] = rowsOf(built)
    expect(a?.after.date).toBeNull()
    expect(b?.after.date).toBe(iso(120 * MIN))
    expect(c?.after.date).toBeNull()
  })

  test('midnight in the person’s zone splits two messages a minute apart', () => {
    const late = Date.parse('2026-10-04T15:59:30Z') - T0
    const built = build([msg(1, late), msg(2, late + MIN)], { timeZone: 'Asia/Shanghai' })
    expect(rowsOf(built)[0]?.after.date).toBe(iso(late + MIN))
    expect(build([msg(1, late), msg(2, late + MIN)], { timeZone: 'UTC' }).items[1]).toMatchObject({
      after: { date: null },
    })
  })

  test('a separator ends a group', () => {
    const built = build([msg(1, 0), msg(2, MIN), msg(3, 100 * MIN)])
    const [a, b, c] = rowsOf(built)
    expect([a?.first, a?.last]).toEqual([true, false])
    expect([b?.first, b?.last]).toEqual([false, true])
    expect([c?.first, c?.last]).toEqual([true, true])
  })
})

describe('grouping', () => {
  test('consecutive messages of one sender within three minutes are one group', () => {
    const built = build([msg(1, 0), msg(2, MIN), msg(3, 2 * MIN), msg(4, 6 * MIN)])
    const flags = rowsOf(built).map((r) => [r.first, r.last])
    expect(flags).toEqual([
      [true, false],
      [false, false],
      [false, true],
      [true, true],
    ])
  })

  test('another sender starts a new group', () => {
    const built = build([msg(1, 0, BEA), msg(2, MIN, CAL), msg(3, 2 * MIN, BEA)])
    expect(rowsOf(built).map((r) => [r.first, r.last])).toEqual([
      [true, true],
      [true, true],
      [true, true],
    ])
  })

  test('names go above the first and avatars beside the last of a group, for other people in groups and channels only', () => {
    const built = build([
      msg(1, 0, BEA),
      msg(2, MIN, BEA),
      msg(3, 2 * MIN, ME),
      msg(4, 3 * MIN, ME),
    ])
    const [a, b, c, d] = rowsOf(built)
    expect([a?.showName, a?.showAvatar]).toEqual([true, false])
    expect([b?.showName, b?.showAvatar]).toEqual([false, true])
    expect([c?.who, c?.showName, c?.showAvatar]).toEqual(['me', false, false])
    expect([d?.showName, d?.showAvatar]).toEqual([false, false])
    const dm = build([msg(1, 0, BEA)], { conversation: { kind: 'dm', me: { visibleFromSeq: 0 } } })
    expect([rowsOf(dm)[0]?.showName, rowsOf(dm)[0]?.showAvatar]).toEqual([false, false])
  })

  test('recalled, deleted and system rows are plain lines that break a group', () => {
    const built = build([
      msg(1, 0),
      recalled(msg(2, MIN), 9),
      msg(3, 2 * MIN),
      msg(4, 3 * MIN, null, { kind: 'system', body: null }),
      msg(5, 4 * MIN),
    ])
    const rows = rowsOf(built)
    expect(rows.map((r) => r.notice)).toEqual([null, 'recalled', null, 'system', null])
    expect(rows.map((r) => [r.first, r.last])).toEqual([
      [true, true],
      [true, true],
      [true, true],
      [true, true],
      [true, true],
    ])
    expect(rows[3]?.who).toBe('system')
    expect(rows[1]?.showName).toBe(false)
  })

  test('a deleted message is shown as deleted', () => {
    const deleted = msg(2, MIN, BEA, { body: null, deletedAt: iso(MIN) })
    expect(rowsOf(build([msg(1, 0), deleted]))[1]?.notice).toBe('deleted')
  })
})

describe('the "new messages" line', () => {
  test('hangs under the row above the first unread message from someone else; my own are skipped', () => {
    const built = build(
      [msg(1, 0), msg(2, MIN), msg(3, 2 * MIN, ME), msg(4, 3 * MIN, BEA), msg(5, 4 * MIN)],
      {
        anchor: 2,
      },
    )
    const rows = rowsOf(built)
    expect(rows.map((r) => r.after.unread)).toEqual([false, false, true, false, false])
    expect(rows.map((r) => r.firstUnread)).toEqual([false, false, false, true, false])
    expect(built.leadingUnread).toBe(false)
  })

  test('ends the group above it', () => {
    const built = build([msg(1, 0), msg(2, MIN), msg(3, 2 * MIN)], { anchor: 2 })
    const rows = rowsOf(built)
    expect([rows[1]?.last, rows[2]?.first]).toEqual([true, true])
  })

  test('is carried by the start row when the first unread message is the first message', () => {
    const built = build([msg(1, 0)], { anchor: 0 })
    expect(built.items[0]?.after.unread).toBe(true)
    expect(built.leadingUnread).toBe(false)
  })

  test('with older messages still to load it sits above the first row, which has no row above it', () => {
    const built = build([msg(10, 0), msg(11, MIN)], { anchor: 9, hasMoreBefore: true })
    expect(built.leadingUnread).toBe(true)
    expect(rowsOf(built)[0]?.firstUnread).toBe(true)
  })

  test('nothing when there is no anchor or nothing after it', () => {
    expect(rowsOf(build([msg(1, 0), msg(2, MIN)])).some((r) => r.firstUnread)).toBe(false)
    expect(rowsOf(build([msg(1, 0), msg(2, MIN)], { anchor: 2 })).some((r) => r.firstUnread)).toBe(
      false,
    )
  })
})

describe('messages being sent', () => {
  test('follow the last message when the window reaches the newest one, and join my own group', () => {
    const built = build([msg(1, 0, BEA), msg(2, MIN, ME)], {
      pending: [pending('a', 2 * MIN), pending('b', 2 * MIN + 1000)],
    })
    const items = built.items
    expect(items.map((i) => i.type)).toEqual(['start', 'message', 'message', 'pending', 'pending'])
    expect(items.at(-1)).toMatchObject({ type: 'pending', first: false, last: true, who: 'me' })
    expect(items.at(-2)).toMatchObject({ type: 'pending', first: false, last: false })
    expect(items.at(-3)).toMatchObject({ first: true, last: false })
  })

  test('are not shown while the window is detached from the newest message', () => {
    const built = build([msg(1, 0)], { pending: [pending('a', MIN)], hasMoreAfter: true })
    expect(built.items.some((i) => i.type === 'pending')).toBe(false)
  })

  test('get a time separator like any other row', () => {
    const built = build([msg(1, 0)], { pending: [pending('a', 3 * 60 * MIN)] })
    expect(rowsOf(built)[0]?.after.date).toBe(iso(180 * MIN))
  })
})

describe('what loading older messages must not disturb', () => {
  test('rows that were already there keep their separators when a page is added above them', () => {
    const all = [
      msg(5, 0),
      msg(6, 30 * MIN),
      msg(7, 31 * MIN),
      msg(8, 200 * MIN),
      msg(9, 201 * MIN),
    ]
    const before = build(all.slice(2), { hasMoreBefore: true })
    const after = build(all, { hasMoreBefore: true })
    const afterByKey = new Map(after.items.map((item) => [item.key, item]))
    for (const row of before.items) {
      expect(afterByKey.get(row.key)?.after, row.key).toEqual(row.after)
    }
  })
})
