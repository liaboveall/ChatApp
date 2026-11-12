import { assistantText, type Conversation } from '@chatapp/contracts'
import { useQuery } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import {
  ArrowUp,
  CircleStop,
  CornerDownLeft,
  Loader2,
  Lock,
  Sparkles,
  SquarePen,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { engine } from '@/app/sync.ts'
import { MessageBody } from '@/components/markdown/message-body.tsx'
import { Button, IconButton } from '@/components/ui/button.tsx'
import { Icon } from '@/components/ui/icon.tsx'
import { initialComposition, shouldSend } from '@/features/composer/enter-key.ts'
import { describeError } from '@/lib/error-messages.ts'
import { meQuery } from '@/lib/queries.ts'
import { draftOf, setDraft, setDraftPreview, useDrafts } from '@/lib/sync/drafts.ts'
import { useConversationIndex, useTimelineWindow } from '@/lib/sync/hooks.ts'
import { registerConversationReset } from '@/lib/sync/stores.ts'
import { showToast } from '@/lib/toast.ts'
import { m } from '@/paraglide/messages.js'
import { startRun, stopRun } from './api.ts'
import { segmentWindow, useAgentContext } from './context.ts'
import { AgentChatControls, AgentKeySource, AgentMode, AgentScope } from './controls.tsx'
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
  const segment = useAgentContext(panelId)
  const shown = window && segment ? segmentWindow(window, segment) : undefined
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
  const composition = useRef(initialComposition())
  const promptField = useRef<HTMLTextAreaElement>(null)
  // The field grows with what is written, up to the CSS maximum. `field-sizing: content` does it where the browser has
  // it; the measured height covers the others. Set through CSSOM, which the content security policy allows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measures whenever the text changes
  useLayoutEffect(() => {
    const element = promptField.current
    if (element === null) return
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }, [prompt])
  const quick = [
    [m.agent_summary(), m.agent_summary_prompt()],
    [m.agent_translate(), m.agent_translate_prompt()],
    [m.agent_draft(), m.agent_draft_prompt()],
  ] as const
  return (
    <div className="agent-panel agent-panel--conversation">
      {/* Which private chat this is, and what can be done with it. The picker stays a native select: the keyboard, type-ahead
          and the phone's own picker come with it. */}
      <div className="agent-panel__bar">
        <select
          className="select agent-panel__session"
          aria-label={m.agent_history()}
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
        {panel ? (
          <AgentChatControls conversation={panel} showMode={false} onDeleted={() => select('')} />
        ) : null}
        <IconButton
          small
          icon={SquarePen}
          label={m.agent_new()}
          disabled={busy || !panel}
          onClick={() => select('')}
        />
      </div>
      <div ref={messages} className="agent-panel__messages scroll">
        {shown?.hasMoreBefore && panelId ? (
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
            <span className="agent-panel__empty-icon" aria-hidden="true">
              <Icon icon={Sparkles} size={24} />
            </span>
            <b>{m.agent_empty()}</b>
            <p>{m.agent_empty_text()}</p>
          </div>
        ) : (
          <p className="agent-panel__private">
            <Icon icon={Lock} size={16} />
            {m.agent_panel_private()}
          </p>
        )}
        {shown?.messages
          .filter((msg) => msg.kind !== 'system')
          .map((msg) => (
            <div key={msg.id} className="agent-panel__message" data-kind={msg.kind}>
              <b className="agent-panel__speaker">
                {msg.kind === 'agent' ? (
                  <>
                    <Icon icon={Sparkles} size={16} />
                    {m.agent_assistant()}
                  </>
                ) : (
                  m.agent_you()
                )}
              </b>
              <MessageBody
                text={msg.kind === 'agent' ? assistantText(msg.body ?? '') : (msg.body ?? '')}
              />
              {msg.kind === 'agent' ? (
                <>
                  <AgentRunCard message={msg} />
                  {msg.status === 'sent' && msg.body ? (
                    <Button
                      kind="tinted"
                      size="sm"
                      icon={CornerDownLeft}
                      className="agent-panel__insert"
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
          kind="tinted"
          size="sm"
          icon={CircleStop}
          className="agent-panel__stop"
          onClick={() => void stopRun(pending.run.id, pending.run.conversationId ?? '')}
        >
          {m.agent_stop()}
        </Button>
      ) : null}
      {/* What the next request reads and how hard it thinks: said where the request is written. */}
      <div className="agent-panel__options">
        <div className="agent-option">
          <span className="agent-option__label" aria-hidden="true">
            {m.agent_scope()}
          </span>
          <AgentScope id={preferenceId} />
        </div>
        {/* Only where there is a context to lose: a chat that has not started has nothing to carry over. */}
        {panel ? <small className="agent-option__note">{m.agent_scope_change()}</small> : null}
        <div className="agent-option">
          <span className="agent-option__label" aria-hidden="true">
            {m.agent_mode()}
          </span>
          <AgentMode id={preferenceId} />
        </div>
        <AgentKeySource conversationId={panelId} />
      </div>
      <div className="agent-panel__quick">
        {quick.map(([label, text]) => (
          <button
            key={label}
            type="button"
            className="agent-chip"
            aria-disabled={busy ? true : undefined}
            onClick={() => void ask(text)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="agent-panel__composer">
        <textarea
          ref={promptField}
          className="agent-prompt"
          aria-label={m.agent_prompt()}
          placeholder={m.agent_prompt()}
          rows={1}
          value={prompt}
          maxLength={20_000}
          onChange={(event) => setDraft(draftKey, event.target.value)}
          onCompositionStart={() => {
            composition.current = { composing: true, endedAt: composition.current.endedAt }
          }}
          onCompositionEnd={() => {
            composition.current = { composing: false, endedAt: performance.now() }
          }}
          // Enter asks, Shift+Enter breaks the line; an Enter that only confirms an input-method candidate does neither.
          onKeyDown={(event) => {
            const native = event.nativeEvent
            if (
              shouldSend(
                {
                  key: event.key,
                  shiftKey: event.shiftKey,
                  altKey: event.altKey,
                  ctrlKey: event.ctrlKey,
                  metaKey: event.metaKey,
                  isComposing: native.isComposing,
                  keyCode: native.keyCode,
                },
                composition.current,
                performance.now(),
              )
            ) {
              event.preventDefault()
              void ask()
            }
          }}
        />
        <IconButton
          variant="filled"
          icon={busy ? Loader2 : ArrowUp}
          label={m.agent_send()}
          className={busy ? 'agent-panel__send agent-panel__send--busy' : 'agent-panel__send'}
          tooltip={false}
          aria-busy={busy ? true : undefined}
          disabled={!prompt.trim()}
          onClick={() => void ask()}
        />
      </div>
      <p className="agent-disclosure">{m.agent_disclosure()}</p>
    </div>
  )
}
