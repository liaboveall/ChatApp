#!/usr/bin/env bun
/** V-01: bounded, synthetic selected-provider probes. No conversations or credentials in artifacts/console. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import {
  generateText,
  jsonSchema,
  stepCountIs,
  ToolLoopAgent,
  tool,
} from '../apps/server/node_modules/ai'
import { type AiConfig, loadAiConfig } from '../apps/server/src/config/ai.ts'
import { ConfigError } from '../apps/server/src/config/env.ts'
import { AiBudgetError, type AiPrice } from '../apps/server/src/domain/ai-budget.ts'
import {
  type AiCallEvidence,
  AiTransportError,
  aiProviderOptions,
  denyAiDownloads,
  guardedAiModel,
} from '../apps/server/src/runtime/ai.ts'
import { ExperimentLedger } from './lib/ai-experiment-ledger.ts'
import { getEnv, readEnvFile } from './lib/env-file.ts'

const env = await readEnvFile('.env.local')
const source: Record<string, string | undefined> = {}
for (const line of env.lines) {
  const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1]
  if (key) source[key] = getEnv(env, key)
}
// Never inherit the test runner's environment or an ambient API key; read the approved local configuration explicitly.
let config: AiConfig
try {
  config = loadAiConfig({ ...source, APP_ENV: 'development' })
} catch (error) {
  console.error(
    `m4-provider: ${error instanceof ConfigError ? error.problems.join('; ') : 'invalid AI configuration'}`,
  )
  process.exit(1)
}
if (
  config.provider === 'mock' ||
  !config.apiKey ||
  (config.provider === 'deepseek' && config.experimentMicroUsd === 0)
) {
  console.error(
    'm4-provider: configure the selected provider key; paid providers also need an experiment reservation',
  )
  process.exit(1)
}
const args = process.argv.slice(2)
const filter = args[0] === '--case' ? args[1] : undefined
if (args.length > 0 && (args[0] !== '--case' || args.length !== 2 || !filter)) {
  console.error('usage: bun run test:m4:provider [--case label-substring]')
  process.exit(1)
}
const runId = randomUUID()
const dir = join('.test-runs', 'm4', runId)
await mkdir(dir, { recursive: true, mode: 0o700 })
const ledger = new ExperimentLedger(
  join(
    '.test-runs',
    'm4',
    config.provider === 'soclaas' ? 'soclaas-usage.sqlite' : 'experiment-budget.sqlite',
  ),
  config.provider === 'soclaas' ? 0 : config.experimentMicroUsd,
)
type Result = {
  name: string
  status: 'pass' | 'fail'
  elapsedMs: number
  evidence: AiCallEvidence[]
  checks?: Record<string, unknown>
  error?: string
}
const results: Result[] = []
const revision = (
  await new Response(Bun.spawn(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe' }).stdout).text()
).trim()
const assert = (condition: unknown, code: string): void => {
  if (!condition) throw new Error(`probe:${code}`)
}

// Generated locally from raw pixels, with no image decoding and no external image service.
function redSquare(): Buffer {
  const crc = (bytes: Buffer): number => {
    let value = 0xffffffff
    for (const byte of bytes) {
      value ^= byte
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
    }
    return (value ^ 0xffffffff) >>> 0
  }
  const chunk = (name: string, bytes: Buffer) => {
    const type = Buffer.from(name)
    const length = Buffer.alloc(4)
    length.writeUInt32BE(bytes.length)
    const checksum = Buffer.alloc(4)
    checksum.writeUInt32BE(crc(Buffer.concat([type, bytes])))
    return Buffer.concat([length, type, bytes, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(64, 0)
  header.writeUInt32BE(64, 4)
  header[8] = 8
  header[9] = 2
  const pixels = Buffer.alloc((64 * 3 + 1) * 64)
  for (let row = 0; row < 64; row++)
    for (let col = 0; col < 64; col++) pixels[row * 193 + 1 + col * 3] = 255
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

async function probe(
  name: string,
  modelId: string,
  mode: 'fast' | 'deep',
  price: AiPrice,
  run: (
    model: ReturnType<typeof guardedAiModel>,
    evidence: AiCallEvidence[],
  ) => Promise<Record<string, unknown>>,
) {
  if (filter && !name.includes(filter)) return
  const evidence: AiCallEvidence[] = []
  const started = performance.now()
  const model = guardedAiModel({
    provider: config.provider as 'soclaas' | 'deepseek',
    apiKey: config.apiKey as string,
    model: modelId,
    mode,
    price,
    label: name,
    ledger,
    // The full documented 1M context is reserved, including images/tools. This avoids inventing a tokenizer/image bound.
    inputTokenBound: 1_000_000,
    maxOutputTokens: 1024,
    onEvidence: (value) => evidence.push(value),
  })
  try {
    const checks = await run(model, evidence)
    assert(
      evidence.length > 0 && evidence.every((call) => call.status === 'settled'),
      'all_calls_must_have_usage',
    )
    results.push({
      name,
      status: 'pass',
      elapsedMs: Math.round(performance.now() - started),
      evidence,
      checks,
    })
    console.log(`PASS ${name} (${evidence.length} calls)`)
  } catch (error) {
    const failedHttp = evidence.findLast((call) => (call.httpStatus ?? 0) >= 400)?.httpStatus
    const code =
      error instanceof AiBudgetError || error instanceof AiTransportError
        ? error.code
        : error instanceof Error && error.message.startsWith('probe:')
          ? error.message.slice(6)
          : failedHttp
            ? `PROVIDER_HTTP_${failedHttp}`
            : 'PROVIDER_OR_SDK_FAILURE'
    results.push({
      name,
      status: 'fail',
      elapsedMs: Math.round(performance.now() - started),
      evidence,
      error: code,
    })
    console.log(`FAIL ${name}: ${code}`)
  }
  // Partial progress survives a later crash. Artifacts contain metadata only.
  await writeFile(
    join(dir, 'result.json'),
    JSON.stringify({ runId, revision, results, budget: ledger.snapshot() }, null, 2),
    { mode: 0o600 },
  )
}

const variants =
  config.provider === 'soclaas'
    ? [{ name: 'glm', id: config.models.fast, price: config.prices.fast }]
    : [
        { name: 'flash', id: config.models.fast, price: config.prices.fast },
        {
          name: 'pro',
          id: 'deepseek-v4-pro',
          price: {
            version: 'deepseek-peak-2026-10-07-pro',
            input: 1_320_000,
            cachedInput: 44_000,
            output: 3_960_000,
          },
        },
      ]
try {
  for (const variant of variants)
    for (const mode of ['fast', 'deep'] as const)
      for (const streaming of [false, true]) {
        await probe(
          `${variant.name}-${mode}-${streaming ? 'stream' : 'generate'}-tool-loop`,
          config.provider === 'soclaas' ? config.models[mode] : variant.id,
          mode,
          variant.price,
          async (model, evidence) => {
            let toolCalls = 0
            const agent = new ToolLoopAgent({
              model,
              instructions:
                'This is a synthetic integration test. You must call fixture_lookup to retrieve the code. Do not guess. After the tool returns, answer only with its code.',
              tools: {
                fixture_lookup: tool({
                  description: 'Returns the synthetic test code.',
                  inputSchema: jsonSchema<{ name: 'test' }>({
                    type: 'object',
                    properties: { name: { type: 'string', enum: ['test'] } },
                    required: ['name'],
                    additionalProperties: false,
                  }),
                  execute: async () => {
                    toolCalls++
                    return { code: 'M4_READY_42' }
                  },
                }),
              },
              providerOptions: aiProviderOptions(config.provider as 'soclaas' | 'deepseek', mode),
              maxOutputTokens: 1024,
              maxRetries: 0,
              stopWhen: stepCountIs(3),
              experimental_download: denyAiDownloads,
              experimental_telemetry: {
                isEnabled: false,
                recordInputs: false,
                recordOutputs: false,
              },
            })
            let text = ''
            let textChunks = 0
            let steps = 0
            let reasoningParts = 0
            if (streaming) {
              const result = await agent.stream({
                prompt: 'Call fixture_lookup with name test, then return the code.',
                abortSignal: AbortSignal.timeout(90_000),
              })
              for await (const part of result.stream) {
                if (part.type === 'error') throw new Error('probe:stream_error')
                if (part.type === 'text-delta') {
                  text += part.text
                  textChunks++
                }
              }
              const completed = await result.steps
              steps = completed.length
              reasoningParts = completed
                .flatMap((step) => step.content)
                .filter((part) => part.type === 'reasoning').length
            } else {
              const result = await agent.generate({
                prompt: 'Call fixture_lookup with name test, then return the code.',
                abortSignal: AbortSignal.timeout(90_000),
              })
              text = result.text
              steps = result.steps.length
              reasoningParts = result.steps
                .flatMap((step) => step.content)
                .filter((part) => part.type === 'reasoning').length
            }
            assert(toolCalls >= 1 && steps >= 2 && text.includes('M4_READY_42'), 'tool_loop_answer')
            assert(!streaming || textChunks > 0, 'stream_deltas')
            return {
              toolCalls,
              steps,
              textChunks,
              toolContinuationAccepted: evidence.length >= 2,
              reasoningParts,
            }
          },
        )
      }
  for (const mode of ['fast', 'deep'] as const)
    await probe(
      `${config.provider === 'soclaas' ? 'glm' : 'flash'}-${mode}-inline-image`,
      config.models[mode],
      mode,
      config.prices[mode],
      async (model) => {
        const image = redSquare()
        const result = await generateText({
          model,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'What is the main color of this image? Answer only with the English color name.',
                },
                {
                  type: 'file',
                  data: image,
                  mediaType: 'image/png',
                  ...(config.provider === 'deepseek'
                    ? { providerOptions: { deepseek: { imageDetail: 'low' } } }
                    : {}),
                },
              ],
            },
          ],
          providerOptions: aiProviderOptions(config.provider as 'soclaas' | 'deepseek', mode),
          maxOutputTokens: 1024,
          maxRetries: 0,
          experimental_download: denyAiDownloads,
          abortSignal: AbortSignal.timeout(90_000),
          experimental_telemetry: { isEnabled: false, recordInputs: false, recordOutputs: false },
        })
        assert(/red/i.test(result.text), 'red_image_answer')
        return {
          inlineImageSha256: createHash('sha256').update(image).digest('hex'),
          colorCorrect: true,
        }
      },
    )
  assert(results.length > 0, 'no_matching_cases')
  const snapshot = ledger.snapshot()
  console.log(
    `m4-provider: ${results.filter((result) => result.status === 'pass').length}/${results.length}; estimated settled USD ${(snapshot.settledMicroUsd / 1_000_000).toFixed(6)}; unknown USD ${(snapshot.unknownMicroUsd / 1_000_000).toFixed(6)}; artifact ${join(dir, 'result.json')}`,
  )
  process.exitCode = results.some((result) => result.status !== 'pass') || snapshot.halted ? 1 : 0
} finally {
  ledger.close()
}
