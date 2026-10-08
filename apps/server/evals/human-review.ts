import { z } from 'zod'
import { evaluationThresholds, hash, type SummaryTask } from './dataset.ts'
import { average } from './metrics.ts'

export const humanReviewSchema = z.strictObject({
  datasetHash: z.string().regex(/^[a-f0-9]{64}$/),
  reviewer: z.string().trim().min(1),
  reviewedAt: z.iso.datetime(),
  goldReviewed: z.literal(true),
  tasks: z.array(
    z.strictObject({
      taskId: z.string(),
      repeat: z.number().int().min(1).max(evaluationThresholds.repeats),
      outputFile: z.string(),
      outputSha256: z.string().regex(/^[a-f0-9]{64}$/),
      supportedFacts: z.number().int().nonnegative(),
      totalVerifiableFacts: z.number().int().positive(),
      correctRequiredFacts: z.number().int().nonnegative(),
      criticalFabrications: z.number().int().nonnegative(),
      notes: z.string().optional(),
      candidate: z.unknown().optional(),
    }),
  ),
})
export function scoreHumanReview(
  datasetHash: string,
  tasks: SummaryTask[],
  outputs: { taskId: string; repeat: number; output: string }[],
  raw: unknown,
) {
  if (tasks.length < 30) throw new Error('summary tasks incomplete')
  const review = humanReviewSchema.parse(raw)
  if (review.datasetHash !== datasetHash) throw new Error('review dataset changed')
  const seen = new Set<string>()
  const scores = review.tasks.map((entry) => {
    const task = tasks.find((t) => t.id === entry.taskId)
    const key = `${entry.taskId}-${entry.repeat}`
    const output = outputs.find((r) => r.taskId === entry.taskId && r.repeat === entry.repeat)
    if (!task || seen.has(key) || !output || entry.outputFile !== `${key}.json`)
      throw new Error('review task missing or duplicated')
    seen.add(key)
    if (entry.outputSha256 !== hash(output.output)) throw new Error('review output changed')
    if (
      entry.supportedFacts > entry.totalVerifiableFacts ||
      entry.correctRequiredFacts > task.required.length
    )
      throw new Error('review fact counts are inconsistent')
    return {
      taskId: entry.taskId,
      repeat: entry.repeat,
      coverage: entry.correctRequiredFacts / task.required.length,
      accuracy: entry.supportedFacts / entry.totalVerifiableFacts,
      criticalFabrications: entry.criticalFabrications,
    }
  })
  for (const task of tasks)
    for (let repeat = 1; repeat <= evaluationThresholds.repeats; repeat++)
      if (!seen.has(`${task.id}-${repeat}`)) throw new Error('review repetitions incomplete')
  const coverage = scores.map((s) => s.coverage)
  const accuracy = scores.map((s) => s.accuracy)
  const critical = scores.reduce((n, s) => n + s.criticalFabrications, 0)
  const worstCoverage = Math.min(...coverage)
  const worstAccuracy = Math.min(...accuracy)
  return {
    reviewer: review.reviewer,
    reviewedAt: review.reviewedAt,
    goldReviewed: review.goldReviewed,
    repetitions: scores.length,
    meanCoverage: average(coverage),
    worstCoverage,
    meanAccuracy: average(accuracy),
    worstAccuracy,
    criticalFabrications: critical,
    scores,
    pass:
      worstCoverage >= evaluationThresholds.summaryCoverage &&
      worstAccuracy >= evaluationThresholds.summaryAccuracy &&
      critical === evaluationThresholds.criticalFabrications,
  }
}
