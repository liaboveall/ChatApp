import { type UserSummary, userSearchResponseSchema } from '@chatapp/contracts'
import { useEffect, useState } from 'react'
import { forScreen } from '@/app/sync.ts'
import { api } from '@/lib/api.ts'
import { m } from '@/paraglide/messages.js'
export function MentionPicker({
  conversationId,
  membershipVersion,
  query,
  choose,
  listId,
  dismiss,
  active,
}: {
  conversationId: string
  membershipVersion: number
  query: string
  choose: (user: UserSummary) => void
  listId: string
  dismiss: () => void
  active: (id: string | undefined) => void
}) {
  const [members, setMembers] = useState<UserSummary[]>([])
  const [selected, setSelected] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: membership version invalidates candidates from the former list
  useEffect(() => {
    const controller = new AbortController()
    setMembers([])
    setSelected(0)
    void forScreen(conversationId, () =>
      api(`/api/conversations/${conversationId}/mentions?query=${encodeURIComponent(query)}`, {
        schema: userSearchResponseSchema,
        signal: controller.signal,
      }),
    )
      .then((result) => {
        if (result && !controller.signal.aborted) setMembers(result.users)
      })
      .catch(() => undefined)
    return () => controller.abort()
  }, [conversationId, membershipVersion, query])
  useEffect(() => {
    active(members[selected] ? `${listId}-${selected}` : undefined)
    return () => active(undefined)
  }, [members, selected, listId, active])
  useEffect(() => {
    if (!members.length) return
    const key = (event: KeyboardEvent) => {
      if (
        !(event.target instanceof HTMLTextAreaElement) ||
        event.isComposing ||
        event.shiftKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      )
        return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        setSelected(
          (old) => (old + (event.key === 'ArrowDown' ? 1 : -1) + members.length) % members.length,
        )
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        dismiss()
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        const user = members[selected]
        if (user) choose(user)
      }
    }
    document.addEventListener('keydown', key, true)
    return () => document.removeEventListener('keydown', key, true)
  }, [members, selected, choose, dismiss])
  if (!members.length) return null
  return (
    <div role="listbox" id={listId} className="mention-picker" aria-label={m.media_mentions()}>
      {members.map((user, index) => (
        <button
          type="button"
          key={user.id}
          role="option"
          id={`${listId}-${index}`}
          aria-selected={index === selected}
          tabIndex={-1}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => choose(user)}
        >
          <b>{user.displayName}</b> @{user.username}
        </button>
      ))}
    </div>
  )
}
