import type { Conversation } from '@chatapp/contracts'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Pencil, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button, IconButton } from '@/components/ui/button.tsx'
import { SegmentedControl } from '@/components/ui/controls.tsx'
import { Dialog } from '@/components/ui/dialog.tsx'
import { patchConversation } from '@/features/conversations/api.ts'
import { describeError } from '@/lib/error-messages.ts'
import { meQuery } from '@/lib/queries.ts'
import { showToast } from '@/lib/toast.ts'
import { m } from '@/paraglide/messages.js'
import { deleteAgentChat } from './api.ts'
import { useAgent } from './store.ts'

export function AgentMode({ id }: { id: string }) {
  const { data: me } = useQuery(meQuery)
  const value =
    useAgent((s) => s.modes[id]) ?? (me?.settings.agentMode === 'deep' ? 'deep' : 'fast')
  return (
    <SegmentedControl
      label={m.agent_mode()}
      value={value}
      onValueChange={(mode) => useAgent.setState((s) => ({ modes: { ...s.modes, [id]: mode } }))}
      items={[
        { value: 'fast', label: m.agent_fast() },
        { value: 'deep', label: m.agent_deep() },
      ]}
    />
  )
}
export function AgentScope({ id }: { id: string }) {
  const value = useAgent((s) => s.scopes[id] ?? 'current')
  return (
    <>
      <SegmentedControl
        label={m.agent_scope()}
        value={value}
        onValueChange={(scope) =>
          useAgent.setState((s) => ({ scopes: { ...s.scopes, [id]: scope } }))
        }
        items={[
          { value: 'current', label: m.agent_current() },
          { value: 'all', label: m.agent_all() },
        ]}
      />
      <small>{m.agent_scope_change()}</small>
    </>
  )
}
export function AgentChatControls({
  conversation,
  onDeleted,
  showMode = true,
  showDisclosure = true,
}: {
  conversation: Conversation
  onDeleted?: () => void
  showMode?: boolean
  showDisclosure?: boolean
}) {
  const navigate = useNavigate()
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null)
  const [name, setName] = useState(conversation.name ?? '')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (busy) return
    setBusy(true)
    try {
      const result =
        dialog === 'delete'
          ? await deleteAgentChat(conversation.id)
          : await patchConversation(conversation.id, {
              name,
              expectedMetadataVersion: conversation.metadataVersion,
            })
      if (result === null) return
      setDialog(null)
      if (dialog === 'delete') {
        if (onDeleted) onDeleted()
        else void navigate({ to: '/' })
      }
    } catch (error) {
      showToast(describeError(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className="agent-controls">
        {showMode ? <AgentMode id={conversation.id} /> : null}
        <IconButton
          small
          icon={Pencil}
          label={m.agent_rename()}
          onClick={() => {
            setName(conversation.name ?? '')
            setDialog('rename')
          }}
        />
        <IconButton
          small
          icon={Trash2}
          label={m.agent_delete()}
          onClick={() => setDialog('delete')}
        />
      </div>
      {showMode && showDisclosure ? (
        <p className="agent-disclosure">{m.agent_disclosure()}</p>
      ) : null}
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => !open && setDialog(null)}
        title={dialog === 'delete' ? m.agent_delete() : m.agent_rename()}
        description={dialog === 'delete' ? m.agent_delete_text() : undefined}
        actions={
          <>
            <Button kind="plain" onClick={() => setDialog(null)}>
              {m.common_cancel()}
            </Button>
            <Button
              busy={busy}
              danger={dialog === 'delete'}
              disabled={dialog === 'rename' && !name.trim()}
              onClick={() => void submit()}
            >
              {dialog === 'delete' ? m.agent_delete() : m.common_save()}
            </Button>
          </>
        }
      >
        {dialog === 'rename' ? (
          <input
            aria-label={m.agent_rename()}
            className="input"
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
          />
        ) : null}
      </Dialog>
    </>
  )
}
