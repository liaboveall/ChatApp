import { z } from 'zod'
import { RETRIEVAL } from '../domain/embeddings.ts'

const qualitySchema = z.object({
  phase: z.literal('holdout'),
  sourceUnchanged: z.literal(true),
  datasetHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  modelVersion: z.string(),
  thresholds: z.object({
    rrfK: z.number(),
    candidates: z.number(),
    messageThreshold: z.number(),
    memoryThreshold: z.number(),
  }),
  result: z.object({
    queries: z.number().min(40),
    noAnswer: z.number().min(10),
    recall10: z.number().min(0.85),
    ndcg10: z.number().min(0.75),
    noAnswerFalsePositive: z.number().max(0.1),
  }),
  baseline: z.object({ ndcg10: z.number() }),
  synonym: z.object({ ndcg10: z.number() }),
  baselineSynonym: z.object({ ndcg10: z.number() }),
  memory: z.object({
    precision: z.number().min(0.9),
    hitRate: z.number().min(0.8),
    unrelatedRate: z.number().max(0.05),
  }),
  queries: z.array(z.object({ forbidden: z.literal(0) })).min(40),
  memoryQueries: z.array(z.unknown()).min(20),
})
const resourcesSchema = z.object({
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceUnchanged: z.literal(true),
  modelVersion: z.string(),
  architecture: z.literal('arm64'),
  cpuLimit: z.literal(2),
  native: z.literal(true),
  debian: z.literal(true),
  mixedLoad: z.literal(true),
  p95Ms: z.number().nonnegative().max(200),
  childPeakBytes: z
    .number()
    .positive()
    .max(1024 ** 3),
  workerPeakBytes: z
    .number()
    .positive()
    .max(1536 * 1024 ** 2),
  mediaPeakBytes: z
    .number()
    .positive()
    .max(512 * 1024 ** 2),
  modelFileBytes: z.number().positive().max(1_500_000_000),
})
/** Activation is refused on development-only or incomplete artifacts even if a summary boolean says pass. */
export function assertEmbeddingEvidence(
  modelVersion: string,
  quality: unknown,
  resources: unknown,
) {
  const q = qualitySchema.parse(quality),
    r = resourcesSchema.parse(resources)
  if (
    q.modelVersion !== modelVersion ||
    r.modelVersion !== modelVersion ||
    r.sourceHash !== q.sourceHash ||
    JSON.stringify(q.thresholds) !== JSON.stringify(RETRIEVAL) ||
    q.baseline.ndcg10 - q.result.ndcg10 > 0.01 ||
    q.synonym.ndcg10 - q.baselineSynonym.ndcg10 < 0.05 ||
    r.workerPeakBytes + r.mediaPeakBytes > 2 * 1024 ** 3
  )
    throw new Error('Embedding quality/resource gate failed; retain the active generation')
  return { quality: q, resources: r }
}
