/**
 * Editing the public profile (docs/01 section 4.3, D-133): display name, username and bio. The write names the `meVersion`
 * it was based on and sends only what changed. A username can be changed once in 30 days and the old one stays reserved for
 * its owner for 30 days, so the dialog says so before the person saves a new one; the server's refusals (taken, reserved,
 * still cooling down) are worded next to the field they belong to.
 */
import { displayNameSchema, LIMITS, type Me, meSchema, usernameSchema } from '@chatapp/contracts'
import { useState } from 'react'
import { engine } from '@/app/sync.ts'
import { Button } from '@/components/ui/button.tsx'
import { Dialog } from '@/components/ui/dialog.tsx'
import { Banner } from '@/components/ui/feedback.tsx'
import { TextAreaField, TextField } from '@/components/ui/fields.tsx'
import { ApiError, api } from '@/lib/api.ts'
import { describeError } from '@/lib/error-messages.ts'
import { dateTime } from '@/lib/time-format.ts'
import { showToast } from '@/lib/toast.ts'
import { useTime } from '@/lib/use-time.ts'
import { m } from '@/paraglide/messages.js'

type Problems = { displayName?: string; username?: string; general?: string }

function Form({ me, onClose }: { me: Me; onClose: () => void }) {
  const [displayName, setDisplayName] = useState(me.displayName)
  const [username, setUsername] = useState(me.username)
  const [bio, setBio] = useState(me.bio ?? '')
  const [busy, setBusy] = useState(false)
  const [problems, setProblems] = useState<Problems>({})
  const { locale, timeZone } = useTime()

  const nameChanged = displayName.trim() !== me.displayName
  const usernameChanged = username !== me.username
  const bioChanged = bio.trim() !== (me.bio ?? '')
  const nameOk = displayNameSchema.safeParse(displayName).success
  const usernameOk = usernameSchema.safeParse(username).success
  const canSave = (nameChanged || usernameChanged || bioChanged) && nameOk && usernameOk && !busy

  const submit = async (): Promise<void> => {
    if (!canSave) return
    setBusy(true)
    setProblems({})
    const ticket = engine.ticket()
    try {
      const updated = await api('/api/me', {
        method: 'PATCH',
        json: {
          expectedMeVersion: me.meVersion,
          ...(nameChanged ? { displayName: displayName.trim() } : {}),
          ...(usernameChanged ? { username } : {}),
          ...(bioChanged ? { bio: bio.trim() === '' ? null : bio.trim() } : {}),
        },
        schema: meSchema,
      })
      engine.ingestMe(updated, ticket)
      showToast(m.settings_profile_saved())
      onClose()
      return
    } catch (error) {
      setProblems(describe(error, locale, timeZone))
    }
    setBusy(false)
  }

  return (
    <form
      className="dialog-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      {problems.general !== undefined ? <Banner tone="danger">{problems.general}</Banner> : null}
      <TextField
        label={m.settings_profile_name()}
        value={displayName}
        onChange={(event) => setDisplayName(event.target.value)}
        error={
          problems.displayName ??
          (nameOk || displayName === '' ? null : m.settings_profile_name_invalid())
        }
        autoComplete="off"
      />
      <TextField
        label={m.settings_profile_username()}
        value={username}
        onChange={(event) => setUsername(event.target.value.trim().toLowerCase())}
        error={problems.username ?? (usernameOk ? null : m.settings_profile_username_invalid())}
        hint={m.settings_profile_username_hint()}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
      />
      {usernameChanged && usernameOk ? (
        <Banner tone="warning">{m.settings_profile_username_warning()}</Banner>
      ) : null}
      <TextAreaField
        label={m.settings_profile_bio()}
        value={bio}
        onChange={(event) => setBio(event.target.value)}
        maxLength={LIMITS.bioMaxLength}
      />
      <div className="dialog__actions">
        <Button kind="plain" onClick={onClose}>
          {m.common_cancel()}
        </Button>
        <Button type="submit" kind="filled" busy={busy} disabled={!canSave}>
          {m.common_save()}
        </Button>
      </div>
    </form>
  )
}

/** The server's refusals, worded next to the field they are about. */
function describe(error: unknown, locale: string, timeZone: string | undefined): Problems {
  if (error instanceof ApiError) {
    if (error.field === 'displayName' && error.reason === 'reserved') {
      return { displayName: m.settings_profile_name_reserved() }
    }
    if (error.field === 'username') {
      if (error.reason === 'taken') return { username: m.settings_profile_username_taken() }
      if (error.reason === 'reserved') return { username: m.settings_profile_username_reserved() }
      if (error.reason === 'cooldown') {
        const at = error.details?.availableAt
        return {
          username:
            typeof at === 'string'
              ? m.settings_profile_username_cooldown({ date: dateTime(at, locale, timeZone) })
              : m.settings_profile_username_cooldown_soon(),
        }
      }
    }
    if (error.code === 'VERSION_CONFLICT') return { general: m.settings_profile_conflict() }
  }
  return { general: describeError(error) }
}

export function EditProfileDialog({
  me,
  open,
  onOpenChange,
}: {
  me: Me
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.settings_profile_edit_title()}
      className="dialog--form"
    >
      {open ? <Form me={me} onClose={() => onOpenChange(false)} /> : null}
    </Dialog>
  )
}
