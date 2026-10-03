/**
 * Topic registry of one API process (docs/03 section 6): which live connections follow which topic. It is only routing:
 * a topic name is chosen by the server from the person's current relations and is never an authorization (SEC-03). The
 * scale (a few hundred connections per process, D-052) does not need Bun's native pub/sub, so this is plain maps and
 * stays runtime-neutral (D-130).
 */
export class Hub<C> {
  readonly #topics = new Map<string, Set<C>>()

  subscribe(topic: string, subscriber: C): void {
    const set = this.#topics.get(topic) ?? new Set<C>()
    this.#topics.set(topic, set)
    set.add(subscriber)
  }

  unsubscribe(topic: string, subscriber: C): void {
    const set = this.#topics.get(topic)
    if (!set) return
    set.delete(subscriber)
    if (set.size === 0) this.#topics.delete(topic)
  }

  /** A snapshot, so the caller may subscribe and unsubscribe while iterating. */
  subscribers(topic: string): C[] {
    return [...(this.#topics.get(topic) ?? [])]
  }

  count(topic: string): number {
    return this.#topics.get(topic)?.size ?? 0
  }

  get topicCount(): number {
    return this.#topics.size
  }
}
