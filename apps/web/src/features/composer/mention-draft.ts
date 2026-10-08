/** The textarea shows names; the draft keeps the exact identities selected from the picker. */
export type DraftMention = {
  start: number
  end: number
  rawStart: number
  rawEnd: number
  id: string
}
export type MentionDraft = { text: string; mentions: DraftMention[] }

export function mentionDraft(raw: string, nameOf: (id: string) => string): MentionDraft {
  let text = ''
  let from = 0
  const mentions: DraftMention[] = []
  for (const match of raw.matchAll(/<@user:([0-9a-f-]{36})>/gi)) {
    text += raw.slice(from, match.index)
    const start = text.length
    const id = match[1] ?? ''
    text += `@${nameOf(id)}`
    from = match.index + match[0].length
    mentions.push({ start, end: text.length, rawStart: match.index, rawEnd: from, id })
  }
  return { text: text + raw.slice(from), mentions }
}

export function rawDraftOffset(view: MentionDraft, offset: number, edge: 'start' | 'end'): number {
  let difference = 0
  for (const mention of view.mentions) {
    if (offset <= mention.start) break
    if (offset < mention.end) return edge === 'start' ? mention.rawStart : mention.rawEnd
    difference += mention.rawEnd - mention.rawStart - (mention.end - mention.start)
  }
  return offset + difference
}

/** Editing part of a name removes its mention identity. Unchanged names keep their original IDs. */
export function editMentionDraft(raw: string, view: MentionDraft, next: string): string {
  if (view.text === next) return raw
  let start = 0
  while (start < view.text.length && start < next.length && view.text[start] === next[start])
    start += 1
  let end = view.text.length
  let nextEnd = next.length
  while (end > start && nextEnd > start && view.text[end - 1] === next[nextEnd - 1]) {
    end -= 1
    nextEnd -= 1
  }
  let nextStart = start
  for (const mention of view.mentions) {
    const extendsName =
      start === end &&
      start === mention.end &&
      /^[\p{L}\p{N}_]/u.test(next.slice(nextStart, nextEnd))
    if (mention.start < start && (start < mention.end || extendsName)) {
      nextStart -= start - mention.start
      start = mention.start
    }
    if (mention.start < end && end < mention.end) {
      nextEnd += mention.end - end
      end = mention.end
    }
  }
  return (
    raw.slice(0, rawDraftOffset(view, start, 'start')) +
    next.slice(nextStart, nextEnd) +
    raw.slice(rawDraftOffset(view, end, 'end'))
  )
}
