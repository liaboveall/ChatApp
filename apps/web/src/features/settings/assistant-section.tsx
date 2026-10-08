import {
  type AiKey,
  aiKeyResponseSchema,
  type Me,
  meSchema,
  okResponseSchema,
  type Reminder,
  reminderListSchema,
  reminderResponseSchema,
  type ScheduledMessage,
  scheduledMessageListSchema,
  scheduledMessageResponseSchema,
} from '@chatapp/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { forScreen } from '@/app/sync.ts'
import { Button } from '@/components/ui/button.tsx'
import { SegmentedControl, Switch } from '@/components/ui/controls.tsx'
import { Banner, Skeleton } from '@/components/ui/feedback.tsx'
import { TextField } from '@/components/ui/fields.tsx'
import { conversationLabel, offsetText } from '@/features/agent/approval-card.tsx'
import { AgentUsage } from '@/features/agent/usage.tsx'
import { ApiError, api } from '@/lib/api.ts'
import { describeError } from '@/lib/error-messages.ts'
import { queryKeys, writeMeAnswer } from '@/lib/queries.ts'
import { useSyncScope } from '@/lib/sync/hooks.ts'
import { showToast } from '@/lib/toast.ts'
import { m } from '@/paraglide/messages.js'
import { MemoriesGroup } from './memories-group.tsx'
import { Box, Group, Row } from './settings-ui.tsx'

function useMeSettings(me: Me) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (settings: { agentMode?: 'fast' | 'deep'; aiKeyPreference?: 'own' | 'site' }) =>
      forScreen(null, () =>
        api('/api/me', {
          method: 'PATCH',
          json: { expectedMeVersion: me.meVersion, settings },
          schema: meSchema,
        }),
      ),
    onSuccess: (updated) => {
      if (updated === null) return
      writeMeAnswer(queryClient, updated)
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.code === 'VERSION_CONFLICT')
        await queryClient.invalidateQueries({ queryKey: queryKeys.me })
      showToast(describeError(error))
    },
  })
}

function ModeGroup({ me }: { me: Me }) {
  const save = useMeSettings(me)
  return (
    <Group title={m.settings_agent_mode()}>
      <Box>
        <Row title={m.settings_agent_mode()} help={m.settings_agent_mode_help()}>
          <SegmentedControl<'fast' | 'deep'>
            label={m.settings_agent_mode()}
            value={me.settings.agentMode === 'deep' ? 'deep' : 'fast'}
            disabled={save.isPending}
            onValueChange={(agentMode) =>
              save.mutate(
                { agentMode },
                { onSuccess: () => showToast(m.settings_agent_mode_saved()) },
              )
            }
            items={[
              { value: 'fast', label: m.agent_fast() },
              { value: 'deep', label: m.agent_deep() },
            ]}
          />
        </Row>
      </Box>
    </Group>
  )
}

function keyState(key: AiKey): string {
  if (key.status === 'active') return m.settings_ai_key_active()
  return key.invalidReason === 'insufficient_balance'
    ? m.settings_ai_key_balance()
    : m.settings_ai_key_invalid()
}

function OwnKeyGroup({ me }: { me: Me }) {
  const queryClient = useQueryClient()
  const scope = useSyncScope()
  const preference = useMeSettings(me)
  const [draft, setDraft] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const current = useQuery({
    queryKey: ['ai-key', scope?.userId, scope?.generation],
    enabled: scope !== null,
    queryFn: () => forScreen(null, () => api('/api/me/ai-key', { schema: aiKeyResponseSchema })),
  })
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['ai-key'] }),
      queryClient.invalidateQueries({ queryKey: ['agent-usage'] }),
    ])
  const save = useMutation({
    mutationFn: (key: string) =>
      forScreen(null, () =>
        api('/api/me/ai-key', {
          method: 'PUT',
          json: { provider: 'deepseek', key },
          schema: aiKeyResponseSchema,
        }),
      ),
    onSuccess: async (answer) => {
      if (answer === null) return
      // The key leaves the page as soon as the server has it; only its last four characters come back.
      setDraft('')
      setProblem(null)
      showToast(m.settings_ai_key_saved())
      await refresh()
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'AI_KEY_INVALID')
        setProblem(
          error.details?.reason === 'insufficient_balance'
            ? m.settings_ai_key_rejected_balance()
            : m.settings_ai_key_rejected(),
        )
      else setProblem(describeError(error))
    },
  })
  const remove = useMutation({
    mutationFn: () =>
      forScreen(null, () => api('/api/me/ai-key', { method: 'DELETE', schema: okResponseSchema })),
    onSuccess: async (answer) => {
      if (answer === null) return
      showToast(m.settings_ai_key_deleted())
      await refresh()
    },
    onError: (error) => showToast(describeError(error)),
  })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (draft.trim()) save.mutate(draft.trim())
  }
  const key = current.data?.aiKey ?? null
  return (
    <Group title={m.settings_ai_key()}>
      <Box>
        <div className="row">
          <div className="row__main">
            <p className="text-subheadline text-label-secondary">{m.settings_ai_key_help()}</p>
          </div>
        </div>
        {current.isPending ? (
          <div className="row">
            <Skeleton width="50%" height={16} />
          </div>
        ) : current.isError ? (
          <div className="row">
            <Banner tone="danger">{describeError(current.error)}</Banner>
          </div>
        ) : key ? (
          <Row title={m.settings_ai_key_current({ last4: key.last4 })} help={keyState(key)}>
            <Button
              kind="tinted"
              size="sm"
              danger
              busy={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {m.settings_ai_key_delete()}
            </Button>
          </Row>
        ) : null}
        <form className="row" onSubmit={submit}>
          <div className="row__main">
            <TextField
              label={m.settings_ai_key_input()}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={draft}
              maxLength={256}
              error={problem ?? undefined}
              onChange={(event) => {
                setDraft(event.currentTarget.value)
                setProblem(null)
              }}
            />
          </div>
          <div className="row__control">
            <Button type="submit" size="sm" busy={save.isPending} disabled={!draft.trim()}>
              {m.settings_ai_key_save()}
            </Button>
          </div>
        </form>
        {key ? (
          <Row title={m.settings_ai_key_prefer_site()} help={m.settings_ai_key_prefer_site_help()}>
            <Switch
              label={m.settings_ai_key_prefer_site()}
              checked={me.settings.aiKeyPreference === 'site'}
              disabled={preference.isPending}
              onCheckedChange={(checked) =>
                preference.mutate(
                  { aiKeyPreference: checked ? 'site' : 'own' },
                  { onSuccess: () => void refresh() },
                )
              }
            />
          </Row>
        ) : null}
      </Box>
    </Group>
  )
}

type Task = { kind: 'reminder'; item: Reminder } | { kind: 'scheduled'; item: ScheduledMessage }

function statusText(status: Reminder['status'], code: string | null): string {
  switch (status) {
    case 'scheduled':
      return m.settings_tasks_status_scheduled()
    case 'sent':
      return m.settings_tasks_status_sent()
    case 'cancelled':
      return m.settings_tasks_status_cancelled()
    case 'failed':
      return m.settings_tasks_status_failed({ code: code ?? '' })
  }
}

function TaskRow({ task }: { task: Task }) {
  const queryClient = useQueryClient()
  const cancel = useMutation({
    mutationFn: () =>
      forScreen(null, async () => {
        if (task.kind === 'reminder')
          await api(`/api/reminders/${task.item.id}`, {
            method: 'DELETE',
            schema: reminderResponseSchema,
          })
        else
          await api(`/api/scheduled-messages/${task.item.id}`, {
            method: 'DELETE',
            schema: scheduledMessageResponseSchema,
          })
        return true as const
      }),
    onSuccess: async (answer) => {
      if (answer === null) return
      showToast(m.settings_tasks_cancelled_toast())
      await queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
    onError: (error) => showToast(describeError(error)),
  })
  const item = task.item
  const content = task.kind === 'reminder' ? task.item.text : task.item.body
  const when = m.agent_approval_time({
    local: item.localDateTime.replace('T', ' '),
    zone: item.timezone,
    offset: offsetText(item.offsetMinutes),
  })
  return (
    <div className="row task-row" data-status={item.status}>
      <div className="row__main">
        <div className="row__title">
          {task.kind === 'reminder' ? m.settings_tasks_reminder() : m.settings_tasks_scheduled()}
          {' · '}
          {when}
        </div>
        <div className="row__help">
          {task.kind === 'scheduled'
            ? `${m.settings_tasks_to({ target: conversationLabel(task.item.conversation) })} · `
            : ''}
          {content ?? m.settings_tasks_content_gone()}
        </div>
        <div className="row__help">
          {statusText(item.status, item.errorCode)}
          {item.origin
            ? ` · ${item.origin.current ? m.settings_tasks_device_current() : m.settings_tasks_device_other()}`
            : ''}
        </div>
      </div>
      {item.status === 'scheduled' ? (
        <div className="row__control">
          <Button
            kind="tinted"
            size="sm"
            danger
            busy={cancel.isPending}
            onClick={() => cancel.mutate()}
          >
            {m.settings_tasks_cancel()}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function TasksGroup() {
  const scope = useSyncScope()
  const enabled = scope !== null
  const reminders = useQuery({
    queryKey: ['tasks', 'reminders', scope?.userId, scope?.generation],
    enabled,
    queryFn: () => forScreen(null, () => api('/api/reminders', { schema: reminderListSchema })),
  })
  const scheduled = useQuery({
    queryKey: ['tasks', 'scheduled', scope?.userId, scope?.generation],
    enabled,
    queryFn: () =>
      forScreen(null, () => api('/api/scheduled-messages', { schema: scheduledMessageListSchema })),
  })
  const error = reminders.error ?? scheduled.error
  const tasks: Task[] = [
    ...(reminders.data?.reminders ?? []).map((item) => ({ kind: 'reminder' as const, item })),
    ...(scheduled.data?.scheduledMessages ?? []).map((item) => ({
      kind: 'scheduled' as const,
      item,
    })),
  ].sort((a, b) => b.item.createdAt.localeCompare(a.item.createdAt))
  return (
    <Group title={m.settings_tasks()}>
      <Box>
        {reminders.isPending || scheduled.isPending ? (
          <div className="row">
            <Skeleton width="60%" height={16} />
          </div>
        ) : error ? (
          <div className="row">
            <Banner tone="danger">{describeError(error)}</Banner>
          </div>
        ) : tasks.length === 0 ? (
          <div className="row">
            <p className="text-subheadline text-label-secondary">{m.settings_tasks_empty()}</p>
          </div>
        ) : (
          tasks.map((task) => <TaskRow key={task.item.id} task={task} />)
        )}
      </Box>
    </Group>
  )
}

/** Settings → Assistant (docs/01 section 4.10): usage, default mode, own key, reminders and scheduled messages. */
export function AssistantSection({ me }: { me: Me }) {
  return (
    <>
      <AgentUsage />
      <ModeGroup me={me} />
      <OwnKeyGroup me={me} />
      <TasksGroup />
      <MemoriesGroup />
    </>
  )
}
