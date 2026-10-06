/**
 * The invitation links of a group (docs/01 section 4.2). A member sees the links they made, an administrator all of them.
 * The link itself exists in plain text only in the answer that creates it (D-128): the list shows who made a link, how long
 * it lasts and how often it was used, and the dialog after creating one is the only time the link can be copied.
 */
import type { Conversation, ConversationInvite } from '@chatapp/contracts'
import { Link2, Plus } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { ConfirmDialog } from '@/components/ui/confirm-dialog.tsx'
import { Dialog } from '@/components/ui/dialog.tsx'
import { Banner, Skeleton } from '@/components/ui/feedback.tsx'
import { SelectField, TextField } from '@/components/ui/fields.tsx'
import { ApiError } from '@/lib/api.ts'
import { describeError } from '@/lib/error-messages.ts'
import { serverNow } from '@/lib/realtime.ts'
import { useUsers } from '@/lib/sync/hooks.ts'
import { dateTime } from '@/lib/time-format.ts'
import { showToast } from '@/lib/toast.ts'
import { useTime } from '@/lib/use-time.ts'
import { m } from '@/paraglide/messages.js'
import { createInvite, listInvites, revokeInvite } from '../conversations/api.ts'
import { inspectorError } from './errors.ts'
import type { ConversationPermissions } from './permissions.ts'
import { nameOf } from './person.ts'
import {
  INVITE_DAYS,
  INVITE_DEFAULT_DAYS,
  INVITE_USES,
  type InviteUses,
  inviteLink,
  inviteState,
} from './presets.ts'
import { useLoaded } from './use-loaded.ts'

const usesLabel = (uses: InviteUses): string =>
  uses === null
    ? m.inspector_invite_uses_unlimited()
    : m.inspector_invite_uses_option({ count: uses })

function CreateForm({
  conversation,
  onClose,
  onCreated,
}: {
  conversation: Conversation
  onClose: () => void
  onCreated: (code: string) => void
}) {
  const [days, setDays] = useState<number>(INVITE_DEFAULT_DAYS)
  const [uses, setUses] = useState<InviteUses>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      const created = await createInvite(conversation.id, {
        expiresInDays: days,
        maxUses: uses,
      })
      // Null: the person who asked, or the membership it was about, is not here any more (D-174); nothing follows.
      if (created === null) {
        setBusy(false)
        return
      }
      onCreated(created.code)
    } catch (error) {
      setProblem(
        error instanceof ApiError && error.code === 'QUOTA_EXCEEDED'
          ? m.inspector_invite_quota()
          : inspectorError(error),
      )
      setBusy(false)
    }
  }

  return (
    <form
      className="dialog-form"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      {problem !== null ? <Banner tone="danger">{problem}</Banner> : null}
      <SelectField
        label={m.inspector_invite_expiry()}
        value={String(days)}
        onChange={(event) => setDays(Number(event.target.value))}
      >
        {INVITE_DAYS.map((value) => (
          <option key={value} value={value}>
            {m.inspector_invite_days({ days: value })}
          </option>
        ))}
      </SelectField>
      <SelectField
        label={m.inspector_invite_max_uses()}
        value={uses === null ? 'none' : String(uses)}
        onChange={(event) =>
          setUses(event.target.value === 'none' ? null : (Number(event.target.value) as InviteUses))
        }
      >
        {INVITE_USES.map((value) => (
          <option key={value ?? 'none'} value={value === null ? 'none' : String(value)}>
            {usesLabel(value)}
          </option>
        ))}
      </SelectField>
      <div className="dialog__actions">
        <Button kind="plain" onClick={onClose}>
          {m.common_cancel()}
        </Button>
        <Button type="submit" kind="filled" busy={busy}>
          {m.inspector_invite_create_action()}
        </Button>
      </div>
    </form>
  )
}

function Ready({ link, onClose }: { link: string; onClose: () => void }) {
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(link)
      showToast(m.common_copied())
    } catch {
      showToast(m.common_copy_failed())
    }
  }
  return (
    <div className="dialog-form">
      <TextField
        label={m.inspector_invite_link_label()}
        value={link}
        readOnly
        onFocus={(event) => event.currentTarget.select()}
        autoComplete="off"
      />
      <div className="dialog__actions">
        <Button kind="tinted" icon={Link2} onClick={() => void copy()}>
          {m.inspector_invite_copy()}
        </Button>
        <Button kind="filled" onClick={onClose}>
          {m.common_done()}
        </Button>
      </div>
    </div>
  )
}

export function InvitesSection({
  conversation,
  meId,
  permissions,
}: {
  conversation: Conversation
  meId: string
  permissions: ConversationPermissions
}) {
  const { state, reload } = useLoaded(
    () => listInvites(conversation.id),
    conversation.membershipVersion,
  )
  const users = useUsers()
  const { locale, timeZone } = useTime()
  const [creating, setCreating] = useState(false)
  const [link, setLink] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<ConversationInvite | null>(null)

  const now = serverNow()
  const active =
    state.status === 'ready'
      ? state.value.filter((invite) => inviteState(invite, now) === 'active')
      : []

  const revoke = async (invite: ConversationInvite): Promise<void> => {
    try {
      if ((await revokeInvite(conversation.id, invite.id)) === null) return
      showToast(m.inspector_invite_revoked())
      reload()
    } catch (error) {
      showToast(inspectorError(error))
    }
  }

  return (
    <section className="dsec" aria-labelledby="invites-title">
      <div className="dsec__head">
        <h2 id="invites-title" className="dsec__title">
          {m.inspector_invites_title()}
        </h2>
        {permissions.createInvite ? (
          <Button kind="tinted" size="sm" icon={Plus} onClick={() => setCreating(true)}>
            {m.inspector_invites_create()}
          </Button>
        ) : null}
      </div>
      <p className="dsec__note">{m.inspector_invites_hint()}</p>
      {state.status === 'loading' ? (
        <Skeleton height={40} className="member__skeleton" />
      ) : state.status === 'error' ? (
        <Banner tone="danger">
          <span>{describeError(state.error)}</span>{' '}
          <Button kind="plain" size="sm" onClick={reload}>
            {m.common_retry()}
          </Button>
        </Banner>
      ) : active.length === 0 ? (
        <p className="dsec__note">{m.inspector_invites_empty()}</p>
      ) : (
        <ul className="invites">
          {active.map((invite) => {
            const creator = users[invite.createdBy]
            const mine = invite.createdBy === meId
            const who = mine
              ? m.inspector_invite_by_me()
              : m.inspector_invite_by({
                  name: creator === undefined ? m.user_member() : nameOf(creator),
                })
            const used =
              invite.maxUses === null
                ? m.inspector_invite_used_unlimited({ count: invite.useCount })
                : m.inspector_invite_used_limited({ count: invite.useCount, max: invite.maxUses })
            return (
              <li key={invite.id} className="invite">
                <div className="invite__body">
                  <span className="invite__title">{who}</span>
                  <span className="invite__sub">
                    {m.inspector_invite_until({
                      when: dateTime(invite.expiresAt, locale, timeZone),
                    })}
                  </span>
                  <span className="invite__sub">{used}</span>
                </div>
                {mine || permissions.revokeAnyInvite ? (
                  <Button kind="plain" size="sm" danger onClick={() => setRevoking(invite)}>
                    {m.inspector_invite_revoke()}
                  </Button>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      <Dialog
        open={creating}
        onOpenChange={setCreating}
        title={m.inspector_invite_create_title()}
        className="dialog--form"
      >
        {creating ? (
          <CreateForm
            conversation={conversation}
            onClose={() => setCreating(false)}
            onCreated={(code) => {
              setCreating(false)
              setLink(inviteLink(window.location.origin, code))
              reload()
            }}
          />
        ) : null}
      </Dialog>
      <Dialog
        open={link !== null}
        onOpenChange={(open) => !open && setLink(null)}
        title={m.inspector_invite_ready_title()}
        description={m.inspector_invite_ready_text()}
        className="dialog--form"
      >
        {link !== null ? <Ready link={link} onClose={() => setLink(null)} /> : null}
      </Dialog>
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={m.inspector_invite_revoke_title()}
        description={m.inspector_invite_revoke_text()}
        confirmLabel={m.inspector_invite_revoke()}
        danger
        onConfirm={() => {
          if (revoking !== null) void revoke(revoking)
        }}
      />
    </section>
  )
}
