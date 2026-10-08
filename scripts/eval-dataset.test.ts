import { expect, test } from 'bun:test'
import { capacityProjection } from '../apps/server/evals/capacity.ts'
import { hash, loadDataset, validateDataset, verifyFreeze } from '../apps/server/evals/dataset.ts'
import { evaluationExitCode } from '../apps/server/evals/exit.ts'
import { scoreHumanReview } from '../apps/server/evals/human-review.ts'
import {
  aggregateRetrieval,
  retrievalScore,
  summaryCandidateScore,
} from '../apps/server/evals/metrics.ts'

test('full evaluation fails when retrieval alone fails and keeps smoke, mock and pending review distinct', () => {
  const full = {
    mock: false,
    smoke: false,
    executionError: false,
    assertionsPass: true,
    automatedGatesPass: true,
  }
  expect(evaluationExitCode(full)).toBe(2)
  expect(evaluationExitCode({ ...full, automatedGatesPass: false })).toBe(1)
  expect(evaluationExitCode({ ...full, assertionsPass: false })).toBe(1)
  expect(evaluationExitCode({ ...full, smoke: true, automatedGatesPass: false })).toBe(0)
  expect(evaluationExitCode({ ...full, mock: true, automatedGatesPass: false })).toBe(0)
  expect(evaluationExitCode({ ...full, mock: true, executionError: true })).toBe(1)
  expect(evaluationExitCode({ ...full, smoke: true, assertionsPass: false })).toBe(1)
})

test('frozen evaluation corpus has disjoint conversations and intents and rejects unauthorized labels', async () => {
  const dataset = await loadDataset()
  expect((await verifyFreeze()).datasetHash).toMatch(/^[0-9a-f]{64}$/)
  const query = dataset.queries.find((q) => q.relevance.length)
  const privateMessage = dataset.messages.find((m) => m.visibility === 'byok_private')
  if (!query || !privateMessage) throw new Error('missing fixture')
  expect(() =>
    validateDataset({
      ...dataset,
      queries: dataset.queries.map((q) =>
        q.id === query.id ? { ...q, relevance: [{ messageId: privateMessage.id, grade: 2 }] } : q,
      ),
    }),
  ).toThrow('unauthorized relevance')
  const hold = dataset.queries.find((q) => q.split === 'holdout')
  const dev = dataset.queries.find((q) => q.split === 'dev')
  if (!hold || !dev) throw new Error('missing split')
  expect(() =>
    validateDataset({
      ...dataset,
      queries: dataset.queries.map((q) =>
        q.id === hold.id ? { ...q, intentGroup: dev.intentGroup } : q,
      ),
    }),
  ).toThrow('intent split leakage')
})
test('retrieval metrics count lost relevance and no-answer false positives without rewarding duplicates', () => {
  const q = {
    id: 'test',
    split: 'holdout' as const,
    intentGroup: 'test',
    conversationId: crypto.randomUUID(),
    category: 'short' as const,
    query: '部署',
    toolQuery: '部署',
    relevance: [
      { messageId: 'a', grade: 2 as const },
      { messageId: 'b', grade: 1 as const },
    ],
  }
  const score = retrievalScore(q, ['a', 'a', 'irrelevant'])
  expect(score.recall10).toBe(0.5)
  expect(score.ndcg10).toBeLessThan(1)
  const combined = aggregateRetrieval([score, retrievalScore({ ...q, relevance: [] }, ['a'])])
  expect(combined.noAnswerFalsePositive).toBe(1)
  expect(combined.answerable).toBe(1)
})
test('summary assistance does not certify empty answers, invented amounts, or human accuracy', async () => {
  const task = (await loadDataset()).summaries[0]
  if (!task) throw new Error('missing summary')
  expect(summaryCandidateScore(task, '').coverageCandidate).toBe(0)
  const score = summaryCandidateScore(task, '预算999999元，已经代发')
  expect(score.unsupportedAmounts).toEqual(['999999'])
  expect(score.forbidden).toContain('已经代发')
  expect(score.humanAccuracy).toBeNull()
})

test('human fact review requires every repetition, matching outputs and consistent fact counts', async () => {
  const tasks = (await loadDataset()).summaries
  const datasetHash = (await verifyFreeze()).datasetHash
  const outputs = tasks.flatMap((task) =>
    [1, 2, 3].map((repeat) => ({ taskId: task.id, repeat, output: 'synthetic test output' })),
  )
  const entries = outputs
    .map((r) => ({
      ...r,
      outputFile: `${r.taskId}-${r.repeat}.json`,
      outputSha256: hash(r.output),
      supportedFacts: 4,
      totalVerifiableFacts: 4,
      correctRequiredFacts: 4,
      criticalFabrications: 0,
    }))
    .map(({ output: _output, ...entry }) => entry)
  const review = {
    datasetHash,
    reviewer: 'unit-test-fixture',
    reviewedAt: '2026-10-07T00:00:00.000Z',
    goldReviewed: true,
    tasks: entries,
  }
  expect(scoreHumanReview(datasetHash, tasks, outputs, review).pass).toBe(true)
  expect(() =>
    scoreHumanReview(datasetHash, tasks, outputs, { ...review, reviewer: null }),
  ).toThrow()
  expect(() =>
    scoreHumanReview(datasetHash, tasks, outputs, { ...review, goldReviewed: false }),
  ).toThrow()
  expect(() =>
    scoreHumanReview(datasetHash, tasks, outputs, { ...review, tasks: entries.slice(1) }),
  ).toThrow('incomplete')
  expect(() =>
    scoreHumanReview(datasetHash, tasks, outputs, {
      ...review,
      tasks: [...entries.slice(1), entries[1]],
    }),
  ).toThrow('duplicated')
  expect(() =>
    scoreHumanReview(
      datasetHash,
      tasks,
      outputs.map((r, i) => (i ? r : { ...r, output: 'changed' })),
      review,
    ),
  ).toThrow('output changed')
  expect(() =>
    scoreHumanReview(datasetHash, tasks, outputs, {
      ...review,
      tasks: entries.map((e, i) => (i ? e : { ...e, supportedFacts: 5 })),
    }),
  ).toThrow('inconsistent')
  expect(
    scoreHumanReview(datasetHash, tasks, outputs, {
      ...review,
      tasks: entries.map((e, i) => (i ? e : { ...e, criticalFabrications: 1 })),
    }).pass,
  ).toBe(false)
  expect(
    scoreHumanReview(datasetHash, tasks, outputs, {
      ...review,
      tasks: entries.map((e, i) => (i ? e : { ...e, correctRequiredFacts: 3, supportedFacts: 3 })),
    }).pass,
  ).toBe(false)
})

test('capacity estimates include unknown usage and do not derive unlimited capacity from free calls', () => {
  const samples = [
    { durationMs: 1000, tokens: 1000, costMicroUsd: 100, unknownTokens: 0, unknownCostMicroUsd: 0 },
    { durationMs: 3000, tokens: 0, costMicroUsd: 0, unknownTokens: 2000, unknownCostMicroUsd: 300 },
  ]
  const paid = capacityProjection(samples, 500000, 20000000)
  expect(paid.meanTokens).toBe(1500)
  expect(paid.meanCostMicroUsd).toBe(200)
  expect(paid.currencyBudgetTasksEstimate).toBe(100000)
  expect(paid.durationMsP95).toBe(3000)
  const free = capacityProjection(
    samples.map((s) => ({ ...s, costMicroUsd: 0, unknownCostMicroUsd: 0 })),
    500000,
    0,
  )
  expect(free.currencyBudgetTasksEstimate).toBeNull()
  expect(
    free.scenarios.every((s) => s.estimatedMicroUsd === 0 && s.currencyBudgetDaysEstimate === null),
  ).toBe(true)
})
