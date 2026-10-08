import { agentUsageSchema, aiKeyResponseSchema, type Conversation } from '@chatapp/contracts'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Pencil, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { forScreen } from '@/app/sync.ts'
import { Button, IconButton } from '@/components/ui/button.tsx'
import { SegmentedControl } from '@/components/ui/controls.tsx'
import { Dialog } from '@/components/ui/dialog.tsx'
import { patchConversation } from '@/features/conversations/api.ts'
import { api } from '@/lib/api.ts'
import { describeError } from '@/lib/error-messages.ts'
import { meQuery } from '@/lib/queries.ts'
import { useSyncScope } from '@/lib/sync/hooks.ts'
import { showToast } from '@/lib/toast.ts'
import { m } from '@/paraglide/messages.js'
import { deleteAgentChat, switchKeySource } from './api.ts'
import { useAgentContext } from './context.ts'
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
/**
 * Which key a private assistant conversation uses, and the switch between the person's own key and the site allowance
 * (docs/02 section 6). Switching starts a blank segment: nothing earlier is carried over (D-080).
 */
export function AgentKeySource({ conversationId }: { conversationId: string | undefined }) {
  const scope = useSyncScope()
  const context = useAgentContext(conversationId)
  const [busy, setBusy] = useState(false)
  const usage = useQuery({
    queryKey: ['agent-usage', scope?.userId, scope?.generation],
    enabled: scope !== null,
    queryFn: () => forScreen(null, () => api('/api/agent/usage', { schema: agentUsageSchema })),
  })
  const key = useQuery({
    queryKey: ['ai-key', scope?.userId, scope?.generation],
    enabled: scope !== null,
    queryFn: () => forScreen(null, () => api('/api/me/ai-key', { schema: aiKeyResponseSchema })),
  })
  const latest = useAgent((s) =>
    Object.values(s.details)
      .filter((d) => d !== 'denied' && conversationId && d.run.conversationId === conversationId)
      .map((d) => (d === 'denied' ? null : d.run))
      .filter((run) => run !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .at(-1),
  )
  const source = context?.keySource ?? latest?.keySource ?? usage.data?.keySource ?? 'site'
  const ownWorks = key.data?.aiKey?.status === 'active'
  const target = source === 'user' ? 'site' : ownWorks ? 'user' : null
  const change = async () => {
    if (!conversationId || !target || busy) return
    setBusy(true)
    try {
      if ((await switchKeySource(conversationId, target)) !== null)
        showToast(m.agent_key_switched())
    } catch (error) {
      showToast(describeError(error))
    } finally {
      setBusy(false)
    }
  }
  if (!ownWorks && source === 'site') return null
  return (
    <div className="agent-controls agent-key-source">
      <small>{source === 'user' ? m.agent_key_own() : m.agent_key_site()}</small>
      {conversationId && target ? (
        <Button kind="plain" size="sm" busy={busy} onClick={() => void change()}>
          {target === 'site' ? m.agent_key_switch_site() : m.agent_key_switch_own()}
        </Button>
      ) : null}
    </div>
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
      {showMode ? <AgentKeySource conversationId={conversation.id} /> : null}
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
