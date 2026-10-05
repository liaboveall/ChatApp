/**
 * The request budget of background sync (D-150). Every person's calls share one rate limit (600 per minute on the
 * account), so a client that fetches whenever a hint arrives can use it up on its own: an active conversation sends a
 * hint per message. Everything the engine starts by itself (catch-up, re-reads, reconciliation, read marks) takes a token
 * from one bucket first: 4 a second, a burst of 20. What the person does (sending, editing, opening a dialog) does not
 * wait in this queue. A 429 or 503 pauses the bucket until the time the server named.
 */

export type BudgetOptions = {
  now: () => number
  /** Tokens added per second. */
  perSecond?: number
  /** The most tokens the bucket can hold. */
  burst?: number
}

export class RequestBudget {
  readonly #now: () => number
  readonly #perSecond: number
  readonly #burst: number
  #tokens: number
  #stamp: number
  #pausedUntil = 0

  constructor(options: BudgetOptions) {
    this.#now = options.now
    this.#perSecond = options.perSecond ?? 4
    this.#burst = options.burst ?? 20
    this.#tokens = this.#burst
    this.#stamp = this.#now()
  }

  #refill(at: number): void {
    const elapsed = Math.max(0, at - this.#stamp)
    this.#tokens = Math.min(this.#burst, this.#tokens + (elapsed / 1000) * this.#perSecond)
    this.#stamp = at
  }

  /** 0: a request may start now and a token was taken; otherwise the milliseconds to wait before asking again. */
  take(): number {
    const at = this.#now()
    if (at < this.#pausedUntil) return this.#pausedUntil - at
    this.#refill(at)
    if (this.#tokens >= 1) {
      this.#tokens -= 1
      return 0
    }
    return Math.ceil(((1 - this.#tokens) / this.#perSecond) * 1000)
  }

  /** The server asked for quiet (429, 503): nothing starts until `ms` from now. Never shortens an existing pause. */
  pauseFor(ms: number): void {
    this.#pausedUntil = Math.max(this.#pausedUntil, this.#now() + Math.max(0, ms))
  }

  get pausedUntil(): number {
    return this.#pausedUntil
  }

  /** Tokens left, for tests and diagnostics. */
  get available(): number {
    this.#refill(this.#now())
    return this.#tokens
  }
}
