import { cx } from '@/lib/cx.ts'

/**
 * The soft accent-coloured lights under the glass (docs/02 section 2). Decorative; capped at --wallpaper-tint. In the app
 * (`side`) it lies under the sidebar only and fades out before the conversation begins. `auth` fills the frame and moves
 * the lights out to the corners, so they frame the centred card. `full` fills its box with the app's own lights: the
 * picture of the window in the appearance settings, and the backdrop of a component shown on its own.
 */
export function Wallpaper({ variant = 'side' }: { variant?: 'side' | 'auth' | 'full' }) {
  return (
    <div
      className={cx(
        'wallpaper',
        variant === 'auth' && 'wallpaper--auth',
        variant === 'side' && 'wallpaper--side',
      )}
      aria-hidden="true"
    >
      <div className="orb orb--a" />
      <div className="orb orb--b" />
      <div className="orb orb--c" />
      <div className="orb orb--d" />
    </div>
  )
}
