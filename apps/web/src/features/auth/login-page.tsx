import { emailSchema } from '@chatapp/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Fingerprint } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { Banner } from '@/components/ui/feedback.tsx'
import { PasswordField, TextField } from '@/components/ui/fields.tsx'
import { ApiError } from '@/lib/api.ts'
import { describeError } from '@/lib/error-messages.ts'
import { PRODUCT_NAME } from '@/lib/product.ts'
import { meQuery } from '@/lib/queries.ts'
import { type SessionEnd, sessionStarted } from '@/lib/session.ts'
import { classifyPasskeyError, passkeysSupported, signInWithPasskey } from '@/lib/webauthn.ts'
import { m } from '@/paraglide/messages.js'
import { authApi } from './auth-api.ts'
import { AuthCard, AuthHead } from './auth-layout.tsx'

type Notice = { tone: 'info' | 'warning' | 'danger'; text: string; resendFor?: string }

type LoginPageProps = {
  /** Where to go after signing in; defaults to the app's start page. */
  redirectTo?: string
  /** Why the user was sent here (a session that ended), shown as a hint above the form. */
  reason?: SessionEnd
  services?: {
    signIn: typeof authApi.signIn
    signInWithPasskey: () => Promise<void>
    passkeysSupported: () => boolean
  }
}

const defaultServices = { signIn: authApi.signIn, signInWithPasskey, passkeysSupported }

function reasonText(reason: SessionEnd | undefined): string | null {
  switch (reason) {
    case 'expired':
    case 'ended-elsewhere':
      return m.login_reason_expired()
    case 'password-changed':
      return m.login_reason_password_changed()
    case 'signed-out':
      return m.login_reason_signed_out()
    default:
      return null
  }
}

export function LoginPage({ redirectTo, reason, services = defaultServices }: LoginPageProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({})
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState<'password' | 'passkey' | null>(null)
  const hint = reasonText(reason)

  async function finish(): Promise<void> {
    // The cookie is set; load the identity before leaving, so the app never starts in an anonymous state.
    await queryClient.fetchQuery({ ...meQuery, staleTime: 0 })
    sessionStarted()
    await navigate({ to: redirectTo ?? '/', replace: true })
  }

  function explain(error: unknown): Notice {
    if (error instanceof ApiError) {
      switch (error.code) {
        case 'INVALID_EMAIL_OR_PASSWORD':
          return { tone: 'danger', text: m.login_error_credentials() }
        case 'EMAIL_NOT_VERIFIED':
          return { tone: 'warning', text: m.login_error_unverified(), resendFor: email.trim() }
        case 'ACCOUNT_NOT_ACTIVE':
          return { tone: 'danger', text: m.login_error_inactive() }
        default:
          return { tone: 'danger', text: describeError(error) }
      }
    }
    return { tone: 'danger', text: describeError(error) }
  }

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (busy) return
    setNotice(null)
    const parsedEmail = emailSchema.safeParse(email)
    const next = {
      email: parsedEmail.success ? undefined : m.field_error_email(),
      password: password ? undefined : m.field_error_password_required(),
    }
    setErrors(next)
    if (next.email || next.password || !parsedEmail.success) return
    setBusy('password')
    try {
      await services.signIn({ email: parsedEmail.data, password })
      await finish()
    } catch (error) {
      setNotice(explain(error))
    } finally {
      setBusy(null)
    }
  }

  async function onPasskey(): Promise<void> {
    if (busy) return
    setNotice(null)
    setBusy('passkey')
    try {
      await services.signInWithPasskey()
      await finish()
    } catch (error) {
      if (error instanceof ApiError) setNotice(explain(error))
      else {
        const failure = classifyPasskeyError(error)
        if (failure === 'unsupported') setNotice({ tone: 'warning', text: m.passkey_unsupported() })
        else if (failure === 'failed') setNotice({ tone: 'danger', text: m.passkey_failed() })
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <AuthCard>
      <AuthHead title={m.login_title({ product: PRODUCT_NAME })} text={m.login_lead()} />
      <form className="auth-form" noValidate onSubmit={onSubmit}>
        {hint ? <Banner tone="info">{hint}</Banner> : null}
        {notice ? (
          <Banner tone={notice.tone}>
            <div>{notice.text}</div>
            {notice.resendFor !== undefined ? (
              <div className="mt-2">
                <Link
                  to="/check-email"
                  state={{ email: notice.resendFor }}
                  className="btn btn--tinted btn--sm no-underline"
                >
                  {m.login_resend_verification()}
                </Link>
              </div>
            ) : null}
          </Banner>
        ) : null}
        <TextField
          // The sign-in page has one purpose, and its first field is where people start.
          autoFocus
          label={m.field_email()}
          type="email"
          size="lg"
          autoComplete="username"
          inputMode="email"
          value={email}
          error={errors.email}
          onChange={(event) => setEmail(event.currentTarget.value)}
        />
        <PasswordField
          label={m.field_password()}
          size="lg"
          autoComplete="current-password"
          showLabel={m.field_password_show()}
          hideLabelText={m.field_password_hide()}
          value={password}
          error={errors.password}
          onChange={(event) => setPassword(event.currentTarget.value)}
        />
        <div className="auth-links">
          <Link to="/forgot-password">{m.login_forgot()}</Link>
        </div>
        <Button type="submit" size="lg" block busy={busy === 'password'}>
          {m.login_submit()}
        </Button>
        <div className="auth-or">
          <span>{m.common_or()}</span>
        </div>
        <Button
          kind="tinted"
          size="lg"
          block
          icon={Fingerprint}
          busy={busy === 'passkey'}
          onClick={onPasskey}
        >
          {m.login_passkey()}
        </Button>
      </form>
      <p className="auth-foot">
        {m.login_have_invite()}
        <Link to="/register">{m.login_register_link()}</Link>
      </p>
    </AuthCard>
  )
}
