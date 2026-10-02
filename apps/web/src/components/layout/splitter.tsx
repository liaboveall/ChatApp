import { type KeyboardEvent, type PointerEvent, useRef } from 'react'
import {
  clampSidebar,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  useShell,
} from '@/lib/shell-state.ts'
import { m } from '@/paraglide/messages.js'

/** Draggable divider between the sidebar and the main panel. Keyboard: arrows (Shift for bigger steps), Home, End. */
export function Splitter() {
  const width = useShell((state) => state.sidebarWidth)
  const setWidth = useShell((state) => state.setSidebarWidth)
  const drag = useRef<{ startX: number; startWidth: number } | null>(null)

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    event.currentTarget.dataset.dragging = 'true'
    drag.current = { startX: event.clientX, startWidth: width }
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (!drag.current) return
    setWidth(drag.current.startWidth + (event.clientX - drag.current.startX), false)
  }
  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    if (!drag.current) return
    drag.current = null
    event.currentTarget.dataset.dragging = 'false'
    setWidth(useShell.getState().sidebarWidth)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 32 : 12
    let next: number
    if (event.key === 'ArrowLeft') next = width - step
    else if (event.key === 'ArrowRight') next = width + step
    else if (event.key === 'Home') next = SIDEBAR_MIN
    else if (event.key === 'End') next = SIDEBAR_MAX
    else return
    event.preventDefault()
    setWidth(clampSidebar(next))
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable, adjustable separator is the WAI-ARIA window splitter pattern; <hr> cannot take keyboard focus or a value.
    <div
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={m.shell_splitter_label()}
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onDoubleClick={() => setWidth(SIDEBAR_DEFAULT)}
    />
  )
}
