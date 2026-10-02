import type { Meta, StoryObj } from '@storybook/react-vite'
import { useLayoutEffect } from 'react'
import { ApiError } from '@/lib/api.ts'
import { AuthLayout } from './auth-layout.tsx'
import { ForgotPasswordPage } from './forgot-password-page.tsx'
import { LoginPage } from './login-page.tsx'
import { RegisterPage } from './register-page.tsx'
import { ResetPasswordPage } from './reset-password-page.tsx'
import { CheckEmailPage, VerifyEmailPage } from './verify-email-page.tsx'

const meta = {
  title: 'Pages/Authentication',
  tags: ['visual'],
  parameters: { layout: 'fullscreen', surface: 'none' },
} satisfies Meta
export default meta
type Story = StoryObj<typeof meta>

const TOKEN = 'A'.repeat(43)

/** The pages read their one-time credential from the address bar's fragment; set it before the page renders. */
function Fragment({ hash, children }: { hash: string; children: React.ReactNode }) {
  useLayoutEffect(() => {
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}${hash}`,
    )
  }, [hash])
  if (hash && window.location.hash !== hash)
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}${hash}`,
    )
  return children
}

const Page = ({ children, hash = '' }: { children: React.ReactNode; hash?: string }) => (
  <div style={{ height: 1000 }}>
    <Fragment hash={hash}>
      <AuthLayout>{children}</AuthLayout>
    </Fragment>
  </div>
)

const never = () => new Promise<never>(() => {})
const fail =
  (code: ConstructorParameters<typeof ApiError>[1], status = 400) =>
  () =>
    Promise.reject(new ApiError(status, code))
const ok = { status: 'ok' as const }

export const SignIn: Story = {
  render: () => (
    <Page>
      <LoginPage />
    </Page>
  ),
}

export const SignInSessionEnded: Story = {
  render: () => (
    <Page>
      <LoginPage reason="expired" />
    </Page>
  ),
}

export const Register: Story = {
  render: () => (
    <Page>
      <RegisterPage
        services={{ signUp: never, checkInvite: () => Promise.resolve({ valid: true as const }) }}
      />
    </Page>
  ),
}

export const RegisterFromInviteLink: Story = {
  render: () => (
    <Page hash="#invite=ABCDEFGHJKLMNPQR">
      <RegisterPage
        services={{ signUp: never, checkInvite: () => Promise.resolve({ valid: true as const }) }}
      />
    </Page>
  ),
}

export const RegisterInviteRefused: Story = {
  render: () => (
    <Page hash="#invite=AAAAAAAAAAAAAAAA">
      <RegisterPage services={{ signUp: never, checkInvite: fail('INVITE_INVALID') }} />
    </Page>
  ),
}

export const CheckInbox: Story = {
  parameters: { route: '/check-email' },
  render: () => (
    <Page>
      <CheckEmailPage
        services={{
          requestVerification: () => Promise.resolve({ status: 'accepted' as const }),
          consumeVerification: () => Promise.resolve(ok),
        }}
      />
    </Page>
  ),
}

export const ConfirmEmailFromLink: Story = {
  render: () => (
    <Page hash={`#token=${TOKEN}`}>
      <VerifyEmailPage
        services={{
          requestVerification: () => Promise.resolve({ status: 'accepted' as const }),
          consumeVerification: () => Promise.resolve(ok),
        }}
      />
    </Page>
  ),
}

export const EmailLinkInvalid: Story = {
  render: () => (
    <Page hash="#token=nonsense">
      <VerifyEmailPage
        services={{
          requestVerification: () => Promise.resolve({ status: 'accepted' as const }),
          consumeVerification: fail('AUTH_CHALLENGE_INVALID'),
        }}
      />
    </Page>
  ),
}

export const ForgotPassword: Story = {
  render: () => (
    <Page>
      <ForgotPasswordPage services={{ requestPasswordReset: never }} />
    </Page>
  ),
}

export const ResetPassword: Story = {
  render: () => (
    <Page hash={`#token=${TOKEN}`}>
      <ResetPasswordPage services={{ consumePasswordReset: never }} />
    </Page>
  ),
}

export const ResetLinkInvalid: Story = {
  render: () => (
    <Page>
      <ResetPasswordPage services={{ consumePasswordReset: never }} />
    </Page>
  ),
}
