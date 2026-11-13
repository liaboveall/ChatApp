/**
 * Formatting from the keyboard in the message field (docs/02 section 7): Ctrl/⌘+B, Ctrl/⌘+I and Ctrl/⌘+Shift+X put the
 * Markdown marks of bold, italic and strikethrough around the selection, or take them off when they are already there.
 * With nothing selected the marks are written and the caret stands between them. Pure: the field's text and selection go
 * in, the new text and selection come out, so the rule is exercised without a browser.
 */

export type FormatKeyEvent = {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

export type TextSelection = { text: string; start: number; end: number }

/** The Markdown mark a key press asks for, or null when it is not a formatting key. `mac`: ⌘ is the modifier there. */
export function formatMark(event: FormatKeyEvent, mac: boolean): string | null {
  const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (!mod || event.altKey) return null
  const key = event.key.toLowerCase()
  if (!event.shiftKey && key === 'b') return '**'
  if (!event.shiftKey && key === 'i') return '*'
  if (event.shiftKey && key === 'x') return '~~'
  return null
}

/**
 * Puts `mark` around the selection, or removes it when the selection already stands between two of them (or includes
 * them). The selection afterwards covers the same words as before.
 */
export function toggleMark(selection: TextSelection, mark: string): TextSelection {
  const { text, start, end } = selection
  const size = mark.length
  const before = text.slice(0, start)
  const chosen = text.slice(start, end)
  const after = text.slice(end)
  // The marks are just outside the selection: **|word|**
  if (before.endsWith(mark) && after.startsWith(mark) && isWhole(before, after, mark)) {
    return {
      text: before.slice(0, -size) + chosen + after.slice(size),
      start: start - size,
      end: end - size,
    }
  }
  // The marks are inside the selection: |**word**|
  if (
    chosen.length >= size * 2 &&
    chosen.startsWith(mark) &&
    chosen.endsWith(mark) &&
    isWhole(chosen.slice(0, size), chosen.slice(-size), mark, chosen.slice(size, -size))
  ) {
    return {
      text: before + chosen.slice(size, -size) + after,
      start,
      end: end - size * 2,
    }
  }
  return {
    text: before + mark + chosen + mark + after,
    start: start + size,
    end: end + size,
  }
}

/**
 * A single asterisk next to another one is half of a bold mark, not an italic mark: `**word**` is not "italic around
 * *word*". Marks of two characters have no such neighbour to mistake.
 */
function isWhole(before: string, after: string, mark: string, inner?: string): boolean {
  if (mark !== '*') return true
  if (inner !== undefined) return !inner.startsWith('*') && !inner.endsWith('*')
  const outerBefore = before.slice(0, -1)
  const outerAfter = after.slice(1)
  return !outerBefore.endsWith('*') && !outerAfter.startsWith('*')
}
