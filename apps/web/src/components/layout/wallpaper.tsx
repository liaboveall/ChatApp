import { cx } from '@/lib/cx.ts'

/**
 * The soft accent-coloured blobs under the glass (docs/02 section 2). Decorative; capped at --wallpaper-tint. The `auth`
 * variant moves the blobs out to the corners so they frame the centred card.
 */
export function Wallpaper({ variant = 'app' }: { variant?: 'app' | 'auth' }) {
  return (
    <div className={cx('wallpaper', variant === 'auth' && 'wallpaper--auth')} aria-hidden="true">
      <div className="orb orb--a" />
      <div className="orb orb--b" />
      <div className="orb orb--c" />
      <div className="orb orb--d" />
    </div>
  )
}
