import { Button } from '@/components/ui/button.tsx'
import { Dialog } from '@/components/ui/dialog.tsx'
import { keyLabel } from '@/lib/platform.ts'
import { SHORTCUTS, type ShortcutId } from '@/lib/shortcuts.ts'
import { m } from '@/paraglide/messages.js'

const LABELS: Record<ShortcutId, () => string> = {
  palette: () => m.shortcut_palette(),
  assistant: () => m.shortcut_assistant(),
  settings: () => m.shortcut_settings(),
  help: () => m.shortcut_help(),
}

/** Rows for the help dialog and the welcome page: the shortcuts that exist, with platform-correct key labels. */
export function ShortcutRows({ only }: { only?: ShortcutId[] }) {
  const rows = SHORTCUTS.filter((shortcut) => !only || only.includes(shortcut.id))
  return (
    <div className="keys-list">
      {rows.map((shortcut) => (
        <div className="keys-row" key={shortcut.id}>
          <span>{LABELS[shortcut.id]()}</span>
          <span>
            {shortcut.keys.map((key) => (
              <kbd key={key}>{keyLabel(key)}</kbd>
            ))}
          </span>
        </div>
      ))}
      <div className="keys-row">
        <span>{m.shortcut_escape()}</span>
        <span>
          <kbd>Esc</kbd>
        </span>
      </div>
    </div>
  )
}

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.shortcuts_title()}
      description={m.shortcuts_lead()}
      actions={<Button onClick={() => onOpenChange(false)}>{m.common_done()}</Button>}
    >
      <ShortcutRows />
    </Dialog>
  )
}
