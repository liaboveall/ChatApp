import { afterEach, describe, expect, test, vi } from 'vitest'
import { springs } from '@/design/tokens.ts'
import { motionOff, play, repaint, spring } from './motion.ts'

const root = document.documentElement

afterEach(() => {
  root.removeAttribute('data-reduce-motion')
  root.removeAttribute('data-no-anim')
  root.removeAttribute('data-repaint')
  vi.unstubAllGlobals()
  Reflect.deleteProperty(document, 'startViewTransition')
})

describe('motionOff', () => {
  test('movement is on by default', () => {
    expect(motionOff()).toBe(false)
  })

  test('the setting turns it off', () => {
    root.setAttribute('data-reduce-motion', 'true')
    expect(motionOff()).toBe(true)
  })

  test('a frozen page (screenshots) turns it off', () => {
    root.setAttribute('data-no-anim', 'true')
    expect(motionOff()).toBe(true)
  })

  test("the system's preference turns it off", () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
    }))
    expect(motionOff()).toBe(true)
  })
})

describe('play', () => {
  const frames: Keyframe[] = [{ opacity: 0 }, { opacity: 1 }]

  test('plays on the element', () => {
    const element = document.createElement('div')
    const animation = {} as Animation
    element.animate = vi.fn(() => animation)
    expect(play(element, frames, { duration: 100 })).toBe(animation)
    expect(element.animate).toHaveBeenCalledWith(frames, { duration: 100 })
  })

  test('does nothing where movement is off, without an element, or without Web Animations', () => {
    const element = document.createElement('div')
    element.animate = vi.fn()
    expect(play(null, frames, { duration: 100 })).toBeUndefined()
    root.setAttribute('data-reduce-motion', 'true')
    expect(play(element, frames, { duration: 100 })).toBeUndefined()
    expect(element.animate).not.toHaveBeenCalled()
    root.removeAttribute('data-reduce-motion')
    // jsdom has no `animate`: an element without it is left alone.
    expect(play(document.createElement('div'), frames, { duration: 100 })).toBeUndefined()
  })
})

describe('spring', () => {
  test('is the curve of the tokens, with a duration and a linear() easing', () => {
    for (const key of Object.keys(springs) as (keyof typeof springs)[]) {
      const curve = spring(key)
      expect(curve.duration).toBeGreaterThan(200)
      expect(curve.duration).toBeLessThan(900)
      expect(curve.easing).toMatch(/^linear\(0, .+, 1\)$/)
      expect(spring(key)).toBe(curve)
    }
  })
})

describe('repaint', () => {
  test('without view transitions the change is simply made', () => {
    const update = vi.fn()
    repaint(update)
    expect(update).toHaveBeenCalledTimes(1)
    expect(root.hasAttribute('data-repaint')).toBe(false)
  })

  test('a frozen page changes at once even where view transitions exist', () => {
    const start = vi.fn()
    Object.defineProperty(document, 'startViewTransition', { value: start, configurable: true })
    root.setAttribute('data-no-anim', 'true')
    const update = vi.fn()
    repaint(update)
    expect(update).toHaveBeenCalledTimes(1)
    expect(start).not.toHaveBeenCalled()
  })

  test('with view transitions the change is made inside one, and the mark is taken off afterwards', async () => {
    let finish: () => void = () => undefined
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    const start = vi.fn((callback: () => void) => {
      callback()
      return { finished, ready: Promise.resolve(), updateCallbackDone: Promise.resolve() }
    })
    Object.defineProperty(document, 'startViewTransition', { value: start, configurable: true })
    const update = vi.fn()
    repaint(update)
    expect(update).toHaveBeenCalledTimes(1)
    // No press came before it (the keyboard): the two pictures cross-fade.
    expect(root.getAttribute('data-repaint')).toBe('fade')
    finish()
    await finished
    await Promise.resolve()
    expect(root.hasAttribute('data-repaint')).toBe(false)
  })

  test('after a press, the new look spreads from where the pointer was', async () => {
    const { watchPointer } = await import('./motion.ts')
    const stop = watchPointer()
    const press = new Event('pointerdown') as PointerEvent
    Object.defineProperties(press, { clientX: { value: 120 }, clientY: { value: 80 } })
    document.dispatchEvent(press)
    stop()
    const start = vi.fn((callback: () => void) => {
      callback()
      return {
        finished: new Promise<void>(() => undefined),
        ready: Promise.resolve(),
        updateCallbackDone: Promise.resolve(),
      }
    })
    Object.defineProperty(document, 'startViewTransition', { value: start, configurable: true })
    repaint(() => undefined)
    expect(root.getAttribute('data-repaint')).toBe('reveal')
    expect(root.style.getPropertyValue('--repaint-x')).toBe('120px')
    expect(root.style.getPropertyValue('--repaint-y')).toBe('80px')
    expect(Number.parseInt(root.style.getPropertyValue('--repaint-r'), 10)).toBeGreaterThan(0)
    // Asked for as a plain cross-fade (the glass level), it is one, press or not.
    repaint(() => undefined, 'fade')
    expect(root.getAttribute('data-repaint')).toBe('fade')
  })
})
