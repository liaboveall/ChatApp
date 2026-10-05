import { Button } from '@/components/ui/button.tsx'
import { Dialog } from '@/components/ui/dialog.tsx'
import { keyLabel } from '@/lib/platform.ts'
import { NAVIGATION_SHORTCUTS, SHORTCUTS, type ShortcutId } from '@/lib/shortcuts.ts'
import { m } from '@/paraglide/messages.js'

const LABELS: Record<ShortcutId, () => string> = {
  palette: () => m.shortcut_palette(),
  assistant: () => m.shortcut_assistant(),
  settings: () => m.shortcut_settings(),
  help: () => m.shortcut_help(),
  previous: () => m.shortcut_previous(),
  next: () => m.shortcut_next(),
  previousUnread: () => m.shortcut_previous_unread(),
  nextUnread: () => m.shortcut_next_unread(),
}

/** Keys that work in the message field: not global shortcuts, but they belong in the list (docs/02 section 7). */
const TYPING: { label: () => string; keys: string[] }[] = [
  { label: () => m.shortcut_send(), keys: ['Enter'] },
  { label: () => m.shortcut_newline(), keys: ['shift', 'Enter'] },
  { label: () => m.shortcut_edit_last(), keys: ['up'] },
]

/** Rows for the help dialog and the welcome page: the shortcuts that exist, with platform-correct key labels. */
export function ShortcutRows({ only }: { only?: ShortcutId[] }) {
  const rows = [...SHORTCUTS, ...NAVIGATION_SHORTCUTS].filter(
    (shortcut) => !only || only.includes(shortcut.id),
  )
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
      {only
        ? null
        : TYPING.map((row) => (
            <div className="keys-row" key={row.keys.join('+')}>
              <span>{row.label()}</span>
              <span>
                {row.keys.map((key) => (
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
