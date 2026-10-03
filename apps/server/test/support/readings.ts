/**
 * A barrier between the gateway and the database for the question "which conversations is this person in?". Every
 * reading is real (it is taken from Postgres at the moment it is asked for), but while the barrier is up the answer is
 * kept back until the test lets it through, so a test can make a reading that was taken early arrive late, after the
 * world has moved on, without sleeping and hoping.
 */
import type { Deps } from '../../src/domain/deps.ts'
import { loadMembershipSnapshots, type MembershipSnapshot } from '../../src/domain/presence.ts'

type Answer = { result: Map<string, MembershipSnapshot>; release: () => void }

export class HeldReadings {
  readonly #deps: Pick<Deps, 'db'>
  #holding = false
  readonly #waiting: Answer[] = []
  readonly #onArrival: Array<() => void> = []
  #failures = 0
  /** How many readings were asked for, answered or not. */
  asked = 0

  constructor(deps: Pick<Deps, 'db'>) {
    this.#deps = deps
  }

  /** What the gateway is given instead of the database loader. */
  readonly load = async (userIds: readonly string[]): Promise<Map<string, MembershipSnapshot>> => {
    this.asked += 1
    if (this.#failures > 0) {
      this.#failures -= 1
      throw new Error('the database could not be read')
    }
    const result = await loadMembershipSnapshots(this.#deps, userIds)
    if (!this.#holding) return result
    return await new Promise((resolve) => {
      this.#waiting.push({ result, release: () => resolve(result) })
      for (const wake of [...this.#onArrival]) wake()
    })
  }

  /** From now on answers wait until they are released. */
  hold(): void {
    this.#holding = true
  }

  /** Answers flow again, and those that wait are let through. */
  letThrough(): void {
    this.#holding = false
    while (this.#waiting.length > 0) this.#waiting.shift()?.release()
  }

  /** The next readings fail, as when the database cannot be reached. */
  failNext(count = 1): void {
    this.#failures = count
  }

  /** Answers taken from the database and not yet handed over. */
  get waiting(): number {
    return this.#waiting.length
  }

  /** Resolves once this many answers are waiting. A guard against hanging, not a pause: it ends the moment they are. */
  async waitingFor(count: number, guardMs = 10_000): Promise<void> {
    if (this.#waiting.length >= count) return
    await new Promise<void>((resolve, reject) => {
      const guard = setTimeout(
        () =>
          reject(
            new Error(`expected ${count} readings to be waiting, found ${this.#waiting.length}`),
          ),
        guardMs,
      )
      const wake = () => {
        if (this.#waiting.length < count) return
        clearTimeout(guard)
        this.#onArrival.splice(this.#onArrival.indexOf(wake), 1)
        resolve()
      }
      this.#onArrival.push(wake)
    })
  }

  /**
   * Hands over the oldest answer that waits, and returns once whatever reacts to it has run (a macrotask later, when every
   * continuation of the answer is done), so the test looks at the result, not at the moment before it.
   */
  async release(): Promise<void> {
    this.#waiting.shift()?.release()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}
