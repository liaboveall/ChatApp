/**
 * The people banned from a channel or a group (docs/01 section 4.4), for the people who may lift a ban. A ban is refused at
 * every way back in (discovery, links, being added), so this list is where it ends.
 */
import type { Ban, Conversation } from '@chatapp/contracts'
import { Avatar } from '@/components/ui/avatar.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Banner, Skeleton } from '@/components/ui/feedback.tsx'
import { describeError } from '@/lib/error-messages.ts'
import { useUsers } from '@/lib/sync/hooks.ts'
import { dateTime } from '@/lib/time-format.ts'
import { showToast } from '@/lib/toast.ts'
import { useTime } from '@/lib/use-time.ts'
import { m } from '@/paraglide/messages.js'
import { liftBan, listBans } from '../conversations/api.ts'
import { inspectorError } from './errors.ts'
import type { ConversationPermissions } from './permissions.ts'
import { nameOf } from './person.ts'
import { useLoaded } from './use-loaded.ts'

export function BansSection({
  conversation,
  permissions,
}: {
  conversation: Conversation
  permissions: ConversationPermissions
}) {
  // A ban changes the membership version, so the list reads again whenever that moves.
  const { state, reload } = useLoaded(
    () => listBans(conversation.id),
    conversation.membershipVersion,
  )
  const users = useUsers()
  const { locale, timeZone } = useTime()

  const lift = async (ban: Ban): Promise<void> => {
    try {
      // Null: the person who asked is not here any more (D-174); the name of the person is not for them.
      if ((await liftBan(conversation.id, ban.user.id)) === null) return
      showToast(m.inspector_unban_done({ name: nameOf(ban.user) }))
      reload()
    } catch (error) {
      showToast(inspectorError(error))
    }
  }

  return (
    <section className="dsec" aria-labelledby="bans-title">
      <h2 id="bans-title" className="dsec__title">
        {m.inspector_bans_title()}
      </h2>
      {state.status === 'loading' ? (
        <Skeleton height={40} className="member__skeleton" />
      ) : state.status === 'error' ? (
        <Banner tone="danger">
          <span>{describeError(state.error)}</span>{' '}
          <Button kind="plain" size="sm" onClick={reload}>
            {m.common_retry()}
          </Button>
        </Banner>
      ) : state.value.length === 0 ? (
        <p className="dsec__note">{m.inspector_bans_empty()}</p>
      ) : (
        <ul className="members">
          {state.value.map((ban) => {
            const by = ban.bannedBy === null ? undefined : users[ban.bannedBy]
            const when = dateTime(ban.createdAt, locale, timeZone)
            return (
              <li key={ban.user.id} className="member">
                <Avatar
                  src={ban.user.avatarUrl}
                  name={nameOf(ban.user)}
                  seed={ban.user.id}
                  size={32}
                  bot={ban.user.isBot}
                />
                <div className="member__body">
                  <span className="member__name">
                    <span className="member__name-text">{nameOf(ban.user)}</span>
                  </span>
                  <span className="member__sub">
                    {by === undefined ? when : m.inspector_ban_meta({ when, name: nameOf(by) })}
                  </span>
                  {ban.reason !== null ? (
                    <span className="member__sub">
                      {m.inspector_ban_reason_line({ reason: ban.reason })}
                    </span>
                  ) : null}
                </div>
                {permissions.unban ? (
                  <Button kind="plain" size="sm" onClick={() => void lift(ban)}>
                    {m.inspector_unban()}
                  </Button>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
