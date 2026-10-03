import { describe, expect, test } from 'bun:test'
import { retryWhile } from './retry.ts'

const transient = (error: unknown) => error instanceof Error && error.message === 'transient'

describe('retrying while a failure is transient', () => {
  test('returns the first success without trying again', async () => {
    let tries = 0
    expect(await retryWhile(4, transient, async () => ++tries)).toBe(1)
  })

  test('tries again after a transient failure and returns what the next attempt gives', async () => {
    const seen: number[] = []
    const result = await retryWhile(
      4,
      transient,
      async (attempt) => {
        if (attempt < 3) throw new Error('transient')
        return `ok on ${attempt}`
      },
      (next) => seen.push(next),
    )
    expect(result).toBe('ok on 3')
    expect(seen).toEqual([2, 3])
  })

  test('throws a failure that is not transient at once, however many attempts are left', async () => {
    let tries = 0
    await expect(
      retryWhile(4, transient, async () => {
        tries += 1
        throw new Error('real fault')
      }),
    ).rejects.toThrow('real fault')
    expect(tries).toBe(1)
  })

  test('gives up after the last attempt and throws that failure', async () => {
    let tries = 0
    await expect(
      retryWhile(3, transient, async () => {
        tries += 1
        throw new Error('transient')
      }),
    ).rejects.toThrow('transient')
    expect(tries).toBe(3)
  })
})
