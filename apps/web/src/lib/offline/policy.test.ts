import { describe, expect, test } from 'vitest'
import { isStale, planRetention, sizeOf } from './policy.ts'
import {
  type DraftRecord,
  draftKey,
  keyOf,
  type QueuedRecord,
  queuedKey,
  type Stamp,
} from './records.ts'

const NOW = Date.parse('2026-10-09T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const who: Stamp = { userId: 'user-a', authEpoch: 3, restoreEpoch: 'r1' }
const C1 = '11111111-1111-4111-8111-111111111111'
const C2 = '22222222-2222-4222-8222-222222222222'
const M1 = '33333333-3333-4333-8333-333333333333'
const K1 = '44444444-4444-4444-8444-444444444444'

const draft = (patch: Partial<DraftRecord> = {}): DraftRecord => ({
  kind: 'draft',
  ...who,
  updatedAt: NOW - 1000,
  conversationId: C1,
  membershipId: M1,
  text: '还没发出去的话',
  ...patch,
})
const queued = (patch: Partial<QueuedRecord> = {}): QueuedRecord => ({
  kind: 'queued',
  ...who,
  updatedAt: NOW - 1000,
  conversationId: C1,
  membershipId: M1,
  clientId: K1,
  body: '离线时写的',
  replyToId: null,
  createdAt: new Date(NOW - 1000).toISOString(),
  state: 'offline',
  error: null,
  ...patch,
})
const entry = (record: DraftRecord | QueuedRecord) => [keyOf(record), record] as const

describe('what stays on disk', () => {
  test('a draft and a waiting message of this account stay', () => {
    const result = planRetention([entry(draft()), entry(queued())], who, NOW)
    expect(result.drop).toEqual([])
    expect(result.keep.map((k) => k.key)).toEqual(
      expect.arrayContaining([draftKey(who.userId, C1), queuedKey(who.userId, K1)]),
    )
  })

  test("another account's records, and another login or restore generation's, are deleted unread", () => {
    const records = [
      draft({ userId: 'user-b' }),
      draft({ conversationId: C2, authEpoch: 2 }),
      queued({ restoreEpoch: 'r0' }),
    ]
    const result = planRetention(records.map(entry), who, NOW)
    expect(result.keep).toEqual([])
    expect(result.drop).toHaveLength(3)
  })

  test('something that does not read as a record of the app is deleted', () => {
    const result = planRetention(
      [
        ['d/user-a/junk', { kind: 'draft', text: 'x' }],
        ['q/user-a/junk', 'a string'],
        ['whatever', null],
        // Extra fields are refused: the shape is fixed.
        [draftKey(who.userId, C1), { ...draft(), name: 'Alice' }],
        // A draft with no text is no draft.
        [draftKey(who.userId, C2), draft({ conversationId: C2, text: '' })],
      ],
      who,
      NOW,
    )
    expect(result.keep).toEqual([])
    expect(result.drop).toHaveLength(5)
  })

  test('a record under a key that is not its own is not trusted', () => {
    const result = planRetention(
      [[draftKey(who.userId, C2), draft({ conversationId: C1 })]],
      who,
      NOW,
    )
    expect(result.keep).toEqual([])
    expect(result.drop).toEqual([draftKey(who.userId, C2)])
  })

  test('seven days unchanged is the end of a draft and of a message waiting for the person', () => {
    const fresh = NOW - 7 * DAY + 1
    const old = NOW - 7 * DAY - 1
    const result = planRetention(
      [
        entry(draft({ updatedAt: fresh })),
        entry(draft({ conversationId: C2, updatedAt: old })),
        entry(queued({ updatedAt: old, state: 'failed', error: 'QUEUE_EXPIRED' })),
      ],
      who,
      NOW,
    )
    expect(result.keep.map((k) => k.key)).toEqual([draftKey(who.userId, C1)])
    expect(result.drop).toHaveLength(2)
  })

  test('over the cap the oldest go first, until what is left fits', () => {
    const records = [
      draft({ conversationId: C1, updatedAt: NOW - 3000, text: 'a'.repeat(100) }),
      draft({ conversationId: C2, updatedAt: NOW - 2000, text: 'b'.repeat(100) }),
      queued({ updatedAt: NOW - 1000, body: 'c'.repeat(100) }),
    ]
    const cap = sizeOf(records[1] as DraftRecord) + sizeOf(records[2] as QueuedRecord) + 10
    const result = planRetention(records.map(entry), who, NOW, { keepMs: 7 * DAY, maxBytes: cap })
    expect(result.keep.map((k) => k.record.updatedAt).sort()).toEqual([NOW - 2000, NOW - 1000])
    expect(result.drop).toEqual([draftKey(who.userId, C1)])
  })

  test('with nothing on disk there is nothing to do', () => {
    expect(planRetention([], who, NOW)).toEqual({ keep: [], drop: [] })
  })
})

describe('the 24 hours of the queue', () => {
  test('a message is stale after a day, not before', () => {
    expect(isStale(new Date(NOW - DAY).toISOString(), NOW)).toBe(false)
    expect(isStale(new Date(NOW - DAY - 1).toISOString(), NOW)).toBe(true)
  })
})
