/**
 * V-02 (docs/12): does the AI SDK's tool approval survive a pause, a JSON round trip through Postgres and a resume in a
 * different process, and can the server execute changed arguments it froze itself? These cases pin the SDK behaviour the
 * runtime relies on, so an SDK upgrade that changes it fails here first.
 */
import { describe, expect, test } from 'bun:test'
import {
  isStepCount,
  jsonSchema,
  type ModelMessage,
  simulateReadableStream,
  ToolLoopAgent,
  tool,
} from 'ai'
import { MockLanguageModelV3 } from 'ai/test'

type Part =
  Awaited<ReturnType<MockLanguageModelV3['doStream']>>['stream'] extends ReadableStream<infer P>
    ? P
    : never
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
}

/** A model that asks for `send_message` first and answers in text once it sees a tool result or denial. */
function scriptedModel(prompts: unknown[]) {
  return new MockLanguageModelV3({
    doStream: async (options) => {
      prompts.push(structuredClone(options.prompt))
      const last = options.prompt.at(-1)
      const chunks: Part[] = [{ type: 'stream-start', warnings: [] }]
      if (last?.role === 'tool') {
        const result = last.content.find((p) => p.type === 'tool-result')
        const text =
          result?.type === 'tool-result' ? `done:${JSON.stringify(result.output)}` : 'no result'
        chunks.push(
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: text },
          { type: 'text-end', id: 't' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
        )
      } else {
        chunks.push(
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'send_message',
            input: JSON.stringify({ conversationId: 'c-1', body: 'model text' }),
          },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
        )
      }
      return { stream: simulateReadableStream({ chunks, chunkDelayInMs: 0 }) }
    },
  })
}

function agentWith(model: MockLanguageModelV3, executed: unknown[]) {
  return new ToolLoopAgent({
    model,
    tools: {
      send_message: tool<unknown, unknown, Record<string, never>>({
        inputSchema: jsonSchema<unknown>({ type: 'object' }),
        // The runtime ignores `input` and executes what the server froze for this call id.
        execute: async (input, options) => {
          executed.push({ input, toolCallId: options.toolCallId })
          return { status: 'sent', body: 'frozen text from the database' }
        },
      }),
    },
    toolApproval: { send_message: 'user-approval' },
    stopWhen: isStepCount(5),
  })
}

function approvalIdOf(parts: { type: string; [key: string]: unknown }[]): string {
  const part = parts.find((p) => p.type === 'tool-approval-request')
  if (typeof part?.approvalId !== 'string') throw new Error('no approval request')
  return part.approvalId
}

async function drain(result: { fullStream: AsyncIterable<unknown> }) {
  const parts: { type: string; [key: string]: unknown }[] = []
  for await (const part of result.fullStream) parts.push(part as (typeof parts)[number])
  return parts
}

describe('V-02: SDK tool approval as the durable effect boundary', () => {
  test('a call needing approval ends the loop without executing, and the history carries the request', async () => {
    const prompts: unknown[] = []
    const executed: unknown[] = []
    const agent = agentWith(scriptedModel(prompts), executed)
    const steps: { finishReason: string; messages: unknown[] }[] = []
    const result = await agent.stream({
      messages: [{ role: 'user', content: 'send it' }],
      onStepFinish: (step) => {
        steps.push({ finishReason: step.finishReason, messages: step.response.messages })
      },
    })
    const parts = await drain(result)
    expect(executed).toEqual([])
    expect(prompts).toHaveLength(1)
    const request = parts.find((p) => p.type === 'tool-approval-request')
    expect(request).toMatchObject({ toolCall: { toolCallId: 'call-1', toolName: 'send_message' } })
    expect(steps).toHaveLength(1)
    expect(steps[0]?.finishReason).toBe('tool-calls')
    const assistant = (steps[0]?.messages ?? []).at(-1) as ModelMessage
    expect(assistant.role).toBe('assistant')
    const content = assistant.content as { type: string }[]
    expect(content.map((p) => p.type)).toEqual(['tool-call', 'tool-approval-request'])
  })

  test('after a JSON round trip, an approval executes the call once and the model sees the real result', async () => {
    const prompts: unknown[] = []
    const executed: unknown[] = []
    const first = agentWith(scriptedModel(prompts), executed)
    let saved: ModelMessage[] = []
    const paused = await first.stream({
      messages: [{ role: 'user', content: 'send it' }],
      onStepFinish: (step) => {
        saved = [{ role: 'user', content: 'send it' }, ...step.response.messages]
      },
    })
    const parts = await drain(paused)
    const request = { approvalId: approvalIdOf(parts) }
    // What Postgres stores and a different worker reads back.
    const restored = JSON.parse(JSON.stringify(saved)) as ModelMessage[]
    const resumedSteps: unknown[][] = []
    const second = agentWith(scriptedModel(prompts), executed)
    const resumed = await second.stream({
      messages: [
        ...restored,
        {
          role: 'tool',
          content: [
            { type: 'tool-approval-response', approvalId: request.approvalId, approved: true },
          ],
        },
      ],
      onStepFinish: (step) => {
        resumedSteps.push(step.response.messages)
      },
    })
    const after = await drain(resumed)
    expect(executed).toEqual([
      { input: { conversationId: 'c-1', body: 'model text' }, toolCallId: 'call-1' },
    ])
    expect(after.some((p) => p.type === 'tool-result')).toBe(true)
    expect(await resumed.text).toContain('frozen text from the database')
    // The provider never receives approval parts, only the call and its result.
    const lastPrompt = JSON.stringify(prompts.at(-1))
    expect(lastPrompt).not.toContain('tool-approval')
    expect(lastPrompt).toContain('frozen text from the database')
    // Neither the step nor the final response reports the result the SDK produced while resuming: a runtime that let
    // the SDK execute could not persist the history the model actually saw. The runtime executes itself (next test).
    const stepMessages = resumedSteps[0] as ModelMessage[]
    expect(stepMessages.map((m) => m.role)).toEqual(['assistant'])
    expect((await resumed.response).messages.map((m) => m.role)).toEqual(['assistant'])
  })

  test('a response that already carries the result is not executed again; the model sees exactly that result', async () => {
    const prompts: unknown[] = []
    const executed: unknown[] = []
    let saved: ModelMessage[] = []
    const parts = await drain(
      await agentWith(scriptedModel(prompts), executed).stream({
        messages: [{ role: 'user', content: 'send it' }],
        onStepFinish: (step) => {
          saved = [{ role: 'user', content: 'send it' }, ...step.response.messages]
        },
      }),
    )
    const request = { approvalId: approvalIdOf(parts) }
    // The runtime's explicit path: execute the frozen arguments under the effect ledger, then hand the SDK the decision
    // and the real result together. This message is exactly what is persisted.
    const answered: ModelMessage = {
      role: 'tool',
      content: [
        { type: 'tool-approval-response', approvalId: request.approvalId, approved: true },
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'send_message',
          output: { type: 'json', value: { status: 'sent', body: 'edited by the person' } },
        },
      ],
    }
    const resumed = await agentWith(scriptedModel(prompts), executed).stream({
      messages: [...(JSON.parse(JSON.stringify(saved)) as ModelMessage[]), answered],
    })
    await drain(resumed)
    expect(executed).toEqual([])
    expect(await resumed.text).toContain('edited by the person')
    const lastPrompt = JSON.stringify(prompts.at(-1))
    expect(lastPrompt).not.toContain('tool-approval')
    expect(lastPrompt).toContain('edited by the person')
  })

  test('a rejection the runtime answers itself reaches the model as the denial with its reason', async () => {
    const prompts: unknown[] = []
    const executed: unknown[] = []
    let saved: ModelMessage[] = []
    const parts = await drain(
      await agentWith(scriptedModel(prompts), executed).stream({
        messages: [{ role: 'user', content: 'send it' }],
        onStepFinish: (step) => {
          saved = [{ role: 'user', content: 'send it' }, ...step.response.messages]
        },
      }),
    )
    const request = { approvalId: approvalIdOf(parts) }
    const resumed = await agentWith(scriptedModel(prompts), executed).stream({
      messages: [
        ...(JSON.parse(JSON.stringify(saved)) as ModelMessage[]),
        {
          role: 'tool',
          content: [
            {
              type: 'tool-approval-response',
              approvalId: request.approvalId,
              approved: false,
              reason: 'rejected',
            },
            {
              type: 'tool-result',
              toolCallId: 'call-1',
              toolName: 'send_message',
              output: { type: 'execution-denied', reason: 'rejected' },
            },
          ],
        },
      ],
    })
    await drain(resumed)
    expect(executed).toEqual([])
    expect(await resumed.text).toContain('execution-denied')
  })

  test('a rejection never executes and reaches the model as a denial it can explain', async () => {
    const prompts: unknown[] = []
    const executed: unknown[] = []
    const first = agentWith(scriptedModel(prompts), executed)
    let saved: ModelMessage[] = []
    const parts = await drain(
      await first.stream({
        messages: [{ role: 'user', content: 'send it' }],
        onStepFinish: (step) => {
          saved = [{ role: 'user', content: 'send it' }, ...step.response.messages]
        },
      }),
    )
    const request = { approvalId: approvalIdOf(parts) }
    const second = agentWith(scriptedModel(prompts), executed)
    const resumed = await second.stream({
      messages: [
        ...(JSON.parse(JSON.stringify(saved)) as ModelMessage[]),
        {
          role: 'tool',
          content: [
            {
              type: 'tool-approval-response',
              approvalId: request.approvalId,
              approved: false,
              reason: 'rejected by the person',
            },
          ],
        },
      ],
    })
    const after = await drain(resumed)
    expect(executed).toEqual([])
    expect(after.some((p) => p.type === 'tool-output-denied')).toBe(true)
    expect(await resumed.text).toContain('execution-denied')
  })

  test('replaying the same approval response after a crash executes again, so the effect ledger must deduplicate', async () => {
    const prompts: unknown[] = []
    const executed: unknown[] = []
    const first = agentWith(scriptedModel(prompts), executed)
    let saved: ModelMessage[] = []
    const parts = await drain(
      await first.stream({
        messages: [{ role: 'user', content: 'send it' }],
        onStepFinish: (step) => {
          saved = [{ role: 'user', content: 'send it' }, ...step.response.messages]
        },
      }),
    )
    const request = { approvalId: approvalIdOf(parts) }
    const response: ModelMessage = {
      role: 'tool',
      content: [{ type: 'tool-approval-response', approvalId: request.approvalId, approved: true }],
    }
    for (let attempt = 0; attempt < 2; attempt++)
      await drain(
        await agentWith(scriptedModel(prompts), executed).stream({
          messages: [...(JSON.parse(JSON.stringify(saved)) as ModelMessage[]), response],
        }),
      )
    // The SDK has no memory across processes: exactly-once is the database's job (agent_effects, INV-10).
    expect(executed).toHaveLength(2)
  })
})
