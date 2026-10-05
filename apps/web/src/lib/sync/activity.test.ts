import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ActivityReporter, IDLE_AFTER_MS } from './activity.ts'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})
afterEach(() => vi.useRealTimers())

function setup() {
  const sent: Array<'active' | 'idle'> = []
  const state = { visible: true, open: true }
  const reporter = new ActivityReporter({
    send: (value) => {
      if (!state.open) return false
      sent.push(value)
      return true
    },
    visible: () => state.visible,
  })
  return { reporter, sent, state }
}

describe('ActivityReporter', () => {
  test('reports active at first, and only reports changes after that', () => {
    const { reporter, sent } = setup()
    reporter.touch()
    reporter.touch()
    vi.advanceTimersByTime(1000)
    reporter.touch()
    expect(sent).toEqual(['active'])
  })

  test('five minutes without input make the person idle, with no further reports until something changes', () => {
    const { reporter, sent } = setup()
    reporter.touch()
    vi.advanceTimersByTime(IDLE_AFTER_MS + 100)
    expect(sent).toEqual(['active', 'idle'])
    vi.advanceTimersByTime(IDLE_AFTER_MS * 3)
    expect(sent).toEqual(['active', 'idle'])
  })

  test('input after being idle makes them active again at once', () => {
    const { reporter, sent } = setup()
    reporter.touch()
    vi.advanceTimersByTime(IDLE_AFTER_MS + 100)
    reporter.touch()
    expect(sent).toEqual(['active', 'idle', 'active'])
  })

  test('a page in the background is idle however recently there was input, and coming back is active', () => {
    const { reporter, sent, state } = setup()
    reporter.touch()
    state.visible = false
    reporter.touch(false)
    expect(sent).toEqual(['active', 'idle'])
    state.visible = true
    reporter.touch(false)
    expect(sent).toEqual(['active', 'idle', 'active'])
  })

  test('a new connection hears the current state again', () => {
    const { reporter, sent } = setup()
    reporter.touch()
    reporter.resend()
    expect(sent).toEqual(['active', 'active'])
  })

  test('a report that could not be sent is repeated at the next chance', () => {
    const { reporter, sent, state } = setup()
    state.open = false
    reporter.touch()
    state.open = true
    reporter.touch()
    expect(sent).toEqual(['active'])
  })
})
