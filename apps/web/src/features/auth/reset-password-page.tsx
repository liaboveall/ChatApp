import { passwordSchema } from '@chatapp/contracts'
import { Link } from '@tanstack/react-router'
import { CircleAlert, CircleCheck } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { Banner } from '@/components/ui/feedback.tsx'
import { PasswordField } from '@/components/ui/fields.tsx'
import { ApiError } from '@/lib/api.ts'
import { describeError, passwordProblemMessage } from '@/lib/error-messages.ts'
import { m } from '@/paraglide/messages.js'
import { authApi } from './auth-api.ts'
import { AuthCard, AuthHead } from './auth-layout.tsx'
import { evaluatePassword, PasswordRules, passwordAcceptable } from './password-rules.tsx'
import { useTokenFromFragment } from './verify-email-page.tsx'

type Services = { consumePasswordReset: typeof authApi.consumePasswordReset }
const defaultServices: Services = { consumePasswordReset: authApi.consumePasswordReset }

type Stage = 'form' | 'done' | 'invalid'

/** The page behind the link in the reset email: the token is read from the fragment, kept in memory, and removed from the URL. */
export function ResetPasswordPage({ services = defaultServices }: { services?: Services }) {
  const { value: token } = useTokenFromFragment()
  return <ResetForm key={token ?? 'none'} token={token} services={services} />
}

function ResetForm({ token, services }: { token: string | null; services: Services }) {
  const [stage, setStage] = useState<Stage>(token ? 'form' : 'invalid')
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [errors, setErrors] = useState<{ password?: string; again?: string }>({})
  const [serverProblem, setServerProblem] = useState<string | undefined>()
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const rules = evaluatePassword(password, {}, serverProblem)

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (busy || !token) return
    setFailure(null)
    setServerProblem(undefined)
    const next = {
      password:
        passwordSchema.safeParse(password).success && passwordAcceptable(rules)
          ? undefined
          : m.register_password_unmet(),
      again: again === password ? undefined : m.reset_mismatch(),
    }
    setErrors(next)
    if (next.password || next.again) return
    setBusy(true)
    try {
      await services.consumePasswordReset({ token, newPassword: password })
      setStage('done')
    } catch (error) {
      if (error instanceof ApiError && error.code === 'AUTH_CHALLENGE_INVALID') setStage('invalid')
      else if (
        error instanceof ApiError &&
        error.code === 'VALIDATION_FAILED' &&
        error.field === 'password'
      ) {
        setServerProblem(error.reason)
        setErrors({ password: passwordProblemMessage(error.reason) })
      } else setFailure(describeError(error))
    } finally {
      setBusy(false)
    }
  }

  if (stage === 'done') {
    return (
      <AuthCard>
        <AuthHead
          icon={CircleCheck}
          tone="ok"
          title={m.reset_done_title()}
          text={m.reset_done_text()}
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
          title={m.reset_invalid_title()}
          text={m.reset_invalid_text()}
        />
        <Link to="/forgot-password" className="btn btn--filled btn--lg btn--block no-underline">
          {m.reset_invalid_action()}
        </Link>
      </AuthCard>
    )
  }
  return (
    <AuthCard>
      <AuthHead title={m.reset_title()} text={m.reset_lead()} />
      <form className="auth-form" noValidate onSubmit={onSubmit}>
        {failure ? <Banner tone="danger">{failure}</Banner> : null}
        <PasswordField
          label={m.reset_new_password()}
          size="lg"
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
        <PasswordField
          label={m.reset_again()}
          size="lg"
          autoComplete="new-password"
          showLabel={m.field_password_show()}
          hideLabelText={m.field_password_hide()}
          value={again}
          error={errors.again}
          onChange={(event) => setAgain(event.currentTarget.value)}
        />
        <p className="text-subheadline text-label-secondary">{m.reset_effect()}</p>
        <Button type="submit" size="lg" block busy={busy}>
          {m.reset_submit()}
        </Button>
      </form>
    </AuthCard>
  )
}
