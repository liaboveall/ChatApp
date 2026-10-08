import { X } from 'lucide-react'
import { useEffect } from 'react'
import { IconButton } from '@/components/ui/button.tsx'
import { SegmentedControl } from '@/components/ui/controls.tsx'
import { AgentPanel } from '@/features/agent/panel.tsx'
import { Details } from '@/features/inspector/details.tsx'
import { type InspectorTab, useShell } from '@/lib/shell-state.ts'
import { m } from '@/paraglide/messages.js'

/**
 * Right panel (docks at 1280 px and wider, floats over the content below that). The details tab shows the open
 * conversation's members and settings (M2b); the assistant tab is a placeholder until the Agent panel arrives with M4.
 */
export function Inspector() {
  const tab = useShell((state) => state.inspector)
  const setInspector = useShell((state) => state.setInspector)
  const open = tab !== null

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

  if (tab === null) return null
  return (
    <div className="contents">
      <div className="inspector__head">
        <div className="inspector__head-row">
          <SegmentedControl<InspectorTab>
            label={m.shell_inspector_label()}
            value={tab}
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
        {tab === 'details' ? <Details /> : <AgentPanel />}
      </div>
    </div>
  )
}
