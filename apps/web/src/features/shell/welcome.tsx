import { AppIcon } from '@/components/brand/app-icon.tsx'
import { m } from '@/paraglide/messages.js'
import { ShortcutRows } from './shortcuts-dialog.tsx'

/** The empty main panel: nothing is open yet. */
export function Welcome({ name }: { name: string }) {
  return (
    <div className="welcome">
      <AppIcon size={72} />
      <h1 className="text-title-1">{m.welcome_title({ name })}</h1>
      <p className="max-w-[44ch] text-body text-label-secondary text-balance">{m.welcome_text()}</p>
      <div className="welcome__keys">
        <ShortcutRows />
      </div>
    </div>
  )
}
