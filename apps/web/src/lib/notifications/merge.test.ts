import type { Notification } from '@chatapp/contracts'
import { describe, expect, test } from 'vitest'
import { displayedUnread, mergeNotifications, unreadKnown } from './merge.ts'

const entry = (n: number, extra: Partial<Notification> = {}): Notification =>
  ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    version: 1,
    type: 'budget_alert',
    data: { period: '2026-10', percent: 80 },
    readAt: null,
    createdAt: new Date(Date.UTC(2026, 9, 9, 12, 0, n)).toISOString(),
    ...extra,
  }) as Notification

describe('merging notifications by version', () => {
  test('newest first, by time and then id', () => {
    const list = mergeNotifications({ items: [] }, [entry(1), entry(3), entry(2)])
    expect(list.items.map((item) => item.id.slice(-1))).toEqual(['3', '2', '1'])
    const same = new Date(Date.UTC(2026, 9, 9)).toISOString()
    const tie = mergeNotifications({ items: [] }, [
      entry(1, { createdAt: same }),
      entry(2, { createdAt: same }),
    ])
    expect(tie.items.map((item) => item.id.slice(-1))).toEqual(['2', '1'])
  })

  test('a higher version replaces, an equal or lower one does not', () => {
    const base = mergeNotifications({ items: [] }, [entry(1)])
    const read = entry(1, { version: 2, readAt: '2026-10-09T12:05:00.000Z' })
    const afterRead = mergeNotifications(base, [read])
    expect(afterRead.items[0]?.readAt).not.toBeNull()
    // The older, unread answer arrives late: it must not bring the unread mark back.
    expect(mergeNotifications(afterRead, [entry(1)])).toBe(afterRead)
    expect(mergeNotifications(afterRead, [read])).toBe(afterRead)
  })

  test('nothing new returns the same list, which saves a render', () => {
    const list = mergeNotifications({ items: [] }, [entry(1)])
    expect(mergeNotifications(list, [])).toBe(list)
    expect(mergeNotifications(list, [entry(1)])).toBe(list)
  })

  test('a new entry is inserted in its place among the known ones', () => {
    const list = mergeNotifications({ items: [] }, [entry(1), entry(3)])
    expect(mergeNotifications(list, [entry(2)]).items.map((item) => item.id.slice(-1))).toEqual([
      '3',
      '2',
      '1',
    ])
  })
})

describe('the unread count', () => {
  test('counts what is known, and never shows less than that', () => {
    const list = mergeNotifications({ items: [] }, [
      entry(1),
      entry(2, { readAt: '2026-10-09T13:00:00.000Z', version: 2 }),
      entry(3),
    ])
    expect(unreadKnown(list)).toBe(2)
    expect(displayedUnread(null, list)).toBe(2)
    expect(displayedUnread(7, list)).toBe(7)
    // A count from an earlier question that is lower than what is known now does not hide the known ones.
    expect(displayedUnread(1, list)).toBe(2)
    expect(displayedUnread(0, { items: [] })).toBe(0)
  })
})
