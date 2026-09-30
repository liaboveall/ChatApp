# 04 数据模型（PostgreSQL 18 + Drizzle）

## 约定

- **表名和列名**：数据库里用 snake_case，TypeScript 里用 camelCase。在 Drizzle 中配置 `casing: 'snake_case'` 自动转换。表名用复数。
- **主键**：统一用 `uuid`，默认值为 `uuidv7()`（PostgreSQL 18 内置函数，按时间有序、无法猜测）。
  - Better Auth 的几张表通过配置 `advanced.database.generateId` 生成 UUIDv7，可以用 `Bun.randomUUIDv7()`。**M1 要验证 Better Auth + Drizzle adapter 能否正常使用 uuid 类型的主键。**
- **时间**：一律用 `timestamptz`，存 UTC。
- **扩展**：在第一个迁移里执行 `CREATE EXTENSION IF NOT EXISTS pg_trgm;` 和 `CREATE EXTENSION IF NOT EXISTS vector;`。
- **枚举**：用 PostgreSQL 的 enum 类型，同时在 `packages/contracts` 里导出同名的 zod 枚举。
- **JSONB 字段**：内容结构用 zod 定义，读取和写入时都要校验。

## 1. 用户与认证

Better Auth 的 Drizzle adapter 需要开启 `usePlural: true`，这样表名才会是 `users`、`sessions` 等复数形式。

### `users`
| 列 | 类型 | 约束 / 默认 | 说明 |
|---|---|---|---|
| id | uuid | PK | |
| name | text | not null | **显示名**，1–32 字符（Better Auth 的 `name` 字段） |
| email | text | unique, not null | 存小写 |
| email_verified | boolean | default false | |
| image | text | null | 头像 URL，由服务端根据头像附件生成 |
| username | text | unique, not null | 3–20 位 `[a-z0-9_]`（username 插件） |
| display_username | text | null | 插件自带字段，暂不使用 |
| role | text | default `'user'` | `'user'` 或 `'admin'`（admin 插件） |
| banned / ban_reason / ban_expires | boolean / text / timestamptz | | admin 插件 |
| is_bot | boolean | default false | 为 true 表示 Agent |
| bio | text | null，≤ 200 字符 | |
| invite_quota | int | default 5 | 成功邀请名额；站点管理员不受限 |
| invited_by_id | uuid | null → users | |
| username_changed_at | timestamptz | null | 用于判断 30 天冷却期 |
| storage_used_bytes | bigint | default 0 | 已用存储空间，与附件增删在同一事务中维护 |
| locale | text | default `'zh-CN'` | |
| settings | jsonb | default `{}` | 外观、Agent 默认模式等，结构由 zod 定义 |
| deleted_at | timestamptz | null | 注销时间，注销后只保留匿名占位 |
| created_at / updated_at | timestamptz | | |

### Better Auth 的其他表
- `sessions`：会话令牌（只存哈希）、过期时间、IP、User-Agent。
- `accounts`：`provider_id = 'credential'` 的那一行保存密码哈希。
- `verifications`：邮箱验证和重置密码用的令牌。
- `passkeys`：Passkey 的公钥、凭证 id、计数器等。
- 具体列以当时版本的 Better Auth CLI（`@better-auth/cli generate`）生成的 schema 为准，生成后纳入 `packages/db`。

### `username_reservations`
| 列 | 类型 | 说明 |
|---|---|---|
| username | text PK | 被释放的旧用户名，以及系统保留名 |
| user_id | uuid null | 原来的主人；系统保留名为 null |
| reserved_until | timestamptz null | 保留截止时间；null 表示永久保留 |

### `registration_invites` 和 `registration_invite_uses`
| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| code_hash | text unique | 邀请码的 SHA-256。明文码为 16 位 base32，只在创建时显示一次 |
| created_by | uuid → users | |
| note | text null | 备注，比如"给小王" |
| max_uses | int null | null 表示不限（只有站点管理员能设） |
| use_count | int default 0 | 约束 `max_uses IS NULL OR use_count <= max_uses` |
| expires_at | timestamptz not null | |
| revoked_at | timestamptz null | |
| created_at | timestamptz | |

`registration_invite_uses` 表的列为 `(invite_id, user_id unique, used_at)`。
- 某个成员已成功邀请的人数 = 他创建的邀请码被使用的总次数；这个数不能超过 `users.invite_quota`，站点管理员不受此限制。

## 2. 会话

### `conversations`
| 列 | 类型 | 约束 / 默认 | 说明 |
|---|---|---|---|
| id | uuid | PK | |
| kind | `conversation_kind` | not null | `channel` / `group` / `dm` / `agent` |
| name | text | 私信为 null，其余必填 | 1–50 字符 |
| description | text | null，≤ 500 | |
| avatar_attachment_id | uuid | null → attachments | |
| owner_id | uuid | null → users | 频道和群组填群主；Agent 会话填所属用户 |
| settings | jsonb | default `{}` | 可能的键：`whoCanInvite`、`agentEnabled`、`panelFor`（面板对话所绑定的会话 id） |
| last_seq | bigint | default 0 | 最后一条消息的 seq |
| last_change_seq | bigint | default 0 | 最后一次变更的序号 |
| last_message_at | timestamptz | null | |
| member_count | int | default 0 | 在同一事务中维护 |
| archived_at | timestamptz | null | |
| created_by | uuid | → users | |
| created_at / updated_at | timestamptz | | |

索引：
- `unique (lower(name)) WHERE kind = 'channel' AND archived_at IS NULL`：频道名全站唯一，不区分大小写；
- `(kind, archived_at)`：用于发现页；
- `gin (name gin_trgm_ops) WHERE kind = 'channel'`：频道搜索。

**面板对话**：侧边助手面板里的对话，本质上是一个 `kind = 'agent'` 的会话，并设置 `settings.panelFor = <当前会话 id>`。每个用户对每个会话最多有一个面板对话，它们不出现在侧边栏的"助手"列表里。

### `dm_pairs`
| 列 | 类型 | 说明 |
|---|---|---|
| user_low | uuid | 两个用户 id 中较小的那个 |
| user_high | uuid | 较大的那个；约束 `user_low < user_high` |
| conversation_id | uuid unique | → conversations |

主键为 `(user_low, user_high)`，保证同一对用户只有一个私信会话。

### `conversation_members`
| 列 | 类型 | 约束 / 默认 | 说明 |
|---|---|---|---|
| conversation_id | uuid | → conversations，级联删除 | |
| user_id | uuid | → users | |
| role | `member_role` | default `member` | `owner` / `admin` / `member` |
| joined_at | timestamptz | default now() | |
| last_read_seq | bigint | default 0 | 只能增大，写法 `GREATEST(旧值, 新值)` |
| notify_level | `notify_level` | default `all` | `all` / `mentions` / `none` |
| muted_until | timestamptz | null | 免打扰截止时间；永久免打扰用 `'infinity'` |
| silenced_until | timestamptz | null | **禁言**截止时间：到期前不能发消息 |
| pinned_at | timestamptz | null | 置顶时间 |
| hidden_at | timestamptz | null | 隐藏私信的时间 |

- 主键 `(conversation_id, user_id)`；另建索引 `(user_id)`，用于查询会话列表。
- 成员退出或被移出时，直接删除这一行。

### `conversation_invites`
| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| conversation_id | uuid → conversations | 只能是群组 |
| code_hash | text unique | |
| created_by | uuid → users | |
| max_uses | int null | null 表示不限 |
| use_count | int default 0 | |
| expires_at | timestamptz not null | |
| revoked_at | timestamptz null | |
| created_at | timestamptz | |

## 3. 消息

### `messages`
| 列 | 类型 | 约束 / 默认 | 说明 |
|---|---|---|---|
| id | uuid | PK | |
| conversation_id | uuid | not null → conversations | |
| seq | bigint | not null | 创建时分配，永不改变 |
| change_seq | bigint | not null | 最近一次变更时分配 |
| sender_id | uuid | null → users | 系统消息为 null；Agent 消息为机器人用户的 id |
| kind | `message_kind` | not null | `user` / `system` / `agent` |
| status | `message_status` | default `sent` | `sent` / `streaming` / `failed` |
| body | text | null | Markdown 正文；撤回或删除后为 null |
| reply_to_id | uuid | null → messages | 必须在同一会话内，由应用层检查 |
| client_id | uuid | null | 幂等键 |
| meta | jsonb | default `{}` | 可能的键：`system`（系统事件内容）、`agent`（runId、模型、模式）、`viaAgent`（经 Agent 代发时的 runId） |
| edited_at / recalled_at / deleted_at | timestamptz | null | |
| deleted_by | uuid | null → users | |
| created_at | timestamptz | default now() | |

约束和索引：
- `unique (conversation_id, seq)`
- `index (conversation_id, change_seq)`：断线补发用
- `unique (sender_id, client_id) WHERE client_id IS NOT NULL`：幂等
- `check (kind = 'system' OR sender_id IS NOT NULL)`
- `check (body IS NULL OR char_length(body) <= 20000)`：应用层对用户消息另外限制为 5000
- **M4 新增** `gin (body gin_trgm_ops) WHERE body IS NOT NULL`：关键词搜索（中文也能匹配子串）

### `message_mentions`
表结构为 `(message_id, user_id)`，两列组成主键。另建索引 `(user_id)`，用于查询"@我的"。

### `message_hidden`
表结构为 `(user_id, message_id, hidden_at)`，前两列组成主键，记录"仅自己删除"。

## 4. 附件

### `attachments`
| 列 | 类型 | 约束 / 默认 | 说明 |
|---|---|---|---|
| id | uuid | PK | |
| uploader_id | uuid | → users | |
| message_id | uuid | null → messages | 发送时才绑定；绑定后不能再改 |
| purpose | text | not null | `message` / `avatar` / `conversation_avatar` |
| kind | `attachment_kind` | not null | `image` / `video` / `audio` / `file`，根据文件内容判断 |
| mime | text | not null | 根据文件内容判断出的类型 |
| original_name | text | not null | 清洗后的原始文件名，≤ 255，只用于显示 |
| size_bytes | bigint | not null | |
| sha256 | text | not null | |
| width / height / duration_ms | int | null | |
| storage_key | text | unique | 格式为 `att/{yyyy}/{mm}/{id}/original`，与原始文件名无关 |
| variants | jsonb | default `{}` | 衍生文件：`{thumb:{key,w,h,mime}, preview:{…}}` |
| thumbhash | text | null | |
| status | `attachment_status` | default `processing` | `processing` / `ready` / `failed` / `deleting` |
| position | smallint | null | 在同一条消息中的排列顺序 |
| created_at / deleted_at | timestamptz | | |

索引：`(message_id)`、`(uploader_id, created_at)`、`(status, created_at)`（清理任务用）。

## 5. 管理

- **`reports`**：
  - 列：`id`、`message_id`、`conversation_id`、`reporter_id`、`reason`（`spam` / `abuse` / `illegal` / `other`）、`details`、`status`（`open` / `resolved` / `dismissed`）、`handled_by`、`handled_at`、`resolution_note`、`created_at`。
  - 约束：`unique (message_id, reporter_id)`，同一个人对同一条消息只能举报一次。
- **`audit_logs`**：
  - 列：`id`、`actor_id`（系统操作为 null）、`action`（例如 `message.delete`、`user.ban`、`agent.run.view`、`settings.update`）、`target_type`、`target_id`、`conversation_id`、`data`（jsonb）、`ip`（inet）、`created_at`。
  - 索引：`(created_at desc)`、`(actor_id)`、`(target_type, target_id)`。
- **`app_settings`**：列为 `key text PK, value jsonb, updated_by, updated_at`，保存后台可调的各项配置（见 01 第 7 节）。

## 6. 通知（M6）

- **`push_subscriptions`**：列为 `id`、`user_id`、`endpoint`（唯一）、`p256dh`、`auth`、`user_agent`、`created_at`、`last_success_at`、`failure_count`。

## 7. Agent（M4 / M5）

### `agent_runs`（M4）
| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| user_id | uuid → users | **调用者**：本次运行按此人的权限执行 |
| trigger | text | `agent_chat` / `mention` / `panel` / `command` / `scheduled` |
| conversation_id | uuid → conversations | 输出写到哪个会话 |
| context_conversation_id | uuid null | 面板或命令所绑定的会话 |
| source_message_id / output_message_id | uuid null | 触发运行的消息 / Agent 回复的消息 |
| read_scope | text | `current_conversation` 或 `all_accessible`，由输出位置决定（见 06） |
| mode / model | text | `fast` 或 `deep`，以及实际使用的模型名 |
| status | `agent_run_status` | `queued` / `running` / `awaiting_approval` / `completed` / `failed` / `cancelled` |
| step_count | int | |
| input_tokens / output_tokens / cached_tokens | int | |
| cost_usd | numeric(12,6) | 估算费用 |
| error_code / error_message | text null | 只存脱敏后的信息 |
| created_at / started_at / finished_at | timestamptz | |

索引：`(user_id, created_at desc)`；`(status) WHERE status IN ('queued','running','awaiting_approval')`。

### `agent_steps`（M4）
- **列**：`id`、`run_id`、`index`（与 `run_id` 联合唯一）、`type`（`model` / `tool_call` / `tool_result` / `approval_request` / `approval_response` / `error`）、`tool_name`、`payload`（jsonb，≤ 32 KB，超出部分截断并加标记）、`input_tokens`、`output_tokens`、`duration_ms`、`created_at`。
- **写入顺序**：有副作用的工具，要**先**写入 `tool_call` 这一步，再真正执行。重试时发现这一步已经存在，就跳过执行，只补写结果，避免重复执行。

### `agent_approvals`（M5）
- **列**：`id`、`run_id`、`step_id`、`user_id`（必须由调用者本人审批）、`tool_name`、`args`（jsonb）、`edited_args`（jsonb，用户修改后的参数，可为空）、`status`（`pending` / `approved` / `rejected` / `expired`）、`decided_at`、`expires_at`（创建后 24 小时）、`created_at`。
- **索引**：`(user_id, status)`。

### `agent_memories`（M5）
- **列**：`id`、`user_id`、`content`（≤ 500 字）、`source`（`user` / `agent`）、`embedding`（vector(N)）、`created_at`、`deleted_at`。
- **向量索引**：在 `embedding` 上建 HNSW 索引，使用 `vector_cosine_ops`，条件为 `deleted_at IS NULL`。

### `message_embeddings`（M5）
- **列**：`message_id`（主键，引用 messages，级联删除）、`conversation_id`（冗余存一份，便于按权限过滤）、`embedding`（vector(N)）、`model`、`created_at`。
- **索引**：在 `embedding` 上建 HNSW 索引；另建 `(conversation_id)`。
- 向量维度 N 由 M5 的技术验证决定：Qwen3-Embedding-0.6B 为 1024（也可截成 512），bge-small-zh 为 512。

### `reminders` / `scheduled_messages`（M5）
- **`reminders`**：列为 `id`、`user_id`、`conversation_id`（可为空）、`text`、`remind_at`、`status`（`scheduled` / `sent` / `cancelled`）、`created_by_run_id`、`created_at`。
- **`scheduled_messages`**：列为 `id`、`user_id`、`conversation_id`、`body`、`send_at`、`status`（`scheduled` / `sent` / `cancelled` / `failed`）、`created_by_run_id`、`sent_message_id`、`created_at`。
- **发送前再检查一次权限**：发送时用户可能已经退出会话，此时不发送，状态记为 `failed`。

### `ai_usage_daily`（M4）
- **列**：`user_id`、`day`（date）、`input_tokens`、`output_tokens`、`cached_tokens`、`cost_usd`、`run_count`；主键为 `(user_id, day)`。
- **全站月度费用**：按 `day` 在本月范围内汇总，结果在 Valkey 里缓存 1 分钟。

## 8. 不变量（在测试中逐条验证）

| 编号 | 规则 |
|---|---|
| INV-01 | 新消息的 `seq` 和 `change_seq`，都通过 `UPDATE conversations … RETURNING` 在**同一事务**中分配，不会重复，也不会跳号 |
| INV-02 | 消息的任何变更（编辑、撤回、删除、Agent 完成输出）都让 `last_change_seq` 加 1，并把新值写入该消息的 `change_seq` |
| INV-03 | 同一发送者使用同一个 `client_id` 重复发送，只会生成一条消息 |
| INV-04 | 同一对用户只有一个私信会话；私信会话恰好有 2 个成员 |
| INV-05 | 附件必须同时满足：上传者就是发送者、状态为 `ready`、之前没有绑定过消息；每条消息最多 10 个附件 |
| INV-06 | 撤回或删除后：`body` 为 null，@提及记录被删除，附件状态进入 `deleting` 并由后台清理文件，向量被删除 |
| INV-07 | `member_count` 和 `storage_used_bytes` 与对应的行变更在同一事务中更新 |
| INV-08 | `last_read_seq` 只增不减，且不超过会话的 `last_seq` |
| INV-09 | 用户对某条消息有读权限，当且仅当他是该会话的成员；附件的读权限跟随它所属的消息，未发送时只有上传者能读 |
| INV-10 | Agent 的副作用工具在同一个 `(run_id, step index)` 上最多执行一次 |
| INV-11 | 注销账号时：`users` 行被匿名化（名字改为"已注销用户"，邮箱和用户名改为占位值），`deleted_at` 被置上；sessions、accounts、passkeys、记忆、推送订阅全部删除；消息保留，发送者显示为"已注销用户" |

## 9. 迁移与种子数据

- **迁移文件**：用 `drizzle-kit generate` 生成 SQL 迁移并提交到仓库。已经应用过的迁移**永远不改**，只做前向迁移。
- **CI 必做**：
  1. 在全新的空数据库上执行全部迁移；
  2. 运行 `drizzle-kit check`；
  3. 运行测试。
  
  这是为了杜绝旧项目那种"迁移链断裂"的问题。
- **生产环境**：先备份，再迁移；迁移必须做到新旧两版代码都能在迁移后的库上运行，以便回滚。
- **种子数据**（仅开发环境）：`bun run db:seed` 可以反复执行，结果不变。它会创建：
  - Agent 机器人用户和系统保留名；
  - 3 个演示用户，密码取自 `SEED_DEMO_PASSWORD`；
  - 2 个频道、1 个群组、1 个私信，以及几十条演示消息。
- **正式管理员**：用 `bun run admin:create` 创建。密码由用户在自己的终端里输入，不经过聊天。
