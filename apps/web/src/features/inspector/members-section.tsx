/**
 * The member list of the Inspector (docs/01 section 4.4 and 5): everyone in the conversation, the owner first, then the
 * administrators; for each person a menu with exactly the actions the viewer's role allows (`permissions.ts` mirrors the
 * server's rule, which decides again when the call arrives). The menu acts through `run`, which words the answer and
 * refreshes the list.
 */
import type { Conversation, Member } from '@chatapp/contracts'
import {
  Ban,
  Crown,
  Ellipsis,
  ShieldCheck,
  ShieldOff,
  UserMinus,
  UserPlus,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { useState } from 'react'
import { Avatar } from '@/components/ui/avatar.tsx'
import { Badge } from '@/components/ui/badge.tsx'
import { Button, IconButton } from '@/components/ui/button.tsx'
import { Banner, Skeleton } from '@/components/ui/feedback.tsx'
import { Menu, MenuItem } from '@/components/ui/menu.tsx'
import { dateTime } from '@/lib/time-format.ts'
import { showToast } from '@/lib/toast.ts'
import { useTime } from '@/lib/use-time.ts'
import { m } from '@/paraglide/messages.js'
import { patchMember } from '../conversations/api.ts'
import { AddMembersDialog } from './add-members-dialog.tsx'
import { inspectorError, isStale } from './errors.ts'
import { type MemberDialog, MemberDialogs, type Run } from './member-dialogs.tsx'
import {
  type Actor,
  anyMemberAction,
  type ConversationFacts,
  type ConversationPermissions,
  type MemberPermissions,
  memberPermissions,
} from './permissions.ts'
import { nameOf } from './person.ts'
import { useMemberList } from './use-member-list.ts'

type Props = {
  conversation: Conversation
  meId: string
  actor: Actor
  facts: ConversationFacts
  permissions: ConversationPermissions
}

function MemberMenu({
  member,
  allowed,
  onDialog,
  run,
  conversation,
}: {
  member: Member
  allowed: MemberPermissions
  onDialog: (dialog: MemberDialog) => void
  run: Run
  conversation: Conversation
}) {
  const name = nameOf(member.user)
  const silenced = member.silencedUntil !== null
  return (
    <Menu
      align="end"
      trigger={
        <IconButton
          label={m.inspector_member_actions({ name })}
          icon={Ellipsis}
          small
          tooltip={false}
        />
      }
    >
      {allowed.changeRole ? (
        member.role === 'admin' ? (
          <MenuItem
            icon={ShieldOff}
            onClick={() =>
              void run(
                () => patchMember(conversation.id, member.user.id, { role: 'member' }),
                m.inspector_toast_admin_off({ name }),
              )
            }
          >
            {m.inspector_action_remove_admin()}
          </MenuItem>
        ) : (
          <MenuItem
            icon={ShieldCheck}
            onClick={() =>
              void run(
                () => patchMember(conversation.id, member.user.id, { role: 'admin' }),
                m.inspector_toast_admin_on({ name }),
              )
            }
          >
            {m.inspector_action_make_admin()}
          </MenuItem>
        )
      ) : null}
      {allowed.silence ? (
        silenced ? (
          <MenuItem
            icon={Volume2}
            onClick={() =>
              void run(
                () => patchMember(conversation.id, member.user.id, { silencedUntil: null }),
                m.inspector_toast_unsilenced({ name }),
              )
            }
          >
            {m.inspector_action_unsilence()}
          </MenuItem>
        ) : (
          <MenuItem icon={VolumeX} onClick={() => onDialog({ kind: 'silence', member })}>
            {m.inspector_action_silence()}
          </MenuItem>
        )
      ) : null}
      {allowed.transfer ? (
        <MenuItem icon={Crown} onClick={() => onDialog({ kind: 'transfer', member })}>
          {m.inspector_action_transfer()}
        </MenuItem>
      ) : null}
      {allowed.remove ? (
        <MenuItem icon={UserMinus} danger onClick={() => onDialog({ kind: 'remove', member })}>
          {m.inspector_action_remove()}
        </MenuItem>
      ) : null}
      {allowed.ban ? (
        <MenuItem icon={Ban} danger onClick={() => onDialog({ kind: 'ban', member })}>
          {m.inspector_action_ban()}
        </MenuItem>
      ) : null}
    </Menu>
  )
}

export function MembersSection({ conversation, meId, actor, facts, permissions }: Props) {
  const { state, loadMore, reload } = useMemberList(conversation.id, conversation.membershipVersion)
  const [dialog, setDialog] = useState<MemberDialog | null>(null)
  const [adding, setAdding] = useState(false)
  const { locale, timeZone } = useTime()

  const run: Run = async (call, success) => {
    try {
      await call()
      showToast(success)
      reload()
      return true
    } catch (error) {
      showToast(inspectorError(error))
      if (isStale(error)) reload()
      return false
    }
  }

  return (
    <section className="dsec" aria-labelledby="members-title">
      <div className="dsec__head">
        <h2 id="members-title" className="dsec__title">
          {m.inspector_members_title()}
          <span className="dsec__count">{conversation.memberCount}</span>
        </h2>
        {permissions.addMembers ? (
          <Button kind="tinted" size="sm" icon={UserPlus} onClick={() => setAdding(true)}>
            {m.inspector_members_add()}
          </Button>
        ) : null}
      </div>
      {state.status === 'loading' ? (
        <div className="members" aria-busy="true">
          <Skeleton height={40} className="member__skeleton" />
          <Skeleton height={40} className="member__skeleton" />
          <Skeleton height={40} className="member__skeleton" />
        </div>
      ) : state.status === 'error' ? (
        <Banner tone="danger">
          <span>{state.message}</span>{' '}
          <Button kind="plain" size="sm" onClick={reload}>
            {m.common_retry()}
          </Button>
        </Banner>
      ) : (
        <>
          <ul className="members" aria-label={m.inspector_members_list_label()}>
            {state.list.members.map((member) => {
              const allowed = memberPermissions(
                facts,
                actor,
                { userId: member.user.id, role: member.role },
                meId,
              )
              const name = nameOf(member.user)
              return (
                <li key={member.user.id} className="member">
                  <Avatar name={name} seed={member.user.id} size={32} bot={member.user.isBot} />
                  <div className="member__body">
                    <span className="member__name">
                      <span className="member__name-text">{name}</span>
                      {member.user.id === meId ? (
                        <span className="member__you">{m.inspector_you()}</span>
                      ) : null}
                    </span>
                    <span className="member__sub">
                      @{member.user.username}
                      {member.silencedUntil !== null
                        ? ` · ${m.inspector_silenced_until({
                            when: dateTime(member.silencedUntil, locale, timeZone),
                          })}`
                        : ''}
                    </span>
                  </div>
                  {member.role === 'owner' ? (
                    <Badge tone="role">{m.inspector_role_owner()}</Badge>
                  ) : member.role === 'admin' ? (
                    <Badge tone="role">{m.inspector_role_admin()}</Badge>
                  ) : null}
                  {anyMemberAction(allowed) ? (
                    <MemberMenu
                      member={member}
                      allowed={allowed}
                      onDialog={setDialog}
                      run={run}
                      conversation={conversation}
                    />
                  ) : null}
                </li>
              )
            })}
          </ul>
          {state.list.nextCursor !== null ? (
            <Button kind="plain" size="sm" busy={state.more === 'loading'} onClick={loadMore}>
              {state.more === 'error' ? m.common_retry() : m.inspector_members_more()}
            </Button>
          ) : null}
        </>
      )}
      <AddMembersDialog
        conversation={conversation}
        open={adding}
        onOpenChange={setAdding}
        onDone={reload}
      />
      <MemberDialogs
        dialog={dialog}
        conversation={conversation}
        run={run}
        onClose={() => setDialog(null)}
      />
    </section>
  )
}
