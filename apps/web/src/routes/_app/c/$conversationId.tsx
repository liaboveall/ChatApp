import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { ConversationScreen } from '@/features/conversations/conversation-screen.tsx'

/** `/c/<id>`: one conversation. The screen fills the panel and scrolls inside itself (`layout: 'fill'`). */
export const Route = createFileRoute('/_app/c/$conversationId')({
  staticData: { layout: 'fill' },
  component: ConversationRoute,
})

function ConversationRoute() {
  const { conversationId } = Route.useParams()
  const { me } = Route.useRouteContext()
  // Anything that is not an id is "no such conversation", the same as an id nobody has.
  const id = z.uuid().safeParse(conversationId)
  return (
    <ConversationScreen
      id={id.success ? id.data : '00000000-0000-4000-8000-000000000000'}
      meId={me.id}
    />
  )
}
