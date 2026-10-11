import { AppIcon } from '@/components/brand/app-icon.tsx'
import { useDocumentTitle } from '@/lib/page-title.ts'

/**
 * The installed app's title bar when the window controls overlay is on (Chromium, docs/01 section 3.5, M6): the browser
 * then draws only its window buttons, and the page draws the rest of the bar. It shows the title (with the unread count in
 * front, as a tab does) and moves the window when dragged. Everywhere else it is not displayed (shell.css). Hidden from
 * assistive technology: the same title is the document's, which is announced already.
 */
export function TitleBar() {
  const title = useDocumentTitle()
  return (
    <div className="titlebar" aria-hidden="true">
      <AppIcon size={16} />
      <span className="titlebar__text">{title}</span>
    </div>
  )
}
