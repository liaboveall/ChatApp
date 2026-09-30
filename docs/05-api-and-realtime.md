# 05 接口与实时协议

> 接口的**唯一定义**是 `packages/contracts` 里的 zod schema，OpenAPI 文档由它生成，开发环境可访问 `/api/openapi.json`。
> 本文件是这份定义的说明和清单。新增或修改接口时，先改 contracts，再改本文件和代码。

## 1. REST 约定

- **路径**：所有接口都在 `/api` 下（包括健康检查），不带版本号。尽量不做破坏性变更；实在无法避免时，新开一个接口，旧接口标为废弃。
- **请求体**：
  - 只接受 `application/json`，唯一的例外是 `POST /api/uploads`，它使用 `multipart/form-data`。
  - 没有请求体的 POST 可以不带 `Content-Type`。
  - 其他类型一律返回 415。
- **认证**：使用 Better Auth 的会话 Cookie。除登录、注册、邀请码检查、健康检查之外，所有接口都要求已登录。
- **防跨站**：所有非 GET 请求都要校验 `Origin`，必须等于 `APP_ORIGIN`，否则返回 403。
- **JSON 格式**：字段名用 camelCase；id 是 UUID 字符串；时间是 ISO 8601 格式的 UTC 时间；`seq` 和 `changeSeq` 以数字形式传输（在 2^53 以内是安全的）。
- **分页**：消息按 `seq` 或 `changeSeq` 做游标分页，其他列表用不透明的 `cursor`；默认每页 50 条，最多 100 条。
- **幂等**：
  - 发消息必须在请求体里带 `clientId`，服务端用它去重；
  - 其他"创建"类接口，前端统一在请求头带 `Idempotency-Key`，10 分钟内重复提交会返回第一次的结果。
- **限流**：超限时返回 429，并带 `Retry-After` 头。按用户和真实客户端 IP 计数；IP 只取可信的本机反向代理写入的头（SEC-28）。
- **私有资源不可见时返回 404**：对私有会话、消息、附件，如果当前用户无权访问，一律返回 404 而不是 403，避免暴露资源是否存在。只有"资源可见、但当前操作不被允许"时才返回 403，比如成员试图踢人。
- **错误文字**：`message` 是给开发者看的英文说明；界面上显示的文字由客户端根据 `code` 和 `details` 本地化。
- **Better Auth 的错误格式**：`/api/auth/*` 沿用 Better Auth 自己的错误格式，前端对这些路由单独适配。
- **邀请码不进日志**：邀请码一律放在请求体或请求头里，不放在 URL 路径或查询参数里（D-045）。

### 错误格式
```json
{ "error": { "code": "FORBIDDEN", "message": "Only the owner can transfer the group", "details": {}, "requestId": "..." } }
```

| code | HTTP | 含义 |
|---|---|---|
| `UNAUTHENTICATED` | 401 | 未登录，或会话已失效 |
| `FORBIDDEN` | 403 | 资源可见，但当前操作不被允许 |
| `NOT_FOUND` | 404 | 资源不存在，或当前用户无权看到 |
| `VALIDATION_FAILED` | 422 | 参数校验失败，`details` 里按字段给出原因 |
| `CONFLICT` | 409 | 名称重复、状态冲突等 |
| `RATE_LIMITED` | 429 | 请求过于频繁 |
| `QUOTA_EXCEEDED` | 403 | 存储空间、邀请名额或 Agent 每日用量已用完 |
| `AI_BUDGET_EXHAUSTED` | 503 | 全站 AI 月度预算已用完（只影响站点 key） |
| `AI_KEY_INVALID` | 422 | 自带的 API key 无效或余额不足 |
| `CONVERSATION_BANNED` | 403 | 已被该会话封禁，不能加入 |
| `PAYLOAD_TOO_LARGE` | 413 | 文件或请求体太大 |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | 不支持的请求类型 |
| `WINDOW_EXPIRED` | 403 | 已超过撤回或编辑时限 |
| `INVITE_INVALID` | 400 | 邀请码无效、过期、用完或已撤销 |
| `INTERNAL` | 500 | 服务端错误，只返回 `requestId` 便于查日志 |

## 2. 主要数据结构（简写，完整定义见 contracts）

```ts
UserSummary  { id, username, displayName, avatarUrl|null, isBot, deleted: boolean }
Me           UserSummary & { email, role: 'user'|'admin', bio, locale, timezone, settings,
               inviteQuota, invitesUsed, storageUsedBytes, storageQuotaBytes, aiDailyTokens,
               aiKey: { provider: 'deepseek', last4, status: 'active'|'invalid' }|null }        // aiKey from M5
Conversation { id, kind: 'channel'|'group'|'dm'|'agent', name|null, description|null, avatarUrl|null,
               memberCount, lastSeq, lastChangeSeq, lastMessageAt|null,
               lastMessagePreview: { senderId|null, text|null, kind, state: 'ok'|'recalled'|'deleted' }|null,
               dmPeer: UserSummary|null, settings: { whoCanInvite?, agentEnabled? },
               panelForConversationId|null, archivedAt|null,
               me: { role, visibleFromSeq, lastReadSeq, unread, notifyLevel, mutedUntil|null,
                     silencedUntil|null, pinnedAt|null, hiddenAt|null } }
Member       { user: UserSummary, role, joinedAt, silencedUntil|null }
Message      { id, conversationId, seq, changeSeq, kind: 'user'|'system'|'agent', status: 'sent'|'streaming'|'failed',
               senderId|null, body|null,
               replyTo: { id, seq, senderId|null, excerpt|null, state: 'ok'|'recalled'|'deleted'|'unavailable' }|null,
               attachments: Attachment[], mentions: string[],
               editedAt|null, recalledAt|null, deletedAt|null, createdAt,
               meta: { system?: {...}, agent?: { runId, mode, keySource, streamIndex? }, viaAgent?: { runId } } }
Attachment   { id, kind: 'image'|'video'|'audio'|'file', mime, name, sizeBytes, width|null, height|null,
               durationMs|null, thumbhash|null, status: 'processing'|'ready'|'failed',
               urls: { original, thumb|null, preview|null } }
AgentRun     { id, trigger, conversationId|null, status, mode, model|null, keySource: 'site'|'user', readScope,
               stepCount, usage: { inputTokens, outputTokens, cachedTokens, costUsd }, createdAt, finishedAt|null,
               error: { code, message }|null, regeneratedFromRunId|null }
Notification { id, type, data, readAt|null, createdAt }                                   // M6
Page<T>      { items: T[], nextCursor|null }  // message lists instead return { messages, users: Record<id, UserSummary>, hasMore }
```

- 消息列表的响应附带一个 `users` 字典，消息里只放 `senderId`，避免每条消息都重复带上用户资料。
- 实时事件里的消息会额外带一个 `sender: UserSummary` 字段，前端收到后直接合并进用户缓存。
- `lastMessagePreview.text` 在撤回或删除后为 null，界面文字（"撤回了一条消息"等）由客户端按 `state` 生成。
- `replyTo.state = 'unavailable'` 表示被引用的消息在我加入之前，此时 `excerpt` 为 null（D-035）。

## 3. 接口清单

表中"里程碑"一列表示这个接口在哪个阶段实现（M1 = M1a + M1b，其余同理，细分见 11）。

### 3.1 认证与账号
| 方法和路径 | 说明 | 里程碑 |
|---|---|---|
| `ALL /api/auth/*` | Better Auth 挂载点：登录、退出、邮箱验证与重发、重置密码、Passkey、会话列表与注销。有以下收口（D-039）：<br>• 注册用 `POST /api/auth/sign-up/email`，必须在请求头 `X-Invite-Code` 里带邀请码，由 before hook 校验并占用名额（D-040）；具体机制在 M1a 验证（V-13）<br>• `update-user` 不能修改用户名、显示名、头像<br>• 用户名登录和 Better Auth 自带的删除账号接口关闭 | M1 |
| `POST /api/invites/check` | `{code}`，注册页用它校验邀请码是否可用；按 IP 限流 | M1 |
| `GET /api/me` / `PATCH /api/me` | 查看或修改自己的资料和设置：用户名（检查冷却期、保留名）、显示名（检查保留名）、简介、时区、偏好设置 | M1 / M2 |
| `POST /api/me/avatar` | `{attachmentId}`，把一个 `purpose=avatar` 的附件设为头像 | M3 |
| `PUT /api/me/ai-key` / `DELETE /api/me/ai-key` | `{provider: 'deepseek', apiKey}`：保存自带 key，保存前先调用模型列表接口验证。只返回末 4 位 | M5 |
| `DELETE /api/me` | 注销账号，需要再次输入密码或验证 Passkey | M7 |

### 3.2 邀请与用户
| 方法和路径 | 说明 | 里程碑 |
|---|---|---|
| `GET /api/invites` / `POST /api/invites` / `DELETE /api/invites/:id` | 我的注册邀请码：列表（包含还没验证邮箱的注册）、创建（明文码只在创建时返回这一次）、撤销 | M1 |
| `DELETE /api/invites/registrations/:useId` | 撤销一个还没验证邮箱的注册：删除这个账号，释放邀请名额和用户名 | M1 |
| `GET /api/users?query=` | 搜索成员（按用户名或显示名），用于开私信、拉人 | M2 |
| `GET /api/users/:id` | 查看成员资料 | M2 |

### 3.3 会话与成员
| 方法和路径 | 说明 | 里程碑 |
|---|---|---|
| `GET /api/conversations` | 我所在的全部会话，附带未读数和最后一条消息预览（不分页，会话数量有限）。加 `?archived=true` 时，返回我是群主的已归档会话 | M2 |
| `POST /api/conversations` | 创建会话：`{kind: 'channel'\|'group'\|'agent', name, description?, memberIds?}` | M2（agent 类型在 M4） |
| `POST /api/conversations/dm` | `{userId}`，获取或创建与此人的私信 | M2 |
| `GET /api/channels?query=&cursor=` | 发现页：搜索频道 | M2 |
| `GET /api/conversations/:id` / `PATCH /api/conversations/:id` | 查看会话详情；修改名称、简介、设置 | M2 |
| `POST /api/conversations/:id/archive` / `POST …/restore` | 归档；恢复（`{name?}`，频道名被占用时返回 409，需要带新名字重试）。群主或站点管理员 | M2 |
| `DELETE /api/conversations/:id` | 只用于 Agent 会话：删除会话和其中的消息（本人） | M4 |
| `POST /api/conversations/:id/join` / `POST …/leave` | 加入频道；退出会话（群主须先转让） | M2 |
| `POST /api/conversations/:id/transfer` | `{userId}`，转让群主 | M2 |
| `PATCH /api/conversations/:id/me` | 我对这个会话的个人设置：`{notifyLevel?, mutedUntil?, pinned?, hidden?}` | M2 |
| `POST /api/conversations/:id/read` | `{seq}`，推进我的已读位置（只能向前推） | M2 |
| `GET /api/conversations/:id/members?cursor=` | 成员列表 | M2 |
| `POST /api/conversations/:id/members` | `{userIds}`，拉人进群（跳过被封禁的人，并在结果里说明） | M2 |
| `PATCH /api/conversations/:id/members/:userId` | `{role?, silencedUntil?}`，任免管理员、禁言 | M2 |
| `DELETE /api/conversations/:id/members/:userId` | 移出（不封禁） | M2 |
| `GET /api/conversations/:id/bans` / `POST …/bans` / `DELETE …/bans/:userId` | 封禁名单；移出并封禁（`{userId, reason?}`）；解除封禁 | M2 |
| `POST /api/conversations/:id/invites` / `GET` / `DELETE …/:inviteId` | 群邀请链接：创建、列表、撤销 | M2 |
| `POST /api/conversation-invites/preview` / `POST /api/conversation-invites/accept` | `{code}`：查看群邀请的预览（群名、人数）；接受邀请加入 | M2 |

### 3.4 消息与搜索
| 方法和路径 | 说明 | 里程碑 |
|---|---|---|
| `GET /api/conversations/:id/messages?beforeSeq=&afterSeq=&aroundSeq=&limit=` | 历史消息，三个游标参数任选一个；不带参数时返回最新的一页。只返回我能看到的消息（`seq > visibleFromSeq`） | M2 |
| `GET /api/conversations/:id/changes?sinceChangeSeq=&hiddenSince=&limit=` | 补发：返回 `changeSeq` 大于给定值、且我能看到的消息，以及 `hiddenSince` 之后我隐藏的消息 id（`hiddenMessageIds`）。缺口超过 1000 条变更时，返回 `resetRequired: true` | M2 |
| `POST /api/conversations/:id/messages` | `{clientId, body?, attachmentIds?, replyToId?}`，正文和附件至少要有一个；新建返回 201，重复提交返回 200 | M2（附件在 M3） |
| `PATCH /api/messages/:id` | `{body}`，编辑（仅发送者，24 小时内）。不会触发 Agent，也不产生新的通知 | M2 |
| `POST /api/messages/:id/recall` | 撤回（仅发送者，2 分钟内，服务端留 5 秒宽限） | M2 |
| `POST /api/messages/:id/hide` | 仅自己删除 | M2 |
| `DELETE /api/messages/:id` | 管理员删除（群主、会话管理员、站点管理员），写审计日志 | M2 |
| `POST /api/messages/:id/report` | `{reason, details?}`，举报 | M7 |
| `GET /api/search/messages?query=&conversationId=&cursor=` | 关键词搜索我能看到的消息（pg_trgm）；与 Agent 的 `search_messages` 共用同一个 domain 函数 | M4 |

### 3.5 附件
| 方法和路径 | 说明 | 里程碑 |
|---|---|---|
| `POST /api/uploads` | multipart 上传，字段为 `file` 和 `purpose`，返回 `Attachment`（通常处于 `processing` 状态） | M3 |
| `GET /api/attachments/:id/:variant` | `variant` 取 `original`、`thumb` 或 `preview`。<br>• 鉴权按 `purpose` 区分（INV-09）<br>• 支持 Range（断点续传和拖动播放）<br>• 响应头见 07 的 SEC-08<br>• 带 `ETag`；衍生图 `Cache-Control: private, max-age=3600`，原图 `private, no-cache` | M3 |

### 3.6 Agent
| 方法和路径 | 说明 | 里程碑 |
|---|---|---|
| `POST /api/agent/runs` | 启动一次运行：`{trigger: 'agent_chat'\|'panel'\|'command', conversationId?, contextConversationId?, prompt, mode?: 'fast'\|'deep', scope?: 'current'\|'all', attachmentIds?, timezone}`，返回 run（含 `keySource`）。<br>• `scope` 只对面板和命令有效，默认 `current`（D-051）<br>• 群里 @Agent 不走这个接口，而是由发送消息自动触发 | M4 |
| `GET /api/agent/runs/:id` | run 的状态和每一步，只有本人可以查看 | M4 |
| `POST /api/agent/runs/:id/cancel` | 停止生成 | M4 |
| `POST /api/agent/runs/:id/regenerate` | 重新生成，替换原回复（D-036），返回新的 run。限制如下：<br>• 只有发起人可以操作；<br>• Agent 会话和面板里，只能重新生成最近一条回复；<br>• 群组和频道里，24 小时内可以重新生成；<br>• 执行过需要审批的工具的运行，不能重新生成 | M4 |
| `GET /api/agent/usage` | 我的今日和本月用量、剩余额度；站点 key 和自带 key 分开统计 | M4 |
| `POST /api/agent/approvals/:id` | `{decision: 'approve'\|'reject', editedArgs?}`，审批 | M5 |
| `GET /api/agent/approvals?status=pending` | 待我审批的列表 | M5 |
| `GET /api/agent/memories` / `POST` / `DELETE /api/agent/memories/:id` | 长期记忆：查看、新增、删除 | M5 |

### 3.7 通知、管理与运维
| 方法和路径 | 说明 | 里程碑 |
|---|---|---|
| `POST /api/push/subscriptions` / `DELETE …/:id` | 订阅或取消浏览器推送。订阅和当前登录会话绑定 | M6 |
| `GET /api/notifications?cursor=` / `POST /api/notifications/read` | 站内通知列表；`{ids}` 或 `{all: true}` 标为已读 | M6 |
| `GET /api/admin/users?query=&cursor=`、`PATCH /api/admin/users/:id`（`{role?, inviteQuota?, storageQuotaBytes?, aiDailyTokens?}`）、`POST …/:id/ban`、`POST …/:id/unban`、`POST …/:id/verify-email` | 用户管理；手动标记邮箱已验证（写审计日志） | M7 |
| `GET /api/admin/invites`、`GET /api/admin/conversations`、`POST /api/admin/conversations/:id/archive` / `restore` | 邀请和会话管理 | M7 |
| `GET /api/admin/reports`、`PATCH /api/admin/reports/:id`（`{status, resolutionNote}`）、`GET /api/admin/reports/:id/context` | 举报处理。`context` 返回被举报消息及前后各 5 条，访问会写审计日志 | M7 |
| `GET /api/admin/agent-runs?userId=&keySource=&status=&cursor=`、`GET /api/admin/agent-runs/:id` | AI 运行记录。站点 key 的运行在保留期内返回完整内容；自带 key 的运行只返回元数据。查看详情会写审计日志（D-034） | M7 |
| `GET /api/admin/audit-logs`、`GET /api/admin/ai-usage`、`GET/PATCH /api/admin/settings` | 审计日志、AI 用量、后台配置 | M7 |
| `GET /api/healthz`、`GET /api/readyz` | 健康检查，不需要登录。`readyz` 检查数据库、Valkey 和 S3，对外只返回 200 或 503，不返回细节 | M1 |
| `POST /api/monitoring` | 转发前端的 Sentry 上报（D-046）。不需要登录，因为登录页也要能上报；按 IP 限流，并限制请求大小 | M7 |
| `/api/test/*` | 测试专用：可控时钟、断开连接等。只在 `APP_ENV=test` 时注册，生产环境启动时检查不存在（SEC-29） | M1 起 |

## 4. WebSocket 协议

### 4.1 连接
- **地址**：`/ws`，与页面同源；开发环境下由 Vite 代理转发。
- **认证**：握手时读取会话 Cookie，未登录直接关闭连接，关闭码 4401。
- **与登录会话绑定**（D-038）：
  - 连接记下自己的 sessionId；
  - 该会话被退出、被注销、账号被封禁或修改密码时，服务端在几秒内以 4401 关闭连接；
  - 服务端每 5 分钟复核一次会话是否仍然有效。
- **来源校验**：握手请求的 `Origin` 必须等于 `APP_ORIGIN`，否则以 4403 关闭。
- **帧大小**：客户端发来的单帧不能超过 64 KB。
- **格式**：全部是 JSON 文本帧，收到二进制帧直接关闭连接。

| 关闭码 | 含义 | 客户端处理 |
|---|---|---|
| 4401 | 未登录，或会话已失效、被注销 | 清除本地缓存，跳转到登录页，不要重连 |
| 4403 | 来源不被允许 | 不要重连 |
| 4408 | 心跳超时 | 立即重连 |
| 4409 | 连接数超限（最早的连接被踢） | 如果当前页面在后台，就不重连 |
| 4429 | 客户端发送太频繁 | 退避后重连 |
| 1012 | 服务重启 | 按退避策略重连 |

### 4.2 消息外层结构
```json
{ "v": 1, "type": "message.created", "topic": "conv:0192…", "data": { … } }
```
- 客户端发给服务端的消息不带 `topic`。
- 收到未知的 `type` 时：客户端直接忽略；服务端回一条 `error` 事件。
- 所有消息都用 contracts 里的 zod 判别联合类型（按 `type` 区分）进行校验。

### 4.3 客户端 → 服务端
| type | data | 说明 |
|---|---|---|
| `ping` | `{}` | 应用层心跳，服务端回 `pong`。协议层的 ping/pong 帧同样有效 |
| `typing` | `{conversationId, state: 'start'\|'stop'}` | 每个会话最多每 3 秒发一次；非成员发的会被忽略 |
| `presence.watch` | `{userIds: string[]}` | **整体替换**关注的用户集合，最多 200 个；服务端立即回一条 `presence.snapshot` |
| `presence.activity` | `{state: 'active'\|'idle'}` | 页面可见性或用户操作状态变化时发送 |
| `focus` | `{conversationId: string\|null, foreground: boolean}` | 当前查看的会话和页面是否在前台；切换会话或页面前后台变化时发送。用于"正在看的会话不推送"（D-043） |

所有写操作都**不走** WebSocket，统一用 HTTP。

### 4.4 服务端 → 客户端
| type | topic | data |
|---|---|---|
| `hello` | — | `{connectionId, userId, serverTime, heartbeatMs: 25000}`。客户端用 `serverTime` 校正本地时钟 |
| `pong` | — | `{serverTime}` |
| `message.created` | `conv:*` | `{message, sender}`。新消息对所有现有成员都可见，总是带完整内容 |
| `message.updated` | `conv:*` | `{message}`。编辑、撤回、管理员删除、Agent 输出完成、重新生成开始都用这个事件；只在消息的 `seq > last_join_seq` 时发送 |
| `message.changed` | `conv:*` | `{conversationId, messageId, changeSeq}`。不含内容：当被更新的消息 `seq ≤ last_join_seq` 时，用它代替 `message.updated`，客户端按自己的权限补拉（INV-12） |
| `message.hidden` | `user:*` | `{conversationId, messageId}`，只发给自己，用于多设备同步 |
| `conversation.created` / `conversation.updated` | `user:*` | `{conversation}`（包含 `me` 字段） |
| `conversation.removed` | `user:*` | `{conversationId, reason: 'left'\|'kicked'\|'banned'\|'archived'\|'deleted'}` |
| `member.joined` / `member.left` / `member.updated` | `conv:*` | `{conversationId, member}` 或 `{conversationId, userId}` |
| `read.updated` | `user:*` | `{conversationId, lastReadSeq}`，用于多设备同步 |
| `typing` | `conv:*` | `{conversationId, userId, state, expiresInMs: 5000}` |
| `presence` | `presence:*` | `{userId, status: 'online'\|'away'\|'offline', lastSeenAt}` |
| `presence.snapshot` | — | `{users: [{userId, status, lastSeenAt}]}`，回应 `presence.watch` |
| `attachment.updated` | `user:*` | `{attachment}`，比如缩略图处理完成 |
| `agent.run.updated` | `user:*` | `{run}`，状态变化时推送 |
| `agent.step` | `user:*`（**只发给调用者本人**，群里其他成员只能看到 Agent 回复的流式文本） | `{runId, step: {index, type, toolName?, summary, status}}` |
| `agent.delta` | `conv:*` | `{runId, messageId, index, text}`，文本增量。服务端每 50–100 毫秒合并发送一次，`index` 从 0 开始递增 |
| `agent.approval.requested` | `user:*` | `{approval}`，只发给调用者本人 |
| `notification` | `user:*` | M6：`{notification}` |
| `error` | — | `{code, message}`，针对客户端刚发来的那条消息 |

### 4.5 顺序、去重与补发
- **消息合并**：以 `message.id` 为键，只接受 `changeSeq` 更大的版本。
- **跳号检测**（D-043）：
  - 客户端为每个会话记住已知的最大 `changeSeq`（初始值取自 `GET /api/conversations`）。
  - 对每一个 `conv:*` 消息事件，如果它的 `changeSeq` 比已知值大 1 以上，1 秒后仍未补上，就调用 `/changes` 补拉。
  - 收到 `message.changed` 时，随机延迟 0–2 秒后补拉；同一会话的多次通知合并成一次。
- **断线补发**：连接断开后可能漏掉事件，重连时按 03 第 5.2 节的流程补齐。页面重新回到前台时，也做一次轻量对账（`GET /api/conversations`）。
- **连带更新**：收到某条消息的更新后，客户端同时更新：
  - 本地所有引用它的回复（`replyTo`）；
  - 会话列表里的预览（如果它是最后一条消息）。
- **流式增量**：
  - `agent.delta` 如果收到的 `index` 不连续，客户端就停止拼接增量，等 `message.updated` 带来完整文本后直接替换。
  - 中途打开会话时，消息里的 `meta.agent.streamIndex` 表示已写入正文的增量序号，客户端从下一个 `index` 接着拼接。
  - 同一条消息出现新的 `runId`（重新生成）时，客户端清空旧文本，重新开始拼接。
- **正在输入**：收到后 5 秒自动消失；收到这个用户在同一会话的新消息时也立即消失。
- **Agent 的流式消息**：
  - 以 `status: 'streaming'` 的状态创建，输出完成后通过 `message.updated` 改为 `sent`；出错则改为 `failed`，并附带错误说明。
  - 运行暂停等待审批时，当前消息也改为 `sent`，并标注"等待批准"（D-051）。
- **离开会话**：收到 `conversation.removed` 后，客户端删除这个会话的本地缓存。
