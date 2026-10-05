import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { applyPresence, PresenceWatch, usePresence } from './presence.ts'

beforeEach(() => {
  vi.useFakeTimers()
  usePresence.setState({ byUser: {} })
})
afterEach(() => vi.useRealTimers())

const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `u${from + i}`)

describe('PresenceWatch', () => {
  test('asks for the people on screen after a short pause, once, however many screens say so', () => {
    const send = vi.fn((_ids: string[]) => true)
    const watch = new PresenceWatch(send)
    watch.want({ userIds: ['a', 'b'], priority: 1 })
    watch.want({ userIds: ['b', 'c'], priority: 1 })
    expect(send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(500)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(['a', 'b', 'c'])
  })

  test('replaces the whole set when a screen stops wanting people, and does not repeat an unchanged set', () => {
    const send = vi.fn((_ids: string[]) => true)
    const watch = new PresenceWatch(send)
    const stop = watch.want({ userIds: ['a'], priority: 1 })
    watch.want({ userIds: ['b'], priority: 1 })
    vi.advanceTimersByTime(500)
    stop()
    vi.advanceTimersByTime(500)
    expect(send).toHaveBeenLastCalledWith(['b'])
    watch.want({ userIds: ['b'], priority: 1 })
    vi.advanceTimersByTime(500)
    expect(send).toHaveBeenCalledTimes(2)
  })

  test('with more than 200 people wanted the more important ones win', () => {
    const send = vi.fn((_ids: string[]) => true)
    const watch = new PresenceWatch(send)
    watch.want({ userIds: ids(150, 1000), priority: 1 })
    watch.want({ userIds: ids(100), priority: 5 })
    vi.advanceTimersByTime(500)
    const sent = send.mock.calls.at(0)?.[0] ?? []
    expect(sent).toHaveLength(200)
    expect(sent.slice(0, 100)).toEqual(ids(100))
    expect(sent.at(-1)).toBe('u1099')
  })

  test('a new connection asks again for the same people', () => {
    const send = vi.fn((_ids: string[]) => true)
    const watch = new PresenceWatch(send)
    watch.want({ userIds: ['a'], priority: 1 })
    vi.advanceTimersByTime(500)
    watch.resend()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith(['a'])
  })

  test('a set that could not be sent (no connection) is tried again at the next chance', () => {
    let open = false
    const send = vi.fn((_ids: string[]) => open)
    const watch = new PresenceWatch(send)
    watch.want({ userIds: ['a'], priority: 1 })
    vi.advanceTimersByTime(500)
    open = true
    watch.resend()
    expect(send).toHaveBeenCalledTimes(2)
  })

  test('clearing forgets everything, so the next account starts from nothing', () => {
    const send = vi.fn((_ids: string[]) => true)
    const watch = new PresenceWatch(send)
    watch.want({ userIds: ['a'], priority: 1 })
    watch.clear()
    vi.advanceTimersByTime(1000)
    expect(send).not.toHaveBeenCalled()
    expect(watch.current()).toEqual([])
  })
})

describe('applyPresence', () => {
  test('keeps the latest entry per person', () => {
    applyPresence([{ userId: 'a', status: 'online', lastSeenAt: null }])
    applyPresence([
      { userId: 'a', status: 'away', lastSeenAt: null },
      { userId: 'b', status: 'offline', lastSeenAt: '2026-10-04T08:00:00.000Z' },
    ])
    expect(usePresence.getState().byUser.a?.status).toBe('away')
    expect(usePresence.getState().byUser.b?.status).toBe('offline')
  })

  test('an empty snapshot changes nothing', () => {
    const before = usePresence.getState()
    applyPresence([])
    expect(usePresence.getState()).toBe(before)
  })
})
