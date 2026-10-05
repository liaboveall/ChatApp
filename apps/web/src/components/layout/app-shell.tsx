import { type CSSProperties, type ReactNode, useEffect, useRef } from 'react'
import { useAppearance } from '@/lib/appearance.ts'
import { useShell } from '@/lib/shell-state.ts'
import { m } from '@/paraglide/messages.js'
import { Splitter } from './splitter.tsx'
import { Wallpaper } from './wallpaper.tsx'

type AppShellProps = {
  sidebar: ReactNode
  /** Rendered at the top of the main panel; omit for screens without a toolbar. */
  toolbar?: ReactNode
  inspector: ReactNode
  /** The screen fills the panel and scrolls inside itself (the conversation): no padding, no scrolling of its own. */
  fill?: boolean
  children: ReactNode
}

/**
 * Wallpaper plus three floating panels: sidebar (glass), main (solid), inspector (solid, or glass when it floats).
 * Layout tiers are container queries on `.window` (shell.css). The window is the viewport.
 */
export function AppShell({ sidebar, toolbar, inspector, fill, children }: AppShellProps) {
  const inspectorTab = useShell((state) => state.inspector)
  const drawerOpen = useShell((state) => state.drawerOpen)
  const setDrawer = useShell((state) => state.setDrawer)
  const sidebarWidth = useShell((state) => state.sidebarWidth)
  const compact = useAppearance((state) => state.compactSidebar)
  const sidebarRef = useRef<HTMLElement>(null)
  const restoreFocus = useRef<HTMLElement | null>(null)

  // The narrow-window drawer is a navigation layer: focus moves into it and comes back when it closes.
  useEffect(() => {
    if (drawerOpen) {
      restoreFocus.current = document.activeElement as HTMLElement | null
      sidebarRef.current
        ?.querySelector<HTMLElement>('button, a, input')
        ?.focus({ preventScroll: true })
    } else if (restoreFocus.current) {
      restoreFocus.current.focus({ preventScroll: true })
      restoreFocus.current = null
    }
  }, [drawerOpen])

  return (
    <div className="window" style={{ '--sidebar-w': `${sidebarWidth}px` } as CSSProperties}>
      <a className="skip-link" href="#main">
        {m.shell_skip_to_content()}
      </a>
      <Wallpaper />
      <div
        className="app"
        data-inspector={inspectorTab ? 'open' : 'closed'}
        data-drawer={drawerOpen ? 'open' : 'closed'}
      >
        <nav
          ref={sidebarRef}
          className="sidebar glass squircle"
          aria-label={m.shell_sidebar_label()}
          data-compact={compact ? 'true' : 'false'}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && drawerOpen) setDrawer(false)
          }}
          // Choosing a place from the drawer closes it, the place that is already open included (the route does not change).
          onClick={(event) => {
            if (drawerOpen && event.target instanceof Element && event.target.closest('a[href]')) {
              setDrawer(false)
            }
          }}
        >
          {sidebar}
          <Splitter />
        </nav>
        <main className="main squircle" id="main" tabIndex={-1} inert={drawerOpen || undefined}>
          {toolbar}
          <div
            className={fill ? 'content' : 'content scroll'}
            data-layout={fill ? 'fill' : undefined}
          >
            {children}
          </div>
        </main>
        <aside
          className="inspector squircle"
          aria-label={m.shell_inspector_label()}
          inert={drawerOpen || undefined}
        >
          {inspector}
        </aside>
        <div className="drawer-scrim" onClick={() => setDrawer(false)} aria-hidden="true" />
      </div>
    </div>
  )
}
