import { type AgentToolName, AppError, agentToolSchemas } from '@chatapp/contracts'
import { jsonSchema, tool } from 'ai'
import { z } from 'zod'
import type { AgentLease } from '../../domain/agent-access.ts'
import { executeAgentTool, recordAgentToolFailure } from '../../domain/agent-tools.ts'
import type { Deps } from '../../domain/deps.ts'
import { boundedAgentData } from '../context.ts'

const descriptions: Record<AgentToolName, string> = {
  read_conversation: '读取范围内的会话最近消息。省略 conversationId 使用当前会话。',
  read_unread: '读取本人已读位置之后的可见消息，最多300条。',
  search_messages:
    '字面关键词检索可见消息，不做语义匹配。空结果时尝试上下文支持的同义短词。from 是发送者用户 UUID，不能填人名；after/before 是消息发送时间，不能用事项或计划日期代替。',
  get_message:
    '读取一条可见消息与前后各五条。长正文用 bodyOffset/bodyLimit 按 Unicode 字符分页；bodyRange 给出总长度，默认每页2000字。',
  list_conversations: '仅在 all_accessible 范围列出我的会话及未读数。',
  list_members: '列出范围内会话的当前成员和角色。',
  get_user_profile: '查询用户的公开资料。',
}
export function agentTools(deps: Deps, lease: AgentLease, allAccessible: boolean, maxBytes = 8000) {
  const build = (name: AgentToolName) =>
    tool<unknown, unknown, Record<string, never>>({
      description: descriptions[name],
      // Domain Zod validation is authoritative. SDK schema failures must not skip the authorized failed-step audit.
      inputSchema: jsonSchema<unknown>(z.toJSONSchema(agentToolSchemas[name])),
      execute: async (input) => {
        try {
          const data = await executeAgentTool(deps, lease, name, input)
          const chronological =
            ['read_conversation', 'read_unread'].includes(name) && Array.isArray(data)
          const view = boundedAgentData(
            chronological ? [...data].reverse() : data,
            maxBytes,
            name === 'get_message' ? undefined : 200,
          )
          return {
            trust: 'untrusted',
            ...view,
            data: chronological && Array.isArray(view.data) ? view.data.reverse() : view.data,
          }
        } catch (error) {
          if (
            error instanceof AppError &&
            ['NOT_FOUND', 'FORBIDDEN', 'VALIDATION_FAILED'].includes(error.code)
          ) {
            await recordAgentToolFailure(deps, lease, name, input, error.code)
            return { trust: 'untrusted', error: error.code }
          }
          throw error
        }
      },
    })
  return {
    read_conversation: build('read_conversation'),
    read_unread: build('read_unread'),
    search_messages: build('search_messages'),
    get_message: build('get_message'),
    list_members: build('list_members'),
    get_user_profile: build('get_user_profile'),
    ...(allAccessible ? { list_conversations: build('list_conversations') } : {}),
  }
}
