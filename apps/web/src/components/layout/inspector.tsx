import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { IconButton } from '@/components/ui/button.tsx'
import { SegmentedControl } from '@/components/ui/controls.tsx'
import { AgentPanel } from '@/features/agent/panel.tsx'
import { Details } from '@/features/inspector/details.tsx'
import { type InspectorTab, useShell } from '@/lib/shell-state.ts'
import { m } from '@/paraglide/messages.js'

/** How long the pane takes to leave (shell.css): what it showed stays in it for that long, so it does not leave empty. */
const LEAVE_MS = 160

/**
 * Right panel (docks at 1280 px and wider, floats over the content below that). The details tab shows the open
 * conversation's members and settings (M2b); the assistant tab is a placeholder until the Agent panel arrives with M4.
 */
export function Inspector() {
  const tab = useShell((state) => state.inspector)
  const setInspector = useShell((state) => state.setInspector)
  const open = tab !== null
  // The tab that is drawn: the open one, or the one that was open while the pane slides away (inert by then).
  const [drawn, setDrawn] = useState(tab)
  if (tab !== null && drawn !== tab) setDrawn(tab)
  useEffect(() => {
    if (tab !== null) return
    const timer = setTimeout(() => setDrawn(null), LEAVE_MS)
    return () => clearTimeout(timer)
  }, [tab])
  const shown = tab ?? drawn

  // Escape closes the panel while focus is inside it (a modal layer on top handles its own Escape first).
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.activeElement?.closest('.inspector')) setInspector(null)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, setInspector])

  if (shown === null) return null
  return (
    <div className="contents" inert={!open || undefined}>
      <div className="inspector__head">
        <div className="inspector__head-row">
          <SegmentedControl<InspectorTab>
            label={m.shell_inspector_label()}
            value={shown}
            block
            onValueChange={setInspector}
            items={[
              { value: 'details', label: m.shell_inspector_details() },
              { value: 'assistant', label: m.shell_inspector_assistant() },
            ]}
          />
          <IconButton
            label={m.shell_inspector_close()}
            icon={X}
            onClick={() => setInspector(null)}
          />
        </div>
      </div>
      <div className="inspector__body scroll">
        {shown === 'details' ? <Details /> : <AgentPanel />}
      </div>
    </div>
  )
}
