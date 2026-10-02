import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { AppIcon } from '@/components/brand/app-icon.tsx'
import { Wallpaper } from '@/components/layout/wallpaper.tsx'
import { Icon } from '@/components/ui/icon.tsx'
import { cx } from '@/lib/cx.ts'
import { m } from '@/paraglide/messages.js'

/** Full-window background for the pages before sign-in. No third-party resources and nothing that needs a session. */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="window">
      <a className="skip-link" href="#main">
        {m.shell_skip_to_content()}
      </a>
      <Wallpaper variant="auth" />
      <div className="auth">
        <main className="auth__inner" id="main" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  )
}

export function AuthCard({ children }: { children: ReactNode }) {
  return <div className="auth-card glass-text squircle">{children}</div>
}

type AuthHeadProps = {
  title: ReactNode
  text?: ReactNode
  /** Without an icon the application icon is shown. */
  icon?: LucideIcon
  tone?: 'default' | 'ok' | 'bad'
}

export function AuthHead({ title, text, icon, tone = 'default' }: AuthHeadProps) {
  return (
    <div className="auth-head">
      {icon ? (
        <div
          className={cx(
            'auth-head__icon',
            tone === 'ok' && 'auth-head__icon--ok',
            tone === 'bad' && 'auth-head__icon--bad',
          )}
        >
          <Icon icon={icon} size={24} />
        </div>
      ) : (
        <AppIcon size={56} />
      )}
      <h1 className="text-title-1 text-balance">{title}</h1>
      {text ? <p className="text-body text-label-secondary text-pretty">{text}</p> : null}
    </div>
  )
}
