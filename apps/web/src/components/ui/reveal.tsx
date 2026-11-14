import { AnimatePresence, motion, useIsPresent, useReducedMotionConfig } from 'motion/react'
import type { ReactNode } from 'react'
import { springs, timing } from '@/design/tokens.ts'
import { cx } from '@/lib/cx.ts'

const SOFT = [0.22, 1, 0.36, 1] as const

type RevealProps = {
  /** Whether the part is there. Its content may be given either way: it is only drawn while this is true. */
  show: boolean
  children: ReactNode
  className?: string
}

/**
 * A part of a pane that opens in place (docs/02 section 4.5): the emoji in the composer, the bar of a reply, a folded
 * group of the sidebar. It takes its height with the smooth spring, so what is around it is moved aside rather than
 * jumped past, and gives it back faster than it took it. With reduced motion the height changes at once and only the
 * opacity fades.
 *
 * While it closes, what it held is still drawn but is no longer there to be used (`inert`): it cannot be pressed, focused
 * or read. Do not put inside it anything that must stop working in the very frame it is dismissed and listens outside
 * its own elements (a key handler on the document): such a part should simply be removed.
 */
export function Reveal({ show, children, className }: RevealProps) {
  return (
    <AnimatePresence initial={false}>
      {show ? (
        <Opening key="open" className={className}>
          {children}
        </Opening>
      ) : null}
    </AnimatePresence>
  )
}

function Opening({ children, className }: { children: ReactNode; className?: string | undefined }) {
  const calm = useReducedMotionConfig()
  const present = useIsPresent()
  return (
    <motion.div
      className={cx('reveal', className)}
      inert={!present || undefined}
      initial={{ height: 0, opacity: 0 }}
      animate={{
        height: 'auto',
        opacity: 1,
        transition: calm
          ? { height: { duration: 0 }, opacity: { duration: 0.12 } }
          : {
              height: { type: 'spring', ...springs.smooth },
              opacity: { duration: timing.fade / 1000, ease: SOFT },
            },
      }}
      exit={{
        height: 0,
        opacity: 0,
        transition: calm
          ? { height: { duration: 0, delay: 0.1 }, opacity: { duration: 0.1 } }
          : { duration: timing.swap / 1000, ease: SOFT },
      }}
    >
      {children}
    </motion.div>
  )
}
