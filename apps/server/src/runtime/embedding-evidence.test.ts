import { describe, expect, test } from 'bun:test'
import { RETRIEVAL } from '../domain/embeddings.ts'
import { assertEmbeddingEvidence } from './embedding-evidence.ts'

const quality = {
  phase: 'holdout',
  sourceUnchanged: true,
  datasetHash: 'a'.repeat(64),
  sourceHash: 'b'.repeat(64),
  modelVersion: 'test-model',
  thresholds: RETRIEVAL,
  result: { queries: 40, noAnswer: 12, recall10: 0.9, ndcg10: 0.8, noAnswerFalsePositive: 0 },
  baseline: { ndcg10: 0.8 },
  synonym: { ndcg10: 0.8 },
  baselineSynonym: { ndcg10: 0.5 },
  memory: { precision: 1, hitRate: 1, unrelatedRate: 0 },
  queries: Array.from({ length: 40 }, () => ({ forbidden: 0 })),
  memoryQueries: Array.from({ length: 20 }, () => ({})),
}
const resources = {
  sourceHash: quality.sourceHash,
  sourceUnchanged: true,
  modelVersion: 'test-model',
  architecture: 'arm64',
  cpuLimit: 2,
  native: true,
  debian: true,
  mixedLoad: true,
  p95Ms: 190,
  childPeakBytes: 900 * 1024 ** 2,
  workerPeakBytes: 1400 * 1024 ** 2,
  mediaPeakBytes: 400 * 1024 ** 2,
  modelFileBytes: 624_962_643,
}
describe('model activation evidence', () => {
  test('requires actual held-out metrics and native mixed-load artifacts, not pass booleans', () => {
    expect(() =>
      assertEmbeddingEvidence(
        'test-model',
        { modelVersion: 'test-model', qualityPass: true, armResourcesPass: true },
        resources,
      ),
    ).toThrow()
    expect(() =>
      assertEmbeddingEvidence('test-model', quality, { ...resources, architecture: 'x64' }),
    ).toThrow()
    expect(() =>
      assertEmbeddingEvidence('test-model', quality, { ...resources, mixedLoad: false }),
    ).toThrow()
    expect(() =>
      assertEmbeddingEvidence('test-model', { ...quality, sourceUnchanged: false }, resources),
    ).toThrow()
  })
  test('rejects changed thresholds, permission leaks, wrong generation and missing memory quality', () => {
    expect(() =>
      assertEmbeddingEvidence('test-model', quality, { ...resources, sourceHash: 'c'.repeat(64) }),
    ).toThrow()
    expect(() => assertEmbeddingEvidence('test-model', quality, resources)).not.toThrow()
    for (const q of [
      { ...quality, thresholds: { ...RETRIEVAL, memoryThreshold: 0 } },
      { ...quality, queries: Array.from({ length: 40 }, () => ({ forbidden: 1 })) },
      { ...quality, modelVersion: 'other' },
      { ...quality, memory: { precision: 1, hitRate: 0.79, unrelatedRate: 0 } },
    ])
      expect(() => assertEmbeddingEvidence('test-model', q, resources)).toThrow()
    expect(() =>
      assertEmbeddingEvidence('test-model', quality, { ...resources, p95Ms: 201 }),
    ).toThrow()
    expect(() =>
      assertEmbeddingEvidence('test-model', quality, {
        ...resources,
        workerPeakBytes: 1537 * 1024 ** 2,
      }),
    ).toThrow()
  })
})
