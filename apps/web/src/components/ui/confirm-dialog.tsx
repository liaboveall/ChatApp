import { AlertDialog } from '@base-ui/react/alert-dialog'
import { type ReactNode, useRef } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { useModalFlag } from '@/components/ui/dialog.tsx'
import { m } from '@/paraglide/messages.js'

type ConfirmDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description: ReactNode
  /** The label of the action, which is also the only way to go through with it. */
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void
}

/**
 * A question the person has to answer before something that cannot be taken back (docs/02 section 7). It is an alert
 * dialog: focus starts on "Cancel", so a key press never confirms by accident, and Escape cancels.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  danger = false,
  onConfirm,
}: ConfirmDialogProps) {
  useModalFlag(open)
  const cancel = useRef<HTMLButtonElement>(null)
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="scrim" />
        <AlertDialog.Viewport className="dialog-host">
          <AlertDialog.Popup className="dialog glass-text squircle" initialFocus={cancel}>
            <AlertDialog.Title className="dialog__title">{title}</AlertDialog.Title>
            <AlertDialog.Description className="dialog__body">
              {description}
            </AlertDialog.Description>
            <div className="dialog__actions">
              <Button ref={cancel} kind="plain" onClick={() => onOpenChange(false)}>
                {m.common_cancel()}
              </Button>
              <Button
                kind="filled"
                danger={danger}
                onClick={() => {
                  onOpenChange(false)
                  onConfirm()
                }}
              >
                {confirmLabel}
              </Button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
