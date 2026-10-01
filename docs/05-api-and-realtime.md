# 05 接口与实时协议

> 当前尚无应用 contracts，本文件是待实现的契约。M1a 起落实到 `packages/contracts` 的 zod schema，并由路由生成 `/api/openapi.json`。
> 实施期间先同步本文件、schema 与调用方，再写代码；契约快照用于发现无意变化。

## 1. REST 约定

- **路径**：所有接口都在 `/api` 下（包括健康检查），不带版本号。尽量不做破坏性变更；实在无法避免时，新开一个接口，旧接口标为废弃。
- **请求体**：
  - 默认只接受 application/json；上传内容 PUT /api/uploads/:id/content 使用 application/octet-stream，Sentry /api/monitoring 仅接收经过大小与格式限制的 envelope。
  - 没有请求体的 POST 可以不带 `Content-Type`。
  - 其他类型一律返回 415。
- **认证**：使用 Better Auth 的会话 Cookie。公开入口仅限认证允许清单中的注册/登录/找回/验证、邀请码检查、healthz/readyz、隐私静态页及受限 monitoring；其他要求 active 账号及有效会话。
- **防跨站**：所有非 GET 请求都要校验 `Origin`，必须等于 `APP_ORIGIN`，否则返回 403。
- **JSON 格式**：字段名用 camelCase；id 是 UUID 字符串；时间是 ISO 8601 格式的 UTC 时间；`seq` 和 `changeSeq` 以数字形式传输（在 2^53 以内是安全的）。
- **分页**：消息按 `seq` 或 `changeSeq` 做游标分页，其他列表用不透明的 `cursor`；默认每页 50 条，最多 100 条。
- **幂等**（D-066）：消息携带 clientId，唯一 (sender_id,client_id)，初始请求指纹包含目标会话、正文、附件和引用；跨目标复用返回 IDEMPOTENCY_CONFLICT。一般创建类请求使用 Idempotency-Key，按 actor+operation+target+key 存 Postgres，保留 24 小时；同键异参 409，同键同参重新鉴权后返回当前资源，不缓存敏感 DTO。并发请求由数据库唯一约束和事务串行化；原资源已删除返回 RESOURCE_GONE。
- **条件更新**：编辑/设置携带 expectedChangeSeq 或 version，失配返回 VERSION_CONFLICT；撤回、取消和删除的重复成功请求返回相同终态，过期键不可作为业务永久去重依据。注册/上传的长操作用状态机而非长事务。

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
| `IDEMPOTENCY_CONFLICT` / `VERSION_CONFLICT` | 409 | 同键异参 / 基于旧版本修改 |
| `RESOURCE_GONE` | 410 | 有权请求的原操作资源已被删除 |
| `CONTEXT_CHANGED` | 409 | Agent 来源、成员或读取范围已经失效，需新运行 |
| `CALL_OUTCOME_UNKNOWN` | 409 | 外部模型请求结果未知，预算保守占用，不自动重试 |
| `CAPACITY_UNAVAILABLE` | 503 | 站点磁盘/资源闸门拒绝新工作，带 Retry-After |
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
               me: { role, membershipId, visibleFromSeq, lastReadSeq, unread, notifyLevel, mutedUntil|null,
                     silencedUntil|null, pinnedAt|null, hiddenAt|null } }
Member       { user: UserSummary, role, membershipId, joinedAt, silencedUntil|null }
Message      { id, conversationId, seq, changeSeq, kind: 'user'|'system'|'agent', status: 'sent'|'streaming'|'failed',
               senderId|null, body|null,
               replyTo: { state: 'unavailable' }|{ id, seq, senderId|null, excerpt|null, state: 'ok'|'recalled'|'deleted' }|null,
               attachments: Attachment[], mentions: string[], streamRevision,
               editedAt|null, recalledAt|null, deletedAt|null, createdAt,
               meta: { system?: {...}, agent?: { runId, mode, keySource, streamIndex? }, viaAgent?: { runId } } }
Attachment   { id, kind: 'image'|'video'|'audio'|'file', mime, name, sizeBytes, width|null, height|null,
               durationMs|null, thumbhash|null, status: 'processing'|'ready'|'failed',
               urls: { original, thumb|null, preview|null } }
AgentRun     { id, trigger, conversationId|null, status, mode, model|null, keySource: 'site'|'user', readScope,
               stepCount, usage: { inputTokens, outputTokens, cachedTokens, costUsd }, createdAt, finishedAt|null,
               error: { code, message }|null, regeneratedFromRunId|null, stateVersion, resumeSeq, contextEpoch }
Notification { id, type, data, readAt|null, createdAt }                                   // M6
Page<T>      { items: T[], nextCursor|null }  // message lists instead return { messages, users: Record<id, UserSummary>, hasMore }
```

- 消息列表的响应附带一个 `users` 字典，消息里只放 `senderId`，避免每条消息都重复带上用户资料。
- 普通实时事件不携带消息或 sender；HTTP 响应按当前请求者投影，再合并 users 字典。
- `lastMessagePreview.text` 在撤回或删除后为 null，界面文字（"撤回了一条消息"等）由客户端按 `state` 生成。
- replyTo.state=unavailable 时只返回不含原消息 id、seq、sender 或摘要的占位；可见引用才使用完整结构。lastMessagePreview 同样逐用户投影，不能复用其他成员看到的预览。

## 3. 接口清单

表中"里程碑"一列表示这个接口在哪个阶段实现（M1 = M1a + M1b，其余同理，细分见 11）。

### 3.1 认证与账号
| 方法和路径 | 说明 | 里程碑 |
|---|---|---|
| `/api/auth/*` | 仅按下方方法/能力清单转发；未列明路由默认 404。注册沿用 POST /api/auth/sign-up/email，但经受控注册 adapter 与激活状态机，不直接透传 | M1 |
| `POST /api/invites/check` | `{code}`，注册页用它校验邀请码是否可用；按 IP 限流 | M1 |
| `GET /api/me` / `PATCH /api/me` | 查看或修改自己的资料和设置：用户名（检查冷却期、保留名）、显示名（检查保留名）、简介、时区、偏好设置 | M1 / M2 |
| `POST /api/me/avatar` | `{attachmentId}`，把一个 `purpose=avatar` 的附件设为头像 | M3 |
| `PUT /api/me/ai-key` / `DELETE /api/me/ai-key` | `{provider: 'deepseek', apiKey}`：保存自带 key，保存前先调用模型列表接口验证。只返回末 4 位 | M5 |
| `DELETE /api/me` | 注销账号，需要再次输入密码或验证 Passkey | M7 |


**认证允许清单（D-058、V-13）**

| 能力 | 放行边界 |
|---|---|
| 邮箱注册 | POST sign-up/email；X-Invite-Code + Idempotency-Key；04 注册状态机；拒绝客户端 role/is_bot/限额/验证状态/registration_id |
| 登录/退出/本人会话 | 邮箱登录、sign-out、get-session、list-sessions、注销本人单个/其他/全部 session；账号必须 active、非 bot、未封禁 |
| 验证与找回 | 验证邮件发送/重发、GET 验证回调、密码找回与重置；单次短期令牌及注册激活检查；匿名响应不枚举账号 |
| 本人修改密码 | 需当前凭证与近期认证，注销其他 session；重置注销全部 session |
| Passkey | 本人的 challenge 生成/校验、登记、登录、列表、改名、删除；所有 challenge 绑定 session/账号、Origin、RP ID，禁止任意 userId |
| 禁止能力 | 所有 admin/impersonation；无邀请创建用户；替他人设置密码、邮箱；change-email（本版不提供）；update-user；原生 delete-user；username 登录；OAuth/社交登录及其他插件入口 |

M1a 从锁定版 SDK 导出精确 HTTP method/path 清单并提交 contracts/auth-endpoints，以上“能力”仅用于选择该清单，绝不是通配路径放行。端点升级的快照测试必须检查新增路径仍默认拒绝；省略、编码、尾斜杠等路由归一化形式也必须覆盖。后台功能全部用 /api/admin 的 domain 接口，不启用 admin 插件 HTTP 路由。机器人和未确认注册不能通过 Passkey/密码/会话恢复绕过激活。

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
| `POST /api/conversations/:id/archive` / `POST …/restore` | 归档；恢复 `{name?, ownerUserId?}`。名称冲突 409；已无有效 owner 时必须指定同意接任的活跃成员（04），并重新建立 owner 关系 | M2 |
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
| `GET /api/conversations/:id/changes?after=&cursor=&limit=` | 固定上界日志补发；after 仅第一页使用，之后仅 cursor；协议见 4.5 | M2 |
| `GET /api/sync/heads` / `GET /api/me/changes?after=&cursor=&limit=` | 轻量会话与个人版本清单 / 个人日志，覆盖成员移除、隐藏、已读和设置 | M2 |
| `GET /api/messages/:id` | 按当前权限获取单条消息及流式持久快照；不可见引用脱敏 | M2 |
| `POST /api/conversations/:id/messages` | `{clientId, body?, attachmentIds?, replyToId?}`，正文和附件至少要有一个；新建返回 201，重复提交返回 200 | M2（附件在 M3） |
| `PATCH /api/messages/:id` | `{body, expectedChangeSeq}`，编辑（仅发送者，24 小时内）。不会触发 Agent，也不产生新的通知 | M2 |
| `POST /api/messages/:id/recall` | 撤回（仅发送者，2 分钟内，服务端留 5 秒宽限） | M2 |
| `POST /api/messages/:id/hide` | 仅自己删除 | M2 |
| `DELETE /api/messages/:id` | 管理员删除（群主、会话管理员、站点管理员），写审计日志 | M2 |
| `POST /api/messages/:id/report` | `{reason, details?}`，举报 | M7 |
| `GET /api/search/messages?query=&conversationId=&cursor=` | 关键词搜索我能看到的消息（pg_trgm）；与 Agent 的 `search_messages` 共用同一个 domain 函数 | M4 |

### 3.5 附件
| 方法和路径 | 说明 | 里程碑 |
|---|---|---|
| `POST /api/uploads/reservations` | `{purpose, declaredSize?, name, conversationId?}`，Idempotency-Key；返回 `{uploadId, expiresAt, maxBytes, status}`，原子预占配额 | M3 |
| `PUT /api/uploads/:id/content` / `GET /api/uploads/:id` / `DELETE /api/uploads/:id` | 单文件流 / 查询状态与 Attachment / 取消未绑定上传；同一 uploadId 可恢复查询，失败重传需新预占 | M3 |
| `GET /api/conversations/:id/attachments?cursor=&kind=` | 共享文件，按 message.seq 和 attachment.id 稳定排序，过滤历史水位/撤回/隐藏，返回 Page<Attachment> 与所属可见消息 id | M3 |
| `GET /api/attachments/:id/:variant` | `variant` 取 `original`、`thumb` 或 `preview`。<br>• 鉴权按 `purpose` 区分（INV-09）<br>• 支持 Range（断点续传和拖动播放）<br>• 响应头见 07 的 SEC-08<br>• 带 `ETag`；所有私有变体与原文件 `Cache-Control: private, no-store`；ETag 仅用于本次 Range/条件验证，不授权跨会话缓存 | M3 |

### 3.6 Agent
| 方法和路径 | 说明 | 里程碑 |
|---|---|---|
| `POST /api/agent/runs` | 启动一次运行：`{trigger: 'agent_chat'\|'panel'\|'command', conversationId?, contextConversationId?, prompt, mode?: 'fast'\|'deep', scope?: 'current'\|'all', attachmentIds?, timezone}`，返回 run（含 `keySource`）。<br>• `scope` 只对面板和命令有效，默认 `current`（D-051）<br>• 群里 @Agent 不走这个接口，而是由发送消息自动触发 | M4 |
| `GET /api/agent/runs/:id` | run 的状态和每一步，只有本人可以查看 | M4 |
| `POST /api/agent/runs/:id/cancel` | 停止生成 | M4 |
| `POST /api/agent/runs/:id/regenerate` | 重新生成，替换原回复（D-036），返回新的 run。限制如下：<br>• 只有发起人可以操作；<br>• Agent 会话和面板里，只能重新生成最近一条回复；<br>• 群组和频道里，24 小时内可以重新生成；<br>• 执行过任何业务效果（包括提醒、记忆）或有待审批的运行不能重新生成；来源失效要求新请求 | M4 |
| `GET /api/agent/usage` | 我的今日和本月用量、剩余额度；站点 key 和自带 key 分开统计 | M4 |
| `POST /api/agent/approvals/:id` | `{decision: 'approve'\|'reject', editedArgs?, expectedStateVersion}`，状态 CAS 审批，回应/queued/work 同事务 | M5 |
| `GET /api/agent/approvals?status=pending` | 待我审批的列表 | M5 |
| `GET /api/agent/memories` / `POST` / `DELETE /api/agent/memories/:id` | 长期记忆：查看、新增、删除 | M5 |

| `GET /api/reminders?status=&cursor=` / `DELETE /api/reminders/:id` | 本人的提醒列表/取消；终态重复取消幂等，无权限 404 | M5 |
| `GET /api/scheduled-messages?status=&cursor=` / `DELETE /api/scheduled-messages/:id` | 本人的定时消息列表/取消；不得修改为未批准的新内容，修改需取消后重新审批 | M5 |

### 3.7 通知、管理与运维
| 方法和路径 | 说明 | 里程碑 |
|---|---|---|
| `POST /api/push/subscriptions` / `DELETE …/:id` | 订阅或取消浏览器推送。订阅和当前登录会话及 installationId 绑定；HTTPS 服务商允许清单、DNS/出口校验见 SEC-23，跨账号端点不得直接换绑 | M6 |
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
  - 退出、设备注销、封禁和密码变化写持久撤销，收到即 4401 关闭；
  - 每 5 秒复核 Postgres，测试调度容差 1 秒；查询失败停止敏感派发并 1013 关闭。内容每批重新授权，已授权在途字节不能撤回。
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
| 1013 | 依赖不可用或发送缓冲超限 | 抖动退避重连，恢复后按 synced 补发 |

### 4.2 消息外层结构
```json
{ "v": 1, "type": "message.changed", "topic": "conv:0192…", "data": { "conversationId": "0192…", "messageId": "0193…", "changeSeq": 42 } }
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
| hello / pong | — | connectionId/userId/serverTime/heartbeatMs（hello）；serverTime（pong） |
| message.changed | conv:* | conversationId、messageId、changeSeq；所有创建/编辑/撤回/删除共用，不含正文、引用或 sender |
| user.changed | user:* | userChangeSeq；通知个人同步，不含私有内容 |
| conversation.changed / conversation.removed | user:* | conversationId、userChangeSeq；成员失效时 removed，客户端清掉该会话缓存 |
| member.changed | conv:* | conversationId、membershipVersion，重拉成员列表 |
| typing | conv:* | conversationId、userId、state、expiresInMs=5000，当前授权后发送 |
| presence / presence.snapshot | presence:* / — | userId、status、lastSeenAt；仅登录用户可接收 |
| attachment.updated | user:* | attachmentId、generation、status，重新查询上传或附件 |
| agent.run.updated / agent.step / agent.approval.requested | user:* | runId、stateVersion、stepIndex 或 approvalId；详情接口读取，仅调用者接收 |
| agent.delta | conv:*（hub 逐连接授权，非盲播） | runId、resumeSeq、messageId、index、text；每批重新检查 session、成员、来源版本、租约 |
| notification | user:* | notificationId、userChangeSeq；正文按权限读取 |
| error | — | code、message |

### 4.5 同步契约与流式合并

会话第一页 after=synced，响应：

    { items: Message[], tombstones: string[], scannedThrough, through, nextCursor,
      membershipId, resetRequired: false }

- through 在第一页固定；后续 cursor 是服务端签名的 actor/conv/membershipId/after/through/过期时间组合，默认 10 分钟。limit 限制扫描日志数（最大 100），不是过滤后的可见消息数，因此空 items 也可以推进。
- 读取当前实体投影，允许 Message.changeSeq 高于 through；客户端只合并更新版本，但 synced 只能由 scannedThrough/最后一页 through 推进。下一轮仍从这个 synced 读取日志，不把新实体版本误当成全量水位。
- user changes 同协议，items 为资源的当前授权状态或移除墓碑，含 hiddenMessageIds/已读/设置/成员变化；不再使用 hiddenSince。成员不再存在返回 404 并清缓存，旧 membershipId 游标返回 resetRequired。
- 日志过期、缺口 >1000 或 cursor 过期返回 resetRequired，不静默跳过。重建响应在同一个数据库一致快照内返回当前会话/最新消息页、baselineChangeSeq、baselineUserSeq；后续从 baseline 补发期间发生的新变化。
- GET /sync/heads 仅返回当前可访问的 id、membershipId、lastChangeSeq、userChangeSeq，不携带正文。前台 30 秒一次（抖动），重连/回前台立即做；客户端始终区分 observed 和 synced。
- 普通提示合并后尽快补拉（目标 50ms 批处理），尾事件目标 35 秒内收敛。无内容的事件不直接写消息缓存。
- agent.delta 仅给通过 03 第 6 节批次授权的接收者。index 不连续就停止拼接，通过 GET /messages/:id 获取持久快照；每秒持久快照的 streamRevision 单调递增，最后完成事件同样走 message.changed。最终事件丢失由周期对账恢复。
- 重新生成使用新的 runId，切换前核对消息当前绑定；旧 run 的迟到增量一律丢弃。审批暂停把当前段标 sent，下一 resumeSeq 创建新段。
- 引用、预览变化时客户端失效相关缓存并重新投影；conversation.removed 清理消息、草稿的可见缓存和离线待发权限，不把清缓存当作防泄露措施。

### 4.6 功能契约闭环

| 功能 | 接口 / 持久状态 | 同步 / 实施验收 |
|---|---|---|
| 共享文件面板 | conversation attachments / attachments+messages | message.changed、attachment.updated / M3 AT-10、AT-22 |
| 提醒与定时消息取消 | GET/DELETE reminders、scheduled-messages / 对应表、work_items | user.changed；取消与到点执行竞争只允许一个结果 / M5a AT-07、AT-22 |
| 会话通知 all/mentions/none | PATCH conversation/me / notify_level、notifications | user.changed；01 第 4.8 节真值表 / M6 AT-11、AT-22 |
| 隐藏/已读/归档/成员变化 | me changes、sync heads / user_changes | 个人序号恢复 / M2a AT-12 |
| 上传状态和取消 | reservations/content/status/delete / reservation+object ledger | attachment.updated / M3 AT-10 |

以上每行的 UI 都必须有 loading、空、权限失效、错误/重试和终态；前端不得凭自己推断未写出的服务器语义。
