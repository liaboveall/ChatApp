/**
 * Moving to the next or the previous conversation with the keyboard (docs/02 section 7): the order is the sidebar's, the
 * list wraps around, and "unread" skips what has nothing new. Pure: the screen asks, this answers with an id.
 */
export type NavItem = { id: string; unread: boolean }

/**
 * The conversation `step` places from the current one (1 forward, -1 back), skipping the read ones when `unreadOnly`.
 * Without a current conversation (home, a list page) forward starts at the top and back at the bottom.
 * undefined: there is nowhere to go.
 */
export function neighbourOf(
  items: readonly NavItem[],
  currentId: string | undefined,
  step: 1 | -1,
  unreadOnly: boolean,
): string | undefined {
  if (items.length === 0) return undefined
  const at = currentId === undefined ? -1 : items.findIndex((item) => item.id === currentId)
  const length = items.length
  // The first candidate: next to the current one, or the end the person is coming from.
  let index = at === -1 ? (step === 1 ? 0 : length - 1) : (at + step + length) % length
  const visits = at === -1 ? length : length - 1
  for (let seen = 0; seen < visits; seen += 1) {
    const item = items[index]
    if (item !== undefined && (!unreadOnly || item.unread)) return item.id
    index = (index + step + length) % length
  }
  return undefined
}
