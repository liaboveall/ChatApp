import { type ErrorComponentProps, Link, useRouter, useRouterState } from '@tanstack/react-router'
import { CircleAlert, Compass, WifiOff } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Spinner } from '@/components/ui/feedback.tsx'
import { AuthCard, AuthHead, AuthLayout } from '@/features/auth/auth-layout.tsx'
import { ApiError } from '@/lib/api.ts'
import { usePageTitle } from '@/lib/page-title.ts'
import { m } from '@/paraglide/messages.js'

export function NotFound() {
  usePageTitle(m.not_found_title())
  return (
    <AuthLayout>
      <AuthCard>
        <AuthHead icon={Compass} title={m.not_found_title()} text={m.not_found_text()} />
        <Link to="/" className="btn btn--filled btn--lg btn--block no-underline">
          {m.not_found_action()}
        </Link>
      </AuthCard>
    </AuthLayout>
  )
}

/**
 * The page could not be opened because there is no connection (a cold start with the network down, M6): the app shell is
 * here, but who is signed in cannot be checked, and nothing of an account is shown before it is (D-070). It tries again by
 * itself when the network returns.
 */
function OfflineScreen({ reset }: { reset: () => void }) {
  usePageTitle(m.route_offline_title())
  const router = useRouter()
  // `reset` only clears the error boundary; the identity check that failed (a `beforeLoad`) runs again on an invalidate.
  const retry = useCallback(() => {
    reset()
    void router.invalidate()
  }, [reset, router])
  useEffect(() => {
    window.addEventListener('online', retry)
    return () => window.removeEventListener('online', retry)
  }, [retry])
  return (
    <AuthLayout>
      <AuthCard>
        <AuthHead
          icon={WifiOff}
          tone="bad"
          title={m.route_offline_title()}
          text={m.route_offline_text()}
        />
        <button type="button" className="btn btn--filled btn--lg btn--block" onClick={retry}>
          {m.common_retry()}
        </button>
      </AuthCard>
    </AuthLayout>
  )
}

export function RouteError({ error, reset }: ErrorComponentProps) {
  usePageTitle(m.route_error_title())
  const router = useRouter()
  if (error instanceof ApiError && error.code === 'NETWORK') return <OfflineScreen reset={reset} />
  return (
    <AuthLayout>
      <AuthCard>
        <AuthHead
          icon={CircleAlert}
          tone="bad"
          title={m.route_error_title()}
          text={m.route_error_text()}
        />
        <button
          type="button"
          className="btn btn--filled btn--lg btn--block"
          onClick={() => {
            reset()
            void router.invalidate()
          }}
        >
          {m.common_retry()}
        </button>
      </AuthCard>
    </AuthLayout>
  )
}

/** Shown while the first identity check is in flight (after a slow start). */
export function Splash() {
  return (
    <AuthLayout>
      <div className="grid place-items-center py-16">
        <Spinner label={m.common_loading()} />
      </div>
    </AuthLayout>
  )
}

/**
 * Tells screen readers that a new page has opened. A single-page app does not reload, so nothing else would: the document
 * title (set by every page) is read out after each navigation, from a polite live region that is otherwise invisible.
 */
export function RouteAnnouncer() {
  const location = useRouterState({ select: (state) => state.location.pathname })
  const [text, setText] = useState('')
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the page changes; the title is read after the page set it.
  useEffect(() => {
    const timer = setTimeout(() => setText(document.title), 100)
    return () => clearTimeout(timer)
  }, [location])
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {text}
    </div>
  )
}
