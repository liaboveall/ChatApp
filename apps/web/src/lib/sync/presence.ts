/**
 * Who is online (docs/01 section 4.7, D-131). The server answers for the people the client asks about: `presence.watch`
 * replaces the whole set of people being followed (at most 200) and is answered with a snapshot; changes arrive as
 * `presence` hints. Screens that show a person's status say so with `usePresenceWatch`; this module follows the union of
 * what is on screen, with the most important first when there are too many, and says it again after every new connection
 * because the server forgets it with the old one.
 */
import { LIMITS, type PresenceEntry } from '@chatapp/contracts'
import { create } from 'zustand'
import { registerStoreReset } from './stores.ts'

type PresenceState = { byUser: Record<string, PresenceEntry> }

export const usePresence = create<PresenceState>()(() => ({ byUser: {} }))

export function applyPresence(entries: PresenceEntry[]): void {
  if (entries.length === 0) return
  usePresence.setState((state) => {
    const next = { ...state.byUser }
    for (const entry of entries) next[entry.userId] = entry
    return { byUser: next }
  })
}

/** Where a screen's wish to follow people goes; higher priority first when more than 200 are wanted. */
export type WatchRequest = { userIds: readonly string[]; priority: number }

export class PresenceWatch {
  readonly #wants = new Map<symbol, WatchRequest>()
  readonly #send: (userIds: string[]) => boolean
  readonly #delayMs: number
  #timer: ReturnType<typeof setTimeout> | undefined
  #last: string[] | undefined

  constructor(send: (userIds: string[]) => boolean, delayMs = 500) {
    this.#send = send
    this.#delayMs = delayMs
  }

  /** The people to follow now: all requests together, higher priority first, no repeats, at most the server's limit. */
  current(): string[] {
    const ordered = [...this.#wants.values()].sort((a, b) => b.priority - a.priority)
    const seen = new Set<string>()
    for (const request of ordered) for (const id of request.userIds) seen.add(id)
    return [...seen].slice(0, LIMITS.presenceWatchMax)
  }

  /** Registers or changes what one screen wants to follow; returns the function that withdraws it. */
  want(request: WatchRequest, key: symbol = Symbol('watch')): () => void {
    this.#wants.set(key, request)
    this.#schedule()
    return () => {
      this.#wants.delete(key)
      this.#schedule()
    }
  }

  #schedule(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#flush(false)
    }, this.#delayMs)
  }

  #flush(force: boolean): void {
    const ids = this.current()
    if (!force && this.#last !== undefined && sameList(this.#last, ids)) return
    if (this.#send(ids)) this.#last = ids
  }

  /** A new connection: whatever was being followed has to be asked for again. */
  resend(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
    this.#flush(true)
  }

  clear(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
    this.#wants.clear()
    this.#last = undefined
  }
}

const sameList = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index])

registerStoreReset(() => usePresence.setState({ byUser: {} }))
