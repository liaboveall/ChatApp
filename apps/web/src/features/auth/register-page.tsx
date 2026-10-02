import {
  displayNameSchema,
  emailSchema,
  formatInviteCode,
  isReservedDisplayName,
  isReservedUsername,
  normalizeInviteCode,
  passwordSchema,
  usernameSchema,
} from '@chatapp/contracts'
import { Link, useNavigate } from '@tanstack/react-router'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { Banner } from '@/components/ui/feedback.tsx'
import { PasswordField, TextField } from '@/components/ui/fields.tsx'
import { ApiError, newIdempotencyKey } from '@/lib/api.ts'
import { describeError, passwordProblemMessage } from '@/lib/error-messages.ts'
import { PRODUCT_NAME } from '@/lib/product.ts'
import { stripFragment, useWindowHash } from '@/lib/url.ts'
import { m } from '@/paraglide/messages.js'
import { authApi } from './auth-api.ts'
import { AuthCard, AuthHead } from './auth-layout.tsx'
import { evaluatePassword, PasswordRules, passwordAcceptable } from './password-rules.tsx'

type Services = {
  signUp: typeof authApi.signUp
  checkInvite: typeof authApi.checkInvite
}
const defaultServices: Services = { signUp: authApi.signUp, checkInvite: authApi.checkInvite }

type FieldName = 'invite' | 'email' | 'username' | 'name' | 'password'
type Errors = Partial<Record<FieldName, string>>
type InviteState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ok' }
  | { status: 'bad'; message: string }

/** `#invite=CODE` from the registration link; the fragment never reaches the server (docs/01 section 4.1). */
export function inviteFromHash(hash: string): string {
  return new URLSearchParams(hash.replace(/^#/, '')).get('invite') ?? ''
}

export function RegisterPage({ services = defaultServices }: { services?: Services }) {
  const navigate = useNavigate()
  const hash = useWindowHash()
  const [invite, setInvite] = useState(() => {
    const code = inviteFromHash(hash)
    return normalizeInviteCode(code) ? formatInviteCode(normalizeInviteCode(code) as string) : code
  })
  const [email, setEmail] = useState('')
  const [username, setUsername] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<Errors>({})
  const [inviteState, setInviteState] = useState<InviteState>({ status: 'idle' })
  const [serverProblem, setServerProblem] = useState<string | undefined>()
  const [banner, setBanner] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const checked = useRef<string>('')
  // The same attempt (same content) reuses its key, so a retry after a lost answer cannot register twice.
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null)

  // A registration link opened in a tab that already shows this page changes only the fragment: read it again, and take
  // the code out of the address bar as soon as it has been read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `checkInvite` only reads state that the effect sets itself.
  useEffect(() => {
    const code = normalizeInviteCode(inviteFromHash(hash))
    if (code) {
      setInvite(formatInviteCode(code))
      void checkInvite(code)
    }
    stripFragment()
  }, [hash])

  async function checkInvite(raw: string): Promise<boolean> {
    const code = normalizeInviteCode(raw)
    if (!code) {
      setInviteState({ status: 'bad', message: m.register_invite_malformed() })
      return false
    }
    if (checked.current === code) return inviteState.status === 'ok'
    checked.current = code
    setInviteState({ status: 'checking' })
    try {
      await services.checkInvite(code)
      setInviteState({ status: 'ok' })
      return true
    } catch (error) {
      checked.current = ''
      const message =
        error instanceof ApiError && error.code === 'INVITE_INVALID'
          ? m.register_invite_invalid()
          : describeError(error)
      setInviteState({ status: 'bad', message })
      return false
    }
  }

  const rules = evaluatePassword(password, { email, username, displayName: name }, serverProblem)

  function validate(): Errors {
    const next: Errors = {}
    if (!normalizeInviteCode(invite)) next.invite = m.register_invite_malformed()
    if (!emailSchema.safeParse(email).success) next.email = m.field_error_email()
    const user = usernameSchema.safeParse(username)
    if (!user.success) next.username = m.register_username_rule()
    else if (isReservedUsername(user.data, [PRODUCT_NAME]))
      next.username = m.register_username_reserved()
    const display = displayNameSchema.safeParse(name)
    if (!display.success)
      next.name = name.trim() ? m.register_name_rule() : m.register_name_required()
    else if (isReservedDisplayName(display.data, [PRODUCT_NAME]))
      next.name = m.register_name_reserved()
    if (!passwordSchema.safeParse(password).success || !passwordAcceptable(rules))
      next.password = m.register_password_unmet()
    return next
  }

  function applyServerError(error: unknown): void {
    if (error instanceof ApiError) {
      if (error.code === 'INVITE_INVALID') {
        setInviteState({ status: 'bad', message: m.register_invite_invalid() })
        setErrors({ invite: m.register_invite_invalid() })
        return
      }
      if (error.code === 'CONFLICT' && error.field === 'username') {
        setErrors({ username: m.register_username_taken() })
        return
      }
      if (error.code === 'VALIDATION_FAILED') {
        const field = error.field
        if (field === 'username')
          return void setErrors({ username: m.register_username_reserved() })
        if (field === 'name') return void setErrors({ name: m.register_name_reserved() })
        if (field === 'password') {
          setServerProblem(error.reason)
          return void setErrors({ password: passwordProblemMessage(error.reason) })
        }
        const paths = error.issuePaths
        if (paths.length > 0) {
          const next: Errors = {}
          if (paths.includes('email')) next.email = m.field_error_email()
          if (paths.includes('username')) next.username = m.register_username_rule()
          if (paths.includes('name')) next.name = m.register_name_rule()
          if (paths.includes('password')) next.password = m.register_password_unmet()
          if (Object.keys(next).length > 0) return void setErrors(next)
        }
      }
    }
    setBanner(describeError(error))
  }

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (busy) return
    setBanner(null)
    setServerProblem(undefined)
    const found = validate()
    setErrors(found)
    if (Object.keys(found).length > 0) return
    const code = normalizeInviteCode(invite) as string
    const body = {
      email: emailSchema.parse(email),
      username: usernameSchema.parse(username),
      name: displayNameSchema.parse(name),
      password,
    }
    const fingerprint = JSON.stringify([code, body])
    if (attempt.current?.fingerprint !== fingerprint) {
      attempt.current = { fingerprint, key: newIdempotencyKey() }
    }
    setBusy(true)
    try {
      await services.signUp(body, code, attempt.current.key)
      await navigate({ to: '/check-email', state: { email: body.email } })
    } catch (error) {
      applyServerError(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthCard>
      <AuthHead title={m.register_title({ product: PRODUCT_NAME })} text={m.register_lead()} />
      <form className="auth-form" noValidate onSubmit={onSubmit}>
        {banner ? <Banner tone="danger">{banner}</Banner> : null}
        <TextField
          label={m.register_invite_label()}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          value={invite}
          hint={m.register_invite_hint()}
          ok={inviteState.status === 'ok' ? m.register_invite_ok() : null}
          error={errors.invite ?? (inviteState.status === 'bad' ? inviteState.message : null)}
          onChange={(event) => {
            setInvite(event.currentTarget.value)
            setInviteState({ status: 'idle' })
            checked.current = ''
          }}
          onBlur={() => invite.trim() && void checkInvite(invite)}
        />
        <TextField
          label={m.field_email()}
          type="email"
          autoComplete="email"
          inputMode="email"
          value={email}
          error={errors.email}
          onChange={(event) => setEmail(event.currentTarget.value)}
        />
        <TextField
          label={m.register_username_label()}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={username}
          hint={m.register_username_hint()}
          error={errors.username}
          onChange={(event) => setUsername(event.currentTarget.value)}
        />
        <TextField
          label={m.register_name_label()}
          autoComplete="nickname"
          value={name}
          hint={m.register_name_hint()}
          error={errors.name}
          onChange={(event) => setName(event.currentTarget.value)}
        />
        <PasswordField
          label={m.field_password()}
          autoComplete="new-password"
          showLabel={m.field_password_show()}
          hideLabelText={m.field_password_hide()}
          value={password}
          error={errors.password}
          onChange={(event) => {
            setPassword(event.currentTarget.value)
            setServerProblem(undefined)
          }}
        />
        <PasswordRules result={rules} />
        <Button type="submit" size="lg" block busy={busy}>
          {m.register_submit()}
        </Button>
      </form>
      <p className="auth-foot">
        {m.register_have_account()}
        <Link to="/login">{m.register_login_link()}</Link>
      </p>
    </AuthCard>
  )
}
