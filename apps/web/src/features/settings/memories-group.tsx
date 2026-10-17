import {
  type AgentMemory,
  deletionOperationSchema,
  memoryListSchema,
  memoryResponseSchema,
} from '@chatapp/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useRef, useState } from 'react'
import { engine, forScreen } from '@/app/sync.ts'
import { Button } from '@/components/ui/button.tsx'
import { Switch } from '@/components/ui/controls.tsx'
import { Banner, Skeleton } from '@/components/ui/feedback.tsx'
import { api } from '@/lib/api.ts'
import { describeError } from '@/lib/error-messages.ts'
import { useSyncScope } from '@/lib/sync/hooks.ts'
import { showToast } from '@/lib/toast.ts'
import { m } from '@/paraglide/messages.js'
import { waitForDeletion } from '../deletions/wait.ts'
import { Box, Group, Row } from './settings-ui.tsx'

export function MemoriesGroup() {
  const scope = useSyncScope(),
    client = useQueryClient()
  const [draft, setDraft] = useState(''),
    [allowSite, setAllowSite] = useState(false)
  const revision = useRef(0)
  const current = useQuery({
    queryKey: ['memories', scope?.userId, scope?.generation],
    enabled: scope !== null,
    queryFn: () => forScreen(null, () => api('/api/me/memories', { schema: memoryListSchema })),
  })
  const refresh = () => client.invalidateQueries({ queryKey: ['memories'] })
  const add = useMutation({
    mutationFn: (input: { content: string; allowSite: boolean; revision: number }) =>
      forScreen(null, () =>
        api('/api/me/memories', {
          method: 'POST',
          json: { content: input.content, allowSite: input.allowSite },
          schema: memoryResponseSchema,
        }),
      ),
    onSuccess: async (answer, input) => {
      if (answer === null) return
      if (revision.current === input.revision) {
        setDraft('')
        setAllowSite(false)
        revision.current += 1
      }
      await refresh()
      showToast(m.settings_memory_saved())
    },
    onError: (error) => showToast(describeError(error)),
  })
  const change = useMutation({
    mutationFn: ({
      memory,
      remove,
      share,
    }: {
      memory: AgentMemory
      remove?: boolean
      share?: boolean
    }) =>
      forScreen(null, async () => {
        const ticket = engine.ticket(null)
        const result = await api(`/api/me/memories/${memory.id}`, {
          method: remove ? 'DELETE' : 'PATCH',
          ...(remove
            ? {}
            : { json: { allowSite: share, expectedContentVersion: memory.contentVersion } }),
          schema: memoryResponseSchema.or(deletionOperationSchema),
        })
        if ('operationId' in result) return (await waitForDeletion(result, ticket)) ? true : null
        return result
      }),
    onSuccess: async (answer) => {
      if (answer !== null) await refresh()
    },
    onError: (error) => showToast(describeError(error)),
  })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!add.isPending && draft.trim())
      add.mutate({ content: draft.trim(), allowSite, revision: revision.current })
  }
  return (
    <Group title={m.settings_memories()}>
      <Box>
        <div className="row">
          <p className="text-subheadline text-label-secondary">{m.settings_memories_help()}</p>
        </div>
        {current.isPending ? (
          <div className="row">
            <Skeleton width="60%" height={16} />
          </div>
        ) : current.error ? (
          <div className="row">
            <Banner tone="danger">{describeError(current.error)}</Banner>
          </div>
        ) : current.data?.memories.length ? (
          current.data.memories.map((memory) => (
            <Row
              key={memory.id}
              title={memory.content ?? ''}
              help={
                memory.privacyClass === 'standard'
                  ? m.settings_memory_site()
                  : m.settings_memory_private()
              }
            >
              <Switch
                label={m.settings_memory_allow_site()}
                checked={memory.privacyClass === 'standard'}
                disabled={
                  change.isPending ||
                  (memory.source === 'agent' && memory.privacyClass === 'byok_private')
                }
                onCheckedChange={(share) => change.mutate({ memory, share })}
              />
              <Button
                kind="plain"
                size="sm"
                busy={change.isPending}
                onClick={() => change.mutate({ memory, remove: true })}
              >
                {m.settings_memory_delete()}
              </Button>
            </Row>
          ))
        ) : (
          <div className="row">
            <p>{m.settings_memories_empty()}</p>
          </div>
        )}
        <form className="settings-memory-form" onSubmit={submit}>
          <label>
            <span>{m.settings_memory_content()}</span>
            <textarea
              value={draft}
              maxLength={1000}
              rows={3}
              onChange={(event) => {
                revision.current += 1
                setDraft(event.target.value)
              }}
              aria-describedby="memory-content-help"
            />
          </label>
          <small id="memory-content-help">{m.settings_memory_limit()}</small>
          <Row title={m.settings_memory_allow_site()}>
            <Switch
              label={m.settings_memory_allow_site()}
              checked={allowSite}
              onCheckedChange={(value) => {
                revision.current += 1
                setAllowSite(value)
              }}
            />
          </Row>
          <Button
            type="submit"
            size="sm"
            busy={add.isPending}
            disabled={!draft.trim() || [...draft].length > 500}
          >
            {m.settings_memory_add()}
          </Button>
        </form>
      </Box>
    </Group>
  )
}
