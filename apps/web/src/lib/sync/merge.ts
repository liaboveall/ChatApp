/**
 * Merge rules of the client cache (docs/05 section 2 and 4.5, D-150, AT-31). Every answer the client gets, whether to a
 * read, to a write, from a catch-up page or from the personal log, passes through these functions before it reaches the
 * cache, so an old answer arriving late can never make a field go backwards. They are pure and keep identity: when
 * nothing changed, the object that came in is the object that comes out, so nothing downstream re-renders for nothing.
 */
import {
  type Conversation,
  type LastMessagePreview,
  LIMITS,
  type Me,
  type Message,
  markdownPreviewText,
  type ReplyTo,
  truncateCodePoints,
  type UserSummary,
} from '@chatapp/contracts'
import type {
  ConversationEffect,
  ConversationIndex,
  PreviewVersion,
  RemovedMarker,
  UsersByid,
} from './types.ts'

// ───────── Messages ─────────

/**
 * A message is replaced only by a newer version of itself: a higher `changeSeq`, or (streaming, M4) the same change with
 * a higher stream revision.
 */
export function mergeMessage(current: Message | undefined, incoming: Message): Message {
  if (current === undefined) return incoming
  if (incoming.changeSeq > current.changeSeq) return incoming
  if (
    incoming.changeSeq === current.changeSeq &&
    incoming.meta.agent?.runId === current.meta.agent?.runId &&
    incoming.status === 'streaming' &&
    current.status === 'streaming' &&
    (incoming.meta.agent?.streamIndex ?? 0) < (current.meta.agent?.streamIndex ?? 0)
  )
    return current
  if (incoming.changeSeq === current.changeSeq && incoming.streamRevision > current.streamRevision)
    return incoming
  return current
}

// Keep complete mention sources in the cache; the plain-text outlet resolves names before its 100-code-point limit.
const excerptOf = (body: string | null): string | null =>
  body === null
    ? null
    : /<@user:/i.test(body)
      ? body
      : truncateCodePoints(body, LIMITS.excerptMaxCodePoints)

/** What a reply's quote of `source` shows now, the way the server's projection words it. */
function quoteOf(replyTo: Extract<ReplyTo, { id: string }>, source: Message): ReplyTo {
  if (source.deletedAt !== null)
    return { ...replyTo, state: 'deleted', excerpt: null, attachmentKind: null }
  if (source.recalledAt !== null)
    return { ...replyTo, state: 'recalled', excerpt: null, attachmentKind: null }
  return {
    ...replyTo,
    state: 'ok',
    excerpt: excerptOf(source.body),
    senderId: source.senderId,
    attachmentKind: source.attachments[0]?.kind ?? null,
  }
}

const sameQuote = (a: ReplyTo, b: ReplyTo): boolean =>
  'id' in a && 'id' in b
    ? a.id === b.id &&
      a.state === b.state &&
      a.excerpt === b.excerpt &&
      a.senderId === b.senderId &&
      (a.attachmentKind ?? null) === (b.attachmentKind ?? null)
    : !('id' in a) && !('id' in b)

/**
 * The replies in `messages` that quote `source` follow it (edit, recall, deletion): their own version does not move when
 * the quoted message changes, so nothing else would update them. A reply to a message I hid reads "unavailable".
 */
export function cascadeReplies(
  messages: Message[],
  source: Message | { id: string; hidden: true },
): Message[] {
  let next: Message[] | undefined
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    const quote = message?.replyTo
    if (message === undefined || quote === null || quote === undefined || !('id' in quote)) continue
    if (quote.id !== source.id) continue
    const replaced: ReplyTo = 'hidden' in source ? { state: 'unavailable' } : quoteOf(quote, source)
    if (sameQuote(quote, replaced)) continue
    next ??= messages.slice()
    next[index] = { ...message, replyTo: replaced }
  }
  return next ?? messages
}

/**
 * `cascadeReplies` for many sources at once, from the newest version of each that is known (D-171). A quote carries no
 * version, so what the quotes were last brought up to date from is remembered per source (`seen`): a source older than
 * that is ignored, and a source that is newer is remembered. That is how an old answer (a slow write answer, a slow
 * page) arriving after a recall, an edit or a deletion cannot put the old excerpt back. One pass over `messages`;
 * the same objects come back when nothing changed.
 */
export function followSources(
  messages: Message[],
  sources: ReadonlyMap<string, Message>,
  seen: Record<string, number>,
): { messages: Message[]; seen: Record<string, number> } {
  let next: Message[] | undefined
  let known = seen
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    const quote = message?.replyTo
    if (message === undefined || quote === null || quote === undefined || !('id' in quote)) continue
    const source = sources.get(quote.id)
    if (source === undefined) continue
    const before = seen[quote.id]
    if (before !== undefined && source.changeSeq < before) continue
    if (source.changeSeq > (known[quote.id] ?? Number.NEGATIVE_INFINITY)) {
      known = { ...known, [quote.id]: source.changeSeq }
    }
    const replaced = quoteOf(quote, source)
    if (sameQuote(quote, replaced)) continue
    next ??= messages.slice()
    next[index] = { ...message, replyTo: replaced }
  }
  return { messages: next ?? messages, seen: known }
}

/**
 * A reply that comes in with an older quote than what this window already knows is corrected on the way in (D-171): a
 * message the window holds as recalled or deleted, and one I hid, never go back, so the quote of a reply that was read
 * before that ("ok" and the excerpt, in a late write answer or a slow page) must not show what was taken back. Only these
 * final states are applied here; an edit has no final state, and that is the log's to replay. The same array comes back
 * when nothing needs correcting.
 */
export function settleQuotes(messages: Message[], hidden: Record<string, true>): Message[] {
  let taken: Map<string, Message> | undefined
  for (const message of messages) {
    if (message.recalledAt !== null || message.deletedAt !== null) {
      taken ??= new Map()
      taken.set(message.id, message)
    }
  }
  let anyHidden = false
  for (const _id in hidden) {
    anyHidden = true
    break
  }
  if (taken === undefined && !anyHidden) return messages
  let next: Message[] | undefined
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    const quote = message?.replyTo
    if (message === undefined || quote === null || quote === undefined || !('id' in quote)) continue
    let replaced: ReplyTo | undefined
    if (quote.id in hidden) replaced = { state: 'unavailable' }
    else {
      const source = taken?.get(quote.id)
      if (source !== undefined) replaced = quoteOf(quote, source)
    }
    if (replaced === undefined || sameQuote(quote, replaced)) continue
    next ??= messages.slice()
    next[index] = { ...message, replyTo: replaced }
  }
  return next ?? messages
}

/** The memory of `followSources`, kept only for sources that some message in `messages` still quotes. */
export function retainQuoted(
  messages: readonly Message[],
  seen: Record<string, number>,
): Record<string, number> {
  const ids = Object.keys(seen)
  if (ids.length === 0) return seen
  const alive = new Set<string>()
  for (const message of messages) {
    const quote = message.replyTo
    if (quote !== null && quote !== undefined && 'id' in quote) alive.add(quote.id)
  }
  if (ids.every((id) => alive.has(id))) return seen
  const kept: Record<string, number> = {}
  for (const id of ids) {
    const version = seen[id]
    if (alive.has(id) && version !== undefined) kept[id] = version
  }
  return kept
}

/** The preview line of a conversation from its newest message, worded the way the server does. */
export function previewOf(message: Message): LastMessagePreview {
  const state =
    message.deletedAt !== null ? 'deleted' : message.recalledAt !== null ? 'recalled' : 'ok'
  return {
    senderId: message.senderId,
    text:
      state === 'ok' && message.kind !== 'system'
        ? excerptOf(markdownPreviewText(message.body))
        : null,
    ...(state === 'ok' && message.attachments[0]
      ? { attachmentKind: message.attachments[0].kind }
      : {}),
    kind: message.kind,
    state,
  }
}

// ───────── People ─────────

export function mergeUser(current: UserSummary | undefined, incoming: UserSummary): UserSummary {
  return current !== undefined && incoming.profileVersion <= current.profileVersion
    ? current
    : incoming
}

/** Folds people into the dictionary, each only by a newer profile version; returns the same object when nothing changed. */
export function mergeUsers(
  current: UsersByid,
  incoming: Iterable<UserSummary> | Record<string, UserSummary>,
): UsersByid {
  const list = Symbol.iterator in incoming ? incoming : Object.values(incoming)
  let next: UsersByid | undefined
  for (const user of list) {
    const before = (next ?? current)[user.id]
    const merged = mergeUser(before, user)
    if (merged === before) continue
    next ??= { ...current }
    next[user.id] = merged
  }
  return next ?? current
}

/**
 * My own account. `null` (nobody is signed in) always wins; so does a different identity (another account, another login
 * generation after a password change, another restore generation); for the same identity the newer version wins.
 * An equal version is taken too, because counters the server derives (invitations used, storage) do not move it.
 */
export function mergeMe(current: Me | null | undefined, incoming: Me | null): Me | null {
  if (incoming === null) return null
  if (current === null || current === undefined) return incoming
  if (
    current.id !== incoming.id ||
    current.authEpoch !== incoming.authEpoch ||
    current.restoreEpoch !== incoming.restoreEpoch
  ) {
    return incoming
  }
  return incoming.meVersion >= current.meVersion ? incoming : current
}

// ───────── Conversations ─────────

export const emptyIndex = (): ConversationIndex => ({ byId: {}, removed: {}, previewHidden: {} })

type PreviewOrder = 'newer' | 'same' | 'older' | 'incomparable'

/** Two previews are ordered only when one is at least as new in both components (docs/05 section 2). */
export function comparePreviewVersions(a: PreviewVersion, b: PreviewVersion): PreviewOrder {
  const changes = a.lastChangeSeq - b.lastChangeSeq
  const views = a.viewerVersion - b.viewerVersion
  if (changes === 0 && views === 0) return 'same'
  if (changes >= 0 && views >= 0) return 'newer'
  if (changes <= 0 && views <= 0) return 'older'
  return 'incomparable'
}

function without<T extends Record<string, unknown>>(record: T, key: string): T {
  if (!(key in record)) return record
  const { [key]: _removed, ...rest } = record
  return rest as T
}

/**
 * Folds one answer about a conversation into the index, field group by field group, each by its own version
 * (docs/05 section 2): shared profile by `metadataVersion`, my relation by `viewerVersion`, counters by `lastChangeSeq`,
 * the preview by its pair of versions, the direct-message peer by `profileVersion`. An answer that carries a relation
 * older than a removal I already know of does not bring the conversation back.
 */
export function mergeConversation(
  index: ConversationIndex,
  incoming: Conversation,
): { index: ConversationIndex; effects: ConversationEffect[] } {
  const id = incoming.id
  const current = index.byId[id]
  const marker = index.removed[id]
  const effects: ConversationEffect[] = []
  let removed = index.removed
  let previewHidden = index.previewHidden

  // My relation: a newer one (by viewer version) replaces mine; a null relation never takes one away (leaving arrives as
  // a tombstone, `applyRemoval`), and a relation older than a known removal is stale data from before it.
  let me = current?.me ?? null
  if (incoming.me !== null) {
    const stale = marker !== undefined && incoming.me.version <= marker.viewerVersion
    if (!stale && (me === null || incoming.me.version > me.version)) {
      if (me !== null && me.membershipId !== incoming.me.membershipId) {
        effects.push({
          type: 'membership-changed',
          conversationId: id,
          from: me.membershipId,
          to: incoming.me.membershipId,
        })
      }
      me = incoming.me
      if (marker !== undefined) removed = without(removed, id)
    }
  }

  if (current === undefined) {
    const first: Conversation = { ...incoming, me, viewerVersion: me?.version ?? 0 }
    return {
      index: {
        ...index,
        byId: { ...index.byId, [id]: first },
        removed,
      },
      effects,
    }
  }

  let next = current
  const set = (patch: Partial<Conversation>): void => {
    next = { ...next, ...patch }
  }

  if (incoming.metadataVersion > current.metadataVersion) {
    set({
      kind: incoming.kind,
      name: incoming.name,
      description: incoming.description,
      avatarUrl: incoming.avatarUrl,
      settings: incoming.settings,
      memberCount: incoming.memberCount,
      archivedAt: incoming.archivedAt,
      panelForConversationId: incoming.panelForConversationId,
      metadataVersion: incoming.metadataVersion,
    })
  }
  if (incoming.membershipVersion > current.membershipVersion) {
    set({ membershipVersion: incoming.membershipVersion })
  }
  if (incoming.lastChangeSeq > current.lastChangeSeq) {
    set({
      lastSeq: Math.max(incoming.lastSeq, current.lastSeq),
      lastChangeSeq: incoming.lastChangeSeq,
      lastMessageAt: incoming.lastMessageAt,
    })
  } else if (incoming.lastSeq > current.lastSeq) {
    set({ lastSeq: incoming.lastSeq })
  }

  const order = comparePreviewVersions(incoming.previewVersion, current.previewVersion)
  if (order === 'newer') {
    set({
      lastMessagePreview: incoming.lastMessagePreview,
      previewVersion: incoming.previewVersion,
    })
    previewHidden = without(previewHidden, id)
  } else if (order === 'incomparable') {
    if (!(id in previewHidden)) previewHidden = { ...previewHidden, [id]: true }
    effects.push({ type: 'preview-incomparable', conversationId: id })
  }

  if (
    incoming.dmPeer !== null &&
    (current.dmPeer === null || incoming.dmPeer.profileVersion > current.dmPeer.profileVersion)
  ) {
    set({ dmPeer: incoming.dmPeer })
  }

  if (me !== current.me) set({ me, viewerVersion: me?.version ?? current.viewerVersion })

  if (next === current && removed === index.removed && previewHidden === index.previewHidden) {
    return { index, effects }
  }
  return {
    index: {
      byId: next === current ? index.byId : { ...index.byId, [id]: next },
      removed,
      previewHidden,
    },
    effects,
  }
}

/** Raises the counters of a conversation from what the client itself saw (a newer message), never lowers them. */
export function raiseCounters(
  index: ConversationIndex,
  id: string,
  counters: { lastSeq: number; lastChangeSeq: number; lastMessageAt: string | null },
  preview?: { preview: LastMessagePreview | null; version: PreviewVersion },
): ConversationIndex {
  const current = index.byId[id]
  if (current === undefined) return index
  let next = current
  if (counters.lastChangeSeq > next.lastChangeSeq || counters.lastSeq > next.lastSeq) {
    next = {
      ...next,
      lastSeq: Math.max(counters.lastSeq, next.lastSeq),
      lastChangeSeq: Math.max(counters.lastChangeSeq, next.lastChangeSeq),
      lastMessageAt:
        counters.lastChangeSeq >= next.lastChangeSeq ? counters.lastMessageAt : next.lastMessageAt,
    }
  }
  let previewHidden = index.previewHidden
  if (preview !== undefined) {
    const order = comparePreviewVersions(preview.version, next.previewVersion)
    if (order === 'newer') {
      next = { ...next, lastMessagePreview: preview.preview, previewVersion: preview.version }
      previewHidden = without(previewHidden, id)
    }
  }
  if (next === current && previewHidden === index.previewHidden) return index
  return {
    ...index,
    byId: next === current ? index.byId : { ...index.byId, [id]: next },
    previewHidden,
  }
}

/** Removes a conversation from the index; with a marker it is also remembered as removed. */
export function forgetInIndex(
  index: ConversationIndex,
  id: string,
  marker?: RemovedMarker,
): ConversationIndex {
  const byId = without(index.byId, id)
  const previewHidden = without(index.previewHidden, id)
  const known = index.removed[id]
  const removed =
    marker !== undefined && (known === undefined || marker.viewerVersion > known.viewerVersion)
      ? { ...index.removed, [id]: marker }
      : index.removed
  if (byId === index.byId && previewHidden === index.previewHidden && removed === index.removed)
    return index
  return { byId, removed, previewHidden }
}

/**
 * A removal tombstone from my own log. It ends the cached relation only when it is newer than that relation (and about
 * the same membership); an older one is a late hint about something that has since been replaced by a re-join.
 * Without a cached relation it is just remembered, so a stale answer cannot bring the conversation back.
 */
export function applyRemoval(
  index: ConversationIndex,
  tombstone: { conversationId: string; membershipId: string | null; viewerVersion: number },
): { index: ConversationIndex; forget: boolean } {
  const { conversationId: id, membershipId, viewerVersion } = tombstone
  const marker: RemovedMarker = { viewerVersion, membershipId }
  const known = index.removed[id]
  if (known !== undefined && known.viewerVersion >= viewerVersion) return { index, forget: false }
  const cached = index.byId[id]?.me ?? null
  if (cached !== null) {
    const sameMembership = membershipId === null || membershipId === cached.membershipId
    if (viewerVersion > cached.version && sameMembership) {
      return { index: forgetInIndex(index, id, marker), forget: true }
    }
    return { index, forget: false }
  }
  return { index: forgetInIndex(index, id, marker), forget: false }
}
