import { authTokenSchema, emailSchema } from '@chatapp/contracts'
import { Link, Navigate, useLocation } from '@tanstack/react-router'
import { CircleAlert, CircleCheck, MailCheck, ShieldCheck } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { Banner } from '@/components/ui/feedback.tsx'
import { TextField } from '@/components/ui/fields.tsx'
import { ApiError } from '@/lib/api.ts'
import { describeError } from '@/lib/error-messages.ts'
import { useFragmentValue } from '@/lib/url.ts'
import { m } from '@/paraglide/messages.js'
import { authApi } from './auth-api.ts'
import { AuthCard, AuthHead } from './auth-layout.tsx'

const RESEND_COOLDOWN_SECONDS = 60

const isToken = (value: string): boolean => authTokenSchema.safeParse(value).success

/** The one-time token in the address (`#token=...`), read into memory and removed from the address bar. */
export function useTokenFromFragment(): { value: string | null; arrived: boolean } {
  return useFragmentValue('token', isToken)
}

/** `a***@example.com`: enough to recognize the address without displaying it in full. */
export function maskEmail(email: string): string {
  return email.replace(/^(.).*(@.*)$/, '$1***$2')
}

type Services = {
  requestVerification: typeof authApi.requestVerification
  consumeVerification: typeof authApi.consumeVerification
}
const defaultServices: Services = {
  requestVerification: authApi.requestVerification,
  consumeVerification: authApi.consumeVerification,
}

/**
 * The page behind the link in the verification email (`/verify-email#token=...`). Without a fragment there is nothing
 * to confirm, and the visitor is sent to the page that asks where to send a new email.
 */
export function VerifyEmailPage({ services = defaultServices }: { services?: Services }) {
  const { value: token, arrived } = useTokenFromFragment()
  if (!arrived) return <Navigate to="/check-email" replace />
  return <ConfirmFromLink key={token ?? 'none'} token={token} services={services} />
}

type Stage = 'ready' | 'working' | 'done' | 'invalid' | 'failed'

/** The link alone verifies nothing: a person has to press the button, so a mail scanner opening it uses nothing up. */
function ConfirmFromLink({ token, services }: { token: string | null; services: Services }) {
  const [stage, setStage] = useState<Stage>(token ? 'ready' : 'invalid')
  const [failure, setFailure] = useState<string | null>(null)

  async function confirm(): Promise<void> {
    if (!token || stage === 'working') return
    setStage('working')
    setFailure(null)
    try {
      await services.consumeVerification(token)
      setStage('done')
    } catch (error) {
      if (error instanceof ApiError && error.code === 'AUTH_CHALLENGE_INVALID') setStage('invalid')
      else {
        setFailure(describeError(error))
        setStage('failed')
      }
    }
  }

  if (stage === 'done') {
    return (
      <AuthCard>
        <AuthHead
          icon={CircleCheck}
          tone="ok"
          title={m.verify_done_title()}
          text={m.verify_done_text()}
        />
        <Link to="/login" className="btn btn--filled btn--lg btn--block no-underline">
          {m.verify_done_action()}
        </Link>
      </AuthCard>
    )
  }
  if (stage === 'invalid') {
    return (
      <AuthCard>
        <AuthHead
          icon={CircleAlert}
          tone="bad"
          title={m.verify_invalid_title()}
          text={m.verify_invalid_text()}
        />
        <Link to="/check-email" className="btn btn--filled btn--lg btn--block no-underline">
          {m.verify_invalid_action()}
        </Link>
      </AuthCard>
    )
  }
  return (
    <AuthCard>
      <AuthHead
        icon={ShieldCheck}
        title={m.verify_confirm_title()}
        text={m.verify_confirm_text()}
      />
      <div className="auth-form">
        {failure ? <Banner tone="danger">{failure}</Banner> : null}
        <Button size="lg" block busy={stage === 'working'} onClick={confirm}>
          {m.verify_confirm_action()}
        </Button>
      </div>
    </AuthCard>
  )
}

/**
 * After registering (or from a refused sign-in): where to look, and a way to send the email again. The address comes
 * with the navigation (history state, never the URL); opened without it, the page asks for the address.
 */
export function CheckEmailPage({ services = defaultServices }: { services?: Services }) {
  const known = useLocation({ select: (location) => (location.state as { email?: unknown }).email })
  return <CheckInbox email={typeof known === 'string' ? known : undefined} services={services} />
}

function CheckInbox({ email: known, services }: { email: string | undefined; services: Services }) {
  const [email, setEmail] = useState(known ?? '')
  const [asked, setAsked] = useState(known !== undefined)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [left, setLeft] = useState(0)

  useEffect(() => {
    if (left <= 0) return
    const timer = setTimeout(() => setLeft((value) => value - 1), 1000)
    return () => clearTimeout(timer)
  }, [left])

  async function send(address: string): Promise<void> {
    setBusy(true)
    setFailure(null)
    try {
      await services.requestVerification(address)
      setLeft(RESEND_COOLDOWN_SECONDS)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'RATE_LIMITED' && error.retryAfterSeconds) {
        setLeft(error.retryAfterSeconds)
      }
      setFailure(describeError(error))
    } finally {
      setBusy(false)
    }
  }

  async function onAsk(event: FormEvent): Promise<void> {
    event.preventDefault()
    const parsed = emailSchema.safeParse(email)
    setFieldError(parsed.success ? null : m.field_error_email())
    if (!parsed.success) return
    setEmail(parsed.data)
    setAsked(true)
    await send(parsed.data)
  }

  if (!asked) {
    return (
      <AuthCard>
        <AuthHead icon={MailCheck} title={m.verify_ask_title()} text={m.verify_ask_text()} />
        <form className="auth-form" noValidate onSubmit={onAsk}>
          <TextField
            label={m.field_email()}
            type="email"
            size="lg"
            autoComplete="username"
            inputMode="email"
            value={email}
            error={fieldError}
            onChange={(event) => setEmail(event.currentTarget.value)}
          />
          <Button type="submit" size="lg" block busy={busy}>
            {m.verify_ask_action()}
          </Button>
        </form>
        <p className="auth-foot">
          <Link to="/login">{m.forgot_back_to_login()}</Link>
        </p>
      </AuthCard>
    )
  }

  return (
    <AuthCard>
      <AuthHead
        icon={MailCheck}
        title={m.verify_sent_title()}
        text={m.verify_sent_text({ email: maskEmail(email) })}
      />
      <div className="auth-form">
        {failure ? <Banner tone="danger">{failure}</Banner> : null}
        <Button
          kind="tinted"
          size="lg"
          block
          busy={busy}
          disabled={left > 0}
          onClick={() => void send(email)}
        >
          {left > 0 ? m.verify_resend_wait({ seconds: left }) : m.verify_resend()}
        </Button>
        <p className="text-subheadline text-label-secondary" aria-live="polite">
          {m.verify_sent_note()}
        </p>
        <p className="auth-foot">
          {m.verify_wrong_email()}
          <Link to="/register">{m.verify_reregister()}</Link>
        </p>
      </div>
    </AuthCard>
  )
}
