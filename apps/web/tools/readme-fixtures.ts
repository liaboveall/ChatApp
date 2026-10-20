/** Synthetic product scenes. No accounts, messages, or AI calls leave the browser. */
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
export const locale = process.argv.includes('--locale=zh-CN') ? 'zh-CN' : 'en'
const text = (english: string, chinese: string) => (locale === 'zh-CN' ? chinese : english)
export const checklistReady = text(
  'The launch checklist is ready for review.',
  '上线检查清单已整理好，大家可以开始检查了。',
)
export const memoryNote = text(
  'Keep project updates concise and list the owner of each next step.',
  '项目更新请保持简洁，并列出每项待办的负责人。',
)
export const me = makeAccount({
  displayName: text('Alice Chen', '陈悦'),
  username: 'alice',
  locale,
  timezone: 'Asia/Singapore',
  storageQuotaBytes: 5 * 1024 ** 3,
  aiDailyTokens: 500000,
})
export const bob = makeUser(2, { displayName: text('Bob Miller', '林博'), username: 'bob' })
export const maya = makeUser(3, { displayName: text('Maya Patel', '苏晴'), username: 'maya' })
export const agent = makeUser(4, {
  displayName: text('Assistant', '助手'),
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
  name: text('Product launch', '产品上线'),
  description: text(
    'A shared space for the launch plan, design reviews, and team updates.',
    '一起讨论上线计划、设计评审和团队进展。',
  ),
  memberCount: 3,
  lastSeq: 5,
  lastChangeSeq: 5,
  lastMessageAt: NOW,
  lastMessagePreview: preview(checklistReady),
  me: makeMe({ role: 'owner', lastReadSeq: 5, pinnedAt: NOW }),
})
export const panel = makeConversation(501, {
  kind: 'agent',
  name: text('Launch recap', '上线安排总结'),
  panelForConversationId: launch.id,
  memberCount: 1,
  lastSeq: 2,
  lastChangeSeq: 2,
  lastMessageAt: NOW,
  me: makeMe({ role: 'owner', lastReadSeq: 2 }),
})
export const assistant = makeConversation(502, {
  kind: 'agent',
  name: text('Launch assistant', '上线小助手'),
  memberCount: 1,
  lastSeq: 4,
  lastChangeSeq: 4,
  lastMessageAt: NOW,
  lastMessagePreview: preview(
    text('Review the message before I send it.', '发送前，请先检查这条消息。'),
    agent.id,
  ),
  me: makeMe({ role: 'owner', lastReadSeq: 4 }),
})
export const conversations = [
  launch,
  panel,
  assistant,
  makeConversation(503, {
    kind: 'channel',
    name: text('general', '综合讨论'),
    memberCount: 12,
    lastMessageAt: NOW,
    lastMessagePreview: preview(text('Welcome to the team!', '欢迎加入团队！')),
    me: makeMe({ lastReadSeq: 8 }),
    lastSeq: 8,
  }),
  makeConversation(504, {
    kind: 'channel',
    name: text('design', '设计交流'),
    memberCount: 8,
    lastMessageAt: NOW,
    lastMessagePreview: preview(text('New mockups are in.', '新版设计稿已经上传。')),
    me: makeMe({ lastReadSeq: 9, unread: 2 }),
    lastSeq: 11,
  }),
  makeConversation(505, {
    name: text('Weekend plans', '周末计划'),
    lastMessageAt: NOW,
    lastMessagePreview: preview(text('Coffee on Saturday?', '周六一起喝杯咖啡？')),
    lastSeq: 6,
    me: makeMe({ lastReadSeq: 6 }),
  }),
  makeConversation(506, {
    kind: 'dm',
    name: null,
    dmPeer: bob,
    lastMessageAt: NOW,
    lastMessagePreview: preview(text('Thanks for the review!', '感谢你的评审意见！')),
    lastSeq: 4,
    me: makeMe({ lastReadSeq: 3, unread: 1 }),
  }),
  makeConversation(507, {
    kind: 'dm',
    name: null,
    dmPeer: maya,
    lastMessageAt: NOW,
    lastMessagePreview: preview(text('See you at the demo.', '演示时见。'), maya.id),
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
  name: text('launch-checklist.pdf', '上线检查清单.pdf'),
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
export const recap = text(
  '**Launch recap**\n\n- **Release:** Friday at 10:00 AM (Singapore time).\n- **Design:** Maya will finish the onboarding review on Thursday.\n- **Engineering:** Bob will complete the final smoke test.\n- **Next step:** Alice will share the go / no-go update after both checks.\n\nMaya and Bob confirmed the owners in this conversation.',
  '**上线安排总结**\n\n- **时间：**周五上午 10 点（新加坡时间）。\n- **设计：**苏晴周四完成新手引导评审。\n- **工程：**林博负责最后一轮冒烟测试。\n- **下一步：**两项检查完成后，陈悦同步是否上线。\n\n以上分工由苏晴和林博在当前会话中确认。',
)
export const outgoing = text(
  'Launch update: we are targeting Friday at 10:00 AM (Singapore time). Maya owns the onboarding review; Bob owns the final smoke test. I will share the go / no-go update once both checks are complete.',
  '上线进展：计划于周五上午 10 点（新加坡时间）发布。苏晴负责新手引导评审，林博负责最后一轮冒烟测试。两项检查完成后，我会同步是否上线。',
)
export const messages: Record<string, Message[]> = {
  [launch.id]: [
    message(
      1,
      text(
        "Let's aim for **Friday at 10:00 AM** for the launch. Can we confirm the remaining checks?",
        '我们计划**周五上午 10 点**上线，剩余的检查工作大家确认一下？',
      ),
    ),
    message(
      2,
      text(
        "I'll finish the onboarding review on Thursday. The new welcome flow is looking good.",
        '我会在周四完成新手引导评审，新版欢迎流程的效果不错。',
      ),
      maya.id,
    ),
    message(
      3,
      text(
        "I'll handle the final smoke test and post the results here.",
        '我来负责最后一轮冒烟测试，结果会同步到这里。',
      ),
      bob.id,
    ),
    message(
      4,
      text(
        "Perfect. I'll share the go / no-go update once both checks are complete.",
        '好，两项检查都完成后，我会同步是否上线。',
      ),
    ),
    message(5, checklistReady, bob.id, { attachments: [file] }),
  ],
  [panel.id]: [
    message(
      1,
      text(
        'Summarize the launch decisions and next steps.',
        '总结一下上线安排、负责人和接下来的待办。',
      ),
      me.id,
      {
        id: uuid(2001),
        conversationId: panel.id,
      },
    ),
    message(2, recap, agent.id, {
      id: uuid(2002),
      conversationId: panel.id,
      kind: 'agent',
      meta: meta(uuid(900)),
    }),
  ],
  [assistant.id]: [
    message(
      1,
      text(
        'Find the launch decisions in Product launch and draft a short update.',
        '找到「产品上线」中的讨论，帮我起草一条简短的进展更新。',
      ),
      me.id,
      {
        id: uuid(3001),
        conversationId: assistant.id,
      },
    ),
    message(
      2,
      `${text('Here is a draft based on the launch discussion:', '根据上线讨论，草稿如下：')}\n\n${outgoing}`,
      agent.id,
      {
        id: uuid(3002),
        conversationId: assistant.id,
        kind: 'agent',
        meta: meta(uuid(901)),
      },
    ),
    message(3, text('Send that update to Product launch.', '把这条更新发到「产品上线」。'), me.id, {
      id: uuid(3003),
      conversationId: assistant.id,
    }),
    message(
      4,
      text('Please review the message below before I send it.', '发送前，请先检查下面的消息。'),
      agent.id,
      {
        id: uuid(3004),
        conversationId: assistant.id,
        kind: 'agent',
        meta: meta(uuid(902)),
      },
    ),
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
