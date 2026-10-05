/**
 * The details tab of the Inspector (docs/01 section 5): what a conversation is and what the viewer may do with it. A
 * direct message shows the other person and the viewer's own settings; a channel or a group shows its members and, by
 * role, its invitation links, settings, bans and the way out. Every section appears only when the viewer's role allows
 * it (`permissions.ts`); the server decides again when the call arrives.
 */
import type { Conversation, Me } from '@chatapp/contracts'
import { useQuery } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import { PanelRight } from 'lucide-react'
import { Avatar } from '@/components/ui/avatar.tsx'
import { Badge } from '@/components/ui/badge.tsx'
import { EmptyState } from '@/components/ui/feedback.tsx'
import { meQuery } from '@/lib/queries.ts'
import { useConversation } from '@/lib/sync/hooks.ts'
import { displayName } from '@/lib/sync/selectors.ts'
import { m } from '@/paraglide/messages.js'
import { BansSection } from './bans-section.tsx'
import { DangerZone } from './danger-zone.tsx'
import { InvitesSection } from './invites-section.tsx'
import { MembersSection } from './members-section.tsx'
import { MySettingsSection } from './my-settings-section.tsx'
import { conversationPermissions } from './permissions.ts'
import { ProfileBlock } from './profile-block.tsx'
import { SettingsSection } from './settings-section.tsx'

const kindLabel = (kind: Conversation['kind']): string =>
  kind === 'channel'
    ? m.inspector_kind_channel()
    : kind === 'group'
      ? m.inspector_kind_group()
      : m.inspector_kind_dm()

export function ConversationDetails({ conversation, me }: { conversation: Conversation; me: Me }) {
  const facts = {
    kind: conversation.kind,
    archived: conversation.archivedAt !== null,
    whoCanInvite: conversation.settings.whoCanInvite ?? 'all_members',
  } as const
  const actor = { role: conversation.me?.role ?? null, siteRole: me.role } as const
  const permissions = conversationPermissions(facts, actor)
  const name = displayName(conversation, m.conversation_unnamed())

  if (conversation.kind === 'dm') {
    return (
      <div className="details">
        <ProfileBlock conversation={conversation} />
        <MySettingsSection conversation={conversation} />
      </div>
    )
  }
  return (
    <div className="details">
      <div className="details__head">
        <Avatar
          name={name}
          seed={conversation.id}
          size={64}
          glyph={conversation.kind === 'channel' ? 'hash' : undefined}
        />
        <h1 className="details__name">{name}</h1>
        <p className="details__meta">
          {kindLabel(conversation.kind)} ·{' '}
          {m.toolbar_member_count({ count: conversation.memberCount })}
        </p>
        {facts.archived ? <Badge tone="muted">{m.inspector_archived_badge()}</Badge> : null}
        {conversation.description ? (
          <p className="details__text">{conversation.description}</p>
        ) : null}
      </div>
      <MembersSection
        conversation={conversation}
        meId={me.id}
        actor={actor}
        facts={facts}
        permissions={permissions}
      />
      {permissions.seeInvites ? (
        <InvitesSection conversation={conversation} meId={me.id} permissions={permissions} />
      ) : null}
      {permissions.member ? <MySettingsSection conversation={conversation} /> : null}
      {permissions.update ? <SettingsSection conversation={conversation} /> : null}
      {permissions.seeBans ? (
        <BansSection conversation={conversation} permissions={permissions} />
      ) : null}
      <DangerZone conversation={conversation} permissions={permissions} />
    </div>
  )
}

/** The tab: the conversation that is open, or a few words about what will be here. */
export function Details() {
  const { conversationId } = useParams({ strict: false })
  const conversation = useConversation(conversationId ?? '')
  const { data: me } = useQuery(meQuery)
  if (conversation === undefined || me === undefined || me === null) {
    return (
      <EmptyState icon={PanelRight} title={m.shell_inspector_details_title()}>
        {m.shell_inspector_details_text()}
      </EmptyState>
    )
  }
  // A different conversation is a different panel: nothing of the last one (a half-written form) carries over.
  return <ConversationDetails key={conversation.id} conversation={conversation} me={me} />
}
