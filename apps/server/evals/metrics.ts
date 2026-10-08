import type { EvalQuery, SummaryTask } from './dataset.ts'

export function retrievalScore(query: EvalQuery, rawIds: string[]) {
  const ids = [...new Set(rawIds)].slice(0, 10)
  const grades = new Map(query.relevance.map((r) => [r.messageId, r.grade]))
  const gain = (grade: number, rank: number) => (2 ** grade - 1) / Math.log2(rank + 2)
  const ideal = [...grades.values()]
    .sort((a, b) => b - a)
    .slice(0, 10)
    .reduce((n, g, r) => n + gain(g, r), 0)
  const dcg = ids.reduce((n, id, r) => n + gain(grades.get(id) ?? 0, r), 0)
  return {
    answerable: grades.size > 0,
    recall10: grades.size ? ids.filter((id) => grades.has(id)).length / grades.size : null,
    ndcg10: ideal ? dcg / ideal : null,
    falsePositive: grades.size === 0 && ids.length > 0,
  }
}
export const average = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
export function aggregateRetrieval(scores: ReturnType<typeof retrievalScore>[]) {
  const answerable = scores.filter((s) => s.answerable)
  const noAnswer = scores.filter((s) => !s.answerable)
  return {
    queries: scores.length,
    answerable: answerable.length,
    noAnswer: noAnswer.length,
    recall10: average(answerable.map((s) => s.recall10 ?? 0)),
    ndcg10: average(answerable.map((s) => s.ndcg10 ?? 0)),
    noAnswerFalsePositive: noAnswer.length
      ? noAnswer.filter((s) => s.falsePositive).length / noAnswer.length
      : 0,
  }
}
const normal = (s: string) => s.replace(/[,，\s]/g, '').toLowerCase()
/** An automated aid only. It cannot decide whether every natural-language fact has a valid source. */
export function summaryCandidateScore(task: SummaryTask, output: string) {
  const text = normal(output)
  const matched = task.required.map((fact) => ({
    text: fact.text,
    present: fact.matches.some((value) => text.includes(normal(value))),
    cited: fact.sourceIds.some((id) => output.includes(id)),
    sourceIds: fact.sourceIds,
  }))
  const knownAmounts = new Set(
    [...task.required, ...task.optional].flatMap((f) => f.matches).filter((s) => /^\d+$/.test(s)),
  )
  const amounts = [...text.matchAll(/(\d+(?:\.\d+)?)元/g)].map((m) => m[1] ?? '')
  const unsupportedAmounts = amounts.filter((amount) => !knownAmounts.has(amount))
  const forbidden = task.forbidden.filter((s) => output.includes(s))
  return {
    coverageCandidate: matched.filter((f) => f.present).length / matched.length,
    citedRequiredFacts: matched.filter((f) => f.present && f.cited).length,
    matched,
    unsupportedAmounts,
    forbidden,
    humanAccuracy: null,
    humanCriticalFabrications: null,
  }
}
