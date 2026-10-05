/**
 * A small in-memory stand-in for the server's conversation, sync and message endpoints, faithful where the sync engine
 * depends on it: a change log with a fixed upper bound per catch-up, current-state projections, tombstones, reset
 * snapshots, versions that only grow. For unit tests of the engine and of screens; not imported by application code.
 */
import type {
  ChangesQuery,
  Conversation,
  ConversationChangesResponse,
  ConversationListResponse,
  Message,
  MessagesQuery,
  MessagesResponse,
  SyncHeadsResponse,
  UserChangesResponse,
} from '@chatapp/contracts'
import { makeConversation, makeMe, makeMessage, uuid } from './fixtures.ts'
import type { SyncTransport } from './transport.ts'

type Hook = (name: string, args: unknown[]) => Promise<void> | void

export class FakeServer implements SyncTransport {
  conversation: Conversation
  /** Every message the person can see, ascending by seq (the projection is the current state of each). */
  messages: Message[] = []
  /** The change log: one entry per change, `changeSeq` ascending. */
  log: Array<{ changeSeq: number; id: string }> = []
  tombstones: Array<{ id: string; changeSeq: number }> = []
  head = 0
  userSeq = 1
  /** Calls in order, by method name (and the query where it matters). */
  calls: string[] = []
  /** Errors to throw for the next calls of a method, one per call. */
  failures = new Map<string, unknown[]>()
  /** When set, the next catch-up answers "start over" with a snapshot. */
  resetNext = false
  /** Called at the start of every method; may return a promise to hold the answer back. */
  hook: Hook | undefined
  /** What `userChanges` answers; tests fill it. */
  personal: UserChangesResponse['items'] = []
  personalReset: UserChangesResponse['baseline'] = null

  constructor(conversation: Conversation = makeConversation(500)) {
    this.conversation = conversation
  }

  // ───────── Test controls ─────────

  /** A message from someone else, as the server would store it. */
  add(body: string, patch: Partial<Message> = {}): Message {
    const seq = (this.messages[this.messages.length - 1]?.seq ?? 0) + 1
    this.head += 1
    const message = makeMessage(seq, {
      id: uuid(10_000 + seq),
      conversationId: this.conversation.id,
      changeSeq: this.head,
      body,
      senderId: uuid(2),
      ...patch,
    })
    this.messages.push(message)
    this.log.push({ changeSeq: this.head, id: message.id })
    this.#touchConversation(message)
    return message
  }

  /** Replaces a message by an edited version (new change). */
  edit(seq: number, body: string): Message {
    return this.#replace(seq, (m) => ({ ...m, body, editedAt: '2026-10-04T08:05:00.000Z' }))
  }

  recall(seq: number): Message {
    return this.#replace(seq, (m) => ({ ...m, body: null, recalledAt: '2026-10-04T08:05:00.000Z' }))
  }

  /** The message left this person's view (deleted for themself): a tombstone in the log. */
  vanish(seq: number): void {
    const index = this.messages.findIndex((m) => m.seq === seq)
    const message = this.messages[index]
    if (message === undefined) return
    this.head += 1
    this.messages.splice(index, 1)
    this.log.push({ changeSeq: this.head, id: message.id })
    this.tombstones.push({ id: message.id, changeSeq: this.head })
    this.#touchConversation(undefined)
  }

  failNext(method: string, error: unknown, times = 1): void {
    this.failures.set(method, [...Array(times).fill(error), ...(this.failures.get(method) ?? [])])
  }

  count(prefix: string): number {
    return this.calls.filter((call) => call.startsWith(prefix)).length
  }

  #replace(seq: number, change: (m: Message) => Message): Message {
    const index = this.messages.findIndex((m) => m.seq === seq)
    const current = this.messages[index]
    if (current === undefined) throw new Error(`no message ${seq}`)
    this.head += 1
    const next = { ...change(current), changeSeq: this.head }
    this.messages[index] = next
    this.log.push({ changeSeq: this.head, id: next.id })
    this.#touchConversation(next)
    return next
  }

  #touchConversation(newest: Message | undefined): void {
    const last = this.messages[this.messages.length - 1] ?? newest
    this.conversation = {
      ...this.conversation,
      lastSeq: Math.max(this.conversation.lastSeq, last?.seq ?? 0),
      lastChangeSeq: this.head,
      lastMessageAt: last?.createdAt ?? null,
      lastMessagePreview:
        last === undefined
          ? null
          : {
              senderId: last.senderId,
              text: last.recalledAt ? null : (last.body ?? null),
              kind: last.kind,
              state: last.recalledAt ? 'recalled' : 'ok',
            },
      previewVersion: {
        lastChangeSeq: this.head,
        viewerVersion: this.conversation.me?.version ?? 0,
      },
    }
  }

  async #enter(name: string, label: string, ...args: unknown[]): Promise<void> {
    this.calls.push(label)
    await this.hook?.(name, args)
    const queue = this.failures.get(name)
    const error = queue?.shift()
    if (error !== undefined) throw error
  }

  // ───────── The transport ─────────

  async listConversations(): Promise<ConversationListResponse> {
    await this.#enter('listConversations', 'listConversations')
    return { conversations: [this.conversation], userChangeSeq: this.userSeq }
  }

  async getConversation(): Promise<Conversation> {
    await this.#enter('getConversation', 'getConversation')
    return this.conversation
  }

  async listMessages(_id: string, query: MessagesQuery): Promise<MessagesResponse> {
    await this.#enter('listMessages', `listMessages ${JSON.stringify(query)}`, _id, query)
    const limit = query.limit ?? 50
    const all = this.messages
    let from: number
    let to: number
    if (query.beforeSeq !== undefined) {
      const upper = all.filter((m) => m.seq < (query.beforeSeq ?? 0))
      to = upper.length
      from = Math.max(0, to - limit)
    } else if (query.afterSeq !== undefined) {
      const first = all.findIndex((m) => m.seq > (query.afterSeq ?? 0))
      from = first === -1 ? all.length : first
      to = Math.min(all.length, from + limit)
    } else if (query.aroundSeq !== undefined) {
      const at = Math.max(
        0,
        all.findIndex((m) => m.seq >= (query.aroundSeq ?? 0)),
      )
      from = Math.max(0, at - Math.floor(limit / 2))
      to = Math.min(all.length, from + limit)
      from = Math.max(0, to - limit)
    } else {
      to = all.length
      from = Math.max(0, to - limit)
    }
    return {
      messages: all.slice(from, to),
      users: {},
      hasMoreBefore: from > 0,
      hasMoreAfter: to < all.length,
    }
  }

  async conversationChanges(
    _id: string,
    query: ChangesQuery,
  ): Promise<ConversationChangesResponse> {
    await this.#enter(
      'conversationChanges',
      `conversationChanges ${JSON.stringify(query)}`,
      _id,
      query,
    )
    const membershipId = this.conversation.me?.membershipId ?? uuid(700)
    if (this.resetNext) {
      this.resetNext = false
      return {
        items: [],
        tombstones: [],
        users: {},
        scannedThrough: 0,
        through: 0,
        nextCursor: null,
        membershipId,
        resetRequired: true,
        baseline: {
          conversation: this.conversation,
          messages: this.messages.slice(-50),
          users: {},
          hasMoreBefore: this.messages.length > 50,
          baselineChangeSeq: this.head,
          baselineUserSeq: this.userSeq,
        },
      }
    }
    let position: number
    let through: number
    if (query.cursor !== undefined) {
      const [p, t] = query.cursor.split(':').map(Number)
      position = p ?? 0
      through = t ?? this.head
    } else {
      position = query.after ?? 0
      through = this.head
    }
    const limit = query.limit ?? 100
    const entries = this.log.filter((e) => e.changeSeq > position && e.changeSeq <= through)
    const page = entries.slice(0, limit)
    const last = page[page.length - 1]
    const more = entries.length > page.length
    const seen = new Set<string>()
    const items: Message[] = []
    const tombs: Array<{ id: string; changeSeq: number }> = []
    for (const entry of page) {
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      const message = this.messages.find((m) => m.id === entry.id)
      if (message !== undefined) items.push(message)
      else {
        const tomb = this.tombstones.find((t) => t.id === entry.id)
        if (tomb !== undefined) tombs.push(tomb)
      }
    }
    return {
      items,
      tombstones: tombs,
      users: {},
      scannedThrough: more ? (last?.changeSeq ?? position) : through,
      through,
      nextCursor: more ? `${last?.changeSeq ?? position}:${through}` : null,
      membershipId,
      resetRequired: false,
      baseline: null,
    }
  }

  async userChanges(query: ChangesQuery): Promise<UserChangesResponse> {
    await this.#enter('userChanges', `userChanges ${JSON.stringify(query)}`, query)
    if (this.personalReset !== null) {
      const baseline = this.personalReset
      this.personalReset = null
      return {
        items: [],
        scannedThrough: 0,
        through: 0,
        nextCursor: null,
        resetRequired: true,
        baseline,
      }
    }
    const items = this.personal
    this.personal = []
    return {
      items,
      scannedThrough: this.userSeq,
      through: this.userSeq,
      nextCursor: null,
      resetRequired: false,
      baseline: null,
    }
  }

  async syncHeads(): Promise<SyncHeadsResponse> {
    await this.#enter('syncHeads', 'syncHeads')
    const me = this.conversation.me
    return {
      userChangeSeq: this.userSeq,
      conversations: [
        {
          id: this.conversation.id,
          membershipId: me?.membershipId ?? uuid(700),
          lastChangeSeq: this.head,
          metadataVersion: this.conversation.metadataVersion,
          membershipVersion: this.conversation.membershipVersion,
          viewerVersion: me?.version ?? 0,
        },
      ],
    }
  }

  async markRead(_id: string, seq: number): Promise<Conversation> {
    await this.#enter('markRead', `markRead ${seq}`, _id, seq)
    const me = this.conversation.me ?? makeMe()
    const lastReadSeq = Math.max(me.lastReadSeq, seq)
    this.conversation = {
      ...this.conversation,
      viewerVersion: me.version + 1,
      me: { ...me, version: me.version + 1, lastReadSeq },
    }
    this.userSeq += 1
    return this.conversation
  }
}
