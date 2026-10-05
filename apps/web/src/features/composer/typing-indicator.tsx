import { useEffect, useState } from 'react'
import { useUsers } from '@/lib/sync/hooks.ts'
import { nextExpiry, typersOf, useTyping } from '@/lib/sync/typing.ts'
import { m } from '@/paraglide/messages.js'

/**
 * Who is typing, above the composer and outside the list (so it never changes a row's size, docs/02 section 5). A polite
 * status that does not interrupt a screen reader: it is there to be read on request, not announced every few seconds.
 */
export function TypingIndicator({ conversationId }: { conversationId: string }) {
  const entries = useTyping((state) => state.byConversation[conversationId])
  const users = useUsers()
  const [now, setNow] = useState(() => Date.now())

  // Look again at the moment the earliest "typing" runs out, not on a timer that ticks every second.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs again whenever somebody starts or stops typing here
  useEffect(() => {
    const at = Date.now()
    setNow(at)
    const expiry = nextExpiry(useTyping.getState(), conversationId, at)
    if (expiry === null) return
    const timer = setTimeout(() => setNow(Date.now()), expiry - at + 20)
    return () => clearTimeout(timer)
  }, [conversationId, entries])

  const typers = typersOf(useTyping.getState(), conversationId, now)
  const first = typers[0]
  const name = (id: string | undefined): string => {
    const user = id === undefined ? undefined : users[id]
    return user === undefined || user.deleted ? m.user_member() : user.displayName
  }
  return (
    <div className="typing" role="status" aria-live="off" data-conversation={conversationId}>
      {first === undefined ? null : (
        <>
          <span className="typing__dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="typing__label">
            {typers.length === 1
              ? m.typing_one({ name: name(first) })
              : m.typing_many({ name: name(first), count: typers.length - 1 })}
          </span>
        </>
      )}
    </div>
  )
}
