# 04 数据模型（PostgreSQL 18 + Drizzle）

## 约定

- **命名**：数据库里用 snake_case，TypeScript 里用 camelCase。在 Drizzle 中配置 `casing: 'snake_case'` 自动转换。表名用复数。
- **主键**：统一用 `uuid`，默认值为 `uuidv7()`（PostgreSQL 18 内置函数，按时间有序、无法猜测）。
  - Better Auth 的几张表通过配置 `advanced.database.generateId` 生成 UUIDv7，可以用 `Bun.randomUUIDv7()`。**M1a 要验证 Better Auth + Drizzle adapter 能否正常使用 uuid 类型的主键（V-04）。**
- **时间**：一律用 `timestamptz`，存 UTC。"每天""每月"这类按日期归类的数据，按业务时区 `APP_TIMEZONE`（默认 `Asia/Shanghai`）计算。
- **大整数**：`seq` 等 bigint 列在 TypeScript 里按 number 处理（Drizzle 的 `mode: 'number'`），实际数值远小于 2^53。
- **文本比较**：频道名唯一性、保留名比较之前，先做 Unicode NFKC 规范化，再转小写，比如 `lower(normalize(name, NFKC))`。
- **扩展**：在第一个迁移里执行 `CREATE EXTENSION IF NOT EXISTS pg_trgm;` 和 `CREATE EXTENSION IF NOT EXISTS vector;`。
- **枚举**：用 PostgreSQL 的 enum 类型，同时在 `packages/contracts` 里导出同名的 zod 枚举。
- **JSONB 字段**：内容结构用 zod 定义，读取和写入时都要校验。可以作为外键的关系字段不放进 JSONB。
- **数据库账号**：迁移用拥有者账号；应用运行时用普通账号，只有表的读写权限，不能改表结构，也不是超级用户。

## 1. 用户与认证

Better Auth 的 Drizzle adapter 需要开启 `usePlural: true`，这样表名才会是 `users`、`sessions` 等复数形式。

### `users`
| 列 | 类型 | 约束 / 默认 | 说明 |
|---|---|---|---|
| id | uuid | PK | |
| name | text | not null | **显示名**，1–32 字符（Better Auth 的 `name` 字段），不能用保留名 |
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
| invites_used | int | default 0 | 已占用的名额，只做条件更新（D-040） |
| invited_by_id | uuid | null → users | |
| username_changed_at | timestamptz | null | 用于判断 30 天冷却期 |
| storage_used_bytes | bigint | default 0 | 已用存储空间，与附件增删在同一事务中维护 |
| storage_quota_bytes | bigint | null | 按人调整的存储空间；null 表示用默认值 |
| ai_daily_tokens | int | null | 按人调整的站点 key 每日 token；null 表示用默认值 |
| locale | text | default `'zh-CN'` | |
| timezone | text | default `'Asia/Shanghai'` | IANA 时区名。`settings.timezoneAuto` 为 true 时，客户端按浏览器时区自动更新 |
| last_seen_at | timestamptz | null | 最后一个连接断开的时间 |
| settings | jsonb | default `{}` | 用户自己能改的偏好：外观、Agent 默认模式、`timezoneAuto` 等。管理员控制的限额**不**放这里 |
| deleted_at | timestamptz | null | 注销时间，注销后只保留匿名占位 |
| created_at / updated_at | timestamptz | | |

### Better Auth 的其他表
- `sessions`：会话令牌、过期时间、IP、User-Agent。
  - **会话以 Postgres 为准**：Valkey 只用于缓存和限流，Valkey 丢数据不会让用户掉线（D-044）。
  - 令牌在库里怎么存，以 M1a 的验证结果为准（V-13）。如果是明文存储，数据库备份必须加密，数据库访问也要严格限制。
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

显示名的保留词不存表，而是用 contracts 里的保留名单，外加配置里的 `AGENT_DISPLAY_NAME`。比较前先做 NFKC 规范化，再转小写，并去掉空白。

### `registration_invites`
| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| code_hash | text unique | 邀请码的 SHA-256。明文码为 16 位 base32，只在创建时显示一次 |
| created_by | uuid → users | |
| note | text null | 备注，比如"给小王" |
| max_uses | int null | null 表示不限（只有站点管理员能设） |
| use_count | int default 0 | 条件更新：只有 `max_uses IS NULL OR use_count < max_uses` 时才能加 1；另加约束 `max_uses IS NULL OR use_count <= max_uses` |
| expires_at | timestamptz not null | |
| revoked_at | timestamptz null | |
| created_at | timestamptz | |

### `registration_invite_uses`
| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| invite_id | uuid → registration_invites | |
| user_id | uuid unique null → users | 账号创建成功后填入 |
| status | text | `pending` / `confirmed` |
| expires_at | timestamptz | `pending` 的超时时间（创建后 10 分钟），过期由 cleanup 释放 |
| created_at / confirmed_at | timestamptz | |

占用和释放的规则（D-040）：
- **占用**：注册时在一个事务里完成三件事，任何一步条件不满足，整个事务失败：
  - 邀请码的 `use_count` 条件加 1；
  - 邀请人的 `users.invites_used` 条件加 1（站点管理员不受限）；
  - 插入一条 `pending` 记录。
- **确认**：账号创建成功后，把这条记录改为 `confirmed`，并填入 `user_id`。
- **释放**：以下三种情况，在同一个事务里删除这条记录，并把两个计数各减 1：
  - `pending` 超时；
  - 账号 7 天未验证，被删除；
  - 邀请人撤销还没验证的注册。

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
| settings | jsonb | default `{}` | 可能的键：`whoCanInvite`、`agentEnabled` |
| panel_for_conversation_id | uuid | null → conversations，级联删除 | 面板对话所绑定的会话，只用于 `kind = 'agent'` |
| last_seq | bigint | default 0 | 最后一条消息的 seq |
| last_change_seq | bigint | default 0 | 最后一次变更的序号 |
| last_join_seq | bigint | default 0 | 最近一次有成员加入时的 `last_seq`，用来决定更新事件能不能带内容（D-035） |
| last_message_at | timestamptz | null | |
| member_count | int | default 0 | 在同一事务中维护 |
| archived_at | timestamptz | null | |
| created_by | uuid | → users | |
| created_at / updated_at | timestamptz | | |

索引：
- `unique (lower(normalize(name, NFKC))) WHERE kind = 'channel' AND archived_at IS NULL`：频道名全站唯一，不区分大小写和全角半角；
- `(kind, archived_at)`：用于发现页；
- `gin (name gin_trgm_ops) WHERE kind = 'channel'`：频道搜索；
- `unique (owner_id, panel_for_conversation_id) WHERE panel_for_conversation_id IS NOT NULL`：每个用户对每个会话最多一个面板对话；
- `(owner_id) WHERE archived_at IS NOT NULL`：已归档列表。

**面板对话**：侧边助手面板里的对话，本质上是一个 `kind = 'agent'` 的会话，`panel_for_conversation_id` 指向当前会话。面板对话不出现在侧边栏的"助手"列表里。

**删除 Agent 会话**：
- 在一个事务里删除会话、成员和消息；附件标为 `deleting`，由 cleanup 删除文件。
- 相关 `agent_runs` 的 `conversation_id` 置为 null，只保留元数据，内容按第 10 节的保留期清除。
- 其他类型的会话只归档，不删除。

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
| visible_from_seq | bigint | not null, default 0 | 只能看到 `seq` 大于它的消息（D-035）。加入时取会话当时的 `last_seq`；创建会话时的初始成员为 0 |
| last_read_seq | bigint | default 0 | 加入时取 `visible_from_seq`；只能增大，写法 `GREATEST(旧值, 新值)` |
| notify_level | `notify_level` | default `all` | `all` / `mentions` / `none` |
| muted_until | timestamptz | null | 免打扰截止时间；永久免打扰用 `'infinity'` |
| silenced_until | timestamptz | null | **禁言**截止时间：到期前不能发消息 |
| pinned_at | timestamptz | null | 置顶时间 |
| hidden_at | timestamptz | null | 隐藏私信的时间 |

- 主键 `(conversation_id, user_id)`；另建索引 `(user_id)`，用于查询会话列表。
- 机器人不是任何会话的成员（D-051）。
- 成员退出或被移出时，直接删除这一行；再次加入时按新成员处理。

**加入会话**的事务（频道自己加入、接受群邀请、被拉入都一样）：
1. 检查 `conversation_bans`；
2. `UPDATE conversations SET member_count = member_count + 1, last_join_seq = last_seq … RETURNING last_seq`；
3. 插入成员行，`visible_from_seq` 和 `last_read_seq` 都取上一步返回的 `last_seq`；
4. 在群组里插入"某某加入了群组"的系统消息。这条消息的 seq 比 `visible_from_seq` 大，所以新成员能看到它。

### `conversation_bans`
| 列 | 类型 | 说明 |
|---|---|---|
| conversation_id | uuid → conversations，级联删除 | |
| user_id | uuid → users | 被封禁的人 |
| banned_by | uuid → users | |
| reason | text null | |
| created_at | timestamptz | |

主键 `(conversation_id, user_id)`。加入频道、接受群邀请、被拉入之前都要检查这张表（D-042）。

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

以下情况会在同一个事务里，把创建者的所有链接标为已撤销：
- 创建者退出群组，或被移出；
- 群设置为 `admins_only` 时，创建者被取消管理员。

## 3. 消息

### `messages`
| 列 | 类型 | 约束 / 默认 | 说明 |
|---|---|---|---|
| id | uuid | PK | |
| conversation_id | uuid | not null → conversations，级联删除 | 只有 Agent 会话会被删除 |
| seq | bigint | not null | 创建时分配，永不改变 |
| change_seq | bigint | not null | 最近一次变更时分配 |
| sender_id | uuid | null → users | 系统消息为 null；Agent 消息为机器人用户的 id |
| kind | `message_kind` | not null | `user` / `system` / `agent` |
| status | `message_status` | default `sent` | `sent` / `streaming` / `failed` |
| body | text | null | Markdown 正文；撤回或删除后为 null |
| reply_to_id | uuid | null → messages | 必须在同一会话内，而且发送者能看到它（seq 大于发送者的 `visible_from_seq`），由应用层检查 |
| client_id | uuid | null | 幂等键 |
| meta | jsonb | default `{}` | 可能的键：`system`（系统事件内容）、`agent`（runId、mode、keySource、streamIndex）、`viaAgent`（经 Agent 代发时的 runId） |
| edited_at / recalled_at / deleted_at | timestamptz | null | |
| deleted_by | uuid | null → users | |
| created_at | timestamptz | default now() | |

约束和索引：
- `unique (conversation_id, seq)`
- `index (conversation_id, change_seq)`：断线补发用
- `unique (sender_id, client_id) WHERE client_id IS NOT NULL`：幂等
- `check (kind = 'system' OR sender_id IS NOT NULL)`
- `check (body IS NULL OR char_length(body) <= 20000)`：应用层对用户消息另外限制为 5000
- **M4 新增** `gin (body gin_trgm_ops) WHERE body IS NOT NULL`：关键词搜索。中文也能匹配子串，但少于 3 个字的查询用不上索引（V-15）

**可见性**：消息对某个成员可见，当且仅当 `seq > 该成员的 visible_from_seq`（INV-09）。

### `message_mentions`
表结构为 `(message_id, user_id)`，两列组成主键。另建索引 `(user_id)`，用于查询"@我的"。

### `message_hidden`
表结构为 `(user_id, message_id, hidden_at)`，前两列组成主键，记录"仅自己删除"。另建索引 `(user_id, hidden_at)`，补发时用它返回某个时间之后隐藏的消息（D-043）。

## 4. 附件

### `attachments`
| 列 | 类型 | 约束 / 默认 | 说明 |
|---|---|---|---|
| id | uuid | PK | |
| uploader_id | uuid | → users | |
| message_id | uuid | null → messages | 发送时才绑定；绑定后不能再改 |
| purpose | text | not null | `message` / `avatar` / `conversation_avatar`，决定读权限（INV-09） |
| kind | `attachment_kind` | not null | `image` / `video` / `audio` / `file`，根据文件内容判断；处理失败的视频改为 `file` |
| mime | text | not null | 根据文件内容判断出的类型 |
| original_name | text | not null | 清洗后的原始文件名，≤ 255，只用于显示 |
| size_bytes | bigint | not null | |
| sha256 | text | not null | 处理后文件的哈希（图片重新编码、视频重新封装之后） |
| width / height / duration_ms | int | null | |
| storage_key | text | unique | 格式为 `att/{yyyy}/{mm}/{id}/original`，与原始文件名无关 |
| variants | jsonb | default `{}` | 衍生文件：`{thumb:{key,w,h,mime}, preview:{…}}` |
| thumbhash | text | null | |
| status | `attachment_status` | default `processing` | `processing` / `ready` / `failed` / `deleting`；图片和视频都要经过 media 队列处理 |
| position | smallint | null | 在同一条消息中的排列顺序 |
| created_at / deleted_at | timestamptz | | |

- 索引：`(message_id)`、`(uploader_id, created_at)`、`(status, created_at)`（清理任务用）。
- **存储空间**：
  - 上传时，按文件大小条件增加 `users.storage_used_bytes`（不能超过配额）；
  - 撤回、删除或清理时，在同一个事务里减回去。
  - 衍生文件不计入。

## 5. 管理

- **`reports`**：
  - 列：`id`、`message_id`、`conversation_id`、`reporter_id`、`reason`（`spam` / `abuse` / `illegal` / `other`）、`details`、`status`（`open` / `resolved` / `dismissed`）、`handled_by`、`handled_at`、`resolution_note`、`created_at`。
  - 约束：`unique (message_id, reporter_id)`，同一个人对同一条消息只能举报一次。只能举报自己看得到的消息。
- **`audit_logs`**：
  - 列：`id`、`actor_id`（系统操作为 null）、`action`、`target_type`、`target_id`、`conversation_id`、`data`（jsonb）、`ip`（inet）、`created_at`。
  - `action` 的例子：`message.delete`、`user.ban`、`user.verify_email`、`conversation.ban`、`agent.run.view`、`report.context.view`、`settings.update`。
  - `data` 里只存 id 和必要的元数据，**不存**消息正文和 AI 内容。
  - 索引：`(created_at desc)`、`(actor_id)`、`(target_type, target_id)`。
- **`app_settings`**：列为 `key text PK, value jsonb, updated_by, updated_at`，保存后台可调的各项配置（见 01 第 7 节）。

## 6. 通知（M6）

- **`push_subscriptions`**：
  - 列：`id`、`user_id`、`session_id`、`endpoint`（唯一）、`p256dh`、`auth`、`user_agent`、`created_at`、`last_success_at`、`failure_count`。
  - `session_id` 是订阅时的登录会话；该会话退出或被注销时，这条订阅一并删除（D-038）。
- **`notifications`**：
  - 列：`id`、`user_id`、`type`、`data`（jsonb）、`read_at`、`created_at`。
  - `type` 的取值：`mention` / `reply` / `approval_requested` / `reminder` / `budget_alert` / `report_opened`。
  - 索引：`(user_id, created_at desc)`。保留 90 天。

## 7. Agent（M4 / M5）

### `agent_runs`（M4）
| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| user_id | uuid → users | **调用者**：本次运行按此人的权限执行 |
| trigger | text | `agent_chat` / `mention` / `panel` / `command` / `scheduled` |
| conversation_id | uuid null → conversations | 输出写到哪个会话；会话被删除时置为 null |
| context_conversation_id | uuid null | 面板或命令所绑定的会话 |
| source_message_id / output_message_id | uuid null | 触发运行的消息 / Agent 回复的消息 |
| read_scope | text | `current_conversation` 或 `all_accessible`（见 06） |
| key_source | text | `site`（站点 key）或 `user`（自带 key），决定内容是否对站点管理员可见（D-034） |
| mode / model | text | `fast` 或 `deep`，以及实际使用的模型名 |
| timezone | text | 本次运行采用的时区 |
| status | `agent_run_status` | `queued` / `running` / `awaiting_approval` / `completed` / `failed` / `cancelled` |
| regenerated_from_run_id | uuid null | 重新生成时，指向被替换的那次运行（D-036） |
| step_count | int | |
| input_tokens / output_tokens / cached_tokens | int | |
| cost_usd | numeric(12,6) | 估算费用 |
| error_code / error_message | text null | 只存脱敏后的信息 |
| heartbeat_at | timestamptz null | 每一步和每次写库时更新，对账任务据此判断运行是否卡住 |
| content_purged_at | timestamptz null | 内容按保留期清除的时间 |
| created_at / started_at / finished_at | timestamptz | |

索引：
- `(user_id, created_at desc)`；
- `(status) WHERE status IN ('queued','running','awaiting_approval')`；
- `(key_source, created_at desc)`：供管理后台查询。

### `agent_run_states`（M4）
- **列**：`run_id`（主键，→ agent_runs）、`messages`（jsonb，完整的模型消息，包括工具调用和结果）、`updated_at`。
- **用途**：
  - 审批之后继续运行；
  - 崩溃后恢复；
  - 本人查看运行详情；
  - 站点管理员查看站点 key 的运行（D-034）。
- 内容保留 30 天，之后清空，并写入 `agent_runs.content_purged_at`。

### `agent_steps`（M4）
- **列**：`id`、`run_id`、`index`（与 `run_id` 联合唯一）、`type`（`model` / `tool_call` / `tool_result` / `approval_request` / `approval_response` / `error`）、`tool_name`、`status`（仅 `tool_call` 步骤使用：`pending` / `done` / `failed`）、`payload`（jsonb）、`input_tokens`、`output_tokens`、`duration_ms`、`created_at`。
- `payload` 是**展示用的摘要**，不超过 32 KB，超出部分截断并加标记。完整内容在 `agent_run_states` 里，续跑也只从那里恢复。

### `agent_effects`（M5a）
- **列**：`run_id`、`step_index`、`tool_name`、`entity_type`、`entity_id`、`result`（jsonb）、`created_at`；主键 `(run_id, step_index)`。
- **用法**：执行有副作用的工具时，domain 在同一个事务里完成操作，并插入这一行。重试时先查这张表：已有记录就直接返回其中的 `result`，不再执行（INV-10，D-037）。

### `agent_approvals`（M5a）
- **列**：`id`、`run_id`、`step_id`、`user_id`（必须由调用者本人审批）、`tool_name`、`args`（jsonb）、`edited_args`（jsonb，用户修改后的参数，可为空）、`status`（`pending` / `approved` / `rejected` / `expired`）、`decided_at`、`expires_at`（创建后 24 小时）、`created_at`。
- **索引**：`(user_id, status)`。过期由对账任务处理。

### `agent_memories`（M5b）
- **列**：`id`、`user_id`、`content`（≤ 500 字）、`source`（`user` / `agent`）、`created_by_run_id`（用户在设置里手动添加时为 null）、`embedding`（vector(N)）、`created_at`、`deleted_at`。
- **向量索引**：在 `embedding` 上建 HNSW 索引，使用 `vector_cosine_ops`，条件为 `deleted_at IS NULL`。

### `message_embeddings`（M5b）
- **列**：`message_id`（主键，引用 messages，级联删除）、`conversation_id`、`seq`、`embedding`（vector(N)）、`model`、`created_at`。
  - `conversation_id` 和 `seq` 是冗余存储，用来按成员关系和可见性过滤。
- **索引**：在 `embedding` 上建 HNSW 索引；另建 `(conversation_id, seq)`。
- 向量维度 N 由 M5b 的技术验证决定：Qwen3-Embedding-0.6B 为 1024（也可截成 512），bge-small-zh 为 512。

### `reminders` / `scheduled_messages`（M5a）
- **`reminders`**：列为 `id`、`user_id`、`conversation_id`（相关的会话，可为空）、`text`、`remind_at`、`status`（`scheduled` / `sent` / `cancelled`）、`created_by_run_id`、`created_at`。
  - 提醒到点时，发到用户的"提醒"Agent 会话里（第一次使用时自动创建）。
- **`scheduled_messages`**：列为 `id`、`user_id`、`conversation_id`、`body`、`send_at`、`status`（`scheduled` / `sent` / `cancelled` / `failed`）、`created_by_run_id`、`sent_message_id`、`created_at`。
- **到点执行**：由对账任务把即将到点的项放入队列（D-044），不依赖长时间挂在 Valkey 里的延迟任务。
- **发送前再检查一次权限**：发送时，用户可能已经退出会话，此时不发送，状态记为 `failed`。

### `ai_usage_daily`（M4）
- **列**：`user_id`、`day`（date，按 `APP_TIMEZONE` 计算）、`key_source`、`input_tokens`、`output_tokens`、`cached_tokens`、`cost_usd`、`run_count`；主键为 `(user_id, day, key_source)`。
- **全站月度费用**：只统计 `key_source = 'site'` 的记录，按本月范围汇总，结果在 Valkey 里缓存 1 分钟。

### `user_ai_keys`（M5a）
- **列**：`user_id`（主键，→ users，级联删除）、`provider`（目前只有 `deepseek`）、`key_ciphertext`（bytea）、`key_nonce`（bytea）、`key_version`（smallint，加密密钥的版本号，便于轮换）、`key_last4`、`status`（`active` / `invalid`）、`last_verified_at`、`created_at`、`updated_at`。
- 用 AES-256-GCM 加密，密钥来自 `AI_KEY_ENCRYPTION_KEY`。明文只在 worker 发起模型请求时解密，不返回给任何人，也不写日志（SEC-26）。

### `agent_conversation_state`（M5b）
- **列**：`conversation_id`（主键，→ conversations，级联删除）、`summary`、`summarized_through_seq`、`updated_at`。
- 长对话的滚动摘要。它不随会话数据下发给客户端。

## 8. 不变量（在测试中逐条验证）

| 编号 | 规则 |
|---|---|
| INV-01 | 新消息的 `seq` 和 `change_seq`，都通过 `UPDATE conversations … RETURNING` 在**同一事务**中分配，不会重复，也不会跳号 |
| INV-02 | 消息的任何变更（编辑、撤回、删除、Agent 完成输出、重新生成开始）都让 `last_change_seq` 加 1，并把新值写入该消息的 `change_seq`。Agent 输出过程中每秒一次的写库**不**推进 |
| INV-03 | 同一发送者使用同一个 `client_id` 重复发送，只会生成一条消息 |
| INV-04 | 同一对用户只有一个私信会话；私信会话恰好有 2 个成员（包括已注销的用户） |
| INV-05 | 附件必须同时满足：上传者就是发送者、状态为 `ready`、之前没有绑定过消息；每条消息最多 10 个附件 |
| INV-06 | 撤回或删除后：`body` 为 null，@提及记录被删除，附件状态进入 `deleting` 并由后台清理文件，向量被删除，存储用量减回 |
| INV-07 | `member_count`、`storage_used_bytes`、`invites_used`、`use_count`，都与对应的行变更在同一事务中更新 |
| INV-08 | `visible_from_seq ≤ last_read_seq ≤ 会话的 last_seq`，且 `last_read_seq` 只增不减 |
| INV-09 | 用户对某条消息有读权限，当且仅当他是该会话的成员，并且消息的 `seq` 大于他的 `visible_from_seq`。附件的读权限取决于 `purpose`：消息附件跟随所属消息，未发送时只有上传者能读；用户头像所有登录成员都能读；会话头像跟随会话的可见性 |
| INV-10 | Agent 的副作用工具，每个 `(run_id, step_index)` 的效果**恰好**发生一次：操作和 `agent_effects` 记录在同一事务中提交，重试时复用已有结果 |
| INV-11 | 注销账号时：<br>① `users` 行被匿名化（名字改为"已注销用户"，邮箱改为占位值，用户名改为 `deleted_` 加随机串，旧用户名保留 30 天），并置上 `deleted_at`；<br>② sessions、accounts、passkeys、记忆、自带 key、推送订阅、通知全部删除，未使用的邀请码撤销；<br>③ Agent 会话删除；<br>④ 退出所有频道和群组：自己是群主的，按"最早的管理员，否则最早的成员"转让，没有其他成员就归档；<br>⑤ 私信保留，但对方不能再给他发消息；<br>⑥ 发过的消息和附件保留，发送者显示为"已注销用户" |
| INV-12 | 广播和补发不泄露成员看不到的内容：被更新的消息如果 `seq ≤ last_join_seq`，只广播不含内容的 `message.changed`。Agent 流式增量同理，但允许在有人加入后最多再推送 1 秒（D-035） |
| INV-13 | 被封禁的用户不能以任何方式重新加入该会话，直到解除封禁 |
| INV-14 | 邀请计数不超限：`use_count ≤ max_uses`；非管理员的 `invites_used ≤ invite_quota`；并发注册也成立 |
| INV-15 | 站点管理员只能查看 `key_source = 'site'` 的运行内容；超过保留期的内容被清空 |

## 9. 迁移与种子数据

- **迁移文件**：用 `drizzle-kit generate` 生成 SQL 迁移并提交到仓库。已经应用过的迁移**永远不改**，只做前向迁移。
- **执行方式**：生产镜像里用 `bun src/cli.ts migrate`（使用 drizzle-orm 自带的 migrator，不依赖 drizzle-kit），以拥有者账号运行。
- **CI 必做**：
  1. 在全新的空数据库上执行全部迁移；
  2. 运行 `drizzle-kit check`；
  3. 运行测试。

  这是为了杜绝旧项目那种"迁移链断裂"的问题。
- **生产环境**：先备份，再迁移。迁移后的库必须同时兼容新旧两版代码，以便回滚。
- **种子数据**（仅开发环境）：`bun run db:seed` 可以反复执行，结果不变。它会创建：
  - Agent 机器人用户和系统保留名；
  - 3 个演示用户，密码取自 `SEED_DEMO_PASSWORD`；
  - 2 个频道、1 个群组、1 个私信，以及几十条演示消息。
- **正式管理员**：用 `bun run admin:create` 创建。密码由用户在自己的终端里输入，不经过聊天。

## 10. 数据保留

| 数据 | 保留规则 |
|---|---|
| 撤回或删除的消息 | 正文、@提及、附件文件、向量立即清除 |
| Agent 运行内容（`agent_run_states`、`agent_steps.payload`） | 30 天后清空（后台可调），`agent_runs` 的元数据保留。两种 key 相同，但管理员只能看站点 key 的（INV-15） |
| 已删除的 Agent 会话 | 消息立即删除；运行记录按上一行处理 |
| 站内通知 | 90 天 |
| 未验证邮箱的账号 | 7 天后删除，释放邀请名额、用户名和邮箱 |
| 未发送的附件 | 24 小时后清理 |
| 邀请占用的 `pending` 记录 | 10 分钟未确认即释放 |
| 审计日志 | 长期保留（不含正文） |
| 备份 | 7 份日备份 + 4 份周备份，最长约 4 周（10 第 7 节） |
| Valkey 中的数据 | 不备份，都可以从数据库重建（D-044） |

清理由 `cleanup` 任务执行（03 第 7 节）。修改本节任何一条时，同步修改 01 第 4.11 节的隐私说明。
