import { ChevronDown } from 'lucide-react'
import { Badge } from '@/components/ui/badge.tsx'
import { Icon } from '@/components/ui/icon.tsx'
import { m } from '@/paraglide/messages.js'

/** The round button at the bottom right that appears when the reader is not at the newest message (docs/02 section 5). */
export function JumpToLatest({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      className="jump glass-lite"
      aria-label={m.timeline_jump_to_latest({ count })}
      onClick={onClick}
    >
      <Icon icon={ChevronDown} size={20} />
      {count > 0 ? <Badge>{count > 99 ? '99+' : count}</Badge> : null}
    </button>
  )
}
