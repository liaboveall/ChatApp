import { privacyPolicySchema } from '@chatapp/contracts'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Banner } from '@/components/ui/feedback.tsx'
import { api } from '@/lib/api.ts'
import { m } from '@/paraglide/messages.js'

export function PrivacyPage() {
  const policy = useQuery({
    queryKey: ['public-privacy'],
    queryFn: () => api('/api/privacy', { schema: privacyPolicySchema }),
    staleTime: 0,
  })
  const sections = [
    [m.privacy_admin_title(), m.privacy_admin()],
    [m.privacy_ai_title(), m.privacy_ai()],
    [m.privacy_delete_title(), m.privacy_delete()],
    [m.privacy_account_title(), m.privacy_account()],
    [m.privacy_local_title(), m.privacy_local()],
    [m.privacy_identity_title(), m.privacy_identity()],
    [m.privacy_monitoring_title(), m.privacy_monitoring()],
  ]
  return (
    <article className="privacy-page glass-text squircle scroll">
      <h1 className="text-title-1">{m.privacy_title()}</h1>
      {sections.map(([title, text]) => (
        <section key={title}>
          <h2 className="text-title-3">{title}</h2>
          <p>{text}</p>
          {title === m.privacy_delete_title() ? (
            policy.data ? (
              <p>{m.privacy_retention({ days: policy.data.runContentDays })}</p>
            ) : (
              <Banner tone={policy.isError ? 'danger' : 'info'}>
                {policy.isError ? m.common_retry() : m.common_loading()}
              </Banner>
            )
          ) : null}
        </section>
      ))}
      <nav aria-label={m.privacy_title()}>
        <Link to="/">{m.admin_home()}</Link>
        <Link to="/login">{m.register_login_link()}</Link>
      </nav>
    </article>
  )
}
