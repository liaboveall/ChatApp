import { Toast } from '@base-ui/react/toast'
import { toastManager } from '@/lib/toast.ts'

function ToastList() {
  const { toasts } = Toast.useToastManager()
  return toasts.map((toast) => (
    <Toast.Root key={toast.id} toast={toast} className="toast">
      <Toast.Title />
      {toast.actionProps ? <Toast.Action className="toast__action" /> : null}
    </Toast.Root>
  ))
}

/** Mount once near the root: the toast viewport at the bottom centre. */
export function Toasts() {
  return (
    <Toast.Provider toastManager={toastManager} limit={3}>
      <Toast.Portal>
        <Toast.Viewport className="toast-stack">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  )
}
