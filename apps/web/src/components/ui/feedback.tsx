import {
  CircleAlert,
  CircleCheck,
  Info,
  Loader2,
  type LucideIcon,
  TriangleAlert,
} from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { cx } from '@/lib/cx.ts'
import { Icon } from './icon.tsx'

export type Tone = 'info' | 'warning' | 'danger' | 'success'

const TONE_ICON: Record<Tone, LucideIcon> = {
  info: Info,
  warning: TriangleAlert,
  danger: CircleAlert,
  success: CircleCheck,
}

/** A short message inside a page. Danger banners are announced at once, the others politely. */
export function Banner({
  tone = 'info',
  icon,
  children,
  className,
}: {
  tone?: Tone
  icon?: LucideIcon
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cx('banner', `banner--${tone}`, className)}
      role={tone === 'danger' ? 'alert' : 'status'}
    >
      <Icon icon={icon ?? TONE_ICON[tone]} size={18} />
      <div>{children}</div>
    </div>
  )
}

export function Skeleton({
  width,
  height = 14,
  className,
}: {
  width?: number | string
  height?: number | string
  className?: string
}) {
  return (
    <span
      className={cx('skeleton', className)}
      style={{ width, height } as CSSProperties}
      aria-hidden="true"
    />
  )
}

export function Spinner({ label, className }: { label: string; className?: string }) {
  return (
    <span role="status" aria-label={label} className={cx('inline-flex', className)}>
      <Icon icon={Loader2} className="spin" />
    </span>
  )
}

type EmptyStateProps = {
  icon: LucideIcon
  title: ReactNode
  children?: ReactNode
  action?: ReactNode
  /** Error variant: red icon, announced as an alert. */
  error?: boolean
  className?: string
}

export function EmptyState({ icon, title, children, action, error, className }: EmptyStateProps) {
  return (
    <div
      className={cx('empty', error && 'empty--error', className)}
      role={error ? 'alert' : undefined}
    >
      <div className="empty__icon">
        <Icon icon={icon} size={24} />
      </div>
      <div className="empty__title">{title}</div>
      {children ? <p className="empty__text">{children}</p> : null}
      {action}
    </div>
  )
}
