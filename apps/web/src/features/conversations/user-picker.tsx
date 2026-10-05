/**
 * Choosing people (docs/05 section 3.2): a search field and the matches under it; the ones chosen so far are chips above.
 * The search waits 250 ms after typing stops and ignores answers that arrive for an older query. Used to start a direct
 * message (one person), to start a group and to add members (several).
 */
import type { UserSummary } from '@chatapp/contracts'
import { LIMITS } from '@chatapp/contracts'
import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Avatar } from '@/components/ui/avatar.tsx'
import { SearchField } from '@/components/ui/fields.tsx'
import { Icon } from '@/components/ui/icon.tsx'
import { describeError } from '@/lib/error-messages.ts'
import { m } from '@/paraglide/messages.js'
import { searchUsers } from './api.ts'

type UserPickerProps = {
  selected: UserSummary[]
  onChange: (selected: UserSummary[]) => void
  /** One person (a new person replaces the old) or several. */
  multiple: boolean
  /** People who must not be offered (me, the people already in the conversation). */
  exclude?: readonly string[]
  max?: number
  label: string
}

export function UserPicker({
  selected,
  onChange,
  multiple,
  exclude = [],
  max,
  label,
}: UserPickerProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<UserSummary[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const trimmed = query.trim()

  useEffect(() => {
    if (trimmed === '') {
      setResults(null)
      setFailure(null)
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      searchUsers(trimmed.slice(0, LIMITS.userSearchQueryMaxLength), controller.signal)
        .then((users) => {
          setResults(users)
          setFailure(null)
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return
          setFailure(describeError(error))
        })
    }, 250)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [trimmed])

  const chosen = new Set(selected.map((user) => user.id))
  const toggle = (user: UserSummary): void => {
    if (chosen.has(user.id)) {
      onChange(selected.filter((other) => other.id !== user.id))
    } else if (multiple) {
      if (max === undefined || selected.length < max) onChange([...selected, user])
    } else {
      onChange([user])
    }
  }
  const visible = (results ?? []).filter((user) => !exclude.includes(user.id) && !user.deleted)

  return (
    <div className="picker">
      {selected.length > 0 ? (
        <ul className="picker__chips" aria-label={m.picker_selected()}>
          {selected.map((user) => (
            <li key={user.id} className="chip">
              <span>{user.displayName}</span>
              <button
                type="button"
                className="chip__remove"
                aria-label={m.picker_remove({ name: user.displayName })}
                onClick={() => toggle(user)}
              >
                <Icon icon={X} size={16} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <SearchField
        label={label}
        placeholder={label}
        value={query}
        onValueChange={setQuery}
        clearLabel={m.search_clear()}
        autoComplete="off"
      />
      <div className="picker__results" aria-live="polite">
        {failure !== null ? (
          <p className="picker__note">{failure}</p>
        ) : results === null ? null : visible.length === 0 ? (
          <p className="picker__note">{m.picker_no_results()}</p>
        ) : (
          <ul>
            {visible.map((user) => (
              <li key={user.id}>
                <button
                  type="button"
                  className="person"
                  aria-pressed={chosen.has(user.id)}
                  onClick={() => toggle(user)}
                >
                  <Avatar name={user.displayName} seed={user.id} size={32} bot={user.isBot} />
                  <span>
                    <span className="person__name">{user.displayName}</span>
                    <span className="person__sub">@{user.username}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
