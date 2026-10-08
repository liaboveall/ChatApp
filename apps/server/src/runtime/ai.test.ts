import { describe, expect, test } from 'bun:test'
import { generateText, stepCountIs, streamText, ToolLoopAgent, tool } from 'ai'
import { z } from 'zod'
import type { AiCallEvidence } from './ai.ts'
import { AiTransportError, deepSeekOptions, guardedDeepSeekModel } from './ai.ts'

const price = { version: 'fixture', input: 1_000_000, cachedInput: 0, output: 1_000_000 }
// Deliberately has no dependency on scripts/ or SQLite: the transport is tested through its domain port.
function harness(
  send: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  mode: 'fast' | 'deep' = 'fast',
) {
  const statuses = new Map<string, string>()
  const evidence: AiCallEvidence[] = []
  let settled = 0
  const model = guardedDeepSeekModel({
    apiKey: 'test-fixture-key',
    model: 'deepseek-flash',
    mode,
    price,
    label: 'fixture',
    inputTokenBound: 1000,
    maxOutputTokens: 100,
    fetch: send,
    ledger: {
      reserve: ({ id }) => {
        statuses.set(id, 'reserved')
      },
      start: (id) => {
        statuses.set(id, 'started')
      },
      settle: (id) => {
        if (statuses.get(id) !== 'settled') settled++
        statuses.set(id, 'settled')
      },
      unknown: (id) => {
        statuses.set(id, 'unknown')
      },
      release: (id) => {
        statuses.set(id, 'released')
      },
    },
    onEvidence: (value) => evidence.push(value),
  })
  return { model, statuses, evidence, settled: () => settled }
}
const rawUsage = {
  prompt_tokens: 10,
  completion_tokens: 4,
  total_tokens: 14,
  prompt_cache_hit_tokens: 0,
  prompt_cache_miss_tokens: 10,
}
function completion(
  message: Record<string, unknown> = { role: 'assistant', content: 'ok' },
  finish = 'stop',
  usage: unknown = rawUsage,
) {
  return Response.json({
    id: 'fixture-response',
    model: 'deepseek-flash',
    created: 1,
    object: 'chat.completion',
    choices: [{ index: 0, message, finish_reason: finish }],
    usage,
  })
}
const settings = { maxOutputTokens: 100, maxRetries: 0 }

describe('guarded real SDK transport with a synthetic server', () => {
  test('explicit fast thinking setting, fixed endpoint, no redirects and original usage settlement', async () => {
    const h = harness(async (input, init) => {
      expect(String(input)).toBe('https://api.deepseek.com/chat/completions')
      expect(init?.redirect).toBe('error')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-fixture-key')
      expect(JSON.parse(String(init?.body)).thinking).toEqual({ type: 'disabled' })
      return completion()
    })
    const result = await generateText({
      model: h.model,
      prompt: 'synthetic input',
      providerOptions: deepSeekOptions('fast'),
      ...settings,
    })
    expect(result.text).toBe('ok')
    expect(h.settled()).toBe(1)
    expect(h.evidence[0]).toMatchObject({
      status: 'settled',
      actualModel: 'deepseek-flash',
      usage: { inputTokens: 10, outputTokens: 4 },
    })
  })
  test('ToolLoopAgent preserves reasoning_content across deep tool continuation and charges both steps', async () => {
    const calls: Array<Record<string, unknown>> = []
    const h = harness(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>
      calls.push(request)
      if (calls.length === 1)
        return completion(
          {
            role: 'assistant',
            content: null,
            reasoning_content: 'synthetic-reasoning',
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: { name: 'lookup', arguments: '{"id":"fixture"}' },
              },
            ],
          },
          'tool_calls',
        )
      const messages = request.messages as Array<Record<string, unknown>>
      expect(messages.find((message) => message.role === 'assistant')?.reasoning_content).toBe(
        'synthetic-reasoning',
      )
      expect(messages.find((message) => message.role === 'tool')?.content).toContain('42')
      return completion({ role: 'assistant', content: '42', reasoning_content: 'synthetic-finish' })
    }, 'deep')
    const agent = new ToolLoopAgent({
      model: h.model,
      providerOptions: deepSeekOptions('deep'),
      ...settings,
      stopWhen: stepCountIs(2),
      tools: {
        lookup: tool({
          inputSchema: z.object({ id: z.string() }),
          execute: async () => ({ answer: 42 }),
        }),
      },
    })
    const result = await agent.generate({ prompt: 'Use lookup for fixture' })
    expect(result.text).toBe('42')
    expect(calls).toHaveLength(2)
    expect(h.settled()).toBe(2)
    for (const call of calls) expect(call.thinking).toEqual({ type: 'enabled' })
  })
  test('fragmented real SSE passes incremental output and settles terminal usage once', async () => {
    const payload = `${[
      {
        id: 'stream-1',
        model: 'deepseek-flash',
        created: 1,
        choices: [{ index: 0, delta: { role: 'assistant', content: '你' }, finish_reason: null }],
      },
      {
        id: 'stream-1',
        model: 'deepseek-flash',
        choices: [{ index: 0, delta: { content: '好' }, finish_reason: 'stop' }],
        usage: rawUsage,
      },
    ]
      .map((value) => `data: ${JSON.stringify(value)}\n\n`)
      .join('')}data: [DONE]\n\n`
    const bytes = new TextEncoder().encode(payload)
    const h = harness(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (let offset = 0; offset < bytes.length; offset += 7)
                controller.enqueue(bytes.slice(offset, offset + 7))
              controller.close()
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    )
    const result = streamText({
      model: h.model,
      prompt: 'fixture',
      providerOptions: deepSeekOptions('fast'),
      ...settings,
    })
    const chunks: string[] = []
    for await (const chunk of result.textStream) chunks.push(chunk)
    expect(chunks).toEqual(['你', '好'])
    expect(h.settled()).toBe(1)
    expect(h.evidence[0]).toMatchObject({ streaming: true, status: 'settled' })
  })
  test('unknown network results are attempted once and retain the reservation', async () => {
    let sends = 0
    const h = harness(async () => {
      sends++
      throw new Error('raw-private-response')
    })
    try {
      await generateText({
        model: h.model,
        prompt: 'fixture',
        providerOptions: deepSeekOptions('fast'),
        ...settings,
      })
    } catch (error) {
      expect(String(error)).not.toContain('raw-private-response')
    }
    expect(sends).toBe(1)
    expect([...h.statuses.values()]).toEqual(['unknown'])
  })
  test('429 rejection releases budget without forwarding private provider error content', async () => {
    let sends = 0
    const h = harness(async () => {
      sends++
      return Response.json({ error: { message: 'private-error-fixture' } }, { status: 429 })
    })
    try {
      await generateText({
        model: h.model,
        prompt: 'fixture',
        providerOptions: deepSeekOptions('fast'),
        ...settings,
      })
    } catch (error) {
      expect(String(error)).not.toContain('private-error-fixture')
    }
    expect(sends).toBe(1)
    expect(h.evidence[0]).toMatchObject({ httpStatus: 429, status: 'released' })
  })
  test('missing usage is an unknown outcome even if the SDK maps it to zero tokens', async () => {
    const h = harness(async () => completion(undefined, 'stop', null))
    await generateText({
      model: h.model,
      prompt: 'fixture',
      providerOptions: deepSeekOptions('fast'),
      ...settings,
    })
    expect(h.evidence[0]?.status).toBe('unknown')
    expect(h.settled()).toBe(0)
  })
  test('accepts inline images and rejects remote image URLs before any provider request', async () => {
    let sends = 0
    const h = harness(async () => {
      sends++
      return completion()
    })
    await generateText({
      model: h.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'fixture' },
            { type: 'file', data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' },
          ],
        },
      ],
      providerOptions: deepSeekOptions('fast'),
      ...settings,
    })
    expect(sends).toBe(1)
    await expect(
      generateText({
        model: h.model,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'file',
                data: new URL('http://127.0.0.1/private.png'),
                mediaType: 'image/png',
              },
            ],
          },
        ],
        providerOptions: deepSeekOptions('fast'),
        ...settings,
      }),
    ).rejects.toBeInstanceOf(AiTransportError)
    expect(sends).toBe(1)
  })
  test('output exceeding the declared bound is rejected before reservation or sending', async () => {
    let sends = 0
    const h = harness(async () => {
      sends++
      return completion()
    })
    await expect(
      generateText({
        model: h.model,
        prompt: 'fixture',
        providerOptions: deepSeekOptions('fast'),
        maxOutputTokens: 101,
        maxRetries: 0,
      }),
    ).rejects.toBeInstanceOf(AiTransportError)
    expect(sends).toBe(0)
    expect(h.statuses.size).toBe(0)
  })
})
