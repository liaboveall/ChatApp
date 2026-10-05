/**
 * Whether the person is here (docs/01 section 4.7): "active" while the page is in front and they have touched it in the
 * last five minutes, "idle" otherwise. Reported to the server only when it changes, and again after every new connection
 * (the server keeps it per connection). The server turns the reports of all of a person's connections into one status.
 */
export const IDLE_AFTER_MS = 5 * 60_000

export type ActivityDeps = {
  send: (state: 'active' | 'idle') => boolean
  now?: () => number
  visible?: () => boolean
}

export class ActivityReporter {
  readonly #send: ActivityDeps['send']
  readonly #now: () => number
  readonly #visible: () => boolean
  #lastInput: number
  #reported: 'active' | 'idle' | undefined
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(deps: ActivityDeps) {
    this.#send = deps.send
    this.#now = deps.now ?? Date.now
    this.#visible = deps.visible ?? (() => document.visibilityState === 'visible')
    this.#lastInput = this.#now()
  }

  get state(): 'active' | 'idle' {
    return this.#visible() && this.#now() - this.#lastInput < IDLE_AFTER_MS ? 'active' : 'idle'
  }

  /** The person did something (key, pointer, wheel) or the page changed visibility: look again and report a change. */
  touch(input = true): void {
    if (input) this.#lastInput = this.#now()
    this.#report(false)
    this.#arm()
  }

  #report(force: boolean): void {
    const state = this.state
    if (!force && state === this.#reported) return
    if (this.#send(state)) this.#reported = state
  }

  /** The state is only worth looking at again at the moment "active" would run out. */
  #arm(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
    if (this.state !== 'active') return
    const remaining = IDLE_AFTER_MS - (this.#now() - this.#lastInput)
    this.#timer = setTimeout(() => this.touch(false), remaining + 50)
  }

  /** A new connection: say again what the server forgot. */
  resend(): void {
    this.#report(true)
    this.#arm()
  }

  stop(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
    this.#reported = undefined
  }
}
