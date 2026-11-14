/**
 * Which rows of a timeline have only just arrived, and how (docs/02 section 4.5). A row that was not in the list a
 * moment ago and stands at its foot is a message that came (or one I am sending): it opens its own room and springs
 * in. My own message that takes the place of the bubble it was sent as has already made its entrance (it goes on with
 * what is left of it, no more). Everything else that changes the list (an older page above, a jump to another part of the
 * conversation, a burst of messages after a reconnection) is not an arrival and moves nothing.
 *
 * Pure: the rows before and the rows now, nothing about React or the DOM.
 */

/**
 * `new`: a row that came in at the foot of the list. `sent`: my message, confirmed, standing where its pending bubble
 * (the row `from`) stood.
 */
export type Arrival = { kind: 'new' } | { kind: 'sent'; from: string }

export type ArrivalRow = {
  /** The row's key in the list: `m:<message id>`, `o:<client id>` for a message being sent, `start`. */
  key: string
  mine: boolean
}

/** More new rows than this in one step is a page catching up, not somebody writing: none of them moves. */
export const ARRIVAL_BURST = 3

const isPending = (key: string): boolean => key.startsWith('o:')
const isMessage = (key: string): boolean => key.startsWith('m:')

export function arrivalsOf(
  before: readonly ArrivalRow[],
  now: readonly ArrivalRow[],
): Map<string, Arrival> {
  const known = new Set(before.map((row) => row.key))
  const first = now.findIndex((row) => !known.has(row.key))
  const found = new Map<string, Arrival>()
  if (first === -1) return found
  // At the foot: after the first new row there is nothing that was already there, except messages still being sent
  // (they are always last). A row that was there and now follows a new one means the list changed further up.
  for (let index = first + 1; index < now.length; index += 1) {
    const row = now[index]
    if (row !== undefined && known.has(row.key) && !isPending(row.key)) return found
  }
  // The pending bubbles that are gone, oldest first: each was answered by one of my messages, in the same order (the
  // outbox sends one at a time).
  const present = new Set(now.map((row) => row.key))
  const resolved = before.filter((row) => isPending(row.key) && !present.has(row.key))
  let fresh = 0
  for (const row of now.slice(first)) {
    if (known.has(row.key)) continue
    const from = isMessage(row.key) && row.mine ? resolved.shift() : undefined
    if (from !== undefined) {
      found.set(row.key, { kind: 'sent', from: from.key })
    } else if (isMessage(row.key) || isPending(row.key)) {
      fresh += 1
      found.set(row.key, { kind: 'new' })
    }
  }
  if (fresh > ARRIVAL_BURST) {
    for (const [key, arrival] of found) if (arrival.kind === 'new') found.delete(key)
  }
  return found
}
