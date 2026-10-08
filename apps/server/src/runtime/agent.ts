import { AppError, agentToolSchemas, truncateCodePoints } from '@chatapp/contracts'
import {
  isStepCount,
  type LanguageModel,
  type ModelMessage,
  simulateReadableStream,
  ToolLoopAgent,
} from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { z } from 'zod'
import { boundedAgentData, compactAgentMessages } from '../agent/context.ts'
import { agentSystemPrompt, answerReminder, untrustedHistory } from '../agent/prompts/system.ts'
import { agentTools } from '../agent/tools/index.ts'
import { AI_LIMITS, type AiConfig } from '../config/ai.ts'
import { type AgentLease, withAgentLease } from '../domain/agent-access.ts'
import { closeAgentCalls, createAgentLedger, recordAgentEvidence } from '../domain/agent-budget.ts'
import {
  claimAgentRun,
  completeAgentRun,
  ensureAgentOutput,
  failAgentRun,
  heartbeatAgentRun,
  persistAgentText,
} from '../domain/agent-runs.ts'
import {
  buildAgentContext,
  recordAgentToolFailure,
  saveAgentModelStep,
} from '../domain/agent-tools.ts'
import type { PaidCallLedger } from '../domain/ai-budget.ts'
import type { Deps } from '../domain/deps.ts'
import { AiTransportError, aiProviderOptions, denyAiDownloads, guardedAiModel } from './ai.ts'

/** Deliberately deterministic; only APP_ENV=test may run mock integration and browser cases. */
function mockAgentModel(
  deps: Deps,
  lease: AgentLease,
  bound: number,
  maxOutputTokens: number,
  stepIndex: number,
  price: AiConfig['prices']['fast'],
  experimentLedger?: PaidCallLedger,
  attemptIds?: Set<string>,
  historySources: unknown = [],
): LanguageModel {
  const ledger = trackedLedger(
    createAgentLedger(deps, lease, stepIndex, price),
    experimentLedger,
    attemptIds,
  )
  return new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock-chatapp',
    doStream: async (options) => {
      const id = deps.newId()
      await ledger.reserve({
        id,
        label: 'mock',
        model: 'mock-chatapp',
        price,
        inputTokenBound: bound,
        maxOutputTokens,
      })
      await ledger.start(id)
      const toolResult = options.prompt.findLast((p) => p.role === 'tool')
      const visible =
        toolResult?.role === 'tool'
          ? toolResult.content.flatMap((part) => {
              if (part.type !== 'tool-result' || part.output.type !== 'json') return []
              const value = part.output.value
              if (
                !value ||
                typeof value !== 'object' ||
                Array.isArray(value) ||
                !('data' in value) ||
                !Array.isArray(value.data)
              )
                return []
              return value.data.flatMap((row: unknown) => {
                // The prepared tool page may refer to the identical source already supplied in history.
                const source =
                  row &&
                  typeof row === 'object' &&
                  'alreadyProvided' in row &&
                  row.alreadyProvided === true &&
                  'id' in row &&
                  Array.isArray(historySources)
                    ? historySources.find(
                        (source: unknown) =>
                          source &&
                          typeof source === 'object' &&
                          'id' in source &&
                          source.id === row.id,
                      )
                    : row
                if (
                  !source ||
                  typeof source !== 'object' ||
                  Array.isArray(source) ||
                  !('body' in source) ||
                  typeof source.body !== 'string'
                )
                  return []
                return [
                  `- ${'sender' in source && typeof source.sender === 'string' ? source.sender : '成员'}：${source.body.replace(/<[^>]*>/g, '').slice(0, 200)}`,
                ]
              })
            })
          : []
      const text = toolResult
        ? `已读取可见消息。\n\n**讨论摘要**\n\n${visible.length ? visible.slice(0, 4).join('\n') : '- 当前没有可引用的讨论。'}`
        : ''
      const tokens = {
        inputTokens: Math.min(bound, 120),
        outputTokens: text ? 60 : 12,
        cachedTokens: 0,
        reasoningTokens: 0,
      }
      await ledger.settle(id, tokens)
      const usage = {
        inputTokens: {
          total: tokens.inputTokens,
          noCache: tokens.inputTokens,
          cacheRead: 0,
          cacheWrite: 0,
        },
        outputTokens: { total: tokens.outputTokens, text: tokens.outputTokens, reasoning: 0 },
      }
      const finishReason = {
        unified: toolResult ? ('stop' as const) : ('tool-calls' as const),
        raw: toolResult ? 'stop' : 'tool_calls',
      }
      type Part =
        Awaited<ReturnType<MockLanguageModelV3['doStream']>>['stream'] extends ReadableStream<
          infer P
        >
          ? P
          : never
      const chunks: Part[] = [{ type: 'stream-start', warnings: [] }]
      if (!toolResult)
        chunks.push({
          type: 'tool-call',
          toolCallId: 'read-1',
          toolName: 'read_conversation',
          input: JSON.stringify({ limit: 30 }),
        })
      else {
        chunks.push({ type: 'text-start', id: 'text-1' })
        for (let i = 0; i < text.length; i += 80)
          chunks.push({ type: 'text-delta', id: 'text-1', delta: text.slice(i, i + 80) })
        chunks.push({ type: 'text-end', id: 'text-1' })
      }
      chunks.push({ type: 'finish', finishReason, usage })
      return { stream: simulateReadableStream({ chunks, chunkDelayInMs: 20 }) }
    },
  })
}

export type AgentDelta = {
  conversationId: string
  runId: string
  resumeSeq: number
  leaseEpoch: number
  messageId: string
  index: number
  streamRevision: number
  text: string
}
export type AgentExecution = {
  deps: Deps
  config: AiConfig
  emitDelta?: (delta: AgentDelta) => Promise<void>
  model?: (step: number) => LanguageModel
  /** Synthetic evals add the durable experiment account; the primary domain admission remains mandatory. */
  experimentLedger?: PaidCallLedger
}

export function trackedLedger(
  primary: PaidCallLedger,
  experiment?: PaidCallLedger,
  attemptIds?: Set<string>,
): PaidCallLedger {
  if (!experiment && !attemptIds) return primary
  return {
    async reserve(attempt) {
      await primary.reserve(attempt)
      try {
        await experiment?.reserve(attempt)
        attemptIds?.add(attempt.id)
      } catch (error) {
        await primary.release(attempt.id)
        throw error
      }
    },
    async start(id) {
      await primary.start(id)
      await experiment?.start(id)
    },
    async settle(id, usage) {
      await primary.settle(id, usage)
      await experiment?.settle(id, usage)
    },
    async release(id) {
      await primary.release(id)
      await experiment?.release(id)
    },
    async unknown(id) {
      await primary.unknown(id)
      await experiment?.unknown(id)
    },
  }
}

/** One runtime for private chat, panels, commands and shared mentions. Every prepareStep re-enters domain authority. */
export async function executeAgentRun(parts: AgentExecution, id: string): Promise<void> {
  const { deps, config } = parts
  let lease: AgentLease | undefined
  let providerStatus: number | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let heartbeat: Promise<void> | undefined
  let finishStream: (() => Promise<void>) | undefined
  const attemptIds = new Set<string>()
  const abort = new AbortController()
  try {
    const claimed = await claimAgentRun(deps, id)
    if (!claimed) return
    lease = claimed.lease
    const currentLease = lease
    const context = await buildAgentContext(deps, currentLease)
    const limits = AI_LIMITS[context.run.mode]
    if (
      context.run.provider !== config.provider ||
      context.run.model !== config.models[context.run.mode]
    )
      throw new AppError('CONTEXT_CHANGED', 'The model configuration changed')
    const outputId = await ensureAgentOutput(deps, currentLease)
    if (context.finalText !== null) {
      await persistAgentText(deps, currentLease, context.finalText, 1)
      await completeAgentRun(deps, currentLease)
      return
    }
    const imageParts: { type: 'file'; data: Uint8Array; mediaType: string }[] = []
    if (context.images.length && config.provider === 'deepseek')
      throw new AppError('VALIDATION_FAILED', 'Paid image input requires a verified billing bound')
    for (const image of context.images) {
      if (!deps.blobs) throw new AppError('CAPACITY_UNAVAILABLE', 'Image storage is unavailable')
      const stream = deps.blobs.read(image.key)
      const reader = stream.getReader()
      const chunks: Uint8Array[] = []
      let length = 0
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          length += chunk.value.byteLength
          if (length > 1_000_000)
            throw new AppError('PAYLOAD_TOO_LARGE', 'Image preview is too large')
          chunks.push(chunk.value)
        }
      } finally {
        await reader.cancel().catch(() => {})
      }
      if (!length) throw new AppError('VALIDATION_FAILED', 'Image preview is unavailable')
      const bytes = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      imageParts.push({ type: 'file', data: bytes, mediaType: image.mime })
    }
    const historyView = boundedAgentData(
      [...context.history].reverse(),
      context.run.mode === 'fast' ? 4000 : 16_000,
      context.run.mode === 'fast' ? 200 : 1000,
    )
    const initialMessages: ModelMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `${untrustedHistory([historyView])}\n\n${imageParts.length ? `本轮实际附带 ${imageParts.length} 张参考图片，图片像素见本条消息的图片部分。\n\n` : ''}本轮用户请求：\n${context.prompt}\n\n${answerReminder}`,
          },
          ...imageParts,
        ],
      },
    ]
    if (context.continuation.length)
      initialMessages.push(...(context.continuation as ModelMessage[]))
    const instructions = agentSystemPrompt(context.run, deps.clock.now())
    const tools = agentTools(
      deps,
      currentLease,
      context.run.readScope === 'all_accessible',
      context.run.mode === 'fast' ? 8000 : 64_000,
    )
    const price = config.prices[context.run.mode]
    let durableMessages: unknown[] = [...initialMessages]
    let lastFinishReason: string | undefined
    const agent = new ToolLoopAgent({
      model:
        parts.model?.(0) ??
        mockAgentModel(
          deps,
          currentLease,
          1,
          limits.maxOutputTokens,
          0,
          price,
          parts.experimentLedger,
          attemptIds,
        ),
      instructions,
      tools,
      maxRetries: 0,
      // SDK errors can contain prompts and vendor response bodies. Persist only the classified run error below.
      prepareCall: (call) => ({ ...call, onError: () => {} }),
      telemetry: { isEnabled: false, recordInputs: false, recordOutputs: false },
      maxOutputTokens: limits.maxOutputTokens,
      stopWhen: isStepCount(Math.max(1, limits.steps - context.run.stepCount)),
      experimental_download: denyAiDownloads,
      prepareStep: async (step) => {
        await withAgentLease(deps, currentLease, async () => {})
        const messages = compactAgentMessages(step.messages, historyView.data)
        // UTF-8 bytes bound text tokens conservatively, including full schemas/tool results and framing overhead.
        const bound =
          Buffer.byteLength(
            JSON.stringify(
              {
                instructions,
                messages,
                schemas: Object.fromEntries(
                  Object.keys(tools).map((name) => [
                    name,
                    z.toJSONSchema(agentToolSchemas[name as keyof typeof agentToolSchemas]),
                  ]),
                ),
              },
              (_, value: unknown) => (value instanceof Uint8Array ? '[server image]' : value),
            ),
          ) +
          8192 +
          imageParts.length * 8192
        if (bound > limits.maxInputTokens)
          throw new AppError('QUOTA_EXCEEDED', 'The model input limit was reached')
        const stepIndex = step.stepNumber + context.run.stepCount
        const ledger = trackedLedger(
          createAgentLedger(deps, currentLease, stepIndex, price),
          parts.experimentLedger,
          attemptIds,
        )
        if (parts.model) return { messages, model: parts.model(step.stepNumber) }
        if (config.provider === 'mock')
          return {
            messages,
            model: mockAgentModel(
              deps,
              currentLease,
              bound,
              limits.maxOutputTokens,
              stepIndex,
              price,
              parts.experimentLedger,
              attemptIds,
              historyView.data,
            ),
          }
        const provider = config.provider
        return {
          messages,
          model: guardedAiModel({
            provider,
            apiKey: config.apiKey ?? '',
            model: context.run.model,
            mode: context.run.mode,
            price,
            ledger,
            label: 'agent',
            inputTokenBound: bound,
            maxOutputTokens: limits.maxOutputTokens,
            onEvidence: async (evidence) => {
              providerStatus = evidence.httpStatus
              await recordAgentEvidence(deps, evidence)
            },
          }),
          providerOptions: aiProviderOptions(provider, context.run.mode),
        }
      },
      onStepFinish: async (step) => {
        lastFinishReason = step.finishReason
        durableMessages = [...durableMessages, ...step.response.messages]
        await saveAgentModelStep(deps, currentLease, {
          messages: durableMessages,
          text: step.text,
          finishReason: step.finishReason,
        })
      },
    })
    timer = setInterval(() => {
      if (heartbeat) return
      heartbeat = heartbeatAgentRun(deps, currentLease)
        .catch(() => abort.abort())
        .finally(() => {
          heartbeat = undefined
        })
    }, 5000)
    const remainingMs = limits.durationMs - context.run.elapsedActiveMs
    if (remainingMs <= 0) throw new AppError('QUOTA_EXCEEDED', 'The request time limit was reached')
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(remainingMs)])
    const result = await agent.stream({ messages: initialMessages, abortSignal: signal })
    finishStream = async () => {
      await result.consumeStream({ onError: () => {} })
    }
    let text = ''
    let pending = ''
    let index = 0
    let revision = 0
    let lastBatch = performance.now()
    let lastPersist = lastBatch
    let truncated = false
    const flush = async (persist = false) => {
      if (!pending && !persist) return
      index += 1
      await withAgentLease(deps, currentLease, async () => {})
      if (persist) {
        const snapshot = await persistAgentText(deps, currentLease, text, index, truncated)
        revision = snapshot.revision
        lastPersist = performance.now()
      }
      if (pending && context.run.conversationId)
        await parts.emitDelta?.({
          conversationId: context.run.conversationId,
          runId: id,
          resumeSeq: context.run.resumeSeq,
          leaseEpoch: currentLease.epoch,
          messageId: outputId,
          index,
          streamRevision: revision,
          text: pending,
        })
      pending = ''
      lastBatch = performance.now()
    }
    for await (const part of result.fullStream) {
      if (part.type === 'tool-error') {
        await recordAgentToolFailure(
          deps,
          currentLease,
          part.toolName in agentToolSchemas ? part.toolName : 'unsupported_tool',
          null,
          'TOOL_FAILED',
        )
        throw part.error
      }
      if (part.type === 'error') throw part.error
      if (part.type === 'text-delta') {
        const next = truncateCodePoints(text + part.text, 20_000)
        const delta = next.slice(text.length)
        text = next
        pending += delta
        if (Array.from(text).length >= 20_000) {
          truncated = true
          await flush(true)
          abort.abort()
          break
        }
        const now = performance.now()
        if (now - lastBatch >= 75) await flush(now - lastPersist >= 1000)
      }
    }
    if (lastFinishReason === 'tool-calls')
      throw new AppError('QUOTA_EXCEEDED', 'The tool step limit was reached')
    if (!text.trim()) {
      if (lastFinishReason === 'length')
        throw new AppError('QUOTA_EXCEEDED', 'The output token limit was reached')
      throw new AiTransportError('RESPONSE_INVALID')
    }
    if (lastFinishReason === 'length') truncated = true
    await flush(true)
    if (!truncated && signal.aborted)
      throw new AppError('QUOTA_EXCEEDED', 'The request was interrupted')
    await completeAgentRun(deps, currentLease)
  } catch (error) {
    const code =
      providerStatus === 429
        ? 'RATE_LIMITED'
        : error instanceof AppError
          ? error.code
          : error instanceof AiTransportError
            ? error.code
            : 'MODEL_REQUEST_FAILED'
    await failAgentRun(deps, id, code, lease?.epoch)
  } finally {
    if (timer) clearInterval(timer)
    abort.abort()
    await finishStream?.()
    await heartbeat
    if (lease) {
      for (const attempt of await closeAgentCalls(deps, id, [...attemptIds])) {
        if (attempt.status === 'unknown') await parts.experimentLedger?.unknown(attempt.id)
        else await parts.experimentLedger?.release(attempt.id)
      }
    }
  }
}
