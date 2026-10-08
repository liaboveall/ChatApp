/**
 * A destination as one person may see it right now (approval cards, task lists): a conversation they are no longer in
 * is `null`, never its stale name, so a card cannot reveal what the person lost access to (docs/02 section 6, A4).
 */
import { AppError, type ConversationRef } from '@chatapp/contracts'
import { conversationMembers, type DbOrTx } from '@chatapp/db'
import { and, eq, ne } from 'drizzle-orm'
import { enforce, loadAccess } from './authorize.ts'
import { loadUserSummaries } from './users.ts'

export async function conversationRefFor(
  db: DbOrTx,
  viewerId: string,
  conversationId: string | null,
  now: Date,
): Promise<ConversationRef | null> {
  if (!conversationId) return null
  try {
    const access = await loadAccess(db, viewerId, conversationId)
    enforce(access, { userId: viewerId, siteRole: 'user' }, 'read_messages', now)
    if (!access.member) return null
    const conversation = access.conversation
    let peer: ConversationRef['peer'] = null
    if (conversation.kind === 'dm') {
      const [other] = await db
        .select({ userId: conversationMembers.userId })
        .from(conversationMembers)
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            ne(conversationMembers.userId, viewerId),
          ),
        )
      peer = other
        ? ((await loadUserSummaries(db, [other.userId])).get(other.userId) ?? null)
        : null
    }
    return { id: conversation.id, kind: conversation.kind, name: conversation.name, peer }
  } catch (error) {
    if (error instanceof AppError && (error.status === 403 || error.status === 404)) return null
    throw error
  }
}
