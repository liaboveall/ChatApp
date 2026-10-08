import { assistantText, type Conversation } from '@chatapp/contracts'
import { useQuery } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { engine } from '@/app/sync.ts'
import { MessageBody } from '@/components/markdown/message-body.tsx'
import { Button } from '@/components/ui/button.tsx'
import { describeError } from '@/lib/error-messages.ts'
import { meQuery } from '@/lib/queries.ts'
import { draftOf, setDraft, setDraftPreview, useDrafts } from '@/lib/sync/drafts.ts'
import { useConversationIndex, useTimelineWindow } from '@/lib/sync/hooks.ts'
import { registerConversationReset } from '@/lib/sync/stores.ts'
import { showToast } from '@/lib/toast.ts'
import { m } from '@/paraglide/messages.js'
import { startRun, stopRun } from './api.ts'
import { AgentChatControls, AgentMode, AgentScope } from './controls.tsx'
import { AgentRunCard } from './run-card.tsx'
import { useAgent } from './store.ts'

registerConversationReset((id) => {
  for (const key of Object.keys(useDrafts.getState().byConversation)) {
    if (key.startsWith(`agent-panel:${id}:`) || key.endsWith(`:${id}`)) setDraft(key, '')
  }
})

export function AgentPanel() {
  const id = useParams({ strict: false }).conversationId
  const index = useConversationIndex()
  const { data: me } = useQuery(meQuery)
  const selected = useAgent((s) => (id ? s.panels[id] : undefined))
  const context = id ? index.byId[id] : undefined
  if (!id || !context?.me || !me) return <p>{m.agent_need_conversation()}</p>
  if (context.kind === 'agent') return <p>{m.agent_all()}</p>
  const sessions = Object.values(index.byId)
    .filter((c) => c.panelForConversationId === id && c.kind === 'agent' && c.me?.role === 'owner')
    .sort(
      (a, b) =>
        (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '') || b.id.localeCompare(a.id),
    )
  const panel =
    selected === '' ? undefined : (sessions.find((c) => c.id === selected) ?? sessions[0])
  return (
    <PanelSession
      key={`${id}:${panel?.id ?? 'new'}`}
      context={context}
      panel={panel}
      sessions={sessions}
    />
  )
}

function PanelSession({
  context,
  panel,
  sessions,
}: {
  context: Conversation
  panel: Conversation | undefined
  sessions: Conversation[]
}) {
  const id = context.id
  const panelId = panel?.id
  const draftKey = `agent-panel:${id}:${panelId ?? 'new'}`
  const preferenceId = panelId ?? id
  const window = useTimelineWindow(panelId ?? '')
  const { data: me } = useQuery(meQuery)
  const scope = useAgent((s) => s.scopes[preferenceId] ?? 'current')
  const mode =
    useAgent((s) => s.modes[preferenceId]) ?? (me?.settings.agentMode === 'deep' ? 'deep' : 'fast')
  const prompt = useDrafts((s) => draftOf(s, draftKey))
  const [busy, setBusy] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const alive = useRef(true)
  const messages = useRef<HTMLDivElement>(null)
  const key = useMemo(() => {
    void prompt
    void scope
    void mode
    return crypto.randomUUID()
  }, [prompt, scope, mode])
  const pending = useAgent((s) =>
    Object.values(s.details).find(
      (d) =>
        d !== 'denied' &&
        d.run.contextConversationId === id &&
        d.run.conversationId === panelId &&
        d.run.status === 'queued' &&
        d.run.outputMessageId === null,
    ),
  )
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    if (!panelId) return
    useAgent.setState((s) =>
      s.panels[id] === panelId ? s : { panels: { ...s.panels, [id]: panelId } },
    )
    void engine.openConversation(panelId, { auxiliary: true })
    const timer = setInterval(() => void engine.reconcile(), 5000)
    return () => {
      clearInterval(timer)
      engine.closeConversation(panelId)
    }
  }, [id, panelId])
  const count = window?.messages.length ?? 0
  useEffect(() => {
    void count
    messages.current?.scrollTo({ top: messages.current.scrollHeight })
  }, [count])
  const select = (value: string) =>
    useAgent.setState((s) => ({ panels: { ...s.panels, [id]: value } }))
  const ask = async (text = prompt) => {
    if (busy || !text.trim() || !me) return
    setBusy(true)
    try {
      const result = await startRun(
        {
          trigger: 'panel',
          conversationId: panelId,
          newConversation: !panelId,
          contextConversationId: id,
          prompt: text,
          scope,
          mode,
          timezone: me.timezone,
          attachmentIds: [],
        },
        text === prompt ? key : crypto.randomUUID(),
      )
      if (!result || !alive.current) return
      if (text === prompt && draftOf(useDrafts.getState(), draftKey) === prompt)
        setDraft(draftKey, '')
      if (result.run.conversationId) {
        const nextId = result.run.conversationId
        useAgent.setState((s) => ({
          panels: { ...s.panels, [id]: nextId },
          modes: { ...s.modes, [nextId]: mode },
          scopes: { ...s.scopes, [nextId]: scope },
        }))
      }
    } catch (error) {
      if (alive.current) showToast(describeError(error))
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  return (
    <div className="agent-panel agent-panel--conversation">
      <div className="agent-panel__toolbar">
        <Button kind="tinted" size="sm" icon={Plus} onClick={() => select('')} disabled={busy}>
          {m.agent_new()}
        </Button>
        {panel ? (
          <AgentChatControls conversation={panel} showMode={false} onDeleted={() => select('')} />
        ) : null}
      </div>
      <label className="agent-panel__history">
        <span>{m.agent_history()}</span>
        <select
          className="select"
          value={panelId ?? ''}
          onChange={(event) => select(event.target.value)}
        >
          <option value="">{m.agent_empty()}</option>
          {sessions.map((session) => (
            <option key={session.id} value={session.id}>
              {session.name}
            </option>
          ))}
        </select>
      </label>
      <p className="agent-panel__private">{m.agent_panel_private()}</p>
      <AgentScope id={preferenceId} />
      <AgentMode id={preferenceId} />
      <div className="agent-controls agent-panel__quick">
        <Button
          kind="tinted"
          size="sm"
          disabled={busy}
          onClick={() => void ask(m.agent_summary_prompt())}
        >
          {m.agent_summary()}
        </Button>
        <Button
          kind="tinted"
          size="sm"
          disabled={busy}
          onClick={() => void ask(m.agent_translate_prompt())}
        >
          {m.agent_translate()}
        </Button>
        <Button
          kind="tinted"
          size="sm"
          disabled={busy}
          onClick={() => void ask(m.agent_draft_prompt())}
        >
          {m.agent_draft()}
        </Button>
      </div>
      <div ref={messages} className="agent-panel__messages scroll">
        {window?.hasMoreBefore && panelId ? (
          <Button
            kind="plain"
            size="sm"
            busy={loadingOlder}
            onClick={() => {
              setLoadingOlder(true)
              const element = messages.current
              const height = element?.scrollHeight ?? 0
              const top = element?.scrollTop ?? 0
              void engine.loadOlder(panelId).finally(() => {
                if (!alive.current) return
                setLoadingOlder(false)
                requestAnimationFrame(() => {
                  if (element && alive.current)
                    element.scrollTop = top + element.scrollHeight - height
                })
              })
            }}
          >
            {m.media_more()}
          </Button>
        ) : null}
        {!panel ? (
          <div className="agent-panel__empty">
            <b>{m.agent_empty()}</b>
            <p>{m.agent_empty_text()}</p>
          </div>
        ) : null}
        {window?.messages
          .filter((msg) => msg.kind !== 'system')
          .map((msg) => (
            <div key={msg.id} className="agent-panel__message" data-kind={msg.kind}>
              <b className="agent-panel__speaker">
                {msg.kind === 'agent' ? m.agent_assistant() : m.agent_you()}
              </b>
              <MessageBody
                text={msg.kind === 'agent' ? assistantText(msg.body ?? '') : (msg.body ?? '')}
              />
              {msg.kind === 'agent' ? (
                <>
                  <AgentRunCard message={msg} />
                  {msg.status === 'sent' && msg.body ? (
                    <Button
                      kind="plain"
                      size="sm"
                      onClick={() => {
                        setDraft(
                          id,
                          [draftOf(useDrafts.getState(), id), assistantText(msg.body ?? '')]
                            .filter(Boolean)
                            .join('\n\n'),
                        )
                        setDraftPreview(id, true)
                      }}
                    >
                      {m.agent_insert()}
                    </Button>
                  ) : null}
                </>
              ) : null}
            </div>
          ))}
      </div>
      {pending && pending !== 'denied' ? (
        <Button
          kind="plain"
          size="sm"
          onClick={() => void stopRun(pending.run.id, pending.run.conversationId ?? '')}
        >
          {m.agent_stop()}
        </Button>
      ) : null}
      <textarea
        className="input agent-prompt"
        aria-label={m.agent_prompt()}
        placeholder={m.agent_prompt()}
        value={prompt}
        maxLength={20_000}
        onChange={(event) => setDraft(draftKey, event.target.value)}
      />
      <Button busy={busy} disabled={!prompt.trim()} onClick={() => void ask()}>
        {m.agent_send()}
      </Button>
      <p className="agent-disclosure">{m.agent_disclosure()}</p>
    </div>
  )
}
