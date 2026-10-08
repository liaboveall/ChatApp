import { describe, expect, test } from 'bun:test'
import { generateText, stepCountIs, streamText, ToolLoopAgent, tool } from 'ai'
import { z } from 'zod'
import { reserveCost } from '../domain/ai-budget.ts'
import type { AiCallEvidence } from './ai.ts'
import { AiTransportError, aiProviderOptions, denyAiDownloads, guardedAiModel } from './ai.ts'

const zeroPrice = { version: 'school-free', input: 0, cachedInput: 0, output: 0 }
const usage = {
  prompt_tokens: 10,
  completion_tokens: 4,
  total_tokens: 14,
  prompt_tokens_details: { cached_tokens: 3 },
  completion_tokens_details: { reasoning_tokens: 2 },
}
type Send = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
function harness(send: Send, mode: 'fast' | 'deep' = 'fast') {
  const evidence: AiCallEvidence[] = []
  const states = new Map<string, string>()
  const model = guardedAiModel({
    provider: 'soclaas',
    apiKey: 'school-key-fixture',
    model: 'x-test-1',
    mode,
    price: zeroPrice,
    label: 'fixture',
    inputTokenBound: 1000,
    maxOutputTokens: 100,
    fetch: send,
    onEvidence: (value) => evidence.push(value),
    ledger: {
      reserve: (attempt) => {
        expect(reserveCost(attempt.price, attempt.inputTokenBound, attempt.maxOutputTokens)).toBe(0)
        states.set(attempt.id, 'reserved')
      },
      start: (id) => states.set(id, 'started'),
      settle: (id) => states.set(id, 'settled'),
      unknown: (id) => states.set(id, 'unknown'),
      release: (id) => states.set(id, 'released'),
    },
  })
  return { model, evidence, states }
}
function completion(
  message: Record<string, unknown> = { role: 'assistant', content: 'ok' },
  finish = 'stop',
) {
  return Response.json({
    id: 'school-response',
    model: 'x-test-1',
    object: 'chat.completion',
    created: 1,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage,
  })
}
const settings = { maxOutputTokens: 100, maxRetries: 0, experimental_download: denyAiDownloads }

describe('SoCLaaS adapter through the real OpenAI-compatible SDK', () => {
  for (const mode of ['fast', 'deep'] as const)
    test(`${mode} uses the school endpoint, its own key and enabled thinking`, async () => {
      let sends = 0
      const h = harness(async (input, init) => {
        sends++
        expect(String(input)).toBe('https://soclaas-api.comp.nus.edu.sg/v1/chat/completions')
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer school-key-fixture')
        expect(init?.redirect).toBe('error')
        const body = JSON.parse(String(init?.body))
        expect(body.model).toBe('x-test-1')
        expect(body.thinking).toEqual({ type: 'enabled', clear_thinking: false })
        expect(body.reasoning_effort).toBe(mode === 'fast' ? 'low' : 'high')
        return completion()
      }, mode)
      const result = await generateText({
        model: h.model,
        prompt: 'fixture',
        providerOptions: aiProviderOptions('soclaas', mode),
        ...settings,
      })
      expect(result.text).toBe('ok')
      expect(sends).toBe(1)
      expect(h.evidence[0]).toMatchObject({
        provider: 'soclaas',
        status: 'settled',
        usage: { inputTokens: 10, outputTokens: 4, cachedTokens: 3, reasoningTokens: 2 },
      })
    })
  test('tool continuation preserves reasoning and records every zero-cost call', async () => {
    let sends = 0
    const h = harness(async (_input, init) => {
      sends++
      if (sends === 1)
        return completion(
          {
            role: 'assistant',
            content: null,
            reasoning_content: 'school-reasoning-fixture',
            tool_calls: [
              {
                id: 'school-tool',
                type: 'function',
                function: { name: 'lookup', arguments: '{"id":"test"}' },
              },
            ],
          },
          'tool_calls',
        )
      const messages = JSON.parse(String(init?.body)).messages as Array<Record<string, unknown>>
      expect(messages.find((message) => message.role === 'assistant')?.reasoning_content).toBe(
        'school-reasoning-fixture',
      )
      expect(messages.find((message) => message.role === 'tool')?.content).toContain('42')
      return completion({
        role: 'assistant',
        content: '42',
        reasoning_content: 'school-finish-fixture',
      })
    }, 'deep')
    const agent = new ToolLoopAgent({
      model: h.model,
      providerOptions: aiProviderOptions('soclaas', 'deep'),
      ...settings,
      stopWhen: stepCountIs(2),
      tools: {
        lookup: tool({
          inputSchema: z.object({ id: z.string() }),
          execute: async () => ({ answer: 42 }),
        }),
      },
    })
    const result = await agent.generate({ prompt: 'Use lookup for test' })
    expect(result.text).toBe('42')
    expect(h.evidence).toHaveLength(2)
    expect([...h.states.values()]).toEqual(['settled', 'settled'])
  })
  test('streaming requests ask for usage and preserve incremental text', async () => {
    const h = harness(async (_input, init) => {
      expect(JSON.parse(String(init?.body)).stream_options.include_usage).toBe(true)
      const parts = [
        {
          id: 'school-stream',
          model: 'x-test-1',
          created: 1,
          choices: [
            { index: 0, delta: { role: 'assistant', content: 'ready' }, finish_reason: null },
          ],
        },
        {
          id: 'school-stream',
          model: 'x-test-1',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage,
        },
      ]
      return new Response(
        `${parts.map((value) => `data: ${JSON.stringify(value)}\n\n`).join('')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const result = streamText({
      model: h.model,
      prompt: 'fixture',
      providerOptions: aiProviderOptions('soclaas', 'fast'),
      ...settings,
    })
    let text = ''
    for await (const part of result.textStream) text += part
    expect(text).toBe('ready')
    expect(h.evidence[0]).toMatchObject({ provider: 'soclaas', status: 'settled', streaming: true })
  })
  test('accepts server-loaded image bytes without an SDK download', async () => {
    const h = harness(async (_input, init) => {
      const body = JSON.parse(String(init?.body))
      expect(body.messages[0].content[1].image_url.url).toStartWith('data:image/png;base64,')
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
      providerOptions: aiProviderOptions('soclaas', 'fast'),
      ...settings,
    })
    expect(h.evidence[0]?.status).toBe('settled')
  })
  test('does not fall back to a paid provider on authentication failure', async () => {
    const urls: string[] = []
    const h = harness(async (input) => {
      urls.push(String(input))
      return Response.json({ error: { message: 'private-provider-fixture' } }, { status: 401 })
    })
    await expect(
      generateText({
        model: h.model,
        prompt: 'fixture',
        providerOptions: aiProviderOptions('soclaas', 'fast'),
        ...settings,
      }),
    ).rejects.toThrow('MODEL_REQUEST_FAILED')
    expect(urls).toEqual(['https://soclaas-api.comp.nus.edu.sg/v1/chat/completions'])
    expect(h.evidence[0]).toMatchObject({ httpStatus: 401, status: 'released' })
  })
  test('an uncertain HTTP error cannot trigger the SDK default automatic retries', async () => {
    let sends = 0
    const h = harness(async () => {
      sends++
      return Response.json({ error: { message: 'private-server-fixture' } }, { status: 503 })
    })
    await expect(
      generateText({
        model: h.model,
        prompt: 'fixture',
        providerOptions: aiProviderOptions('soclaas', 'fast'),
        maxOutputTokens: 100,
        experimental_download: denyAiDownloads,
      }),
    ).rejects.toBeInstanceOf(AiTransportError)
    expect(sends).toBe(1)
    expect([...h.states.values()]).toEqual(['unknown'])
    expect(h.evidence[0]).toMatchObject({ httpStatus: 503, status: 'unknown' })
  })
  test('rate rejection records a bounded cooldown and releases the attempt without replay', async () => {
    let sends = 0
    const h = harness(async () => {
      sends++
      return new Response('private-rate-error', { status: 429, headers: { 'retry-after': '120' } })
    })
    await expect(
      generateText({
        model: h.model,
        prompt: 'fixture',
        providerOptions: aiProviderOptions('soclaas', 'fast'),
        ...settings,
      }),
    ).rejects.toThrow('MODEL_REQUEST_FAILED')
    expect(sends).toBe(1)
    expect([...h.states.values()]).toEqual(['released'])
    expect(h.evidence[0]).toMatchObject({
      httpStatus: 429,
      retryAfterSeconds: 120,
      status: 'released',
    })
  })
  test('SDK URL preprocessing cannot fetch arbitrary files before the transport guard', async () => {
    let sends = 0
    const h = harness(async () => {
      sends++
      return completion()
    })
    await expect(
      generateText({
        model: h.model,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'file',
                data: new URL('http://127.0.0.1/private.pdf'),
                mediaType: 'application/pdf',
              },
            ],
          },
        ],
        providerOptions: aiProviderOptions('soclaas', 'fast'),
        ...settings,
      }),
    ).rejects.toThrow('REQUEST_REJECTED')
    expect(sends).toBe(0)
  })
})
