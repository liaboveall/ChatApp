/** Synthetic, English-only product scenes. No accounts, messages, or AI calls leave the browser. */
import type { AgentRunDetail, Attachment, Message } from '@chatapp/contracts'
import {
  makeAccount,
  makeConversation,
  makeMe,
  makeMessage,
  makeUser,
  uuid,
} from '../src/lib/sync/fixtures.ts'

export const NOW = '2026-10-20T02:30:00.000Z'
export const me = makeAccount({
  displayName: 'Alice Chen',
  username: 'alice',
  locale: 'en',
  timezone: 'Asia/Singapore',
  storageQuotaBytes: 5 * 1024 ** 3,
  aiDailyTokens: 500000,
})
export const bob = makeUser(2, { displayName: 'Bob Miller', username: 'bob' })
export const maya = makeUser(3, { displayName: 'Maya Patel', username: 'maya' })
export const agent = makeUser(4, {
  displayName: 'Assistant',
  username: 'chatapp_agent',
  isBot: true,
})
export const users = Object.fromEntries([me, bob, maya, agent].map((user) => [user.id, user]))
const preview = (text: string, senderId = bob.id) => ({
  senderId,
  text,
  kind: 'user' as const,
  state: 'ok' as const,
})
export const launch = makeConversation(500, {
  name: 'Product launch',
  description: 'A shared space for the launch plan, design reviews, and team updates.',
  memberCount: 3,
  lastSeq: 5,
  lastChangeSeq: 5,
  lastMessageAt: NOW,
  lastMessagePreview: preview('The launch checklist is ready for review.'),
  me: makeMe({ role: 'owner', lastReadSeq: 5, pinnedAt: NOW }),
})
export const panel = makeConversation(501, {
  kind: 'agent',
  name: 'Launch recap',
  panelForConversationId: launch.id,
  memberCount: 1,
  lastSeq: 2,
  lastChangeSeq: 2,
  lastMessageAt: NOW,
  me: makeMe({ role: 'owner', lastReadSeq: 2 }),
})
export const assistant = makeConversation(502, {
  kind: 'agent',
  name: 'Launch assistant',
  memberCount: 1,
  lastSeq: 4,
  lastChangeSeq: 4,
  lastMessageAt: NOW,
  lastMessagePreview: preview('Review the message before I send it.', agent.id),
  me: makeMe({ role: 'owner', lastReadSeq: 4 }),
})
export const conversations = [
  launch,
  panel,
  assistant,
  makeConversation(503, {
    kind: 'channel',
    name: 'general',
    memberCount: 12,
    lastMessageAt: NOW,
    lastMessagePreview: preview('Welcome to the team!'),
    me: makeMe({ lastReadSeq: 8 }),
    lastSeq: 8,
  }),
  makeConversation(504, {
    kind: 'channel',
    name: 'design',
    memberCount: 8,
    lastMessageAt: NOW,
    lastMessagePreview: preview('New mockups are in.'),
    me: makeMe({ lastReadSeq: 9, unread: 2 }),
    lastSeq: 11,
  }),
  makeConversation(505, {
    name: 'Weekend plans',
    lastMessageAt: NOW,
    lastMessagePreview: preview('Coffee on Saturday?'),
    lastSeq: 6,
    me: makeMe({ lastReadSeq: 6 }),
  }),
  makeConversation(506, {
    kind: 'dm',
    name: null,
    dmPeer: bob,
    lastMessageAt: NOW,
    lastMessagePreview: preview('Thanks for the review!'),
    lastSeq: 4,
    me: makeMe({ lastReadSeq: 3, unread: 1 }),
  }),
  makeConversation(507, {
    kind: 'dm',
    name: null,
    dmPeer: maya,
    lastMessageAt: NOW,
    lastMessagePreview: preview('See you at the demo.', maya.id),
    lastSeq: 3,
    me: makeMe({ lastReadSeq: 3 }),
  }),
]
export const file: Attachment = {
  id: uuid(7000),
  version: 1,
  generation: 1,
  kind: 'file',
  mime: 'application/pdf',
  name: 'launch-checklist.pdf',
  sizeBytes: 245760,
  width: null,
  height: null,
  durationMs: null,
  thumbhash: null,
  status: 'ready',
  metadataCleared: true,
  urls: { original: '/api/demo/launch-checklist.pdf', thumb: null, preview: null },
}
function message(seq: number, body: string, senderId = me.id, patch: Partial<Message> = {}) {
  return makeMessage(seq, {
    body,
    senderId,
    createdAt: new Date(Date.parse(NOW) - (10 - seq) * 60000).toISOString(),
    ...patch,
  })
}
const meta = (runId: string) => ({
  agent: {
    runId,
    mode: 'fast' as const,
    keySource: 'site' as const,
    contextEpoch: uuid(800),
    resumeSeq: 0,
    streamIndex: 1,
  },
})
export const recap =
  '**Launch recap**\n\n- **Release:** Friday at 10:00 AM (Singapore time).\n- **Design:** Maya will finish the onboarding review on Thursday.\n- **Engineering:** Bob will complete the final smoke test.\n- **Next step:** Alice will share the go / no-go update after both checks.\n\nMaya and Bob confirmed the owners in this conversation.'
export const outgoing =
  'Launch update: we are targeting Friday at 10:00 AM (Singapore time). Maya owns the onboarding review; Bob owns the final smoke test. I will share the go / no-go update once both checks are complete.'
export const messages: Record<string, Message[]> = {
  [launch.id]: [
    message(
      1,
      "Let's aim for **Friday at 10:00 AM** for the launch. Can we confirm the remaining checks?",
    ),
    message(
      2,
      "I'll finish the onboarding review on Thursday. The new welcome flow is looking good.",
      maya.id,
    ),
    message(3, "I'll handle the final smoke test and post the results here.", bob.id),
    message(4, "Perfect. I'll share the go / no-go update once both checks are complete."),
    message(5, 'The launch checklist is ready for review.', bob.id, { attachments: [file] }),
  ],
  [panel.id]: [
    message(1, 'Summarize the launch decisions and next steps.', me.id, {
      id: uuid(2001),
      conversationId: panel.id,
    }),
    message(2, recap, agent.id, {
      id: uuid(2002),
      conversationId: panel.id,
      kind: 'agent',
      meta: meta(uuid(900)),
    }),
  ],
  [assistant.id]: [
    message(1, 'Find the launch decisions in Product launch and draft a short update.', me.id, {
      id: uuid(3001),
      conversationId: assistant.id,
    }),
    message(2, `Here is a draft based on the launch discussion:\n\n${outgoing}`, agent.id, {
      id: uuid(3002),
      conversationId: assistant.id,
      kind: 'agent',
      meta: meta(uuid(901)),
    }),
    message(3, 'Send that update to Product launch.', me.id, {
      id: uuid(3003),
      conversationId: assistant.id,
    }),
    message(4, 'Please review the message below before I send it.', agent.id, {
      id: uuid(3004),
      conversationId: assistant.id,
      kind: 'agent',
      meta: meta(uuid(902)),
    }),
  ],
}
function run(
  n: number,
  conversationId: string,
  outputMessageId: string,
  tools: string[],
): AgentRunDetail {
  return {
    run: {
      id: uuid(n),
      userId: me.id,
      trigger: conversationId === panel.id ? 'panel' : 'agent_chat',
      conversationId,
      contextConversationId: conversationId === panel.id ? launch.id : null,
      sourceMessageId: null,
      outputMessageId,
      status: n === 902 ? 'awaiting_approval' : 'completed',
      mode: 'fast',
      provider: 'mock',
      model: 'demo-fixture',
      actualModel: null,
      keySource: 'site',
      readScope: conversationId === panel.id ? 'current_conversation' : 'all_accessible',
      privacyClass: 'standard',
      contextEpoch: uuid(800),
      stateVersion: 1,
      resumeSeq: 0,
      stepCount: tools.length,
      regeneratedFromRunId: null,
      hasEffects: false,
      pendingApproval: n === 902,
      usage: { inputTokens: 2140, outputTokens: 186, cachedTokens: 0, costUsd: '0.000000' },
      createdAt: NOW,
      finishedAt: n === 902 ? null : NOW,
      error: null,
    },
    steps: tools.map((toolName, index) => ({
      index,
      type: 'tool_call',
      toolName,
      status: 'done',
      payload:
        toolName === 'send_message'
          ? { conversationId: launch.id, body: outgoing }
          : { conversationId: launch.id },
      createdAt: NOW,
    })),
    approvals: [],
    effects: [],
  }
}
export const runs = [
  run(900, panel.id, uuid(2002), ['read_unread']),
  run(901, assistant.id, uuid(3002), ['search_messages', 'get_conversation_messages']),
  run(902, assistant.id, uuid(3004), ['send_message']),
]
export const approval = {
  id: uuid(950),
  runId: uuid(902),
  toolName: 'send_message',
  status: 'pending' as const,
  reason: null,
  required: true,
  edited: false,
  stateVersion: 1,
  resumeSeq: 0,
  stepIndex: 0,
  expiresAt: '2026-10-21T02:30:00.000Z',
  decidedAt: null,
  createdAt: NOW,
  preview: {
    tool: 'send_message' as const,
    body: outgoing,
    conversation: { id: launch.id, kind: 'group' as const, name: launch.name, peer: null },
  },
}
runs[2]?.approvals.push(approval)
