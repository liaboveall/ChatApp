import { AppError, agentToolSchemas, truncateCodePoints } from '@chatapp/contracts'
import {
  isStepCount,
  type LanguageModel,
  type ModelMessage,
  simulateReadableStream,
  ToolLoopAgent,
} from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { boundedAgentData, compactAgentMessages } from '../agent/context.ts'
import { agentSystemPrompt, answerReminder, untrustedHistory } from '../agent/prompts/system.ts'
import { agentTools, effectApproval, modelToolSchema } from '../agent/tools/index.ts'
import { AI_LIMITS, type AiConfig } from '../config/ai.ts'
import { type AgentLease, type AgentRunRow, withAgentLease } from '../domain/agent-access.ts'
import {
  answerApprovalRequests,
  registerApprovalRequests,
  unansweredRequests,
} from '../domain/agent-approvals.ts'
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
import { markKeyRejected, runKey } from '../domain/ai-keys.ts'
import type { Deps } from '../domain/deps.ts'
import { AiTransportError, aiProviderOptions, denyAiDownloads, guardedAiModel } from './ai.ts'

/** Deliberately deterministic; only APP_ENV=test may run mock integration and browser cases. */
/**
 * The scripted first call of the mock model: an explicit effect request in the person's own words (integration tests
 * and E2E type exactly these forms), otherwise the M4 read of the conversation.
 */
export function mockIntent(
  prompt: string,
  run: Pick<AgentRunRow, 'contextConversationId' | 'timezone'>,
): { toolName: string; input: Record<string, unknown> } {
  const target = run.contextConversationId
  const remember = /记住[:：]\s*([\s\S]+)/.exec(prompt)
  if (remember?.[1]) return { toolName: 'remember', input: { content: remember[1].trim() } }
  const forget = /忘记[:：]\s*([0-9a-f-]{36})/.exec(prompt)
  if (forget?.[1]) return { toolName: 'forget', input: { memoryId: forget[1] } }
  const send = /代发[:：]\s*([\s\S]+)/.exec(prompt)
  if (send?.[1] && target)
    return { toolName: 'send_message', input: { conversationId: target, body: send[1].trim() } }
  const scheduled = /定时[:：]\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})\s+([\s\S]+)/.exec(prompt)
  if (scheduled?.[1] && scheduled[2] && target)
    return {
      toolName: 'schedule_message',
      input: {
        conversationId: target,
        body: scheduled[2].trim(),
        localDateTime: scheduled[1],
        timezone: run.timezone,
      },
    }
  const reminder = /提醒我[:：]\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})\s+([\s\S]+)/.exec(prompt)
  if (reminder?.[1] && reminder[2])
    return {
      toolName: 'create_reminder',
      input: { localDateTime: reminder[1], timezone: run.timezone, text: reminder[2].trim() },
    }
  const group = /建群[:：]\s*(\S+)((?:\s+@[a-z0-9_]+)*)/.exec(prompt)
  if (group?.[1])
    return {
      toolName: 'create_group',
      input: {
        name: group[1],
        memberUsernames: [...(group[2] ?? '').matchAll(/@([a-z0-9_]+)/g)].map((m) => m[1]),
      },
    }
  const invite = /拉人[:：]((?:\s*@[a-z0-9_]+)+)/.exec(prompt)
  if (invite?.[1] && target)
    return {
      toolName: 'invite_members',
      input: {
        conversationId: target,
        usernames: [...invite[1].matchAll(/@([a-z0-9_]+)/g)].map((m) => m[1]),
      },
    }
  const cancel = /取消(提醒|定时消息)[:：]\s*([0-9a-f-]{36})/.exec(prompt)
  if (cancel?.[2])
    return {
      toolName: cancel[1] === '提醒' ? 'cancel_reminder' : 'cancel_scheduled_message',
      input: { id: cancel[2] },
    }
  return { toolName: 'read_conversation', input: { limit: 30 } }
}

/** What the mock says once an effect call was answered: the outcome the runtime reported, never an invented one. */
function mockEffectAnswer(output: { type: string; value?: unknown }): string {
  if (output.type === 'execution-denied') return '已按你的决定取消，没有执行。'
  const value = output.value as { status?: unknown; error?: unknown } | undefined
  switch (value?.status) {
    case 'sent':
      return '已代你发送这条消息。'
    case 'scheduled':
      return '已安排好，到时会执行。'
    case 'created':
      return '群组已建好。'
    case 'invited':
      return '已邀请。'
    case 'cancelled':
      return '已取消。'
    case 'remembered':
      return '已记住，可以在设置中查看和删除。'
    case 'forgotten':
      return '已删除这条记忆。'
    case 'failed':
      return `没能完成：${String(value.error)}。`
    default:
      return `结果：${String(value?.status ?? 'unknown')}。`
  }
}

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
  intent: { toolName: string; input: Record<string, unknown> } = {
    toolName: 'read_conversation',
    input: { limit: 30 },
  },
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
      const effectOutput =
        options.prompt.at(-1)?.role === 'tool'
          ? (options.prompt.at(-1) as { content: unknown[] }).content.find(
              (part): part is { type: 'tool-result'; toolName: string; output: { type: string } } =>
                !!part &&
                typeof part === 'object' &&
                (part as { type?: unknown }).type === 'tool-result' &&
                !['read_conversation', 'read_unread', 'search_messages', 'get_message'].includes(
                  String((part as { toolName?: unknown }).toolName),
                ),
            )
          : undefined
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
      const text = effectOutput
        ? mockEffectAnswer(effectOutput.output)
        : toolResult
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
          toolCallId: `call-${stepIndex}`,
          toolName: intent.toolName,
          input: JSON.stringify(intent.input),
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
  let own = false
  let keyRevision: number | null = null
  let runUserId: string | undefined
  try {
    const claimed = await claimAgentRun(deps, id)
    if (!claimed) return
    lease = claimed.lease
    const currentLease = lease
    const context = await buildAgentContext(deps, currentLease)
    const limits = AI_LIMITS[context.run.mode]
    // The run's source was pinned at creation: an own key always goes to DeepSeek with its own models (docs/06 14).
    own = context.run.keySource === 'user'
    const route = own
      ? { provider: config.byok.provider, models: config.byok.models, prices: config.byok.prices }
      : { provider: config.provider, models: config.models, prices: config.prices }
    if (
      context.run.provider !== route.provider ||
      context.run.model !== route.models[context.run.mode]
    )
      throw new AppError('CONTEXT_CHANGED', 'The model configuration changed')
    // Decrypted only here, for the fixed endpoint; a replaced or rejected key ends the run (A12, SEC-26).
    const ownKey = own ? await runKey(deps, context.run) : undefined
    keyRevision = context.run.keyRevision
    runUserId = context.run.userId
    const outputId = await ensureAgentOutput(deps, currentLease)
    if (context.finalText !== null) {
      await persistAgentText(deps, currentLease, context.finalText, 1)
      await completeAgentRun(deps, currentLease)
      return
    }
    const imageParts: { type: 'file'; data: Uint8Array; mediaType: string }[] = []
    if (context.images.length && route.provider === 'deepseek')
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
    const personal = context.history
      .filter(
        (row) =>
          !!row && typeof row === 'object' && ('summary' in row || 'personalMemories' in row),
      )
      .map((row) => {
        const data = row as {
          summary?: string
          personalMemories?: { content: string | null; id: string }[]
        }
        return data.summary
          ? {
              trust: 'untrusted',
              summary: [...data.summary].slice(-600).join(''),
              truncated: [...data.summary].length > 600,
            }
          : {
              trust: 'untrusted',
              personalMemories: data.personalMemories?.map((m) => ({
                id: m.id,
                content: [...(m.content ?? '')].slice(0, 160).join(''),
                truncated: [...(m.content ?? '')].length > 160,
              })),
            }
      })
    const personalView = boundedAgentData(personal, 6000)
    const historyView = boundedAgentData(
      context.history
        .filter(
          (row) =>
            !(row && typeof row === 'object' && ('summary' in row || 'personalMemories' in row)),
        )
        .reverse(),
      context.run.mode === 'fast' ? 4000 : 16_000,
      context.run.mode === 'fast' ? 200 : 1000,
    )
    const initialMessages: ModelMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `${untrustedHistory([historyView])}${personal.length ? `\n\n${untrustedHistory([personalView])}` : ''}\n\n${imageParts.length ? `本轮实际附带 ${imageParts.length} 张参考图片，图片像素见本条消息的图片部分。\n\n` : ''}本轮用户请求：\n${context.prompt}\n\n${answerReminder}`,
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
    const price = route.prices[context.run.mode]
    const intent = mockIntent(context.prompt, context.run)
    let durableMessages: unknown[] = [...initialMessages]
    let lastFinishReason: string | undefined
    let stepsUsed = context.run.stepCount
    const claimedAt = performance.now()
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
    /**
     * Settles the approval requests at the end of the history (docs/06 section 5.1). Returns false when the run now
     * waits for the caller (the segment was finished in the pause transaction), true when every request was answered
     * and the model may continue.
     */
    const settle = async (): Promise<boolean> => {
      const requests = unansweredRequests(durableMessages)
      if (!requests.length) return true
      if (text) await flush(true)
      const { waiting } = await registerApprovalRequests(deps, currentLease, requests, text)
      if (waiting) return false
      const answer = await answerApprovalRequests(deps, currentLease, requests)
      if (answer === 'waiting') return false
      durableMessages = [...durableMessages, answer]
      return true
    }
    // A run resumed after a decision, or recovered after a crash, may stop at requests the model already made.
    if (!(await settle())) return
    timer = setInterval(() => {
      if (heartbeat) return
      heartbeat = heartbeatAgentRun(deps, currentLease)
        .catch(() => abort.abort())
        .finally(() => {
          heartbeat = undefined
        })
    }, 5000)
    for (;;) {
      if (stepsUsed >= limits.steps)
        throw new AppError('QUOTA_EXCEEDED', 'The tool step limit was reached')
      const remainingMs =
        limits.durationMs - context.run.elapsedActiveMs - (performance.now() - claimedAt)
      if (remainingMs <= 0)
        throw new AppError('QUOTA_EXCEEDED', 'The request time limit was reached')
      const roundBase = stepsUsed
      const agent = new ToolLoopAgent({
        model:
          parts.model?.(0) ??
          mockAgentModel(
            deps,
            currentLease,
            1,
            limits.maxOutputTokens,
            roundBase,
            price,
            parts.experimentLedger,
            attemptIds,
            [],
            intent,
          ),
        instructions,
        tools,
        toolApproval: effectApproval,
        maxRetries: 0,
        // SDK errors can contain prompts and vendor response bodies. Persist only the classified run error below.
        prepareCall: (call) => ({ ...call, onError: () => {} }),
        telemetry: { isEnabled: false, recordInputs: false, recordOutputs: false },
        maxOutputTokens: limits.maxOutputTokens,
        stopWhen: isStepCount(Math.max(1, limits.steps - roundBase)),
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
                      modelToolSchema(name as keyof typeof agentToolSchemas),
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
          const stepIndex = step.stepNumber + roundBase
          const ledger = trackedLedger(
            createAgentLedger(deps, currentLease, stepIndex, price),
            parts.experimentLedger,
            attemptIds,
          )
          if (parts.model) return { messages, model: parts.model(step.stepNumber) }
          if (route.provider === 'mock') {
            // The mock stands in for the provider refusing a key revoked after it was saved (E2E scenario 13).
            if (ownKey?.startsWith('sk-mock-revoked')) {
              providerStatus = 401
              throw new AiTransportError('REQUEST_REJECTED', 401)
            }
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
                intent,
              ),
            }
          }
          const provider = route.provider
          return {
            messages,
            model: guardedAiModel({
              provider,
              apiKey: ownKey ?? config.apiKey ?? '',
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
          stepsUsed += 1
          durableMessages = [...durableMessages, ...step.response.messages]
          await saveAgentModelStep(deps, currentLease, {
            messages: durableMessages,
            text: step.text,
            finishReason: step.finishReason,
          })
        },
      })
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(remainingMs)])
      const result = await agent.stream({
        messages: durableMessages as ModelMessage[],
        abortSignal: signal,
      })
      finishStream = async () => {
        await result.consumeStream({ onError: () => {} })
      }
      // Rounds continue one reply segment: text after an automatic effect follows on a new paragraph.
      if (text && !text.endsWith('\n')) {
        text += '\n\n'
        pending += '\n\n'
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
      if (truncated) break
      if (unansweredRequests(durableMessages).length) {
        if (!(await settle())) return
        continue
      }
      break
    }
    if (lastFinishReason === 'tool-calls' && !truncated)
      throw new AppError('QUOTA_EXCEEDED', 'The tool step limit was reached')
    if (!text.trim()) {
      if (lastFinishReason === 'length')
        throw new AppError('QUOTA_EXCEEDED', 'The output token limit was reached')
      throw new AiTransportError('RESPONSE_INVALID')
    }
    if (lastFinishReason === 'length') truncated = true
    await flush(true)
    if (!truncated && abort.signal.aborted)
      throw new AppError('QUOTA_EXCEEDED', 'The request was interrupted')
    await completeAgentRun(deps, currentLease)
  } catch (error) {
    // An own key refused by DeepSeek (V-17): 401/403 invalid, 402 out of balance. That revision is marked so the
    // person sees why; rate limiting never marks a key.
    const rejected =
      own && (providerStatus === 401 || providerStatus === 403 || providerStatus === 402)
    if (rejected && runUserId)
      await markKeyRejected(
        deps,
        runUserId,
        keyRevision,
        providerStatus === 402 ? 'insufficient_balance' : 'invalid',
      )
    const code = rejected
      ? 'AI_KEY_INVALID'
      : providerStatus === 429
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
