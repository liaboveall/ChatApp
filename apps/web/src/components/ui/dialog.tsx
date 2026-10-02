import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import { type ReactNode, type RefObject, useEffect } from 'react'
import { cx } from '@/lib/cx.ts'

/**
 * While a modal layer is open the toolbar and composer behind it drop their blur, which keeps the page within four
 * backdrop-filter layers (docs/02 section 2, D-110). The stylesheet keys off this attribute.
 */
export function useModalFlag(open: boolean): void {
  useEffect(() => {
    if (!open) return
    const root = document.documentElement
    root.setAttribute('data-modal', 'true')
    return () => root.removeAttribute('data-modal')
  }, [open])
}

type DialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  /** Buttons, right-aligned at the bottom. */
  actions?: ReactNode
  className?: string
  /** Element to focus on open; by default the first control. Confirmations of risky actions point at Cancel. */
  initialFocus?: RefObject<HTMLElement | null>
}

/** Modal dialog on glass: focus is trapped, Escape closes it and focus returns to the trigger. */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  actions,
  className,
  initialFocus,
}: DialogProps) {
  useModalFlag(open)
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="scrim" />
        <BaseDialog.Viewport className="dialog-host">
          <BaseDialog.Popup
            className={cx('dialog glass-text squircle', className)}
            initialFocus={initialFocus}
          >
            <BaseDialog.Title className="dialog__title">{title}</BaseDialog.Title>
            {description ? (
              <BaseDialog.Description className="dialog__body">
                {description}
              </BaseDialog.Description>
            ) : null}
            {children}
            {actions ? <div className="dialog__actions">{actions}</div> : null}
          </BaseDialog.Popup>
        </BaseDialog.Viewport>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}
