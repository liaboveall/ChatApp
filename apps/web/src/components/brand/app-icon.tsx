import { useId } from 'react'

const STAR =
  'M0 -1c.07 .56 .44 .93 1 1-.56 .07-.93 .44-1 1-.07-.56-.44-.93-1-1 .56-.07 .93-.44 1-1Z'

/**
 * The application icon, direction A ("bubble and star", chosen at D4, D-113): a white chat bubble with a spark on a blue
 * squircle. Original shapes only; no Apple marks, no SF Symbols (docs/02 section 1). Exported PNG sizes follow in M6.
 */
export function AppIcon({ size = 56, label }: { size?: number; label?: string }) {
  const id = useId().replaceAll(':', '')
  return (
    <svg
      viewBox="0 0 128 128"
      width={size}
      height={size}
      style={{ display: 'block', flex: 'none' }}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6DB4FF" />
          <stop offset="1" stopColor="#3C44D4" />
        </linearGradient>
        <radialGradient id={`${id}-hl`} cx="0.25" cy="0.1" r="0.9">
          <stop offset="0" stopColor="#fff" stopOpacity="0.55" />
          <stop offset="0.6" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-sp`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5FA4FF" />
          <stop offset="1" stopColor="#6A4DE0" />
        </linearGradient>
      </defs>
      <rect width="128" height="128" rx="30" fill={`url(#${id}-bg)`} />
      <rect width="128" height="128" rx="30" fill={`url(#${id}-hl)`} />
      <path
        d="M44 30h40a24 24 0 0 1 24 24v12a24 24 0 0 1-24 24H70L50 108V90H44a24 24 0 0 1-24-24V54a24 24 0 0 1 24-24Z"
        fill="#fff"
        fillOpacity="0.97"
      />
      <path d={STAR} transform="translate(64 60) scale(20)" fill={`url(#${id}-sp)`} />
      <path
        d={STAR}
        transform="translate(85 42) scale(7)"
        fill={`url(#${id}-sp)`}
        fillOpacity="0.75"
      />
    </svg>
  )
}
