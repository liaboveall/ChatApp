import { createFileRoute } from '@tanstack/react-router'
import { JoinPage } from '@/features/conversations/join-page.tsx'

/** `/join#<code>`: a group invitation link. Public, because the fragment has to be read before deciding where to go. */
export const Route = createFileRoute('/_public/join')({ component: JoinPage })
