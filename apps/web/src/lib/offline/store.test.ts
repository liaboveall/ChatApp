import { expect, test } from 'vitest'
import { uuid } from '../sync/fixtures.ts'
import { DEFAULT_LIMITS, sizeOf } from './policy.ts'
import { type DraftRecord, keyOf } from './records.ts'
import { type Backend, OfflineStore } from './store.ts'

const who = { userId: 'alice', authEpoch: 1, restoreEpoch: 'r1' }
const now = 10 * 86_400_000
const record = (n: number, updatedAt = now): DraftRecord => ({
  ...who,
  kind: 'draft',
  conversationId: uuid(n),
  membershipId: uuid(100 + n),
  text: 'draft',
  updatedAt,
})
function backend() {
  const rows = new Map<string, unknown>()
  const store: Backend = {
    entries: async () => [...rows],
    set: async (key, value) => {
      rows.set(key, value)
    },
    delete: async (keys) => {
      for (const key of keys) rows.delete(key)
    },
    clear: async () => {
      rows.clear()
    },
  }
  return { rows, store }
}

test('writes enforce the storage ceiling immediately, without requiring a reload', async () => {
  const b = backend()
  const first = record(1, now - 1)
  const second = record(2)
  const store = new OfflineStore(b.store, () => now, {
    ...DEFAULT_LIMITS,
    maxBytes: sizeOf(second),
  })
  await store.put(first)
  await store.put(second)
  expect([...b.rows.keys()]).toEqual([keyOf(second)])
})

test('a write also removes records whose seven days passed while the page stayed open', async () => {
  const b = backend()
  const expired = record(1, now - DEFAULT_LIMITS.keepMs - 1)
  b.rows.set(keyOf(expired), expired)
  const store = new OfflineStore(b.store, () => now)
  await store.put(record(2))
  expect(b.rows.has(keyOf(expired))).toBe(false)
})

test('a stale disk read cannot delete the next account records', async () => {
  const b = backend()
  const next = { ...record(2), userId: 'bob' }
  b.rows.set(keyOf(next), next)
  let current = true
  b.store.entries = async () => {
    current = false
    return [...b.rows]
  }
  const loaded = await new OfflineStore(b.store, () => now).load(who, () => current)
  expect(loaded.drafts).toEqual([])
  expect(b.rows.has(keyOf(next))).toBe(true)
})
