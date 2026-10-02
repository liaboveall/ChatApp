import type { ReactNode } from 'react'
import { cx } from '@/lib/cx.ts'

export function Badge({
  tone = 'accent',
  children,
  className,
}: {
  tone?: 'accent' | 'muted' | 'danger' | 'role'
  children: ReactNode
  className?: string
}) {
  return (
    <span className={cx('badge', tone !== 'accent' && `badge--${tone}`, className)}>
      {children}
    </span>
  )
}
