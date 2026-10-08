import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { Dialog } from '@/components/ui/dialog.tsx'
import { describeError } from '@/lib/error-messages.ts'
import { meQuery } from '@/lib/queries.ts'
import { showToast } from '@/lib/toast.ts'
import { m } from '@/paraglide/messages.js'
import { startRun } from './api.ts'
import { AgentMode } from './controls.tsx'
import { useAgent } from './store.ts'

export function NewAgentChat({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { data: me } = useQuery(meQuery)
  const navigate = useNavigate()
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const mode = useAgent((s) => s.modes.new) ?? 'fast'
  const key = useMemo(() => {
    void prompt
    void mode
    return crypto.randomUUID()
  }, [prompt, mode])
  const send = async () => {
    if (!me || !prompt.trim() || busy) return
    setBusy(true)
    try {
      const result = await startRun(
        { trigger: 'agent_chat', prompt, mode, timezone: me.timezone, attachmentIds: [] },
        key,
      )
      if (!result?.run.conversationId) return
      onOpenChange(false)
      setPrompt('')
      void navigate({
        to: '/c/$conversationId',
        params: { conversationId: result.run.conversationId },
      })
    } catch (error) {
      showToast(describeError(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.agent_new()}
      description={m.agent_disclosure()}
      actions={
        <>
          <Button kind="plain" onClick={() => onOpenChange(false)}>
            {m.common_cancel()}
          </Button>
          <Button busy={busy} disabled={!prompt.trim()} onClick={() => void send()}>
            {m.agent_send()}
          </Button>
        </>
      }
    >
      <AgentMode id="new" />
      <textarea
        className="input agent-prompt"
        aria-label={m.agent_prompt()}
        value={prompt}
        maxLength={20_000}
        onChange={(e) => setPrompt(e.target.value)}
      />
    </Dialog>
  )
}
