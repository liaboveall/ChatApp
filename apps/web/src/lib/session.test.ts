import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { queryKeys } from './queries.ts'
import {
  currentGeneration,
  endSession,
  markSignedIn,
  type SessionDeps,
  sessionStarted,
  startSession,
} from './session.ts'
import { SCOPED_PREFIX } from './storage.ts'

let deps: SessionDeps
let queryClient: QueryClient
let stop: () => void

beforeEach(() => {
  localStorage.clear()
  queryClient = new QueryClient()
  deps = {
    queryClient,
    stopRealtime: vi.fn(),
    toSignIn: vi.fn(),
    onSignedInElsewhere: vi.fn(),
  }
  stop = startSession(deps)
})
afterEach(() => stop())

describe('ending a session', () => {
  test('clears everything that belonged to the account, closes the connection and goes to sign-in', () => {
    markSignedIn()
    queryClient.setQueryData(queryKeys.me, { id: 'u1' })
    queryClient.setQueryData(queryKeys.devices, [{ id: 'd1' }])
    localStorage.setItem(`${SCOPED_PREFIX}.u1.0.draft`, 'private')
    localStorage.setItem('chatapp.appearance', '{"theme":"dark"}')
    const before = currentGeneration()

    endSession('expired')

    expect(queryClient.getQueryData(queryKeys.me)).toBeNull()
    expect(queryClient.getQueryData(queryKeys.devices)).toBeUndefined()
    expect(localStorage.getItem(`${SCOPED_PREFIX}.u1.0.draft`)).toBeNull()
    // Device-level settings are not account data.
    expect(localStorage.getItem('chatapp.appearance')).toBe('{"theme":"dark"}')
    expect(deps.stopRealtime).toHaveBeenCalledTimes(1)
    expect(deps.toSignIn).toHaveBeenCalledWith('expired')
    expect(currentGeneration()).toBe(before + 1)
  })

  test('the second signal about the same loss does nothing', () => {
    markSignedIn()
    endSession('expired')
    endSession('expired')
    endSession('ended-elsewhere', { announce: false })
    expect(deps.toSignIn).toHaveBeenCalledTimes(1)
    expect(deps.stopRealtime).toHaveBeenCalledTimes(1)
  })

  test('a loss signalled when nobody was signed in is not a loss', () => {
    endSession('expired')
    expect(deps.toSignIn).not.toHaveBeenCalled()
  })

  test('an explicit sign-out always acts, and a later sign-in re-arms the guard', () => {
    endSession('signed-out')
    expect(deps.toSignIn).toHaveBeenCalledWith('signed-out')
    sessionStarted()
    endSession('expired')
    expect(deps.toSignIn).toHaveBeenCalledTimes(2)
  })
})

describe('other tabs', () => {
  test("a sign-out announced by another tab ends this tab's session without announcing it again", async () => {
    markSignedIn()
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'chatapp.signed-out-at',
        newValue: `${Date.now()}:signed-out`,
      }),
    )
    expect(deps.toSignIn).toHaveBeenCalledWith('ended-elsewhere')
    expect(queryClient.getQueryData(queryKeys.me)).toBeNull()
  })

  test('a password change in another tab is reported as such', () => {
    markSignedIn()
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'chatapp.signed-out-at',
        newValue: `${Date.now()}:password-changed`,
      }),
    )
    expect(deps.toSignIn).toHaveBeenCalledWith('password-changed')
  })
})
