import type { Message } from '@chatapp/contracts'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { makeMessage, uuid } from '@/lib/sync/fixtures.ts'
import type { PendingMessage } from '@/lib/sync/outbox.ts'
import { windowFromPage } from '@/lib/sync/window.ts'
import { buildItems, type TimelineItem } from './items.ts'
import { useArrivals } from './use-arrivals.ts'

const ME = uuid(1)
const BEA = uuid(2)
const T0 = Date.parse('2026-10-04T08:00:00.000Z')
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString()
const MIN = 60_000

const msg = (seq: number, at: number, sender: string = BEA): Message =>
  makeMessage(seq, { senderId: sender, createdAt: iso(at) })

const pending = (clientId: string, at: number): PendingMessage => ({
  clientId,
  conversationId: uuid(500),
  membershipId: uuid(700),
  body: 'draft',
  replyToId: null,
  quote: null,
  createdAt: iso(at),
  state: 'sending',
  error: null,
})

const items = (messages: Message[], waiting: PendingMessage[] = []): TimelineItem[] =>
  buildItems({
    window: windowFromPage(uuid(500), uuid(700), {
      messages,
      hasMoreBefore: true,
      hasMoreAfter: false,
    }),
    pending: waiting,
    meId: ME,
    conversation: { kind: 'dm', me: { visibleFromSeq: 0 } },
    anchor: undefined,
    timeZone: 'UTC',
  }).items

const keyOf = (message: Message): string => `m:${message.id}`

function mount(first: TimelineItem[], live = true) {
  const state = { live }
  const hook = renderHook(({ rows }) => useArrivals(rows, () => state.live), {
    initialProps: { rows: first },
  })
  return {
    ...hook,
    state,
    show: (rows: TimelineItem[]) => act(() => hook.rerender({ rows })),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('useArrivals', () => {
  test('nothing has arrived in a list that is first drawn', () => {
    const { result } = mount(items([msg(1, 0), msg(2, MIN)]))
    expect(result.current.size).toBe(0)
  })

  test('a message at the foot makes its entrance, and the mark is taken off after it', () => {
    const one = msg(1, 0)
    const two = msg(2, MIN)
    const { result, show } = mount(items([one]))
    show(items([one, two]))
    expect(result.current.get(keyOf(two))).toEqual({ entering: true, delay: 0, after: false })
    expect(result.current.has(keyOf(one))).toBe(false)
    act(() => vi.advanceTimersByTime(1500))
    expect(result.current.size).toBe(0)
  })

  test('nothing is marked while the reader is not at the foot of the list', () => {
    const one = msg(1, 0)
    const { result, show } = mount(items([one]), false)
    show(items([one, msg(2, MIN)]))
    expect(result.current.size).toBe(0)
  })

  test('my message confirmed mid-entrance goes on from where its pending bubble was', () => {
    const one = msg(1, 0)
    const mine = msg(2, MIN, ME)
    const { result, show } = mount(items([one]))
    show(items([one], [pending('a', MIN)]))
    expect(result.current.get('o:a')?.entering).toBe(true)
    act(() => vi.advanceTimersByTime(80))
    show(items([one, mine]))
    const confirmed = result.current.get(keyOf(mine))
    expect(confirmed?.entering).toBe(true)
    expect(confirmed?.delay).toBeLessThanOrEqual(-80)
    expect(confirmed?.delay).toBeGreaterThan(-200)
  })

  test('my message confirmed after the entrance simply stands where its pending bubble stood', () => {
    const one = msg(1, 0)
    const mine = msg(2, MIN, ME)
    const { result, show } = mount(items([one]))
    show(items([one], [pending('a', MIN)]))
    act(() => vi.advanceTimersByTime(5000))
    show(items([one, mine]))
    expect(result.current.has(keyOf(mine))).toBe(false)
  })

  test('a day line that comes with the message opens with it, under the row above', () => {
    const one = msg(1, 0)
    const later = msg(2, 3 * 60 * MIN)
    const { result, show } = mount(items([one]))
    show(items([one, later]))
    expect(result.current.get(keyOf(later))?.entering).toBe(true)
    expect(result.current.get(keyOf(one))).toEqual({ entering: false, delay: 0, after: true })
  })

  test('a separator that was already there is left alone', () => {
    const one = msg(1, 0)
    const later = msg(2, 3 * 60 * MIN)
    const last = msg(3, 3 * 60 * MIN + 1000)
    const { result, show } = mount(items([one, later]))
    show(items([one, later, last]))
    expect(result.current.get(keyOf(last))?.entering).toBe(true)
    expect(result.current.has(keyOf(one))).toBe(false)
    expect(result.current.get(keyOf(later))).toBeUndefined()
  })
})
