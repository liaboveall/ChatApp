import { emailSchema } from '@chatapp/contracts'
import { Link } from '@tanstack/react-router'
import { MailCheck } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { Banner } from '@/components/ui/feedback.tsx'
import { TextField } from '@/components/ui/fields.tsx'
import { describeError } from '@/lib/error-messages.ts'
import { m } from '@/paraglide/messages.js'
import { authApi } from './auth-api.ts'
import { AuthCard, AuthHead } from './auth-layout.tsx'

type Props = {
  services?: { requestPasswordReset: typeof authApi.requestPasswordReset }
}

const defaultServices = { requestPasswordReset: authApi.requestPasswordReset }

/** Asks for a reset email. The answer is the same whether or not the address has an account (docs/05 section 3.1). */
export function ForgotPasswordPage({ services = defaultServices }: Props) {
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (busy) return
    setFailure(null)
    const parsed = emailSchema.safeParse(email)
    setError(parsed.success ? null : m.field_error_email())
    if (!parsed.success) return
    setBusy(true)
    try {
      await services.requestPasswordReset(parsed.data)
      setSent(true)
    } catch (caught) {
      setFailure(describeError(caught))
    } finally {
      setBusy(false)
    }
  }

  if (sent) {
    return (
      <AuthCard>
        <AuthHead icon={MailCheck} title={m.forgot_sent_title()} text={m.forgot_sent_text()} />
        <div className="auth-form">
          <p className="text-subheadline text-label-secondary">{m.forgot_sent_note()}</p>
          <Link to="/login" className="btn btn--tinted btn--lg btn--block no-underline">
            {m.forgot_back_to_login()}
          </Link>
        </div>
      </AuthCard>
    )
  }

  return (
    <AuthCard>
      <AuthHead title={m.forgot_title()} text={m.forgot_lead()} />
      <form className="auth-form" noValidate onSubmit={onSubmit}>
        {failure ? <Banner tone="danger">{failure}</Banner> : null}
        <TextField
          label={m.field_email()}
          type="email"
          size="lg"
          autoComplete="username"
          inputMode="email"
          value={email}
          error={error}
          onChange={(event) => setEmail(event.currentTarget.value)}
        />
        <Button type="submit" size="lg" block busy={busy}>
          {m.forgot_submit()}
        </Button>
      </form>
      <p className="auth-foot">
        <Link to="/login">{m.forgot_back_to_login()}</Link>
      </p>
    </AuthCard>
  )
}
