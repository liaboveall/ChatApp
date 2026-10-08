import type { AgentSource } from '@chatapp/contracts'
import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  customType,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { agentRuns } from './agent.ts'
import { jsonbValue } from './json.ts'
import { conversations, messages, users } from './tables.ts'

const ts = () => timestamp({ withTimezone: true })
const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => 'vector',
  toDriver: (value) => JSON.stringify(value),
  fromDriver: (value) => JSON.parse(value) as number[],
})
export const embeddingModels = pgTable(
  'embedding_models',
  {
    version: text().primaryKey(),
    dimension: integer().notNull(),
    status: text().$type<'staging' | 'active' | 'retired'>().notNull(),
    backfillCursor: uuid(),
    createdAt: ts().notNull(),
  },
  (t) => [
    uniqueIndex('embedding_models_one_active').on(t.status).where(sql`${t.status} = 'active'`),
    check('embedding_models_dimension', sql`${t.dimension} in (512, 1024)`),
    check('embedding_models_status', sql`${t.status} in ('staging','active','retired')`),
  ],
)
export const messageEmbeddings = pgTable(
  'message_embeddings',
  {
    messageId: uuid()
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    conversationId: uuid()
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    seq: bigint({ mode: 'number' }).notNull(),
    contentVersion: bigint({ mode: 'number' }).notNull(),
    modelVersion: text()
      .notNull()
      .references(() => embeddingModels.version),
    dimension: integer().notNull(),
    embedding: vector().notNull(),
    createdAt: ts().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.modelVersion] }),
    index('message_embeddings_conversation_seq').on(t.conversationId, t.seq),
    check(
      'message_embeddings_dimension',
      sql`vector_dims(${t.embedding}) = ${t.dimension} and ${t.dimension} in (512,1024)`,
    ),
    index('message_embeddings_bge_hnsw')
      .using('hnsw', sql`(${t.embedding}::vector(512)) vector_cosine_ops`)
      .where(sql`${t.modelVersion} = 'bge-small-zh-q8-75c43b06'`),
    index('message_embeddings_qwen_hnsw')
      .using('hnsw', sql`(${t.embedding}::vector(1024)) vector_cosine_ops`)
      .where(sql`${t.modelVersion} = 'qwen3-06b-q8-c25a394d'`),
  ],
)
export const agentMemories = pgTable(
  'agent_memories',
  {
    id: uuid().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    content: text(),
    source: text().$type<'user' | 'agent'>().notNull(),
    createdByRunId: uuid().references(() => agentRuns.id, { onDelete: 'set null' }),
    privacyClass: text().$type<'standard' | 'byok_private'>().notNull().default('byok_private'),
    contentVersion: bigint({ mode: 'number' }).notNull().default(1),
    sourceManifest: jsonbValue<AgentSource[]>().notNull().default([]),
    embedding: vector(),
    modelVersion: text(),
    dimension: integer(),
    siteConsentAt: ts(),
    createdAt: ts().notNull(),
    deletedAt: ts(),
  },
  (t) => [
    index('agent_memories_user').on(t.userId),
    check(
      'agent_memories_content',
      sql`${t.content} is null or char_length(${t.content}) between 1 and 500`,
    ),
    check('agent_memories_privacy', sql`${t.privacyClass} in ('standard','byok_private')`),
    check(
      'agent_memories_vector',
      sql`${t.embedding} is null or vector_dims(${t.embedding}) = ${t.dimension}`,
    ),
    index('agent_memories_bge_hnsw')
      .using('hnsw', sql`(${t.embedding}::vector(512)) vector_cosine_ops`)
      .where(sql`${t.deletedAt} is null and ${t.modelVersion} = 'bge-small-zh-q8-75c43b06'`),
    index('agent_memories_qwen_hnsw')
      .using('hnsw', sql`(${t.embedding}::vector(1024)) vector_cosine_ops`)
      .where(sql`${t.deletedAt} is null and ${t.modelVersion} = 'qwen3-06b-q8-c25a394d'`),
  ],
)
export const agentConversationState = pgTable('agent_conversation_state', {
  conversationId: uuid()
    .primaryKey()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  contextEpoch: uuid().notNull(),
  keySource: text().$type<'site' | 'user'>().notNull(),
  privacyClass: text().$type<'standard' | 'byok_private'>().notNull(),
  sourceManifest: jsonbValue<AgentSource[]>().notNull().default([]),
  summary: text(),
  summarizedThroughSeq: bigint({ mode: 'number' }).notNull(),
  expiresAt: ts().notNull(),
  updatedAt: ts().notNull(),
})
/** Separate generations preserve active vectors while a model is staged and allow a dimension rollback. */
export const memoryEmbeddings = pgTable(
  'memory_embeddings',
  {
    memoryId: uuid()
      .notNull()
      .references(() => agentMemories.id, { onDelete: 'cascade' }),
    modelVersion: text()
      .notNull()
      .references(() => embeddingModels.version),
    contentVersion: bigint({ mode: 'number' }).notNull(),
    dimension: integer().notNull(),
    embedding: vector().notNull(),
    createdAt: ts().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.memoryId, t.modelVersion] }),
    check(
      'memory_embeddings_dimension',
      sql`vector_dims(${t.embedding}) = ${t.dimension} and ${t.dimension} in (512,1024)`,
    ),
    index('memory_embeddings_bge_hnsw')
      .using('hnsw', sql`(${t.embedding}::vector(512)) vector_cosine_ops`)
      .where(sql`${t.modelVersion} = 'bge-small-zh-q8-75c43b06'`),
    index('memory_embeddings_qwen_hnsw')
      .using('hnsw', sql`(${t.embedding}::vector(1024)) vector_cosine_ops`)
      .where(sql`${t.modelVersion} = 'qwen3-06b-q8-c25a394d'`),
  ],
)
