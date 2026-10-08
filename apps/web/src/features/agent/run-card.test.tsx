import type { AgentRunDetail } from '@chatapp/contracts'
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ISO, makeMessage, uuid } from '@/lib/sync/fixtures.ts'
import { loadRun } from './api.ts'
import { AgentRunCard } from './run-card.tsx'
import { useAgent } from './store.ts'

vi.mock('./api.ts', () => ({ loadRun: vi.fn(), regenerateRun: vi.fn(), stopRun: vi.fn() }))
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  useAgent.setState({ details: {} })
})
afterEach(() => {
  vi.useRealTimers()
  useAgent.setState({ details: {} })
})

test('incoming detail versions do not start a request loop, and denial stops the timer', () => {
  const id = uuid(880)
  const message = makeMessage(10, {
    kind: 'agent',
    status: 'streaming',
    meta: {
      agent: {
        runId: id,
        mode: 'fast',
        keySource: 'site',
        contextEpoch: uuid(881),
        resumeSeq: 0,
        streamIndex: 1,
      },
    },
  })
  const detail: AgentRunDetail = {
    run: {
      id,
      userId: uuid(1),
      trigger: 'agent_chat',
      conversationId: message.conversationId,
      contextConversationId: null,
      sourceMessageId: uuid(9),
      outputMessageId: message.id,
      status: 'running',
      mode: 'fast',
      provider: 'mock',
      model: 'mock-chatapp',
      actualModel: null,
      keySource: 'site',
      readScope: 'current_conversation',
      privacyClass: 'standard',
      contextEpoch: uuid(881),
      stateVersion: 2,
      resumeSeq: 0,
      stepCount: 1,
      regeneratedFromRunId: null,
      usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, costUsd: '0.000000' },
      createdAt: ISO,
      finishedAt: null,
      error: null,
    },
    steps: [],
  }
  render(<AgentRunCard message={message} />)
  expect(loadRun).toHaveBeenCalledTimes(1)
  act(() => useAgent.setState({ details: { [id]: detail } }))
  act(() =>
    useAgent.setState({
      details: { [id]: { ...detail, run: { ...detail.run, stateVersion: 3 } } },
    }),
  )
  expect(loadRun).toHaveBeenCalledTimes(1)
  act(() => vi.advanceTimersByTime(2000))
  expect(loadRun).toHaveBeenCalledTimes(2)
  act(() => useAgent.setState({ details: { [id]: 'denied' } }))
  act(() => vi.advanceTimersByTime(10000))
  expect(loadRun).toHaveBeenCalledTimes(2)
})
