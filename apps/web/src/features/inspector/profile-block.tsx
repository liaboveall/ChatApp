/**
 * The other person of a direct message (docs/01 section 4.3): who they are, what they wrote about themselves, since when
 * they are here and whether they are around. The public profile is read once when the panel opens.
 */
import type { Conversation } from '@chatapp/contracts'
import { usePresenceOf, usePresenceWatch } from '@/app/presence.ts'
import { Avatar } from '@/components/ui/avatar.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Banner, Skeleton } from '@/components/ui/feedback.tsx'
import { describeError } from '@/lib/error-messages.ts'
import { dateTime } from '@/lib/time-format.ts'
import { useTime } from '@/lib/use-time.ts'
import { m } from '@/paraglide/messages.js'
import { getProfile } from '../conversations/api.ts'
import { presenceLabel, presenceText } from '../conversations/presence-text.ts'
import { nameOf } from './person.ts'
import { useLoaded } from './use-loaded.ts'

export function ProfileBlock({ conversation }: { conversation: Conversation }) {
  const peer = conversation.dmPeer
  const peerId = peer?.id ?? ''
  const { state, reload } = useLoaded(
    () => (peerId === '' ? Promise.reject(new Error('no peer')) : getProfile(peerId)),
    peerId,
  )
  usePresenceWatch(peerId === '' ? [] : [peerId], 3)
  const presence = usePresenceOf(peer?.id)
  const { locale, timeZone, now } = useTime()
  if (peer === null) return null

  const status = presenceText(presence, now(), locale, {
    online: m.presence_online(),
    away: m.presence_away(),
    offline: m.presence_offline(),
    lastSeen: (when) => m.presence_last_seen({ when }),
  })
  const name = nameOf(peer)
  return (
    <section className="dsec" aria-labelledby="profile-title">
      <h2 id="profile-title" className="sr-only">
        {m.inspector_profile_title()}
      </h2>
      <div className="details__head">
        <Avatar
          name={name}
          src={state.status === 'ready' ? state.value.avatarUrl : peer.avatarUrl}
          seed={peer.id}
          size={64}
          bot={peer.isBot}
          status={presence?.status}
          statusLabel={presence === undefined ? undefined : presenceLabel(presence.status)}
        />
        <p className="details__name">{name}</p>
        <p className="details__meta">@{peer.username}</p>
        {status !== null ? <p className="details__meta">{status}</p> : null}
      </div>
      {state.status === 'loading' ? (
        <Skeleton height={36} className="member__skeleton" />
      ) : state.status === 'error' ? (
        <Banner tone="danger">
          <span>{describeError(state.error)}</span>{' '}
          <Button kind="plain" size="sm" onClick={reload}>
            {m.common_retry()}
          </Button>
        </Banner>
      ) : (
        <>
          <p className="details__text">
            {state.value.bio === null ? m.inspector_profile_bio_empty() : state.value.bio}
          </p>
          <p className="dsec__note">
            {m.inspector_profile_since({ when: dateTime(state.value.createdAt, locale, timeZone) })}
          </p>
        </>
      )}
    </section>
  )
}
