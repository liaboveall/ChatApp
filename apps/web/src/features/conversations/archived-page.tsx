/**
 * Archived conversations I own (docs/01 section 4.4): read-only, gone from everyone's sidebar, and mine to bring back.
 * When another live channel has taken the name in the meantime, restoring asks for a new name first.
 */
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Archive } from 'lucide-react'
import { useState } from 'react'
import { Avatar } from '@/components/ui/avatar.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Dialog } from '@/components/ui/dialog.tsx'
import { EmptyState, Spinner } from '@/components/ui/feedback.tsx'
import { TextField } from '@/components/ui/fields.tsx'
import { ApiError } from '@/lib/api.ts'
import { describeError } from '@/lib/error-messages.ts'
import { usePageTitle } from '@/lib/page-title.ts'
import { useSyncScope } from '@/lib/sync/hooks.ts'
import { syncKeys } from '@/lib/sync/keys.ts'
import { showToast } from '@/lib/toast.ts'
import { m } from '@/paraglide/messages.js'
import { listArchived, restoreConversation } from './api.ts'

export function ArchivedPage() {
  usePageTitle(m.archived_title())
  const scope = useSyncScope()
  const navigate = useNavigate()
  const archived = useQuery({
    queryKey: scope === null ? ['u', 'pending'] : syncKeys.archived(scope),
    enabled: scope !== null,
    queryFn: listArchived,
    staleTime: 0,
    gcTime: 60_000,
    refetchOnMount: 'always',
  })
  const [busy, setBusy] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [newName, setNewName] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)

  const restore = async (id: string, name?: string): Promise<void> => {
    setBusy(id)
    setNameError(null)
    try {
      await restoreConversation(id, name === undefined ? {} : { name })
      setRenaming(null)
      await navigate({ to: '/c/$conversationId', params: { conversationId: id } })
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.status === 409 || error.status === 422) &&
        error.field === 'name'
      ) {
        // Another live channel has the name: ask for a new one.
        const target = archived.data?.find((conversation) => conversation.id === id)
        setRenaming({ id, name: target?.name ?? '' })
        setNewName(name ?? target?.name ?? '')
        setNameError(name === undefined ? null : m.new_conversation_name_taken())
      } else if (error instanceof ApiError && error.status === 409) {
        const target = archived.data?.find((conversation) => conversation.id === id)
        setRenaming({ id, name: target?.name ?? '' })
        setNewName(target?.name ?? '')
        setNameError(name === undefined ? null : m.new_conversation_name_taken())
      } else {
        showToast(describeError(error))
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="page">
      <div className="page__head">
        <h1 className="text-title-1">{m.archived_title()}</h1>
        <p className="page__lead">{m.archived_lead()}</p>
      </div>
      {archived.isPending ? (
        <div className="page__state">
          <Spinner label={m.common_loading()} />
        </div>
      ) : archived.isError ? (
        <EmptyState icon={Archive} title={m.archived_failed()}>
          <Button kind="tinted" size="sm" onClick={() => void archived.refetch()}>
            {m.common_retry()}
          </Button>
        </EmptyState>
      ) : archived.data.length === 0 ? (
        <EmptyState icon={Archive} title={m.archived_none()} />
      ) : (
        <ul className="list-rows">
          {archived.data.map((conversation) => (
            <li key={conversation.id} className="list-row">
              <Avatar
                name={conversation.name ?? ''}
                seed={conversation.id}
                size={40}
                glyph={conversation.kind === 'channel' ? 'hash' : undefined}
              />
              <div className="list-row__body">
                <div className="list-row__title">{conversation.name}</div>
                <div className="list-row__text">{conversation.description ?? ''}</div>
              </div>
              <Button
                kind="tinted"
                size="sm"
                busy={busy === conversation.id}
                onClick={() => void restore(conversation.id)}
              >
                {m.archived_restore()}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={renaming !== null}
        onOpenChange={(open) => !open && setRenaming(null)}
        title={m.archived_rename_title()}
        description={m.archived_rename_text()}
        className="dialog--form"
      >
        <form
          className="dialog-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (renaming !== null && newName.trim() !== '')
              void restore(renaming.id, newName.trim())
          }}
        >
          <TextField
            label={m.new_conversation_name()}
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            error={nameError}
            autoComplete="off"
          />
          <div className="dialog__actions">
            <Button
              type="submit"
              kind="filled"
              busy={busy !== null}
              disabled={newName.trim() === ''}
            >
              {m.archived_restore()}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  )
}
