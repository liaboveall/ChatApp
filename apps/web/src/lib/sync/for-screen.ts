/**
 * The writes a screen makes (D-174, on top of D-171 and D-173). A request is made for the person in front of the screen, and
 * what follows from its answer on the screen (a jump to what it made, a message saying what was done, ending the session)
 * is for them too. By the time the answer comes the person may have signed out and somebody else signed in, in the same
 * page, or the membership the request was about may have ended: then the answer is null, and so is a failure, which says
 * nothing about what is here now. A screen that gets null does nothing more; it cannot forget to, because the type makes
 * it ask.
 */
import type { RequestTicket } from './types.ts'

/** What the wrapper needs of the engine: a ticket before the request goes out, and whether it is still the one that is here. */
export type Tickets = {
  ticket(conversationId: string | null): RequestTicket
  isCurrent(ticket: RequestTicket): boolean
}

/**
 * Makes the request for the screen. `conversationId` is the conversation the request is about, when it is about one the
 * person is in (it then also has to be the same membership when the answer comes); null for a request about the account,
 * or one that makes the membership (create, join, restore). `take` puts the answer into the cache, and runs only for an
 * answer that is still for the screen.
 */
export type ForScreen = <T>(
  conversationId: string | null,
  request: () => Promise<T>,
  take?: (answer: T, ticket: RequestTicket) => void,
) => Promise<T | null>

export function screenWrites(engine: Tickets): ForScreen {
  return async (conversationId, request, take) => {
    const ticket = engine.ticket(conversationId)
    let answer: Awaited<ReturnType<typeof request>>
    try {
      answer = await request()
    } catch (error) {
      // The failure of a request made for somebody who is not here says nothing about what is here now.
      if (!engine.isCurrent(ticket)) return null
      throw error
    }
    if (!engine.isCurrent(ticket)) return null
    take?.(answer, ticket)
    return answer
  }
}
