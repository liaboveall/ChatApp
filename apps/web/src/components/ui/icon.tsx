import type { LucideIcon, LucideProps } from 'lucide-react'
import { cx } from '@/lib/cx.ts'

export type IconSize = 16 | 18 | 20 | 24

type IconProps = Omit<LucideProps, 'size'> & {
  icon: LucideIcon
  size?: IconSize
}

/** Lucide glyph at the spec's sizes (16, 18, 20) and line weight 1.75 (docs/02 section 8). Decorative by default. */
export function Icon({ icon: Glyph, size = 18, className, ...rest }: IconProps) {
  return (
    <Glyph
      aria-hidden="true"
      focusable="false"
      size={size}
      strokeWidth={1.75}
      className={cx('icon', size !== 18 && `icon--${size}`, className)}
      {...rest}
    />
  )
}
