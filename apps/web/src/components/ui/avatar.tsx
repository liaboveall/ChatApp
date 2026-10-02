import { Sparkles } from 'lucide-react'
import type { CSSProperties } from 'react'
import { cx } from '@/lib/cx.ts'
import { Icon } from './icon.tsx'

export type PresenceStatus = 'online' | 'away' | 'offline'

/** A stable hue (0-359) from an id, so the same person always gets the same colour. */
export function hueOf(seed: string): number {
  let hash = 0
  for (const char of seed) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360
  return hash
}

/** First visible character of a name, upper-cased: "alice" gives "A", "周屿" gives "周". */
export function initialOf(name: string): string {
  const first = [
    ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(name.trim()),
  ][0]
  return (first?.segment ?? '?').toUpperCase()
}

type AvatarProps = {
  /** Display name, for the initial. */
  name: string
  /** Identity the hue is derived from (the user id). */
  seed: string
  size?: number
  bot?: boolean
  status?: PresenceStatus
  /** Localized text for the status dot, read by assistive technology. */
  statusLabel?: string
  className?: string
}

/** Placeholder avatar (uploads arrive with M3) with an optional presence dot whose shape carries the state. */
export function Avatar({
  name,
  seed,
  size = 36,
  bot,
  status,
  statusLabel,
  className,
}: AvatarProps) {
  const style = { '--size': `${size}px`, '--h': hueOf(seed) } as CSSProperties
  return (
    <span className={cx('avatar', bot && 'avatar--bot', className)} style={style}>
      {bot ? <Icon icon={Sparkles} /> : <span aria-hidden="true">{initialOf(name)}</span>}
      {status ? (
        <span className="presence" data-status={status} role="img" aria-label={statusLabel} />
      ) : null}
    </span>
  )
}
