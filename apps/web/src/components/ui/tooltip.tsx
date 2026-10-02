import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip'
import type { ReactElement, ReactNode } from 'react'
import { keyLabel } from '@/lib/platform.ts'

export const TooltipProvider = BaseTooltip.Provider

type TooltipProps = {
  /** Text shown in the tooltip. */
  content: ReactNode
  /** Keys of a shortcut to show next to the text, e.g. ['mod', 'K']. */
  shortcut?: string[]
  side?: 'top' | 'bottom' | 'left' | 'right'
  /** Start open (stories and tests). */
  defaultOpen?: boolean
  /** The element that triggers it; must accept a ref and props (a native element or a forwardRef component). */
  children: ReactElement
}

export function Tooltip({
  content,
  shortcut,
  side = 'bottom',
  defaultOpen,
  children,
}: TooltipProps) {
  return (
    <BaseTooltip.Root defaultOpen={defaultOpen}>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} sideOffset={6} className="positioner">
          <BaseTooltip.Popup className="tooltip">
            {content}
            {shortcut ? <kbd>{shortcut.map((key) => keyLabel(key)).join(' ')}</kbd> : null}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  )
}
