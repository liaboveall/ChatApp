/**
 * A person's card (docs/02 section 5): opened from their picture beside a message. Who they are, whether they are
 * around, what they wrote about themselves, and the way to write to them directly. The public profile is read when the
 * card opens; the card is a panel of glass anchored to the picture, closed by Escape or a press outside it.
 */
import { Popover as BasePopover } from '@base-ui/react/popover'
import type { UserSummary } from '@chatapp/contracts'
import { useNavigate } from '@tanstack/react-router'
import { MessageCircle } from 'lucide-react'
import { useRef, useState } from 'react'
import { usePresenceOf, usePresenceWatch } from '@/app/presence.ts'
import { Avatar } from '@/components/ui/avatar.tsx'
import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Skeleton } from '@/components/ui/feedback.tsx'
import { describeError } from '@/lib/error-messages.ts'
import { showToast } from '@/lib/toast.ts'
import { useTime } from '@/lib/use-time.ts'
import { m } from '@/paraglide/messages.js'
import { getProfile, openDm } from '../conversations/api.ts'
import { presenceLabel, presenceText } from '../conversations/presence-text.ts'
import { useLoaded } from '../inspector/use-loaded.ts'

export type ProfileTarget = { user: UserSummary; anchor: Element }

function Body({ user, meId, onClose }: { user: UserSummary; meId: string; onClose: () => void }) {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const { state } = useLoaded(() => getProfile(user.id), user.id)
  usePresenceWatch(user.isBot ? [] : [user.id], 3)
  const presence = usePresenceOf(user.isBot ? null : user.id)
  const { locale, now } = useTime()
  const status = presenceText(presence, now(), locale, {
    online: m.presence_online(),
    away: m.presence_away(),
    offline: m.presence_offline(),
    lastSeen: (when) => m.presence_last_seen({ when }),
  })
  const profile = state.status === 'ready' ? state.value : undefined
  const write = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      // Null: the person who asked is not here any more (D-174); nothing follows.
      const conversation = await openDm(user.id)
      if (conversation === null) return
      onClose()
      void navigate({ to: '/c/$conversationId', params: { conversationId: conversation.id } })
    } catch (error) {
      showToast(describeError(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Avatar
        name={user.displayName}
        src={profile?.avatarUrl ?? user.avatarUrl}
        seed={user.id}
        size={64}
        bot={user.isBot}
        status={presence?.status}
        statusLabel={presence === undefined ? undefined : presenceLabel(presence.status)}
      />
      <p className="profile-card__name">
        {user.displayName}
        {user.id === meId ? <span className="member__you">{m.inspector_you()}</span> : null}
      </p>
      <p className="details__meta">@{user.username}</p>
      {user.isBot ? <Badge tone="role">{m.user_bot()}</Badge> : null}
      {status !== null ? <p className="details__meta">{status}</p> : null}
      {state.status === 'loading' ? (
        <Skeleton width="70%" height={14} className="profile-card__wait" />
      ) : profile?.bio ? (
        <p className="details__text">{profile.bio}</p>
      ) : null}
      {user.id !== meId && !user.isBot ? (
        <Button
          kind="tinted"
          block
          icon={MessageCircle}
          busy={busy}
          className="profile-card__action"
          onClick={() => void write()}
        >
          {m.profile_message()}
        </Button>
      ) : null}
    </>
  )
}

export function ProfileCard({
  target,
  meId,
  onClose,
}: {
  target: ProfileTarget | null
  meId: string
  onClose: () => void
}) {
  const popup = useRef<HTMLDivElement>(null)
  return (
    <BasePopover.Root open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <BasePopover.Portal>
        <BasePopover.Positioner
          anchor={target?.anchor ?? null}
          side="right"
          align="end"
          sideOffset={10}
          collisionPadding={12}
          className="positioner"
        >
          <BasePopover.Popup
            ref={popup}
            initialFocus={popup}
            aria-label={m.inspector_profile_title()}
            className="panel profile-card glass-text"
          >
            {target ? (
              <Body key={target.user.id} user={target.user} meId={meId} onClose={onClose} />
            ) : null}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  )
}
