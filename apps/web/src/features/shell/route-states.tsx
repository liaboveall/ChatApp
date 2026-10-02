import { type ErrorComponentProps, Link, useRouterState } from '@tanstack/react-router'
import { CircleAlert, Compass } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Spinner } from '@/components/ui/feedback.tsx'
import { AuthCard, AuthHead, AuthLayout } from '@/features/auth/auth-layout.tsx'
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

export function RouteError({ reset }: ErrorComponentProps) {
  usePageTitle(m.route_error_title())
  return (
    <AuthLayout>
      <AuthCard>
        <AuthHead
          icon={CircleAlert}
          tone="bad"
          title={m.route_error_title()}
          text={m.route_error_text()}
        />
        <button type="button" className="btn btn--filled btn--lg btn--block" onClick={reset}>
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
