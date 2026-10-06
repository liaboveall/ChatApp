/**
 * The writes a screen makes (D-174): the answer, and the failure, reach the screen only while the person who asked and the
 * membership the request was about are still here; otherwise the screen gets null and nothing follows.
 */
import { describe, expect, test, vi } from 'vitest'
import { uuid } from './fixtures.ts'
import { screenWrites, type Tickets } from './for-screen.ts'
import type { RequestTicket } from './types.ts'

const CONV = uuid(500)
const ticketOf = (conversationId: string | null): RequestTicket => ({
  scope: null,
  session: 1,
  conversationId,
  membershipId: conversationId === null ? null : uuid(700),
  watermark: 0,
})

function setup(current = true) {
  const calls: string[] = []
  const state = { current }
  const tickets: Tickets = {
    ticket: (conversationId) => {
      calls.push(`ticket:${conversationId}`)
      return ticketOf(conversationId)
    },
    isCurrent: () => {
      calls.push('isCurrent')
      return state.current
    },
  }
  return { forScreen: screenWrites(tickets), calls, state }
}

describe('what a screen gets from its own write', () => {
  test('the answer, after the cache has taken it, while the person and the membership are the ones that asked', async () => {
    const t = setup()
    const take = vi.fn()
    const answer = await t.forScreen(
      CONV,
      async () => {
        t.calls.push('request')
        return { id: 1 }
      },
      take,
    )
    expect(answer).toEqual({ id: 1 })
    expect(take).toHaveBeenCalledWith({ id: 1 }, ticketOf(CONV))
    // The ticket is taken before the request goes out, and the question is asked when the answer is in.
    expect(t.calls).toEqual([`ticket:${CONV}`, 'request', 'isCurrent'])
  })

  test('null, and nothing put into the cache, when they are not here any more', async () => {
    const t = setup()
    const take = vi.fn()
    const answer = await t.forScreen(
      null,
      async () => {
        t.state.current = false
        return { id: 1 }
      },
      take,
    )
    expect(answer).toBeNull()
    expect(take).not.toHaveBeenCalled()
  })

  test('a failure is the screen’s own while they are here: it is thrown as it came', async () => {
    const t = setup()
    const failure = new Error('refused')
    await expect(
      t.forScreen(CONV, async () => {
        throw failure
      }),
    ).rejects.toBe(failure)
  })

  test('a failure says nothing about what is here now when they are not: null, no error', async () => {
    const t = setup()
    const answer = await t.forScreen(CONV, async () => {
      t.state.current = false
      throw new Error('refused')
    })
    expect(answer).toBeNull()
  })

  test('a request about the account asks for a ticket without a conversation', async () => {
    const t = setup()
    await t.forScreen(null, async () => true)
    expect(t.calls[0]).toBe('ticket:null')
  })
})
