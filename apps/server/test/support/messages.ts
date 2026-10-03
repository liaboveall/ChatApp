/**
 * Bulk fixtures for message tests. The API limits how fast one person can send (10 per 10 seconds), so tests that need
 * dozens of messages write them straight into the tables, the way the domain would: next sequence numbers, a log entry
 * each, the conversation counters moved. The rows are ordinary; only the path to them is shorter.
 */
import { conversationChanges, conversations, type Db, messages } from '@chatapp/db'
import { eq } from 'drizzle-orm'

export type SeedOptions = {
  count: number
  /** Null writes system lines. */
  senderId: string | null
  /** Defaults to "m<seq>". */
  body?: (seq: number) => string
  executionSource?: 'interactive' | 'offline_replay' | 'agent_effect' | 'scheduled' | 'system'
  at?: Date
}

/** Inserts `count` messages after the current end of the conversation and returns their sequence numbers. */
export async function seedMessages(
  db: Db,
  conversationId: string,
  options: SeedOptions,
): Promise<number[]> {
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
  if (!conversation) throw new Error('conversation not found')
  const at = options.at ?? new Date()
  const seqs: number[] = []
  const rows: Array<typeof messages.$inferInsert> = []
  const log: Array<typeof conversationChanges.$inferInsert> = []
  for (let i = 1; i <= options.count; i += 1) {
    const seq = conversation.lastSeq + i
    const changeSeq = conversation.lastChangeSeq + i
    const id = crypto.randomUUID()
    seqs.push(seq)
    rows.push({
      id,
      conversationId,
      seq,
      changeSeq,
      senderId: options.senderId,
      kind: options.senderId === null ? 'system' : 'user',
      body: options.senderId === null ? null : (options.body?.(seq) ?? `m${seq}`),
      executionSource:
        options.executionSource ?? (options.senderId === null ? 'system' : 'interactive'),
      createdAt: at,
    })
    log.push({ conversationId, changeSeq, messageId: id, kind: 'message_created', createdAt: at })
  }
  await db.insert(messages).values(rows)
  await db.insert(conversationChanges).values(log)
  await db
    .update(conversations)
    .set({
      lastSeq: conversation.lastSeq + options.count,
      lastChangeSeq: conversation.lastChangeSeq + options.count,
      lastMessageAt: at,
    })
    .where(eq(conversations.id, conversationId))
  return seqs
}
