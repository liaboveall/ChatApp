import { QueryClient } from '@tanstack/react-query'
import { describe, expect, test } from 'vitest'
import { queryKeys, writeMe, writeMeAnswer } from './queries.ts'
import { makeAccount, uuid } from './sync/fixtures.ts'

const cache = (value?: ReturnType<typeof makeAccount> | null) => {
  const client = new QueryClient()
  if (value !== undefined) client.setQueryData(queryKeys.me, value)
  return client
}

describe('the answer to a write on my own account (R3, SEC-34)', () => {
  test('updates the same identity by its version', () => {
    const client = cache(makeAccount({ meVersion: 2, displayName: 'Now' }))
    writeMeAnswer(client, makeAccount({ meVersion: 3, displayName: 'Newer' }))
    expect(client.getQueryData<{ displayName: string }>(queryKeys.me)?.displayName).toBe('Newer')
    writeMeAnswer(client, makeAccount({ meVersion: 1, displayName: 'Older' }))
    expect(client.getQueryData<{ displayName: string }>(queryKeys.me)?.displayName).toBe('Newer')
  })

  test('never puts one account in the place of another', () => {
    const client = cache(makeAccount({ id: uuid(2), displayName: 'B' }))
    writeMeAnswer(client, makeAccount({ id: uuid(1), displayName: 'A', meVersion: 99 }))
    expect(client.getQueryData<{ displayName: string }>(queryKeys.me)?.displayName).toBe('B')
  })

  test('never writes into a cache nobody is signed in to, or into an empty one', () => {
    const signedOut = cache(null)
    writeMeAnswer(signedOut, makeAccount())
    expect(signedOut.getQueryData(queryKeys.me)).toBeNull()
    const empty = cache()
    writeMeAnswer(empty, makeAccount())
    expect(empty.getQueryData(queryKeys.me)).toBeUndefined()
  })

  test('is not for another login generation or restore generation of the same person either', () => {
    const client = cache(makeAccount({ authEpoch: 2 }))
    writeMeAnswer(
      client,
      makeAccount({ authEpoch: 1, meVersion: 99, displayName: 'Before the password change' }),
    )
    expect(client.getQueryData<{ authEpoch: number }>(queryKeys.me)?.authEpoch).toBe(2)
    const restored = cache(makeAccount({ restoreEpoch: 'r2' }))
    writeMeAnswer(restored, makeAccount({ restoreEpoch: 'r1', meVersion: 99 }))
    expect(restored.getQueryData<{ restoreEpoch: string }>(queryKeys.me)?.restoreEpoch).toBe('r2')
  })

  test('a fresh read still replaces the identity (that is what signing in as someone else is)', () => {
    const client = cache(makeAccount({ id: uuid(2) }))
    writeMe(client, makeAccount({ id: uuid(1) }))
    expect(client.getQueryData<{ id: string }>(queryKeys.me)?.id).toBe(uuid(1))
  })
})
