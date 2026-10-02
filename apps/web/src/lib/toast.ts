import { Toast } from '@base-ui/react/toast'

/** One manager for the whole app, so code outside React (mutation callbacks) can raise toasts too. */
export const toastManager = Toast.createToastManager()

export type ToastOptions = {
  /** Milliseconds before it goes away; errors stay a little longer. */
  timeout?: number
  action?: { label: string; onClick: () => void }
}

export function showToast(message: string, options: ToastOptions = {}): void {
  toastManager.add({
    title: message,
    timeout: options.timeout ?? 4000,
    actionProps: options.action
      ? { children: options.action.label, onClick: options.action.onClick }
      : undefined,
  })
}
