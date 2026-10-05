import { createFileRoute } from '@tanstack/react-router'
import { ArchivedPage } from '@/features/conversations/archived-page.tsx'

export const Route = createFileRoute('/_app/archived')({ component: ArchivedPage })
