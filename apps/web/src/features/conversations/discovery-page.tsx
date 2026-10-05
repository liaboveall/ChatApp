/**
 * Channel discovery (docs/01 section 4.4): every live channel by name, searchable, with its description and how many are in
 * it. Channels I am in say so; the others have a button that joins at once. Opening a channel I am not in shows its
 * description and the same button (the conversation screen), never its messages.
 */
import { useInfiniteQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Compass } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Avatar } from '@/components/ui/avatar.tsx'
import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button.tsx'
import { EmptyState, Spinner } from '@/components/ui/feedback.tsx'
import { SearchField } from '@/components/ui/fields.tsx'
import { describeError } from '@/lib/error-messages.ts'
import { usePageTitle } from '@/lib/page-title.ts'
import { useConversationIndex, useSyncScope } from '@/lib/sync/hooks.ts'
import { syncKeys } from '@/lib/sync/keys.ts'
import { showToast } from '@/lib/toast.ts'
import { m } from '@/paraglide/messages.js'
import { joinConversation, listChannels } from './api.ts'
import { joinErrorText } from './join-error.ts'

export function DiscoveryPage({
  query,
  onQueryChange,
}: {
  query: string
  onQueryChange: (query: string) => void
}) {
  usePageTitle(m.discovery_title())
  const scope = useSyncScope()
  const index = useConversationIndex()
  const navigate = useNavigate()
  const [draft, setDraft] = useState(query)
  const [joining, setJoining] = useState<string | null>(null)

  // The address follows the search 250 ms after typing stops (not while a join is taking the person to the conversation: a
  // late update of this page's address would pull them back).
  useEffect(() => {
    if (joining !== null) return
    const timer = setTimeout(() => {
      if (draft.trim() !== query) onQueryChange(draft.trim())
    }, 250)
    return () => clearTimeout(timer)
  }, [draft, query, onQueryChange, joining])

  const channels = useInfiniteQuery({
    queryKey: scope === null ? ['u', 'pending'] : syncKeys.discovery(scope, query),
    enabled: scope !== null,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => listChannels({ query, cursor: pageParam }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    // Unlike the conversation cache this is a plain list: read it again whenever the page opens.
    staleTime: 0,
    gcTime: 60_000,
    refetchOnMount: 'always',
  })
  const rows = channels.data?.pages.flatMap((page) => page.items) ?? []

  const join = async (id: string): Promise<void> => {
    setJoining(id)
    try {
      await joinConversation(id)
      await navigate({ to: '/c/$conversationId', params: { conversationId: id } })
    } catch (error) {
      showToast(joinErrorText(error) ?? describeError(error))
    } finally {
      setJoining(null)
    }
  }

  return (
    <div className="page">
      <div className="page__head">
        <h1 className="text-title-1">{m.discovery_title()}</h1>
        <SearchField
          label={m.discovery_search()}
          placeholder={m.discovery_search()}
          value={draft}
          onValueChange={setDraft}
          clearLabel={m.search_clear()}
          autoComplete="off"
        />
      </div>
      {channels.isPending ? (
        <div className="page__state">
          <Spinner label={m.common_loading()} />
        </div>
      ) : channels.isError ? (
        <EmptyState icon={Compass} title={m.discovery_failed()}>
          <Button kind="tinted" size="sm" onClick={() => void channels.refetch()}>
            {m.common_retry()}
          </Button>
        </EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Compass}
          title={query === '' ? m.discovery_none() : m.discovery_no_match()}
        />
      ) : (
        <ul className="list-rows">
          {rows.map((channel) => {
            const mine = index.byId[channel.id]?.me != null
            return (
              <li key={channel.id} className="list-row">
                <Avatar name={channel.name ?? ''} seed={channel.id} size={40} glyph="hash" />
                <div className="list-row__body">
                  <Link
                    to="/c/$conversationId"
                    params={{ conversationId: channel.id }}
                    className="list-row__title"
                  >
                    {channel.name}
                  </Link>
                  <div className="list-row__text">{channel.description ?? ''}</div>
                  <div className="list-row__meta">
                    {m.discovery_members({ count: channel.memberCount })}
                  </div>
                </div>
                {mine ? (
                  <Badge tone="muted">{m.discovery_joined()}</Badge>
                ) : (
                  <Button
                    kind="tinted"
                    size="sm"
                    busy={joining === channel.id}
                    onClick={() => void join(channel.id)}
                  >
                    {m.discovery_join()}
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {channels.hasNextPage ? (
        <div className="page__more">
          <Button
            kind="plain"
            busy={channels.isFetchingNextPage}
            onClick={() => void channels.fetchNextPage()}
          >
            {m.discovery_more()}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
