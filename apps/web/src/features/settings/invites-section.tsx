import {
  createdInviteSchema,
  formatInviteCode,
  type Invite,
  type InviteRegistration,
  type Me,
} from '@chatapp/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Ticket } from 'lucide-react'
import { useId, useState } from 'react'
import { forScreen } from '@/app/sync.ts'
import { Button } from '@/components/ui/button.tsx'
import { SegmentedControl } from '@/components/ui/controls.tsx'
import { Dialog } from '@/components/ui/dialog.tsx'
import { Banner, Skeleton } from '@/components/ui/feedback.tsx'
import { TextField } from '@/components/ui/fields.tsx'
import { api } from '@/lib/api.ts'
import { describeError } from '@/lib/error-messages.ts'
import { invitesQuery, queryKeys } from '@/lib/queries.ts'
import { showToast } from '@/lib/toast.ts'
import { m } from '@/paraglide/messages.js'
import { Box, Group, Row } from './settings-ui.tsx'

const date = (value: string): string =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value))

type InviteStatus = 'active' | 'revoked' | 'expired' | 'used'

export function inviteStatus(invite: Invite, now = Date.now()): InviteStatus {
  if (invite.revokedAt) return 'revoked'
  if (Date.parse(invite.expiresAt) <= now) return 'expired'
  if (invite.maxUses !== null && invite.useCount >= invite.maxUses) return 'used'
  return 'active'
}

const STATUS_TEXT: Record<InviteStatus, () => string> = {
  active: () => m.invites_status_active(),
  revoked: () => m.invites_status_revoked(),
  expired: () => m.invites_status_expired(),
  used: () => m.invites_status_used(),
}

function registrationLink(code: string): string {
  return `${window.location.origin}/register#invite=${code.replaceAll('-', '')}`
}

function QuotaMeter({ me }: { me: Me }) {
  if (me.role === 'admin') {
    return <p className="text-callout">{m.invites_quota_admin()}</p>
  }
  const total = Math.max(me.inviteQuota, 1)
  return (
    <div className="meter">
      <div className="meter__row">
        <span>
          {m.invites_quota_used()} <b>{`${me.invitesUsed} / ${me.inviteQuota}`}</b>
        </span>
        <span>{m.invites_quota_left({ count: Math.max(0, me.inviteQuota - me.invitesUsed) })}</span>
      </div>
      <div
        className="meter__bar"
        role="progressbar"
        aria-label={m.invites_quota_label()}
        aria-valuenow={me.invitesUsed}
        aria-valuemin={0}
        aria-valuemax={me.inviteQuota}
      >
        <i
          style={
            { '--v': `${Math.min(100, (me.invitesUsed / total) * 100)}%` } as React.CSSProperties
          }
        />
      </div>
    </div>
  )
}

function CreateInvite() {
  const queryClient = useQueryClient()
  const [days, setDays] = useState('7')
  const [uses, setUses] = useState('1')
  const [note, setNote] = useState('')
  const [created, setCreated] = useState<string | null>(null)
  const linkId = useId()
  const create = useMutation({
    mutationFn: () =>
      forScreen(null, () =>
        api('/api/invites', {
          json: {
            expiresInDays: Number(days),
            maxUses: Number(uses),
            ...(note.trim() ? { note: note.trim() } : {}),
          },
          schema: createdInviteSchema,
        }),
      ),
    onSuccess: async (invite) => {
      // Null: the person who asked is not here any more (D-174); the code is not for whoever is.
      if (invite === null) return
      setCreated(invite.code)
      setNote('')
      await queryClient.invalidateQueries({ queryKey: queryKeys.invites })
    },
    onError: (error) => showToast(describeError(error)),
  })
  const link = created ? registrationLink(created) : ''
  return (
    <Group title={m.invites_create()}>
      <Box>
        <Row title={m.invites_expiry()} help={m.invites_expiry_help()}>
          <SegmentedControl
            label={m.invites_expiry()}
            value={days}
            onValueChange={setDays}
            items={[
              { value: '1', label: m.invites_days({ count: 1 }) },
              { value: '7', label: m.invites_days({ count: 7 }) },
              { value: '30', label: m.invites_days({ count: 30 }) },
            ]}
          />
        </Row>
        <Row title={m.invites_uses()} help={m.invites_uses_help()}>
          <SegmentedControl
            label={m.invites_uses()}
            value={uses}
            onValueChange={setUses}
            items={[
              { value: '1', label: m.invites_times({ count: 1 }) },
              { value: '3', label: m.invites_times({ count: 3 }) },
              { value: '5', label: m.invites_times({ count: 5 }) },
            ]}
          />
        </Row>
        <div className="row">
          <div className="row__main">
            <TextField
              label={m.invites_note()}
              hint={m.invites_note_help()}
              maxLength={100}
              value={note}
              onChange={(event) => setNote(event.currentTarget.value)}
            />
          </div>
          <div className="row__control self-end">
            <Button icon={Ticket} busy={create.isPending} onClick={() => create.mutate()}>
              {m.invites_create_action()}
            </Button>
          </div>
        </div>
      </Box>
      <Dialog
        open={created !== null}
        onOpenChange={(open) => !open && setCreated(null)}
        title={m.invites_created_title()}
        actions={<Button onClick={() => setCreated(null)}>{m.common_done()}</Button>}
      >
        <Banner tone="warning">{m.invites_created_once()}</Banner>
        <TextField
          id={linkId}
          label={m.invites_created_link()}
          hint={m.invites_created_link_help()}
          readOnly
          value={link}
          onFocus={(event) => event.currentTarget.select()}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
        />
        <div className="flex items-center gap-2">
          <Button
            kind="tinted"
            icon={Copy}
            onClick={() => {
              void navigator.clipboard
                .writeText(link)
                .then(() => showToast(m.common_copied()))
                .catch(() => showToast(m.common_copy_failed()))
            }}
          >
            {m.common_copy()}
          </Button>
          {created ? (
            <code className="text-subheadline">
              {formatInviteCode(created.replaceAll('-', ''))}
            </code>
          ) : null}
        </div>
        <p className="text-subheadline text-label-secondary">{m.invites_created_note()}</p>
      </Dialog>
    </Group>
  )
}

function InviteRow({ invite }: { invite: Invite }) {
  const queryClient = useQueryClient()
  const status = inviteStatus(invite)
  const revoke = useMutation({
    mutationFn: () =>
      forScreen(null, async () => {
        await api(`/api/invites/${invite.id}`, { method: 'DELETE' })
        return true as const
      }),
    onSuccess: async (answer) => {
      if (answer === null) return
      showToast(m.invites_revoked_toast())
      await queryClient.invalidateQueries({ queryKey: queryKeys.invites })
    },
    onError: (error) => showToast(describeError(error)),
  })
  const used =
    invite.maxUses === null ? `${invite.useCount}` : `${invite.useCount} / ${invite.maxUses}`
  return (
    <Row
      title={invite.note?.trim() || m.invites_row_title({ date: date(invite.createdAt) })}
      help={`${STATUS_TEXT[status]()} · ${m.invites_row_expires({ date: date(invite.expiresAt) })} · ${m.invites_row_used({ used })}`}
    >
      {status === 'active' ? (
        <Button
          kind="tinted"
          size="sm"
          danger
          busy={revoke.isPending}
          onClick={() => revoke.mutate()}
        >
          {m.invites_revoke()}
        </Button>
      ) : null}
    </Row>
  )
}

function RegistrationRow({ registration }: { registration: InviteRegistration }) {
  const queryClient = useQueryClient()
  const [asking, setAsking] = useState(false)
  const name = registration.username
    ? `@${registration.username}`
    : m.invites_registration_unnamed()
  const revoke = useMutation({
    mutationFn: () =>
      forScreen(null, async () => {
        await api(`/api/invites/registrations/${registration.id}`, { method: 'DELETE' })
        return true as const
      }),
    onSuccess: async (answer) => {
      if (answer === null) return
      setAsking(false)
      showToast(m.invites_registration_revoked())
      await queryClient.invalidateQueries({ queryKey: queryKeys.invites })
      await queryClient.invalidateQueries({ queryKey: queryKeys.me })
    },
    onError: (error) => {
      setAsking(false)
      showToast(describeError(error))
    },
  })
  return (
    <Row title={name} help={m.invites_registration_help({ date: date(registration.createdAt) })}>
      <Button kind="tinted" size="sm" danger onClick={() => setAsking(true)}>
        {m.invites_registration_revoke()}
      </Button>
      <Dialog
        open={asking}
        onOpenChange={setAsking}
        title={m.invites_registration_revoke_title({ name })}
        description={m.invites_registration_revoke_text()}
        actions={
          <>
            <Button kind="plain" onClick={() => setAsking(false)}>
              {m.common_cancel()}
            </Button>
            <Button danger busy={revoke.isPending} onClick={() => revoke.mutate()}>
              {m.invites_registration_revoke()}
            </Button>
          </>
        }
      />
    </Row>
  )
}

export function InvitesSection({ me }: { me: Me }) {
  const invites = useQuery(invitesQuery)
  return (
    <>
      <Group title={m.invites_quota()}>
        <div className="group__box p-3.5">
          <QuotaMeter me={me} />
        </div>
      </Group>
      <CreateInvite />
      <Group title={m.invites_mine()}>
        <Box>
          {invites.isPending ? (
            <div className="py-3">
              <Skeleton width="55%" height={16} />
            </div>
          ) : invites.isError ? (
            <div className="py-3">
              <Banner tone="danger">{describeError(invites.error)}</Banner>
            </div>
          ) : invites.data.invites.length === 0 ? (
            <div className="py-3 text-callout text-label-secondary">{m.invites_none()}</div>
          ) : (
            invites.data.invites.map((invite) => <InviteRow key={invite.id} invite={invite} />)
          )}
        </Box>
      </Group>
      <Group title={m.invites_pending()}>
        <Box>
          {invites.data && invites.data.registrations.length > 0 ? (
            invites.data.registrations.map((registration) => (
              <RegistrationRow key={registration.id} registration={registration} />
            ))
          ) : (
            <div className="py-3 text-callout text-label-secondary">{m.invites_pending_none()}</div>
          )}
        </Box>
      </Group>
    </>
  )
}
