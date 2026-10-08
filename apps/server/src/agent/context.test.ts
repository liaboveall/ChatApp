import { expect, test } from 'bun:test'
import type { ModelMessage } from 'ai'
import { boundedAgentData, compactAgentMessages } from './context.ts'
import { untrustedHistory } from './prompts/system.ts'

test('long body previews keep their actual Unicode range and a deep view can preserve complete text', () => {
  const body = '😀'.repeat(5000)
  const input = [{ id: 'focus', body, bodyRange: { offset: 1000, length: 5000, total: 10000 } }]
  const small = boundedAgentData(input, 8000)
  const row = (small.data as typeof input)[0]
  expect(small.truncated).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(small.data))).toBeLessThanOrEqual(8000)
  expect(row?.id).toBe('focus')
  expect(row?.bodyRange.length).toBe([...(row?.body ?? '')].length)
  expect(row?.bodyRange.offset).toBe(1000)
  const deep = boundedAgentData(input, 64000)
  expect(deep.truncated).toBe(false)
  expect((deep.data as typeof input)[0]?.body).toBe(body)
})
test('bounded lists expose truncation and available count without changing source identifiers', () => {
  const list = Array.from({ length: 30 }, (_, i) => ({
    id: `source-${i}`,
    body: '资料'.repeat(200),
  }))
  const result = boundedAgentData(list, 4000)
  expect(result.truncated).toBe(true)
  expect(result.available).toBe(30)
  expect(Buffer.byteLength(JSON.stringify(result.data))).toBeLessThanOrEqual(4000)
  expect(JSON.stringify(result.data)).toContain('source-0')
})

test('a large recent message does not displace the other recent factual sources', () => {
  const data = [
    { id: 'long', body: '长记录😀'.repeat(4000) },
    ...Array.from({ length: 8 }, (_, i) => ({ id: `fact-${i}`, body: `事实${i}` })),
  ]
  const view = boundedAgentData(data, 4000, 200)
  expect(view.truncated).toBe(true)
  const rows = view.data as { id: string; body: string; bodyTruncated?: boolean }[]
  expect(rows).toHaveLength(9)
  expect(rows[0]?.bodyTruncated).toBe(true)
  expect([...(rows[0]?.body ?? '')]).toHaveLength(200)
  expect(rows[8]?.id).toBe('fact-7')
  expect(Buffer.byteLength(JSON.stringify(rows))).toBeLessThanOrEqual(4000)
})

test('duplicate neighboring pages retain every tool result and a complete first source without mutating durable history', () => {
  const row = {
    id: 'message-1',
    conversationId: 'conversation-1',
    body: '原始事实',
    bodyRange: { offset: 0, length: 4, total: 4 },
  }
  const reversed = {
    bodyRange: { total: 4, length: 4, offset: 0 },
    body: '原始事实',
    conversationId: 'conversation-1',
    id: 'message-1',
  }
  const history: ModelMessage[] = [
    { role: 'user', content: '总结' },
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'first', toolName: 'get_message', input: {} },
        { type: 'tool-call', toolCallId: 'second', toolName: 'get_message', input: {} },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'first',
          toolName: 'get_message',
          output: { type: 'json', value: { trust: 'untrusted', data: [row] } },
        },
        {
          type: 'tool-result',
          toolCallId: 'second',
          toolName: 'get_message',
          output: { type: 'json', value: { trust: 'untrusted', data: [reversed] } },
        },
      ],
    },
  ]
  const original = JSON.stringify(history)
  const compacted = compactAgentMessages(history)
  expect(JSON.stringify(history)).toBe(original)
  expect(compacted[0]).toBe(history[0])
  expect(compacted[1]).toBe(history[1])
  const output = compacted[2]
  if (output?.role !== 'tool') throw new Error('tool results missing')
  expect(output.content).toHaveLength(2)
  expect(output.content[0]).toMatchObject({
    toolCallId: 'first',
    output: { type: 'json', value: { trust: 'untrusted', data: [row] } },
  })
  expect(output.content[1]).toMatchObject({
    toolCallId: 'second',
    output: {
      type: 'json',
      value: { trust: 'untrusted', data: [{ id: row.id, alreadyProvided: true }] },
    },
  })
})

test('identical text on different Unicode pages and unrecognized tool payloads are never dropped', () => {
  const history: ModelMessage[] = [
    {
      role: 'tool',
      content: [
        ...[0, 1000].map((offset) => ({
          type: 'tool-result' as const,
          toolCallId: `page-${offset}`,
          toolName: 'get_message',
          output: {
            type: 'json' as const,
            value: {
              trust: 'untrusted',
              data: [
                {
                  id: 'long',
                  conversationId: 'c',
                  body: '重复段落',
                  bodyRange: { offset, length: 4, total: 2000 },
                },
              ],
            },
          },
        })),
        {
          type: 'tool-result',
          toolCallId: 'raw',
          toolName: 'get_message',
          output: { type: 'text', value: 'original' },
        },
        {
          type: 'tool-result',
          toolCallId: 'error',
          toolName: 'get_message',
          output: { type: 'json', value: null },
        },
        {
          type: 'tool-result',
          toolCallId: 'members',
          toolName: 'list_members',
          output: {
            type: 'json',
            value: { trust: 'untrusted', data: [null, 'label', { id: 'user', name: '公开名字' }] },
          },
        },
      ],
    },
  ]
  expect(compactAgentMessages(history)).toEqual(history)
})

test('repeated recent sources reference the supplied history while new pages and changed facts stay complete', () => {
  const row = {
    id: 'message-1',
    conversationId: 'conversation-1',
    seq: 91,
    sender: '韩霖',
    createdAt: '2026-05-09T01:31:00.000Z',
    body: '部署采用灰度更新，保留回滚窗口。',
    attachments: [],
  }
  const preview = { ...row, id: 'long', body: '长消息预览', bodyTruncated: true }
  const provided = [row, preview]
  const history: ModelMessage[] = [
    { role: 'user', content: untrustedHistory([{ data: provided, truncated: false }]) },
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'read', toolName: 'read_conversation', input: {} },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'read',
          toolName: 'read_conversation',
          output: {
            type: 'json',
            value: {
              trust: 'untrusted',
              data: [
                row,
                { ...row, body: '部署更正为完整更新。' },
                { ...row, id: 'long', body: '长消息预览以及后续事实' },
                { ...row, bodyRange: { offset: 200, length: 20, total: 1000 } },
              ],
            },
          },
        },
      ],
    },
  ]
  const original = JSON.stringify(history)
  const compacted = compactAgentMessages(history, provided)
  expect(JSON.stringify(history)).toBe(original)
  expect(compacted[0]).toBe(history[0])
  expect(compacted[1]).toBe(history[1])
  const output = compacted[2]
  if (output?.role !== 'tool') throw new Error('tool results missing')
  expect(output.content[0]).toMatchObject({
    toolCallId: 'read',
    output: {
      type: 'json',
      value: {
        trust: 'untrusted',
        data: [
          { id: row.id, alreadyProvided: true },
          { ...row, body: '部署更正为完整更新。' },
          { ...row, id: 'long', body: '长消息预览以及后续事实' },
          { ...row, bodyRange: { offset: 200, length: 20, total: 1000 } },
        ],
      },
    },
  })
})
