import type { Device, Me } from '@chatapp/contracts'
import { changePasswordRequestSchema, meSchema } from '@chatapp/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Fingerprint, Laptop, LogOut, Pencil, Smartphone } from 'lucide-react'
import { type FormEvent, useId, useMemo, useState } from 'react'
import { forScreen } from '@/app/sync.ts'
import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button.tsx'
import { SegmentedControl } from '@/components/ui/controls.tsx'
import { Dialog } from '@/components/ui/dialog.tsx'
import { Banner, Skeleton } from '@/components/ui/feedback.tsx'
import { PasswordField, TextField } from '@/components/ui/fields.tsx'
import { Icon } from '@/components/ui/icon.tsx'
import { authApi } from '@/features/auth/auth-api.ts'
import {
  evaluatePassword,
  PasswordRules,
  passwordAcceptable,
} from '@/features/auth/password-rules.tsx'
import { ApiError, api } from '@/lib/api.ts'
import { describeError, passwordProblemMessage } from '@/lib/error-messages.ts'
import { devicesQuery, queryKeys, writeMeAnswer } from '@/lib/queries.ts'
import { endSession } from '@/lib/session.ts'
import { showToast } from '@/lib/toast.ts'
import { describeUserAgent, deviceTitle } from '@/lib/user-agent.ts'
import {
  addPasskey,
  classifyPasskeyError,
  deletePasskey,
  listPasskeys,
  type Passkey,
  passkeysSupported,
  renamePasskey,
} from '@/lib/webauthn.ts'
import { m } from '@/paraglide/messages.js'
import { EditProfileDialog } from './profile-dialog.tsx'
import { Box, Group, Row } from './settings-ui.tsx'

const formatDate = (value: Date | string | null | undefined): string => {
  if (!value) return ''
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value))
}

const formatDateTime = (value: string): string =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  )

// ───────────────────────── profile ─────────────────────────

function ProfileGroup({ me }: { me: Me }) {
  const [editing, setEditing] = useState(false)
  return (
    <Group title={m.settings_profile()}>
      <Box>
        <Row title={m.settings_profile_name()}>
          <span className="text-callout">{me.displayName}</span>
        </Row>
        <Row title={m.settings_profile_username()}>
          <span className="text-callout">@{me.username}</span>
        </Row>
        <Row title={m.settings_profile_bio()}>
          <span className="text-callout">{me.bio ?? m.settings_profile_bio_empty()}</span>
        </Row>
        <Row title={m.settings_profile_email()} help={m.settings_profile_email_help()}>
          <span className="text-callout">{me.email}</span>
        </Row>
      </Box>
      <div>
        <Button kind="tinted" size="sm" icon={Pencil} onClick={() => setEditing(true)}>
          {m.settings_profile_edit()}
        </Button>
      </div>
      <EditProfileDialog me={me} open={editing} onOpenChange={setEditing} />
    </Group>
  )
}

// ───────────────────────── password ─────────────────────────

function ChangePasswordDialog({
  me,
  open,
  onOpenChange,
}: {
  me: Me
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [errors, setErrors] = useState<{ current?: string; next?: string }>({})
  const [serverProblem, setServerProblem] = useState<string | undefined>()
  const [failure, setFailure] = useState<string | null>(null)
  const queryClient = useQueryClient()
  const rules = evaluatePassword(
    next,
    { email: me.email, username: me.username, displayName: me.displayName },
    serverProblem,
  )

  const change = useMutation({
    mutationFn: () =>
      forScreen(null, () =>
        authApi.changePassword({ currentPassword: current, newPassword: next }),
      ),
    onSuccess: async (answer) => {
      // Null: the person who asked is not here any more (D-174); nothing is announced to whoever is.
      if (answer === null) return
      onOpenChange(false)
      setCurrent('')
      setNext('')
      showToast(m.settings_password_changed())
      // The server replaced this session's identity (new epoch, new origin): reload what depends on it.
      await queryClient.invalidateQueries({ queryKey: queryKeys.me })
      await queryClient.invalidateQueries({ queryKey: queryKeys.devices })
    },
    onError: (error) => {
      if (
        error instanceof ApiError &&
        error.code === 'FORBIDDEN' &&
        error.reason === 'wrong_password'
      ) {
        setErrors({ current: m.settings_password_wrong() })
      } else if (
        error instanceof ApiError &&
        error.code === 'VALIDATION_FAILED' &&
        error.field === 'password'
      ) {
        setServerProblem(error.reason)
        setErrors({ next: passwordProblemMessage(error.reason) })
      } else setFailure(describeError(error))
    },
  })

  function onSubmit(event: FormEvent): void {
    event.preventDefault()
    if (change.isPending) return
    setFailure(null)
    setServerProblem(undefined)
    const parsed = changePasswordRequestSchema.safeParse({
      currentPassword: current,
      newPassword: next,
    })
    const found = {
      current: current ? undefined : m.field_error_password_required(),
      next: parsed.success && passwordAcceptable(rules) ? undefined : m.register_password_unmet(),
    }
    setErrors(found)
    if (found.current || found.next) return
    change.mutate()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.settings_password_title()}
      actions={
        <>
          <Button kind="plain" onClick={() => onOpenChange(false)}>
            {m.common_cancel()}
          </Button>
          <Button type="submit" form="change-password" busy={change.isPending}>
            {m.settings_password_submit()}
          </Button>
        </>
      }
    >
      <form id="change-password" className="grid gap-3" noValidate onSubmit={onSubmit}>
        {failure ? <Banner tone="danger">{failure}</Banner> : null}
        <PasswordField
          label={m.settings_password_current()}
          autoComplete="current-password"
          showLabel={m.field_password_show()}
          hideLabelText={m.field_password_hide()}
          value={current}
          error={errors.current}
          onChange={(event) => setCurrent(event.currentTarget.value)}
        />
        <PasswordField
          label={m.settings_password_new()}
          autoComplete="new-password"
          showLabel={m.field_password_show()}
          hideLabelText={m.field_password_hide()}
          value={next}
          error={errors.next}
          onChange={(event) => {
            setNext(event.currentTarget.value)
            setServerProblem(undefined)
          }}
        />
        <PasswordRules result={rules} />
        <Banner tone="warning">{m.settings_password_effect()}</Banner>
      </form>
    </Dialog>
  )
}

// ───────────────────────── passkeys ─────────────────────────

function PasskeyRow({ passkey }: { passkey: Passkey }) {
  const queryClient = useQueryClient()
  const [renaming, setRenaming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [name, setName] = useState(passkey.name ?? '')
  const nameId = useId()
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.passkeys })
  const rename = useMutation({
    mutationFn: () =>
      forScreen(null, async () => {
        await renamePasskey(passkey.id, name.trim())
        return true as const
      }),
    onSuccess: async (answer) => {
      if (answer === null) return
      setRenaming(false)
      await refresh()
    },
    onError: (error) => showToast(describeError(error)),
  })
  const remove = useMutation({
    mutationFn: () =>
      forScreen(null, async () => {
        await deletePasskey(passkey.id)
        return true as const
      }),
    onSuccess: async (answer) => {
      if (answer === null) return
      setRemoving(false)
      showToast(m.settings_passkey_removed())
      await refresh()
    },
    onError: (error) => showToast(describeError(error)),
  })
  const title = passkey.name?.trim() || m.settings_passkey_unnamed()
  return (
    <Row
      title={title}
      help={
        passkey.createdAt
          ? m.settings_passkey_added({ date: formatDate(passkey.createdAt) })
          : undefined
      }
    >
      <Button kind="plain" size="sm" icon={Pencil} onClick={() => setRenaming(true)}>
        {m.settings_passkey_rename()}
      </Button>
      <Button kind="plain" size="sm" danger onClick={() => setRemoving(true)}>
        {m.settings_passkey_remove()}
      </Button>
      <Dialog
        open={renaming}
        onOpenChange={setRenaming}
        title={m.settings_passkey_rename_title()}
        actions={
          <>
            <Button kind="plain" onClick={() => setRenaming(false)}>
              {m.common_cancel()}
            </Button>
            <Button busy={rename.isPending} onClick={() => name.trim() && rename.mutate()}>
              {m.common_save()}
            </Button>
          </>
        }
      >
        <TextField
          id={nameId}
          label={m.settings_passkey_name()}
          maxLength={64}
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </Dialog>
      <Dialog
        open={removing}
        onOpenChange={setRemoving}
        title={m.settings_passkey_remove_title({ name: title })}
        description={m.settings_passkey_remove_text()}
        actions={
          <>
            <Button kind="plain" onClick={() => setRemoving(false)}>
              {m.common_cancel()}
            </Button>
            <Button danger busy={remove.isPending} onClick={() => remove.mutate()}>
              {m.settings_passkey_remove()}
            </Button>
          </>
        }
      />
    </Row>
  )
}

function PasskeysRows() {
  const queryClient = useQueryClient()
  const supported = useMemo(passkeysSupported, [])
  const list = useQuery({
    queryKey: queryKeys.passkeys,
    queryFn: ({ signal }) => listPasskeys(signal),
    enabled: supported,
  })
  const add = useMutation({
    // Named after the device it was created on, so the list tells them apart.
    mutationFn: () =>
      forScreen(null, async () => {
        await addPasskey(
          deviceTitle(describeUserAgent(navigator.userAgent), m.settings_passkey_unnamed()),
        )
        return true as const
      }),
    onSuccess: async (answer) => {
      if (answer === null) return
      showToast(m.settings_passkey_added_toast())
      await queryClient.invalidateQueries({ queryKey: queryKeys.passkeys })
    },
    onError: (error) => {
      if (error instanceof ApiError) return showToast(describeError(error))
      const failure = classifyPasskeyError(error)
      if (failure === 'unsupported') showToast(m.passkey_unsupported())
      else if (failure === 'failed') showToast(m.passkey_failed())
    },
  })
  return (
    <>
      <Row
        title={m.settings_passkey()}
        help={supported ? m.settings_passkey_help() : m.settings_passkey_unsupported()}
      >
        <Button
          kind="tinted"
          size="sm"
          icon={Fingerprint}
          disabled={!supported}
          busy={add.isPending}
          onClick={() => add.mutate()}
        >
          {m.settings_passkey_add()}
        </Button>
      </Row>
      {list.data?.map((passkey) => (
        <PasskeyRow key={passkey.id} passkey={passkey} />
      ))}
    </>
  )
}

// ───────────────────────── devices ─────────────────────────

type RevokeTarget = { kind: 'one'; device: Device } | { kind: 'others' } | { kind: 'all' }

function DevicesGroup() {
  const queryClient = useQueryClient()
  const devices = useQuery(devicesQuery)
  const [target, setTarget] = useState<RevokeTarget | null>(null)

  const revoke = useMutation({
    mutationFn: (what: RevokeTarget) =>
      forScreen(null, async () => {
        if (what.kind === 'one')
          await api(`/api/me/devices/${what.device.id}`, { method: 'DELETE' })
        else if (what.kind === 'others')
          await api('/api/me/devices/revoke-others', { method: 'POST' })
        else await api('/api/me/devices/revoke-all', { method: 'POST' })
        return true as const
      }),
    onSuccess: async (answer, what) => {
      // Null: the person who asked is not here any more (D-174); ending the session below would end whoever's is here.
      if (answer === null) return
      setTarget(null)
      if (what.kind === 'all') {
        endSession('signed-out')
        return
      }
      showToast(m.settings_devices_revoked())
      await queryClient.invalidateQueries({ queryKey: queryKeys.devices })
    },
    onError: (error) => {
      setTarget(null)
      showToast(describeError(error))
    },
  })

  const others = (devices.data ?? []).filter((device) => !device.current)
  const title =
    target?.kind === 'one'
      ? m.settings_devices_revoke_one_title({
          name: deviceTitle(
            describeUserAgent(target.device.userAgent),
            m.settings_devices_unknown(),
          ),
        })
      : target?.kind === 'others'
        ? m.settings_devices_revoke_others_title()
        : m.settings_devices_revoke_all_title()

  return (
    <Group title={m.settings_devices()}>
      <div className="group__box" style={{ padding: '2px 14px' }}>
        {devices.isPending ? (
          <div className="device">
            <Skeleton width={38} height={38} />
            <Skeleton width="60%" height={16} />
          </div>
        ) : devices.isError ? (
          <div className="py-3">
            <Banner tone="danger">{describeError(devices.error)}</Banner>
          </div>
        ) : (
          devices.data.map((device) => {
            const name = describeUserAgent(device.userAgent)
            return (
              <div className="device" key={device.id}>
                <span className="device__icon">
                  <Icon icon={name.kind === 'phone' ? Smartphone : Laptop} size={20} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-headline">
                    {deviceTitle(name, m.settings_devices_unknown())}
                    {device.current ? (
                      <Badge tone="role" className="ml-1.5">
                        {m.settings_devices_current()}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="text-subheadline text-label-secondary">
                    {m.settings_devices_active({ time: formatDateTime(device.lastActiveAt) })}
                    {device.ipAddress ? ` · IP ${device.ipAddress}` : ''}
                  </div>
                </div>
                {device.current ? null : (
                  <Button
                    kind="tinted"
                    size="sm"
                    danger
                    onClick={() => setTarget({ kind: 'one', device })}
                  >
                    {m.settings_devices_revoke()}
                  </Button>
                )}
              </div>
            )
          })
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-[260px] flex-1 text-subheadline text-label-secondary">
          {m.settings_devices_privacy()}
        </p>
        <div className="flex gap-2">
          <Button
            kind="tinted"
            size="sm"
            danger
            disabled={others.length === 0}
            onClick={() => setTarget({ kind: 'others' })}
          >
            {m.settings_devices_revoke_others()}
          </Button>
          <Button
            kind="tinted"
            size="sm"
            danger
            icon={LogOut}
            onClick={() => setTarget({ kind: 'all' })}
          >
            {m.settings_devices_revoke_all()}
          </Button>
        </div>
      </div>
      <Dialog
        open={target !== null}
        onOpenChange={(open) => !open && setTarget(null)}
        title={title}
        actions={
          <>
            <Button kind="plain" onClick={() => setTarget(null)}>
              {m.common_cancel()}
            </Button>
            <Button danger busy={revoke.isPending} onClick={() => target && revoke.mutate(target)}>
              {target?.kind === 'all'
                ? m.settings_devices_revoke_all_confirm()
                : m.settings_devices_revoke_confirm()}
            </Button>
          </>
        }
      >
        <p className="text-body text-label-secondary">
          {target?.kind === 'all'
            ? m.settings_devices_revoke_all_text()
            : m.settings_devices_revoke_text()}
        </p>
        <Banner tone="warning">{m.settings_devices_revoke_effect()}</Banner>
        <p className="text-subheadline text-label-secondary">{m.settings_devices_signout_note()}</p>
      </Dialog>
    </Group>
  )
}

// ───────────────────────── time zone ─────────────────────────

const browserZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

function zoneOffsetLabel(zone: string, now: Date): string {
  try {
    const part = new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(now)
      .find((p) => p.type === 'timeZoneName')?.value
    const offset = part?.replace('GMT', 'UTC') ?? 'UTC'
    return offset === 'UTC' ? 'UTC+00:00' : offset
  } catch {
    return 'UTC'
  }
}

function TimezoneGroup({ me }: { me: Me }) {
  const queryClient = useQueryClient()
  const auto = me.settings.timezoneAuto !== false
  const zoneId = useId()
  const zones = useMemo(() => {
    const all = Intl.supportedValuesOf('timeZone')
    return all.includes(me.timezone) ? all : [me.timezone, ...all]
  }, [me.timezone])
  const save = useMutation({
    mutationFn: (change: { timezone?: string; timezoneAuto?: boolean }) =>
      forScreen(null, () =>
        api('/api/me', {
          method: 'PATCH',
          json: {
            expectedMeVersion: me.meVersion,
            ...(change.timezone === undefined ? {} : { timezone: change.timezone }),
            ...(change.timezoneAuto === undefined
              ? {}
              : { settings: { timezoneAuto: change.timezoneAuto } }),
          },
          schema: meSchema,
        }),
      ),
    onSuccess: (updated) => {
      if (updated === null) return
      writeMeAnswer(queryClient, updated)
      showToast(m.settings_timezone_saved())
    },
    onError: async (error) => {
      // Another device changed the settings first: show what is there now.
      if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
        await queryClient.invalidateQueries({ queryKey: queryKeys.me })
        showToast(m.settings_timezone_conflict())
      } else showToast(describeError(error))
    },
  })
  const now = new Date()
  const shown = auto ? browserZone() : me.timezone
  return (
    <Group title={m.settings_timezone()}>
      <Box>
        <Row title={m.settings_timezone_mode()} help={m.settings_timezone_mode_help()}>
          <SegmentedControl<'auto' | 'fixed'>
            label={m.settings_timezone_mode()}
            value={auto ? 'auto' : 'fixed'}
            disabled={save.isPending}
            onValueChange={(value) =>
              save.mutate(
                value === 'auto'
                  ? { timezoneAuto: true, timezone: browserZone() }
                  : { timezoneAuto: false },
              )
            }
            items={[
              { value: 'auto', label: m.settings_timezone_auto() },
              { value: 'fixed', label: m.settings_timezone_fixed() },
            ]}
          />
        </Row>
        <Row
          title={auto ? m.settings_timezone_current_auto() : m.settings_timezone_current_fixed()}
          help={m.settings_timezone_now({
            time: new Intl.DateTimeFormat(undefined, {
              dateStyle: 'full',
              timeStyle: 'short',
              timeZone: shown,
            }).format(now),
          })}
          htmlFor={zoneId}
        >
          {auto ? (
            <span className="text-callout">
              {shown} ({zoneOffsetLabel(shown, now)})
            </span>
          ) : (
            <select
              id={zoneId}
              className="input"
              style={{ width: 260 }}
              value={me.timezone}
              disabled={save.isPending}
              onChange={(event) => save.mutate({ timezone: event.currentTarget.value })}
            >
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone} ({zoneOffsetLabel(zone, now)})
                </option>
              ))}
            </select>
          )}
        </Row>
        <div className="row">
          <div className="row__main">
            <p className="text-subheadline text-label-secondary">{m.settings_timezone_note()}</p>
          </div>
        </div>
      </Box>
    </Group>
  )
}

// ───────────────────────── section ─────────────────────────

export function AccountSection({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const [passwordOpen, setPasswordOpen] = useState(false)
  return (
    <>
      <ProfileGroup me={me} />
      <Group title={m.settings_signin()}>
        <Box>
          <Row title={m.settings_password()} help={m.settings_password_help()}>
            <Button kind="tinted" size="sm" onClick={() => setPasswordOpen(true)}>
              {m.settings_password_change()}
            </Button>
          </Row>
          <PasskeysRows />
        </Box>
      </Group>
      <ChangePasswordDialog me={me} open={passwordOpen} onOpenChange={setPasswordOpen} />
      <DevicesGroup />
      <TimezoneGroup me={me} />
      <div>
        <Button kind="tinted" icon={LogOut} onClick={onSignOut}>
          {m.settings_sign_out()}
        </Button>
        <p className="mt-2 text-subheadline text-label-secondary">{m.settings_sign_out_help()}</p>
      </div>
    </>
  )
}
