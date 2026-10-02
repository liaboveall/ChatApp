import { createFileRoute, Outlet } from '@tanstack/react-router'
import { AuthLayout } from '@/features/auth/auth-layout.tsx'

/**
 * Pages opened from an email link. They work whether or not someone is signed in in this browser: redirecting a signed-in
 * visitor away would throw the one-time credential in the address away.
 */
export const Route = createFileRoute('/_public')({ component: PublicLayout })

function PublicLayout() {
  return (
    <AuthLayout>
      <Outlet />
    </AuthLayout>
  )
}
