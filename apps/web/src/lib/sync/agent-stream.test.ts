import { expect, test } from 'vitest'
import { mergeAgentDelta } from './agent-stream.ts'
import { makeMessage, uuid } from './fixtures.ts'
import { mergeMessage } from './merge.ts'

const message = makeMessage(8, {
  kind: 'agent',
  body: '前文',
  status: 'streaming',
  streamRevision: 2,
  meta: {
    agent: { runId: uuid(90), mode: 'fast', keySource: 'site', streamIndex: 4, resumeSeq: 0 },
  },
})
const delta = {
  conversationId: message.conversationId,
  messageId: message.id,
  runId: uuid(90),
  resumeSeq: 0,
  leaseEpoch: 1,
  index: 5,
  streamRevision: 2,
  text: '后文',
}
test('ordered deltas append once without advancing the durable cursor', () => {
  const next = mergeAgentDelta(message, delta)
  expect(next).toMatchObject({ body: '前文后文', changeSeq: message.changeSeq, streamRevision: 2 })
  if (typeof next === 'string') throw new Error('missing merged message')
  expect(mergeAgentDelta(next, delta)).toBe('ignore')
})
test('a dropped batch requests a snapshot; old runs, resumes and terminal messages cannot append', () => {
  expect(mergeAgentDelta(message, { ...delta, index: 7 })).toBe('gap')
  expect(mergeAgentDelta(message, { ...delta, resumeSeq: 1 })).toBe('ignore')
  expect(mergeAgentDelta(message, { ...delta, runId: uuid(91) })).toBe('ignore')
  expect(mergeAgentDelta({ ...message, status: 'sent' }, delta)).toBe('ignore')
  expect(mergeAgentDelta(undefined, delta)).toBe('gap')
})
test('a late snapshot cannot roll back text already streamed; the terminal change replaces it', () => {
  const next = mergeAgentDelta(message, delta)
  if (typeof next === 'string') throw new Error('missing merged message')
  expect(mergeMessage(next, { ...message, streamRevision: 3 })).toBe(next)
  const final = {
    ...next,
    changeSeq: next.changeSeq + 1,
    status: 'sent' as const,
    streamRevision: 4,
  }
  expect(mergeMessage(next, final)).toBe(final)
})
