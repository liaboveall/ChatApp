import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api } from './api.ts'
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
    resetClientState: vi.fn(),
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
    expect(deps.resetClientState).toHaveBeenCalledTimes(1)
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

/**
 * D-175 (M2b recheck 2026-10-06, R6): what a request brings back is for the login session it was made in. The answer to a
 * request of the account that signed out, arriving after somebody else signed in, in the same page, must neither end the
 * new session nor clear what it holds nor tell the other tabs it ended; and the browser is told to give such requests up
 * when their session ends, because what the browser does with an answer (it keeps its cookies) is not up to the page.
 */
describe('requests that outlive their session', () => {
  const fetchMock = vi.fn<typeof fetch>()
  const unauthenticated = (): Response =>
    new Response(
      JSON.stringify({
        error: { code: 'UNAUTHENTICATED', message: 'Sign in required', requestId: 'r' },
      }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    )

  /** A fetch that answers when the test says, whatever happened to its signal: an answer already on its way. */
  const answersLater = (response: Response): (() => void) => {
    let answer: () => void = () => undefined
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = () => resolve(response)
        }),
    )
    return () => answer()
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    fetchMock.mockReset()
    vi.unstubAllGlobals()
  })

  test('the 401 for the request of the account that signed out does not end the session of the next one', async () => {
    markSignedIn()
    // Alice's request is out; she signs out.
    const answer = answersLater(unauthenticated())
    const outcome = api('/api/conversations', { json: {} }).catch((caught: unknown) => caught)
    endSession('signed-out')
    expect(deps.toSignIn).toHaveBeenCalledTimes(1)

    // Bob signs in and has things of his own.
    sessionStarted()
    markSignedIn()
    localStorage.removeItem('chatapp.signed-out-at')
    queryClient.setQueryData(queryKeys.me, { id: 'bob' })
    localStorage.setItem(`${SCOPED_PREFIX}.bob.0.draft`, 'Bob draft')
    vi.mocked(deps.toSignIn).mockClear()
    vi.mocked(deps.stopRealtime).mockClear()
    vi.mocked(deps.resetClientState).mockClear()
    const generation = currentGeneration()

    // Alice's answer arrives now, late.
    answer()
    expect(await outcome).toMatchObject({ name: 'AbortError' })

    expect(deps.toSignIn).not.toHaveBeenCalled()
    expect(deps.stopRealtime).not.toHaveBeenCalled()
    expect(deps.resetClientState).not.toHaveBeenCalled()
    expect(currentGeneration()).toBe(generation)
    expect(queryClient.getQueryData(queryKeys.me)).toEqual({ id: 'bob' })
    expect(localStorage.getItem(`${SCOPED_PREFIX}.bob.0.draft`)).toBe('Bob draft')
    // The other tabs are not told Bob's session ended.
    expect(localStorage.getItem('chatapp.signed-out-at')).toBeNull()
  })

  test('the same account signing out and in again: the old request is not the new session either', async () => {
    markSignedIn()
    const answer = answersLater(unauthenticated())
    const outcome = api('/api/conversations', { json: {} }).catch((caught: unknown) => caught)
    endSession('signed-out')
    sessionStarted()
    markSignedIn()
    queryClient.setQueryData(queryKeys.me, { id: 'alice' })
    vi.mocked(deps.toSignIn).mockClear()
    answer()
    await outcome
    expect(deps.toSignIn).not.toHaveBeenCalled()
    expect(queryClient.getQueryData(queryKeys.me)).toEqual({ id: 'alice' })
  })

  test('the 401 for a request made in the session that is current still ends it, with everything it held', async () => {
    markSignedIn()
    queryClient.setQueryData(queryKeys.me, { id: 'bob' })
    localStorage.setItem(`${SCOPED_PREFIX}.bob.0.draft`, 'Bob draft')
    fetchMock.mockResolvedValueOnce(unauthenticated())

    await expect(api('/api/conversations', { json: {} })).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    })

    expect(deps.toSignIn).toHaveBeenCalledWith('expired')
    expect(queryClient.getQueryData(queryKeys.me)).toBeNull()
    expect(localStorage.getItem(`${SCOPED_PREFIX}.bob.0.draft`)).toBeNull()
    expect(localStorage.getItem('chatapp.signed-out-at')).toMatch(/:expired$/)
  })

  test('a session that ends is given up for what it asked, whichever signal ended it', async () => {
    for (const end of [
      () => endSession('expired'),
      () => endSession('ended-elsewhere', { announce: false }),
      () => endSession('signed-out'),
    ]) {
      markSignedIn()
      fetchMock.mockImplementationOnce(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
          }),
      )
      const outcome = api('/api/conversations', { json: {} }).catch((caught: unknown) => caught)
      end()
      expect(await outcome).toMatchObject({ name: 'AbortError' })
    }
  })

  test('a sign-in gives up what was asked before it: a probe sent while nobody was signed in cannot answer after', async () => {
    markSignedIn()
    endSession('expired')
    // The end was announced to the other tabs, and a BroadcastChannel also reaches the other channel objects of this very
    // page: let that arrive (it finds nobody signed in, and does nothing) before the sign-in, as it does in a page, where
    // a person takes seconds to sign in. Otherwise it would arrive after the sign-in and end the new session, and give up the
    // probe for that reason.
    await new Promise((resolve) => setTimeout(resolve, 50))
    fetchMock.mockImplementationOnce(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        }),
    )
    const probe = api('/api/me', { anonymous: true }).catch((caught: unknown) => caught)
    sessionStarted()
    expect(await probe).toMatchObject({ name: 'AbortError' })
    expect(deps.toSignIn).toHaveBeenCalledTimes(1)
  })

  test('a signal about a loss that nobody was there to have does not give up the requests of the next session', async () => {
    // Nobody signed in: the second signal of a loss (or a stray one) does nothing, and so does it to the requests.
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }))
    const pending = api('/api/x')
    endSession('expired')
    await expect(pending).resolves.toBeUndefined()
  })
})
