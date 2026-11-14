import type { PointerEvent, ReactNode } from 'react'
import { motionOff } from '@/lib/motion.ts'

/**
 * Makes what it holds (the application icon, on the two pages where it is the picture of the page) a pane one can tip:
 * it leans towards the pointer and the light on it follows, and it swings back when the pointer leaves (docs/02
 * section 4.5). Decoration only: nothing depends on it, a finger does not start it, and with reduced motion it stays
 * still.
 */
export function Tilt({ children }: { children: ReactNode }) {
  const lean = (event: PointerEvent<HTMLSpanElement>): void => {
    if (event.pointerType === 'touch' || motionOff()) return
    const element = event.currentTarget
    const box = element.getBoundingClientRect()
    const x = ((event.clientX - box.left) / box.width) * 2 - 1
    const y = ((event.clientY - box.top) / box.height) * 2 - 1
    element.style.setProperty('--tilt-x', Math.max(-1, Math.min(1, x)).toFixed(3))
    element.style.setProperty('--tilt-y', Math.max(-1, Math.min(1, y)).toFixed(3))
    element.setAttribute('data-tilting', '')
  }
  // The lean is let go; where the light was stays (it fades out where it stood, instead of jumping to the middle first).
  const rest = (event: PointerEvent<HTMLSpanElement>): void => {
    event.currentTarget.removeAttribute('data-tilting')
  }
  return (
    <span className="tilt" onPointerMove={lean} onPointerLeave={rest} onPointerCancel={rest}>
      {children}
    </span>
  )
}
