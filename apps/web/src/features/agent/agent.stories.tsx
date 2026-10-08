import type { AgentRunDetail, ApprovalPreview } from '@chatapp/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useEffect, useState } from 'react'
import { MessageBody } from '@/components/markdown/message-body.tsx'
import { ISO, makeMessage, uuid } from '@/lib/sync/fixtures.ts'
import { installMockApi, restoreFetch, sampleMe } from '../../../.storybook/mock-api.ts'
import { AgentMode, AgentScope } from './controls.tsx'
import { AgentRunCard } from './run-card.tsx'
import { useAgent } from './store.ts'

const meta = {
  title: 'Assistant/Run states',
  tags: ['visual'],
  parameters: { layout: 'padded', surface: 'plain', api: { 'GET /api/me': { body: sampleMe } } },
} satisfies Meta
export default meta
type Story = StoryObj<typeof meta>

function Stage({
  status = 'completed',
  error = null,
  denied = false,
  approval,
}: {
  status?: AgentRunDetail['run']['status']
  error?: string | null
  denied?: boolean
  approval?: ApprovalPreview
}) {
  const id = uuid(880)
  const message = makeMessage(12, {
    kind: 'agent',
    status: status === 'running' ? 'streaming' : status === 'failed' ? 'failed' : 'sent',
    body:
      status === 'completed'
        ? '发布安排：周五上午九点半开始灰度部署；负责人苏澄，预算 12000 元。'
        : '',
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
      userId: sampleMe.id,
      trigger: 'panel',
      conversationId: message.conversationId,
      contextConversationId: uuid(501),
      sourceMessageId: uuid(883),
      outputMessageId: message.id,
      status,
      mode: 'fast',
      provider: 'soclaas',
      model: 'x-test-1',
      actualModel: 'glm-5.3-flash',
      keySource: 'site',
      readScope: 'current_conversation',
      privacyClass: 'standard',
      contextEpoch: uuid(881),
      stateVersion: 3,
      resumeSeq: 0,
      stepCount: 2,
      regeneratedFromRunId: null,
      hasEffects: false,
      pendingApproval: status === 'awaiting_approval',
      usage: { inputTokens: 1800, outputTokens: 120, cachedTokens: 0, costUsd: '0.000000' },
      createdAt: ISO,
      finishedAt: status === 'running' ? null : ISO,
      error: error ? { code: error, message: '' } : null,
    },
    steps: [
      {
        index: 0,
        type: 'tool_call',
        toolName: 'read_unread',
        status: 'done',
        payload: { limit: 300 },
        createdAt: ISO,
      },
    ],
    approvals: approval
      ? [
          {
            id: uuid(890),
            runId: id,
            toolName: approval.tool,
            status: 'pending',
            reason: null,
            required: true,
            preview: approval,
            edited: false,
            stateVersion: 3,
            resumeSeq: 0,
            stepIndex: 1,
            expiresAt: '2026-10-09T03:00:00.000Z',
            decidedAt: null,
            createdAt: ISO,
          },
        ]
      : [],
    effects: [],
  }
  useState(() => {
    installMockApi({
      'GET /api/me': { body: sampleMe },
      [`GET /api/agent/runs/${id}`]: { body: detail },
    })
    useAgent.setState({ details: { [id]: denied ? 'denied' : detail }, modes: {}, scopes: {} })
  })
  useEffect(
    () => () => {
      useAgent.setState({ details: {}, modes: {}, scopes: {} })
      restoreFetch()
    },
    [],
  )
  return (
    <div className="agent-panel" style={{ width: '100%', maxWidth: 520 }}>
      <p>这里的请求和回答仅你可见。</p>
      <AgentMode id={message.conversationId} />
      <AgentScope id={message.conversationId} />
      <MessageBody text={message.body ?? ''} />
      <AgentRunCard message={message} />
    </div>
  )
}

export const Completed: Story = { render: () => <Stage /> }
export const Streaming: Story = { render: () => <Stage status="running" /> }
export const DailyLimit: Story = { render: () => <Stage status="failed" error="QUOTA_EXCEEDED" /> }
export const UnknownCall: Story = {
  render: () => <Stage status="failed" error="UNKNOWN_EXECUTION" />,
}
export const SharedReply: Story = { render: () => <Stage denied /> }
export const RememberApproval: Story = {
  render: () => (
    <Stage
      status="awaiting_approval"
      approval={{
        tool: 'remember',
        content: '我喜欢在九点开始工作，会议中安排短暂休息。',
        privacyClass: 'byok_private',
      }}
    />
  ),
}
export const SendApproval: Story = {
  render: () => (
    <Stage
      status="awaiting_approval"
      approval={{
        tool: 'send_message',
        body: '灰度验证完成，仍保留回滚窗口。',
        conversation: { id: uuid(501), kind: 'group', name: '项目协作', peer: null },
      }}
    />
  ),
}
