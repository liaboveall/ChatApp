import { describe, expect, test } from 'vitest'
import { RequestBudget } from './budget.ts'

function budget(perSecond?: number, burst?: number) {
  const clock = { at: 1_000_000 }
  const instance = new RequestBudget({ now: () => clock.at, perSecond, burst })
  return { clock, instance }
}

describe('RequestBudget', () => {
  test('starts full: a burst of 20 goes through at once, the 21st has to wait a quarter of a second', () => {
    const { instance } = budget()
    for (let i = 0; i < 20; i += 1) expect(instance.take()).toBe(0)
    expect(instance.take()).toBe(250)
  })

  test('refills at 4 a second and never beyond the burst', () => {
    const { clock, instance } = budget()
    for (let i = 0; i < 20; i += 1) instance.take()
    clock.at += 1000
    for (let i = 0; i < 4; i += 1) expect(instance.take()).toBe(0)
    expect(instance.take()).toBeGreaterThan(0)
    clock.at += 60_000
    expect(instance.available).toBe(20)
  })

  test('asking while empty does not use up a token', () => {
    const { clock, instance } = budget(4, 2)
    instance.take()
    instance.take()
    const wait = instance.take()
    clock.at += wait
    expect(instance.take()).toBe(0)
  })

  test('a pause blocks everything until the time named, and a shorter pause never shortens a longer one', () => {
    const { clock, instance } = budget()
    instance.pauseFor(10_000)
    expect(instance.take()).toBe(10_000)
    clock.at += 4000
    expect(instance.take()).toBe(6000)
    instance.pauseFor(1000)
    expect(instance.take()).toBe(6000)
    clock.at += 6000
    expect(instance.take()).toBe(0)
  })

  test('a negative pause is no pause', () => {
    const { instance } = budget()
    instance.pauseFor(-5)
    expect(instance.take()).toBe(0)
  })
})
