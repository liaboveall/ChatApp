import { ChevronDown } from 'lucide-react'
import { motion } from 'motion/react'
import { Badge } from '@/components/ui/badge.tsx'
import { Icon } from '@/components/ui/icon.tsx'
import { springs, timing } from '@/design/tokens.ts'
import { m } from '@/paraglide/messages.js'

/**
 * The round button at the bottom right that appears when the reader is not at the newest message (docs/02 section 5).
 * It pops out of the corner it stands in and shrinks back into it; the count ticks over as messages come.
 */
export function JumpToLatest({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <motion.button
      type="button"
      className="jump glass-clear"
      aria-label={m.timeline_jump_to_latest({ count })}
      onClick={onClick}
      initial={{ opacity: 0, scale: 0.6 }}
      animate={{
        opacity: 1,
        scale: 1,
        transition: {
          scale: { type: 'spring', ...springs.bouncy },
          opacity: { duration: 0.14 },
        },
      }}
      exit={{ opacity: 0, scale: 0.6, transition: { duration: timing.swap / 1000 } }}
    >
      <Icon icon={ChevronDown} size={20} />
      {count > 0 ? <Badge tick>{count > 99 ? '99+' : count}</Badge> : null}
    </motion.button>
  )
}
