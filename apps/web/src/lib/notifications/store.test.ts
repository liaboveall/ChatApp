import type { Notification, NotificationPage } from '@chatapp/contracts'
import { beforeEach, expect, test } from 'vitest'
import { makeUser, uuid } from '../sync/fixtures.ts'
import { clearConversationStores } from '../sync/stores.ts'
import { noticeProjectionEpoch, notices, useNotices } from './store.ts'

const source = (): Extract<Notification, { type: 'mention' }> => ({
  id: uuid(1),
  version: 1,
  type: 'mention',
  readAt: null,
  createdAt: '2026-10-11T00:00:00.000Z',
  data: {
    available: true,
    conversation: { id: uuid(10), kind: 'group', name: 'private group' },
    message: { id: uuid(20), seq: 1, preview: 'private words', recalled: false },
    sender: makeUser(30),
  },
})
const page = (entry = source()): NotificationPage => ({
  items: [entry],
  nextCursor: null,
  unreadCount: entry.readAt === null ? 1 : 0,
})
beforeEach(() => notices.reset())

test('a fresh projection can withdraw a source without changing the notification row version', () => {
  notices.firstPage(page(), 1)
  const recalled = source()
  if (recalled.data.available)
    recalled.data.message = { ...recalled.data.message, preview: null, recalled: true }
  notices.firstPage(page(recalled), 2)
  expect(JSON.stringify(useNotices.getState().items)).not.toContain('private words')
})

test('every conversation reset erases projected names and words immediately', () => {
  notices.firstPage(page(), 1)
  clearConversationStores(uuid(10), 'membership')
  expect(useNotices.getState().items[0]?.data).toEqual({ available: false })
  expect(JSON.stringify(useNotices.getState().items)).not.toContain('private')
})

test('a list or older page started before a source change cannot restore it', () => {
  notices.firstPage(page(), 1)
  const epoch = noticeProjectionEpoch()
  notices.invalidateSources(uuid(10))
  expect(notices.firstPage(page(), 2, epoch)).toBe(false)
  expect(notices.olderPage(page(), 3, epoch)).toBe(false)
  expect(useNotices.getState().items[0]?.data).toEqual({ available: false })
})

test('a personal log or mark-read answer cannot reintroduce an earlier projection, even with a higher row version', () => {
  notices.firstPage(page(), 1)
  notices.invalidateSources(uuid(10))
  const read = { ...source(), version: 2, readAt: '2026-10-11T00:01:00.000Z' }
  notices.ingest([read])
  notices.marked([read], 0, 3)
  expect(useNotices.getState().items[0]?.data).toEqual({ available: false })
  expect(useNotices.getState().items[0]?.readAt).toBe(read.readAt)
})

test('an earlier read cannot overwrite the projection of a later read', () => {
  notices.firstPage(page({ ...source(), data: { available: false } }), 3)
  expect(notices.firstPage(page(), 2)).toBe(false)
  expect(useNotices.getState().items[0]?.data).toEqual({ available: false })
})

test('a fresh snapshot drops expired entries and retains a newer read state', () => {
  notices.firstPage(page({ ...source(), version: 2, readAt: '2026-10-11T00:01:00.000Z' }), 1)
  notices.firstPage(page(), 2)
  expect(useNotices.getState().items[0]?.version).toBe(2)
  expect(useNotices.getState().items[0]?.readAt).not.toBeNull()
  notices.firstPage({ items: [], nextCursor: null, unreadCount: 0 }, 3)
  expect(useNotices.getState().items).toEqual([])
})
