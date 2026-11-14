import type { ReactNode, Ref } from 'react'
import { cx } from '@/lib/cx.ts'
import { useTick } from '@/lib/motion.ts'

export function Badge({
  tone = 'accent',
  tick,
  children,
  className,
  ref,
}: {
  tone?: 'accent' | 'muted' | 'danger' | 'role'
  /** A count that changes while it is on screen: the new number moves into the place of the old (docs/02 4.5). */
  tick?: boolean
  children: ReactNode
  className?: string
  ref?: Ref<HTMLSpanElement>
}) {
  const count = useTick<HTMLSpanElement>(tick ? String(children) : null)
  return (
    <span ref={ref} className={cx('badge', tone !== 'accent' && `badge--${tone}`, className)}>
      {tick ? (
        <span ref={count} className="badge__tick">
          {children}
        </span>
      ) : (
        children
      )}
    </span>
  )
}
