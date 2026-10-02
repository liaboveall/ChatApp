/** Injectable clock: window-based rules (expiry, rate limits, cleanup) must be testable without waiting. */
export interface Clock {
  now(): Date
}

export const systemClock: Clock = { now: () => new Date() }

/** Test clock that only moves when told to. */
export class ManualClock implements Clock {
  #now: number

  constructor(start: Date | number = Date.UTC(2026, 0, 1)) {
    this.#now = typeof start === 'number' ? start : start.getTime()
  }

  now(): Date {
    return new Date(this.#now)
  }

  advance(ms: number): void {
    this.#now += ms
  }

  set(time: Date | number): void {
    this.#now = typeof time === 'number' ? time : time.getTime()
  }
}
