import { afterEach, expect, test } from 'vitest'
import { clearClientStores, clearConversationStores } from './stores.ts'
import { addUpload, updateUpload, uploadsOf, useUploads } from './uploads.ts'

afterEach(() => clearClientStores())
test('ending membership aborts its uploads and a late callback cannot resurrect a new membership draft', () => {
  const old = addUpload('c', new File(['old'], 'old.png'))
  const other = addUpload('other', new File(['other'], 'other.png'))
  clearConversationStores('c')
  expect(old.controller.signal.aborted).toBe(true)
  expect(other.controller.signal.aborted).toBe(false)
  const current = addUpload('c', new File(['new'], 'new.png'))
  updateUpload('c', old.id, { status: 'ready', percent: 100 })
  expect(uploadsOf(useUploads.getState(), 'c')).toEqual([current])
})
test('ending an account aborts and clears uploads of every conversation', () => {
  const a = addUpload('a', new File(['a'], 'a')),
    b = addUpload('b', new File(['b'], 'b'))
  clearClientStores()
  expect(a.controller.signal.aborted && b.controller.signal.aborted).toBe(true)
  updateUpload('a', a.id, { status: 'failed' })
  expect(useUploads.getState().byConversation).toEqual({})
})
