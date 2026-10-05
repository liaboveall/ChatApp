/**
 * The screen of one conversation (docs/05 section 3.3 and 3.4): the toolbar content, the timeline and the composer for a
 * member; a plain message for a conversation that is not there or not mine. A private conversation I may not see looks
 * exactly like one that does not exist (docs/07, scenario 5): same words, same page title.
 */
import type { Conversation } from '@chatapp/contracts'
import { useQuery } from '@tanstack/react-query'
import { Compass, Hash } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { usePresenceOf, usePresenceWatch } from '@/app/presence.ts'
import { realtime } from '@/app/realtime.ts'
import { engine } from '@/app/sync.ts'
import { useMarkdownReady } from '@/components/markdown/lazy.ts'
import { Avatar } from '@/components/ui/avatar.tsx'
import { Button } from '@/components/ui/button.tsx'
import { EmptyState, Spinner } from '@/components/ui/feedback.tsx'
import { Composer } from '@/features/composer/composer.tsx'
import { TypingIndicator } from '@/features/composer/typing-indicator.tsx'
import { Timeline, type TimelineHandle } from '@/features/timeline/timeline.tsx'
import { describeError } from '@/lib/error-messages.ts'
import { usePageTitle } from '@/lib/page-title.ts'
import { meQuery } from '@/lib/queries.ts'
import { useToolbarContent } from '@/lib/shell-chrome.ts'
import { useConversation, useSyncReady, useTimelineWindow, useUsers } from '@/lib/sync/hooks.ts'
import { displayName } from '@/lib/sync/selectors.ts'
import { useSyncUi } from '@/lib/sync/state.ts'
import { showToast } from '@/lib/toast.ts'
import { useTime } from '@/lib/use-time.ts'
import { m } from '@/paraglide/messages.js'
import { joinConversation } from './api.ts'
import { joinErrorText } from './join-error.ts'
import { presenceText } from './presence-text.ts'

function Gone() {
  usePageTitle(m.conversation_not_found_title())
  return (
    <div className="convo-state">
      <EmptyState icon={Compass} title={m.conversation_not_found_title()}>
        {m.conversation_not_found_text()}
      </EmptyState>
    </div>
  )
}

function LoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="convo-state">
      <EmptyState icon={Compass} title={m.conversation_load_failed()}>
        <Button kind="tinted" size="sm" onClick={onRetry}>
          {m.common_retry()}
        </Button>
      </EmptyState>
    </div>
  )
}

/**
 * A conversation I can see but am not in: a channel from the discovery page (what it is, and a way in) or a group a site
 * administrator looks after (what it is, and the panel with its members). Never its messages.
 */
function NotMember({
  conversation,
  adminView,
}: {
  conversation: Conversation
  adminView: boolean
}) {
  const [busy, setBusy] = useState(false)
  const name = displayName(conversation, m.conversation_unnamed())
  const join = async (): Promise<void> => {
    setBusy(true)
    try {
      await joinConversation(conversation.id)
    } catch (error) {
      showToast(joinErrorText(error) ?? describeError(error))
      setBusy(false)
    }
  }
  return (
    <div className="convo-state">
      <Avatar
        name={name}
        seed={conversation.id}
        size={64}
        glyph={conversation.kind === 'channel' ? 'hash' : undefined}
      />
      <h1 className="text-title-1">{name}</h1>
      {conversation.description ? (
        <p className="convo-state__text">{conversation.description}</p>
      ) : null}
      <p>{m.toolbar_member_count({ count: conversation.memberCount })}</p>
      {adminView ? <p className="convo-state__text">{m.conversation_admin_view()}</p> : null}
      {conversation.kind === 'channel' && conversation.archivedAt === null ? (
        <Button kind="filled" busy={busy} icon={Hash} onClick={() => void join()}>
          {m.discovery_join()}
        </Button>
      ) : null}
    </div>
  )
}

function Loading() {
  return (
    <div className="convo-state">
      <Spinner label={m.common_loading()} />
    </div>
  )
}

export function ConversationScreen({ id, meId }: { id: string; meId: string }) {
  const ready = useSyncReady()
  const conversation = useConversation(id)
  const win = useTimelineWindow(id)
  const users = useUsers()
  const markdownReady = useMarkdownReady()
  const state = useSyncUi((s) => s.timelines[id])
  const { data: account } = useQuery(meQuery)
  const membershipId = conversation?.me?.membershipId
  const timeline = useRef<TimelineHandle>(null)

  // Open it (read what is needed, keep it current) while it is on screen; start over when the membership changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a different membership is a different timeline to open
  useEffect(() => {
    if (!ready) return
    void engine.openConversation(id)
    realtime.setFocus({ conversationId: id })
    return () => {
      engine.closeConversation(id)
      realtime.setFocus({ conversationId: null })
    }
  }, [id, ready, membershipId])

  const title = conversation
    ? displayName(conversation, m.conversation_unnamed())
    : ready
      ? m.conversation_not_found_title()
      : m.conversation_default_title()
  usePageTitle(title)

  const member = conversation?.me != null
  // A site administrator looks after any channel or group, in it or not (docs/01 section 5): the details are theirs.
  const adminView =
    !member && account?.role === 'admin' && conversation !== undefined && conversation.kind !== 'dm'
  const peerId = conversation?.kind === 'dm' ? conversation.dmPeer?.id : undefined
  usePresenceWatch(peerId === undefined ? [] : [peerId], 2)
  const presence = usePresenceOf(peerId)
  const { locale, now } = useTime()
  const peerStatus = presenceText(presence, now(), locale, {
    online: m.presence_online(),
    away: m.presence_away(),
    offline: m.presence_offline(),
    lastSeen: (when) => m.presence_last_seen({ when }),
  })
  useToolbarContent(
    conversation && (member || adminView)
      ? {
          title: displayName(conversation, m.conversation_unnamed()),
          subtitle:
            conversation.kind === 'dm'
              ? peerStatus
              : m.toolbar_member_count({ count: conversation.memberCount }),
          avatar: {
            name: displayName(conversation, m.conversation_unnamed()),
            seed: conversation.dmPeer?.id ?? conversation.id,
            glyph: conversation.kind === 'channel' ? 'hash' : undefined,
            status: presence?.status,
          },
          members: true,
        }
      : null,
  )

  if (!ready) return <Loading />
  if (conversation === undefined) {
    // Not in my list: the engine asked the server for it once. "No such conversation" and "not yours" are one answer.
    if (state === 'missing') return <Gone />
    if (state === 'error') return <LoadFailed onRetry={() => void engine.openConversation(id)} />
    return <Loading />
  }
  if (!member) return <NotMember conversation={conversation} adminView={adminView} />
  if (state === 'error' && win === undefined) {
    return <LoadFailed onRetry={() => void engine.openConversation(id)} />
  }
  if (win === undefined || !markdownReady) return <Loading />

  return (
    <ConvoFrame>
      <Timeline
        key={`${id}:${win.membershipId}`}
        conversation={conversation}
        window={win}
        users={users}
        meId={meId}
        handleRef={timeline}
      />
      <div>
        <TypingIndicator conversationId={id} />
        <Composer conversation={conversation} timeline={timeline} />
      </div>
    </ConvoFrame>
  )
}

/** The frame: the list fills it, the composer floats at the bottom, and the list learns how tall the composer is. */
function ConvoFrame({ children }: { children: React.ReactNode[] }) {
  const frame = useRef<HTMLDivElement>(null)
  const dock = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = dock.current
    const root = frame.current
    if (!element || !root) return
    const measure = (): void => root.style.setProperty('--composer-h', `${element.offsetHeight}px`)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const [list, composer] = children
  return (
    <div className="convo" ref={frame}>
      {list}
      <div className="composer-dock" ref={dock}>
        {composer}
      </div>
    </div>
  )
}
