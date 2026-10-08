#!/usr/bin/env bun
/** Consume an actual human worksheet; neither mocks nor automatic keyword scores certify factual accuracy. */
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { hash, loadDataset, verifyFreeze } from './dataset.ts'
import { scoreHumanReview } from './human-review.ts'

const args = process.argv.slice(2).filter((arg) => arg !== '--')
if (args.length !== 1) {
  console.error('usage: bun run eval:review <result-directory>')
  process.exit(1)
}
const directory = resolve(args[0] ?? '')
try {
  const freeze = await verifyFreeze()
  const data = await loadDataset()
  const report = z
    .object({
      runId: z.uuid(),
      datasetHash: z.string(),
      mode: z.literal('real_provider'),
      complete: z.literal(true),
      automatedExecutionPass: z.boolean(),
      automatedSecurityPass: z.boolean(),
      automatedRetrievalPass: z.boolean(),
    })
    .parse(JSON.parse(await readFile(join(directory, 'report.json'), 'utf8')))
  if (report.datasetHash !== freeze.datasetHash) throw new Error('report dataset changed')
  const outputs: { taskId: string; repeat: number; output: string }[] = []
  for (const task of data.summaries) {
    for (let repeat = 1; repeat <= 3; repeat++) {
      const row = z
        .object({
          taskId: z.literal(task.id),
          repeat: z.literal(repeat),
          runId: z.uuid(),
          output: z.string(),
          status: z.literal('completed'),
        })
        .parse(JSON.parse(await readFile(join(directory, `${task.id}-${repeat}.json`), 'utf8')))
      outputs.push(row)
    }
  }
  const raw = await readFile(join(directory, 'human-review.json'), 'utf8')
  const summary = scoreHumanReview(freeze.datasetHash, data.summaries, outputs, JSON.parse(raw))
  const pass =
    report.automatedExecutionPass &&
    report.automatedSecurityPass &&
    report.automatedRetrievalPass &&
    summary.pass
  await writeFile(
    join(directory, 'reviewed-report.json'),
    `${JSON.stringify(
      {
        runId: report.runId,
        datasetHash: freeze.datasetHash,
        humanReviewHash: hash(raw),
        summary,
        gate: pass ? 'evaluation_pass' : 'evaluation_failed',
        userTrial: 'pending',
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )
  console.log(
    `eval-review: ${pass ? 'pass' : 'failed'}; summary coverage=${summary.worstCoverage}, accuracy=${summary.worstAccuracy}, critical=${summary.criticalFabrications}`,
  )
  process.exitCode = pass ? 0 : 1
} catch {
  console.error('eval-review: incomplete or invalid evidence/worksheet; no acceptance certified')
  process.exitCode = 1
}
