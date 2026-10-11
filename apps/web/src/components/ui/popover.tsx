import { Popover as BasePopover } from '@base-ui/react/popover'
import { type ReactElement, type ReactNode, useRef } from 'react'
import { cx } from '@/lib/cx.ts'

type PopoverProps = {
  /** The element that opens it (a button). */
  trigger: ReactElement
  children: ReactNode
  /** Accessible name of the panel. */
  label: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
  defaultOpen?: boolean
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  className?: string
}

/**
 * A panel on glass that stays open while one works in it: focus moves to the panel itself (not to its first button, which a
 * stray Enter would press), Esc and a click outside close it (Base UI).
 */
export function Popover({
  trigger,
  children,
  label,
  open,
  onOpenChange,
  defaultOpen,
  side = 'bottom',
  align = 'start',
  className,
}: PopoverProps) {
  const popup = useRef<HTMLDivElement>(null)
  return (
    <BasePopover.Root open={open} onOpenChange={onOpenChange} defaultOpen={defaultOpen}>
      <BasePopover.Trigger render={trigger} />
      <BasePopover.Portal>
        <BasePopover.Positioner side={side} align={align} sideOffset={8} className="positioner">
          <BasePopover.Popup
            ref={popup}
            initialFocus={popup}
            aria-label={label}
            className={cx('panel glass-text squircle', className)}
          >
            {children}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  )
}
