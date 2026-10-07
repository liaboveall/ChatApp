# 04 数据模型（PostgreSQL 18 + Drizzle）

## 约定

- **命名**：数据库里用 snake_case，TypeScript 里用 camelCase。在 Drizzle 中配置 `casing: 'snake_case'` 自动转换。表名用复数。
- **主键**：统一用 `uuid`，默认值为 `uuidv7()`（PostgreSQL 18 内置函数，按时间有序；不把 id 的随机性当作授权）。
  - Better Auth 的几张表通过配置 `advanced.database.generateId` 注入 `runtime/ids` 的 UUIDv7 工厂，Bun 专用实现不进入 auth/domain（D-090）。M1a 已验证 Better Auth 1.7.7 + Drizzle adapter 可以使用 uuid 主键和 UUIDv7（V-04，D-100）。
- **时间**：一律用 `timestamptz`，存 UTC。"每天""每月"这类按日期归类的数据，按业务时区 `APP_TIMEZONE`（默认 `Asia/Shanghai`）计算。
- **大整数**：`seq` 等 bigint 列在 TypeScript 里按 number 处理（Drizzle 的 `mode: 'number'`），实际数值远小于 2^53。
- **文本比较**：频道名唯一性、保留名比较之前，先做 Unicode NFKC 规范化，再转小写，比如 `lower(normalize(name, NFKC))`。
- **扩展**：在第一个迁移里执行 `CREATE EXTENSION IF NOT EXISTS pg_trgm;` 和 `CREATE EXTENSION IF NOT EXISTS vector;`。
- **枚举**：用 PostgreSQL 的 enum 类型，同时在 `packages/contracts` 里导出同名的 zod 枚举。
- **JSONB 字段**：在 Drizzle 里一律用 `packages/db/src/schema/json.ts` 的 `jsonbValue<T>()` 声明，不用 Drizzle 自带的 `jsonb()`（guard 会拒绝）：后者经 Bun 驱动会被编码两次，所有值都变成“内容是 JSON 文本的 jsonb 字符串”，`->>`、`@>` 和索引都读不到（D-107）。用 zod 校验；活实体关联使用外键。历史来源清单是带版本的不可变标识快照，允许 JSONB 保存已删除资源的 id，但读取时必须联表验证，不能当作活授权。
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
| username | text | unique, not null | 3–20 位 `[a-z0-9_]`，CHECK 保证格式；由受控注册写入，不启用 username 插件，没有 display_username 列（D-095） |
| role | text | default `'user'` | `'user'` 或 `'admin'`，应用 domain 管理，客户端不可赋值 |
| banned / ban_reason / ban_expires | boolean / text / timestamptz | | 应用封禁字段，客户端不可赋值 |
| registration_id | uuid | unique null → registration_invite_uses | 普通注册必须在账号首次插入时写入；与 `registration_invite_uses.user_id` 互为外键，插入顺序（先登记、后账号、再回填）使延迟约束没有必要（D-096） |
| activation_status | enum | not null，default `pending` | pending / active / revoked；登录要求 active 且 email_verified |
| account_source | enum | not null，default `registration` | registration / cli / bootstrap。CHECK：active 必须 email_verified；只有 registration 来源带 registration_id。CLI 与 bootstrap 是 INV-18 的受审计例外（D-099） |
| auth_epoch / user_change_seq | bigint | default 0 | 账号授权世代 / 个人同步水位 |
| change_log_floor | bigint | default 0，≤ user_change_seq | 个人日志（`user_changes`）已清理到的序号；游标低于它必须重置（M2a，D-126） |
| profile_version / me_version | bigint | default 1 | 公开资料版本 / 本人资料与设置版本；所覆盖字段见 05，变化同事务递增 |
| avatar_attachment_id | uuid | null → attachments | image 只是服务端派生的 URL |
| is_bot | boolean | default false | 为 true 表示 Agent |
| bio | text | null，≤ 200 字符 | |
| invite_quota | int | default 5 | 成功邀请名额；站点管理员不受限 |
| invites_used | int | default 0 | 已占用的名额，只做条件更新（D-040） |
| invited_by_id | uuid | null → users | |
| username_changed_at | timestamptz | null | 用于判断 30 天冷却期 |
| storage_used_bytes / storage_reserved_bytes | bigint | default 0，均 ≥ 0 | 已结算主文件字节 / 上传预占；两者之和不得超过配额 |
| storage_quota_bytes | bigint | null | 按人调整的存储空间；null 表示用默认值 |
| ai_daily_tokens | int | null | 按人调整的站点 key 每日 token；null 表示用默认值 |
| locale | text | default `'zh-CN'` | |
| timezone | text | default `'Asia/Shanghai'` | IANA 时区名。`settings.timezoneAuto` 为 true 时，客户端按浏览器时区自动更新 |
| last_seen_at | timestamptz | null | 最后一个连接断开的时间 |
| settings | jsonb | default `{}` | 用户自己能改的偏好：Agent 默认模式、`timezoneAuto` 等（M1b 起只有 `timezoneAuto`，由 `PATCH /api/me` 按键合并，D-118）。**外观偏好是设备级的，存在浏览器本地，不在这里**（D-117）。管理员控制的限额**不**放这里 |
| deleted_at | timestamptz | null | 注销时间，注销后只保留匿名占位 |
| created_at / updated_at | timestamptz | | |

### Better Auth 的其他表
- `sessions`：会话令牌、过期时间、IP、User-Agent、auth_epoch、authorization_origin_id（→ authorization_origins）。
  - **会话以 Postgres 为准**：Valkey 只用于缓存和限流，Valkey 丢数据不会让用户掉线（D-044）。
  - 令牌在库里是**明文**（M1a 实测，D-100），Cookie 值是 `令牌.签名`：数据库备份必须加密，数据库访问也要严格限制。
- `accounts`：`provider_id = 'credential'` 的那一行保存密码哈希。
- `verifications`：仅保留锁定版 SDK 确实需要的 challenge；应用邮箱验证/密码重置由下方 auth_challenges 控制，不能假设此表能撤销 SDK 的签名邮件 JWT。
- `passkeys`：Passkey 的公钥、凭证 id、计数器等。
- 具体列以当时版本的 Better Auth CLI（`@better-auth/cli generate`）生成的 schema 为准，生成后纳入 `packages/db`。

### auth_challenges（M1a，D-076）
- 列：id、user_id（FK，删除账号级联）、registration_id（普通注册必填）、purpose（verify_email/reset_password）、email_hash、auth_epoch、restore_epoch、token_hash（unique）、expires_at、consumed_at、revoked_at、created_at。
- token 为随机256-bit，SHA-256 后查行，按 user_id 定位唯一账号并检查注册关联/邮箱摘要/全部世代；不得仅按邮箱查当前账号。验证和重置默认1小时；重发锁定用户后撤销同用途未消费凭证，旧邮件即使晚到也不能使用。
- 邮件 worker 所需 token 仅存该受限认证表的 delivery_ciphertext/delivery_nonce（text，base64url）与 delivery_key_version（smallint），用单独的 AUTH_TOKEN_ENCRYPTION_KEY 以 AES-256-GCM 加密，challenge id 作为附加认证数据，密文挪到别的行就解不开。事务同时创建凭证和仅含 challenge id 的 work_item；发送确认、到期或撤销后清密文。网络结果未知可用同一未过期凭证有限重投，不能把 token/邮件正文写入通用队列或日志。
- 验证消费、email_verified、confirmed 检查及 active 更新同事务；人工验证撤销全部 verify_email 凭证。重置消费、密码哈希写入、auth_epoch 递增、全部 session/origin/delegation 撤销同事务；适配器无法保证时不得开放该原生路径。重复已消费凭证返回通用失效，不登录或重建账号。
- 消费/过期行保留7天无密文元数据后删除。RESTORE_EPOCH 从备份外重新生成，所有旧凭证默认拒绝；清表与世代校验两层同时执行。

### authorization_origins / execution_delegations（身份契约 M1a，业务使用 M4/M5a，D-079）
- authorization_origins：id、user_id、created_at、ended_at、revoked_at、revoke_reason；每次登录生成不可由客户端指定的 origin。session 普通结束只记 ended_at，明确安全撤销设置 revoked_at；origin 在 session 删除后仍保留，直到关联委托终态且超过30天。
- execution_delegations：id、user_id、origin_id、parent_id（可空）、auth_epoch、restore_epoch、purpose（agent_run/reminder/scheduled_message）、target_type/id、args_hash、status（active/revoked/completed/expired）、expires_at、revoked_at、created_at。表由 domain 创建；不是可传给客户端使用的 bearer token。
- run 委托创建后最多25小时；调度子委托绑定已批准的目标/参数、来源 origin 及 epoch，expires_at=到点时间+24小时，预约≤365天。子任务独立于父 run 完成/取消，但继承 origin/账号撤销。审批不可用另一设备重新绑定失效委托。
- 未完成run/任务的delegation_id必须非空且存在；终态元数据引用可ON DELETE SET NULL，清委托前确认无活任务和活子委托，origin最后清。状态CHECK防止清理后终态再次变为可执行；去重账本独立保留。
- SessionPrincipal 验当前 session，DelegatedPrincipal 验 active 委托、origin 未撤销、两个 epoch、有效期及作用范围；两者都验当前业务权限。普通退出/到期不使 origin 撤销；安全操作真值表见03。维护清理的 SystemPrincipal 只允许列明动作，不能据此代用户发送消息。

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

### registration_invite_uses（注册状态机，D-059）
| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | 稳定 registration_id；客户端重试通过幂等记录定位，不接受任意指定 |
| invite_id / inviter_id | uuid FK | 邀请码与邀请人 |
| user_id | uuid unique null → users | 与 users.registration_id 双向关联，允许延迟约束在事务末验证 |
| email_normalized / request_hash | text | 绑定该注册请求，限制读取和日志，不存明文密码 |
| status | text | reserved / account_created / confirmed / released |
| lease_epoch / lease_until | bigint / timestamptz | 创建账号租约；清理取得新 epoch 后旧创建者不得继续提交 |
| expires_at / created_at / confirmed_at / released_at | timestamptz | reserved 10 分钟期限；终态保留去重元数据 |

1. 占用：按统一锁顺序锁定邀请人、邀请码及 registration；原子增加 use_count、invites_used，插入 reserved。重复请求不再次占用。
2. 账号首次 INSERT 必须带 registration_id、activation_status=pending，并在锁定 registration、检查 lease_epoch 的事务中提交。可共享整体事务时一并确认；否则 adapter 的账号创建事务至少要覆盖这一步关联和 account_created 转移，不能靠事后 hook 补关联。
3. 确认器按 registration_id 幂等补齐 user_id，转 confirmed，并创建绑定该 user/registration 的 auth_challenge 和验证邮件工作。email_verified 只能由受控消费或人工验证写入；只有 confirmed 且验证成功才转 active。锁序为用户→注册记录→challenge；清理、撤销和人工验证同序执行（03）。
4. 释放：reserved 超时先取得锁并使旧 epoch 失效，查询 users.registration_id；存在账号则恢复确认，不退名额；不存在才改 released 并原子退两项计数。account_created 不可仅按超时释放。
5. 未验证账号满 7 天或被邀请人撤销时，在锁内检查仍未 active，撤销会话/令牌并清理账号及个人信息，标 released、仅退一次名额。已激活账号之后注销不退“成功邀请”名额。
6. confirmed 的最小关联记录随账号保留（外键仍有效），released 保留 30 天且清空邮箱等个人字段；释放账号前先解除 user_id 反向外键。过期注册键重放返回失效，不能创建替代账号。并发验证与撤销只有一个终态生效。

V-13 必须验证 adapter 创建事务可以实施上述锁和关联；否则先实现受控注册服务/adapter，禁止发布绕过激活闸门的注册。密码、验证码和验证链接不进入幂等响应缓存或通用任务 payload。

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
| change_log_floor | bigint | default 0，≤ last_change_seq | `conversation_changes` 已清理到的序号，只增不减；游标低于它必须重置（M2a，D-126） |
| metadata_version | bigint | default 1 | 名称、简介、头像、设置、人数、归档等共享资料变化递增，不替代消息 change_seq |
| membership_version | bigint | default 0 | 成员、角色、禁言、归档变更时递增；用于 Agent 来源与权限失效 |
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

**删除 Agent 会话**：事务内先取消其未结束 run、使租约失效、拒绝待审批并取消关联未来任务；把附件标 deleting、message_id 置空但保留 tombstone/message identity，再删除消息/成员/会话。run 的 conversation_id/source_message_id/output_message_id 使用 ON DELETE SET NULL，只保留元数据；run_states、steps.payload、approval args、摘要立即清空，不等待 30 天。对象删除由持久工作完成。其他会话只归档。

**群主一致性**：活动 channel/group 有且只有一个 owner 成员，owner_id 与其 user_id 相同；成员表建部分唯一索引 (conversation_id) WHERE role='owner'，延迟约束触发器在事务提交检查双方一致。转让在同一会话锁内先降旧 owner、再升新 owner、更新 owner_id；不能用两个独立请求。
- 唯一成员且为群主退出：同事务归档，清空成员，owner_id 保留为归档管理者。恢复时若原 owner 已离开，以恢复时 last_seq 新建其 membership；普通归档仍保留原成员及水位。
- 注销时按最早管理员、否则最早成员转让；无人接任则归档，owner_id 置 null，由站点管理员管理。归档 owner_id 为 null 时不要求 owner 成员存在；恢复此类会话必须指定同意接任的活跃成员并创建新的 owner 关系，不能恢复成无主活动群。
- avatar_attachment_id 只允许 ready 且用途匹配的附件；替换、解绑与清理同事务，旧附件进入 deleting。消息附件一旦绑定不能再被当作头像；删除消息采用 ON DELETE SET NULL，但 deleting/tombstone 必须优先于“未绑定仅上传者可读”。

### conversation_changes / user_changes（M2a）
- conversation_changes：PK (conversation_id, change_seq)，message_id（可空）、kind（`message_created` / `message_edited` / `message_recalled` / `message_deleted`）、created_at；不存正文，引用已删实体时保留墓碑 id，不用级联删除该日志项。会话整体删除由 user_changes 通知。
- user_changes：PK (user_id, change_seq)，entity_type、entity_id、operation、created_at；对应 users.user_change_seq 同事务递增。`entity_type` 取 `conversation`（我与某会话的关系的任何变化：加入、移出、重入、角色、禁言、通知、免打扰、置顶、隐藏、已读）、`message_hidden`（我「仅自己删除」的消息）、`me`（我的资料）；`operation` 取 `upsert` / `remove`。通知（M6）以后加新的实体类型。**名称、简介、设置、人数、归档是会话的共享资料，不写进个人日志**：它们推进 `conversations.metadata_version`，靠会话主题上的 `conversation.changed` 和 sync heads 的 `metadataVersion` 传播，避免改一次大频道的名字就写几百行（D-125）。
- 两类日志保留 7 天（worker 每 10 分钟清理）；清理在**同一条语句**里删除过期条目，并把 `conversations.change_log_floor` / `users.change_log_floor` 推进到被删的最大序号（只增不减，取代原来设想的 earliest_available_seq）。`after` 低于下限、高于当前头、缺口超过 1000，或游标无效、过期、绑定的 membership 已不是当前这个，都返回 `resetRequired` 加一致快照（D-126）。成员变动的 membership_id 与固定 through 游标防止退出重入复用旧缓存。协议见 05 第 4.5 节。

### user_conversation_states（M2a，D-082）
- PK (user_id,conversation_id)，membership_id（可空）、state（`active` / `hidden` / `removed`；枚举里还有 `archived`，保留不用：归档是会话的共享资料，由 `conversations.archived_at` 对每个成员派生，不逐人写，D-125）、viewer_version、updated_at。conversation_id 是可保留删除墓碑的标识，不因实体删除级联清除此行（表上没有指向 conversations 的外键）。
- 关系加入/移出/重入、已读、个人通知设置、隐藏消息等改变本人投影时，锁用户及关系行，以本次 users.user_change_seq 分配 viewer_version，并同步更新活动成员的 state_version；退出先写 removed 与新版本再删除成员行。新 membership_id 不复用旧 viewer_version。
- active/hidden 随关系保留；removed 最少保留7天且覆盖全部有效游标期限（清理时一并删除，D-126）。删除墓碑后，旧游标/缓存必须 reset，客户端本地重建代次拒绝先前在途响应。账号注销时清理此表。消息新增不必向每个成员复制个人版本，预览用05的复合版本。

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
| membership_id | uuid | unique, not null | 每次加入新建，退出后旧值永不复用 |
| state_version | bigint | not null | 本人关系/偏好版本，与 user_conversation_states.viewer_version 同事务更新；角色/禁言变化也更新 |
| visible_from_seq | bigint | not null, default 0 | 只能看到 `seq` 大于它的消息（D-035）。加入时取会话当时的 `last_seq`；创建会话时的初始成员为 0 |
| last_read_seq | bigint | default 0 | 加入时取 `visible_from_seq`；只能增大，写法 `GREATEST(旧值, 新值)` |
| notify_level | `notify_level` | not null，由创建事务填写 | all / mentions / none；私信默认 all，群/频道默认 mentions |
| mute_mode / muted_until | text / timestamptz | off / null | off、until、forever；CHECK：until 需有限非空时间，其余必须 null，不存 infinity |
| silenced_until | timestamptz | null | **禁言**截止时间：到期前不能发消息 |
| pinned_at | timestamptz | null | 置顶时间 |
| hidden_at | timestamptz | null | 隐藏私信的时间 |

- 主键 `(conversation_id, user_id)`；另建索引 `(user_id)`，用于查询会话列表。
- 机器人不是任何会话的成员（D-051）。
- 成员退出或被移出时，直接删除这一行；再次加入时按新成员处理。

**加入会话**的事务（频道自己加入、接受群邀请、被拉入都一样）：
1. 检查 `conversation_bans`；
2. 锁定会话后重新检查权限及重复成员，再增加 member_count、membership_version，RETURNING last_seq；重复加入不增加计数、不重置水位；
3. 插入成员行，`visible_from_seq` 和 `last_read_seq` 都取上一步返回的 `last_seq`；
4. 在群组里插入"某某加入了群组"的系统消息。这条消息的 seq 比 `visible_from_seq` 大，所以新成员能看到它；追加同步日志/工作意图，并取消该会话成员旧世代的活动共享 Agent run。

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
| client_id / request_hash | uuid / text | null | 客户端稳定键及规范化初始请求哈希 |
| content_version / stream_revision | bigint | default 1 / 0 | 正文语义版本 / 流式持久快照版本；每个流式快照单调递增 |
| execution_source | text | not null | interactive / offline_replay / agent_effect / scheduled / system，由可信入口设置；仅 interactive 自动推进人的已读 |
| privacy_class / context_epoch | text / uuid | standard / null | 私有 BYOK 输入/输出为 byok_private；普通共享消息为 standard；派生标签见06 |
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
表结构为 `(message_id, user_id)`，两列组成主键。另建索引 `(user_id)`，用于查询"@我的"。**M3 才建这张表**：M2a 的消息 `mentions` 恒为 `[]`，附件也恒为 `[]`（D-128）。

### `message_hidden`
表结构为 `(user_id, message_id, hidden_at)`，前两列组成主键，记录“仅自己删除”。变更同时写 user_changes，以个人序号补发，不用时间戳排序；它是视图偏好，不是撤销原始读权限。

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
| raw_size_bytes / size_bytes / charged_bytes | bigint | 均 ≥ 0 | 原始输入 / 处理后主文件 / 用户计费字节；ready 时 charged_bytes=size_bytes |
| sha256 | text | uploading/processing 时可空，ready 必填 | 处理后主文件哈希 |
| generation / deleted_message_id | bigint / uuid | default 1 / null | 处理 fencing 代次 / 原消息墓碑标识（非活外键） |
| version / privacy_class | bigint / text | 1 / standard | 状态/绑定/变体变化递增；私有 BYOK 附件标签不可被 site 工具绕过 |
| width / height / duration_ms | int | null | |
| metadata_cleared | boolean | null | true=媒体清理已验证；false=视频保留原始字节、只可下载并明确警示；null=普通文件/音频或旧记录未验证，不能声称已清理 |
| storage_key | text | unique，ready 前可空 | 当前 generation 主对象 key，格式 att/{id}/{generation}/original；与原始文件名无关 |
| variants | jsonb | default `{}` | 衍生文件：`{thumb:{key,w,h,mime}, preview:{…}}` |
| thumbhash | text | null | |
| status | text + CHECK | default `uploading` | `uploading` / `processing` / `ready` / `failed` / `deleting`；图片和视频都要经过 media 队列处理 |
| position | smallint | null | 在同一条消息中的排列顺序 |
| created_at / deleted_at | timestamptz | | |

- 索引：(message_id)、(uploader_id,created_at)、(status,created_at)。uploading 阶段的 kind/mime 为未识别占位、字节数为 0；ready 时由约束要求类型、size/hash、活对象全部齐全，不能把未校验对象标 ready。
- **存储空间**：主文件用户预占至少 20 MiB（防止小原图重编码变大），不足额度则拒绝；无声明长度预占消息 100 MiB / 头像 20 MiB。上传预占 reserved，发布 ready 时转为 used；deleting 时只退一次 charged_bytes。所有计数非负，由 reservation 状态转换保证不重复结算；衍生文件只计全站实际容量。

### upload_reservations / attachment_objects（M3）
- upload_reservations：id、attachment_id（唯一）、user_id、idempotency_key、request_hash、reserved_bytes（用户主文件预占）、site_reserved_bytes（输入/输出/衍生文件同时存在的峰值）、status（reserved/uploaded/processing/settled/released）、lease_epoch、expires_at、created_at。默认 15 分钟接收期限，处理租约 2 分钟；完成接收后不因原接收期限误清理正在处理项。站点预占只有转换为可核对的实际对象字节或确认删除后才能释放。
- attachment_objects：id、attachment_id、generation、variant、storage_key（唯一且不可覆盖）、size_bytes、sha256、status（staging/live/deleting/deleted）、accounted、delete_after、deleted_at。accounted 标记该对象是否已计入站点 used，删除确认后只退一次；旧 generation 的已知对象也不能漏算。主文件和每个衍生图都记一行；外部写入完成前已有意图行，崩溃后可 HEAD/重试/删除。
- site_storage：单行 used_bytes、reserved_bytes、budget_bytes、uploads_blocked；所有上传和处理预占必须同时通过用户额度与站点闸门。另检查磁盘实际空间，孤儿对象和备份不能靠逻辑计数忽略。
- 对账校正按墓碑、活对象清单和 reservation 状态比较；异常只修可证明的差额，无法解释的差额告警并停止新上传。

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
  - 列：`id`、`user_id`、`session_id`、`endpoint`（唯一）、`installation_id`、`binding_version`、`p256dh`、`auth`、`user_agent`、`created_at`、`last_success_at`、`failure_count`。
  - `session_id` 是订阅时的登录会话；该会话退出或被注销时，这条订阅一并删除（D-038）。
- **`notifications`**：
  - 列：`id`、`user_id`、`type`、`data`（jsonb）、`read_at`、`version`（默认1，变更递增）、`created_at`。
  - `type` 的取值：`mention` / `reply` / `approval_requested` / `reminder` / `budget_alert` / `report_opened`。
  - data 只存资源 id、类型和必要时间，不保存聊天摘要；读取时重查权限并投影。来源不可见时显示通用不可用提示，不返回旧正文。
  - 索引：`(user_id, created_at desc)`。保留 90 天。

## 7. Agent（M4 / M5）

### `agent_runs`（M4）
| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| user_id | uuid → users | **调用者**：本次运行按此人的权限执行 |
| delegation_id | uuid → execution_delegations | 创建 run 同事务签发；不能从 worker 裸 user_id 恢复权限 |
| trigger | text | `agent_chat` / `mention` / `panel` / `command` / `scheduled` |
| conversation_id | uuid null → conversations | 输出写到哪个会话；会话被删除时置为 null |
| context_conversation_id | uuid null | 面板或命令所绑定的会话 |
| source_message_id / output_message_id | uuid null | 触发运行的消息 / Agent 回复的消息 |
| read_scope | text | `current_conversation` 或 `all_accessible`（见 06） |
| key_source | text | `site`（站点 key）或 `user`（自带 key），决定内容是否对站点管理员可见（D-034） |
| privacy_class / key_revision | text / bigint null | standard 或 byok_private；创建时固定 key_source 和自带 key 修订，删除/替换 key 使旧 run 停止 |
| mode / model | text | `fast` 或 `deep`，以及实际使用的模型名 |
| timezone | text | 本次运行采用的时区 |
| status | `agent_run_status` | `queued` / `running` / `awaiting_approval` / `completed` / `failed` / `cancelled` |
| regenerated_from_run_id | uuid null | 重新生成时，指向被替换的那次运行（D-036） |
| step_count | int | |
| input_tokens / output_tokens / cached_tokens | int | |
| cost_usd | numeric(12,6) | 估算费用 |
| error_code / error_message | text null | 只存脱敏后的信息 |
| heartbeat_at / lease_until | timestamptz null | 每 5 秒续租，默认 30 秒租期 |
| resume_seq / lease_epoch | bigint | 逻辑续跑段号 / 每次领取递增的 fencing token |
| cancel_requested_at | timestamptz null | 持久取消，终态不会因重复取消重新执行 |
| context_epoch / context_manifest | uuid / jsonb | scope/key 世代及来源 id、content_version、privacy_class、membership_id、成员版本；包含传递来源，不存第二份正文 |
| state_version / elapsed_active_ms | bigint | 状态 CAS 版本 / 累计活跃时长，重试/续跑不重置总步数与时长 |
| content_purged_at | timestamptz null | 内容按保留期清除的时间 |
| created_at / started_at / finished_at | timestamptz | |

索引：
- `(user_id, created_at desc)`；
- `(status) WHERE status IN ('queued','running','awaiting_approval')`；
- `(key_source, created_at desc)`：供管理后台查询。

### `agent_run_states`（M4）
- **列**：`run_id`（主键，→ agent_runs）、`state_version`、`resume_seq`、`context_epoch`、`messages`（完整模型消息及工具结果）、`updated_at`。
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
- **列**：`run_id`、`step_index`（稳定的 effect 步号，不随重试或恢复改变）、`tool_name`、`args_hash`、`entity_type`、`entity_id`、`result`（仅 id/结果码，无正文）、`created_at`；主键 `(run_id, step_index)`。
- **用法**：执行有副作用的工具时，domain 在同一个事务里完成操作，并插入这一行。重试时先查这张表：已有记录就直接返回其中的 `result`，不再执行（INV-10，D-037）。

### `agent_approvals`（M5a）
- **列**：`id`、`run_id`、`step_id`、`user_id`（调用者本人审批）、`tool_name`、`args`、`edited_args`、`status`（pending/approved/rejected/expired）、`decided_at`、`expires_at`、`created_at`。expires_at=min(创建后24小时, run委托到期)，卡片显示实际期限；时间歧义确认也使用本审批状态机。
- 另有 `args_hash`、`state_version`、`resume_seq`；唯一 (run_id, step_id)。取消时 pending 转 rejected 并标原因。审批状态和 run/工作意图同事务迁移，参数修改必须通过 schema 和当前权限，提交前检查获批参数哈希。
- **索引**：`(user_id, status)`。过期由独立 Postgres 对账循环处理。

### `agent_run_outputs`（M4）
- 主键 (run_id, resume_seq)，message_id FK（ON DELETE SET NULL）、created_at；同一段输出创建和 run 状态同事务。run.output_message_id 只是当前段指针。恢复不能创建第二条输出；重新生成的新 run 可绑定同一个目标消息，由该消息的当前 runId CAS 保护。

### `agent_memories`（M5b）
- **列**：`id`、`user_id`、`content`（≤ 500 字）、`source`（`user` / `agent`）、`created_by_run_id`（用户在设置里手动添加时为 null）、`privacy_class`、`content_version`、`source_manifest`、`embedding`（vector(N)）、`created_at`、`deleted_at`。继承 byok_private，手动添加默认此类；显式允许站点使用须本人操作并递增版本，既有运行不能悄悄换上下文。
- **向量索引**：在 `embedding` 上建 HNSW 索引，使用 `vector_cosine_ops`，条件为 `deleted_at IS NULL`。

### `message_embeddings`（M5b）
- **列**：`message_id`（主键，引用 messages，级联删除）、`conversation_id`、`seq`、`embedding`（vector(N)）、`content_version`、`model_version`、`dimension`、`created_at`。
  - `conversation_id` 和 `seq` 是冗余存储，用来按成员关系和可见性过滤。
- **索引**：在 `embedding` 上建 HNSW 索引；另建 `(conversation_id, seq)`。
- 向量维度 N 由 M5b 的技术验证决定：Qwen3-Embedding-0.6B 为 1024（也可截成 512），bge-small-zh 为 512。

### `reminders` / `scheduled_messages`（M5a）
- **`reminders`**：列为 `id`、`user_id`、`conversation_id`（相关的会话，可为空）、`text`、`remind_at`、`status`（`scheduled` / `sent` / `cancelled`）、`created_by_run_id`、`created_at`。
  - 提醒到点时，发到用户的"提醒"Agent 会话里（第一次使用时自动创建）。
- **`scheduled_messages`**：列为 `id`、`user_id`、`conversation_id`、`body`、`send_at`、`status`（`scheduled` / `sent` / `cancelled` / `failed`）、`created_by_run_id`、`sent_message_id`、`created_at`。
- **到点执行**：由对账任务把即将到点的项放入队列（D-044），不依赖长时间挂在 Valkey 里的延迟任务。
- **发送前再检查一次权限**：持有业务锁复核当前成员/激活/禁言/归档，与写消息和改 sent 同事务。取消使用同一锁；提醒增加 failed 状态及两类任务的 finished_at/content_purged_at。已取消任务绝不再次排入可执行态。
- 两表另有 delegation_id、scheduled_timezone、scheduled_local_time、scheduled_offset_minutes；保存确定的UTC时刻及创建时的当地时间解释，改用户时区不改旧任务。逾期24小时或委托失效则 failed（仅元数据错误码），不补发；成功发送不推进用户已读。
- 两表均有version，创建为1，每次状态/展示字段变化同事务递增；列表/取消响应按version合并，不让旧scheduled覆盖终态。

### `ai_usage_daily`（M4）
- **列**：`user_id`、`day`（date，按 `APP_TIMEZONE` 计算）、`key_source`、`input_tokens`、`output_tokens`、`cached_tokens`、`cost_usd`、`run_count`；主键为 `(user_id, day, key_source)`。
- **全站月度费用**：从调用结算台账派生，可缓存展示，但准入只读锁内的 budget_accounts。不得用一分钟统计缓存决定是否发起收费调用。

### `budget_accounts` / `ai_call_attempts`（M4）
- budget_accounts：scope（user_day/site_month）、owner_key、period_start、limit_units、reserved_units、settled_units；联合主键。token 整数、费用以整数微美元计，避免浮点。站点 key 调用锁定两级账户并原子检查 settled+reserved+本次预占 ≤ limit。
- ai_call_attempts：id、run_id、step_index、attempt_no、key_source、provider_request_id、status（reserved/started/settled/unknown/released）、day、month、price_version、reserved_tokens/cost、actual_tokens/cost、started_at、settled_at；唯一 (run_id,step_index,attempt_no)。
- reserve、标 started、usage 条件结算均为持久事务；unknown 仍占用上限，不按超时自动退款。日/月归属在 reserve 时冻结；reserved 未 started 可以超时释放。自带 key 只记 usage，不占站点预算。

### `user_ai_keys`（M5a）
- **列**：`user_id`（主键，→ users，级联删除）、`provider`（目前只有 `deepseek`）、`key_ciphertext`（bytea）、`key_nonce`（bytea）、`key_version`（smallint，加密密钥版本）、`revision`（bigint，替换key递增）、`key_last4`、`status`（`active` / `invalid`）、`last_verified_at`、`created_at`、`updated_at`。
- 用 AES-256-GCM 加密，密钥来自 `AI_KEY_ENCRYPTION_KEY`。明文只在 worker 发起模型请求时解密，不返回给任何人，也不写日志（SEC-26）。

### `agent_conversation_state`（M5b）
- **列**：`conversation_id`（主键，→ conversations，级联删除）、`context_epoch`、`key_source`、`privacy_class`、`source_manifest`（来源 id/版本/隐私标签）、`summary`、`summarized_through_seq`、`expires_at`、`updated_at`。
- 长对话的滚动摘要。它不随会话数据下发给客户端。来源撤回/编辑、授权或 scope 变化即失效并清空，不得只移除工具却继续注入旧摘要；最长 30 天，不因读取而续期。

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
| INV-11 | 注销账号时：<br>① `users` 行被匿名化（名字改为"已注销用户"，邮箱改为占位值，用户名改为 `deleted_` 加随机串，旧用户名保留 30 天），并置上 `deleted_at`；<br>② sessions、accounts、passkeys、记忆、自带 key、推送订阅、通知全部删除，未使用的邀请码撤销；<br>③ Agent 会话及其运行内容删除；未结束 run/待审批/未来提醒和定时消息同事务取消并清空其内容；<br>④ 退出所有频道和群组：自己是群主的，按"最早的管理员，否则最早的成员"转让，没有其他成员就归档；<br>⑤ 私信保留，但对方不能再给他发消息；<br>⑥ 发过的消息和附件保留，发送者显示为"已注销用户" |
| INV-12 | 普通消息事件不含正文；HTTP 对消息、引用、预览、附件逐项投影。Agent 增量每批重新验证当前 session、membership、可见性和运行来源版本，不接受加入后一秒仍盲播的例外（D-057、D-060） |
| INV-13 | 被封禁的用户不能以任何方式重新加入该会话，直到解除封禁 |
| INV-14 | 邀请计数不超限：`use_count ≤ max_uses`；非管理员的 `invites_used ≤ invite_quota`；并发注册也成立 |
| INV-15 | 站点管理员只能查看 `key_source = 'site'` 的运行内容；超过保留期的内容被清空 |
| INV-16 | 每项可靠后台工作均有同事务 work_items 意图；运输层任务丢失不能丢失业务意图 |
| INV-17 | synced 只由完整消费的日志推进；过滤空页也有 scannedThrough，不由最大观察消息版本替代 |
| INV-18 | 账号 active 必须同时具备 confirmed 注册及 email_verified，受审计的 bootstrap/CLI 例外除外 |
| INV-19 | 旧 lease_epoch、已取消 run、过期审批不能提交输出或效果；每个续跑段最多一条输出 |
| INV-20 | 每个调用 attempt 最多结算一次；站点准入在用户日额度与站点月预算的原子预占之后 |
| INV-21 | 用户 used+reserved 不超额度；S3 写入均有对象账本，旧 generation 不能发布已删除附件 |
| INV-22 | 向量/摘要使用的内容版本与当前有效来源匹配，失配不得检索或进入上下文 |
| INV-23 | 活动群/频道恰有一个 owner，owner_id 与 owner 成员一致；归档空会话按本节例外处理 |
| INV-24 | 验证/重置凭证只消费一次且绑定原 user、registration、用途和授权/恢复世代；旧邮箱链接不能激活后来注册的账号 |
| INV-25 | 后台写操作有有效委托及当前业务权限；安全撤销先提交则旧委托无后续效果，普通退出不误取消长期任务 |
| INV-26 | 私有 byok_private 来源及派生内容不进入 site 自动上下文；只有本人明确重输或发布的内容按06的例外处理 |
| INV-27 | 实体版本随覆盖字段同事务变化，迟到响应和旧 membership 不能倒退状态或复活移除关系；实体版本不推进 synced |
| INV-28 | 非 interactive 发送不推进人的 last_read_seq；所有执行来源由服务端确定 |
| INV-29 | 生产确认成功的删除先有异地持久意图；旧备份对账至独立最新可信删除水位前不得开放 |
| INV-30 | mute=until 才有有限时间；调度保存 UTC/时区/offset，时区修改不重排已授权任务 |

## 9. 迁移与种子数据

- **迁移文件**：用 `drizzle-kit generate` 生成 SQL 迁移并提交到仓库。已经应用过的迁移**永远不改**，只做前向迁移。
- **执行方式**：生产镜像里用 `bun src/cli.ts migrate`（使用 drizzle-orm 自带的 migrator，不依赖 drizzle-kit），以拥有者账号运行。
- **CI 必做**：
  1. 在全新的空数据库上执行全部迁移；
  2. 从上一发布版的带数据夹具升级，运行 `drizzle-kit check`；
  3. 新版及上一版应用都在升级库上做读写冒烟；迁移采用 expand/contract，破坏性收缩至少跨一个兼容发布窗口；
  4. 运行测试。

  这是为了杜绝旧项目那种"迁移链断裂"的问题。
- **生产环境**：先备份，再迁移。迁移后的库必须同时兼容新旧两版代码，以便回滚。
- **生产必需初始化**：`bun run db:bootstrap` 幂等创建不能登录的机器人（无 credential/session）、系统保留名与默认设置，不创建演示用户；应用启动校验它已执行。CLI 管理员也经应用 domain 和审计，不调用原生 admin HTTP 后门。
- **种子数据**（仅开发环境）：`bun run db:seed` 先调用 bootstrap，再幂等创建：
  - 3 个演示用户，密码取自 `SEED_DEMO_PASSWORD`；
  - 2 个频道、1 个群组、1 个私信，以及几十条演示消息。
- **正式管理员**：用 `bun run admin:create` 创建。密码由用户在自己的终端里输入，不经过聊天。

## 10. 数据保留与副本清单（D-063）

| 数据 | 在线读取和清理规则 | 最长保留/失败处理 |
|---|---|---|
| 撤回/删除消息正文、提及、向量 | 同事务清空；保留无正文墓碑及初始请求哈希 | 请求成功即生效 |
| 附件主文件、衍生图、staging | 同事务禁止读取并写删除工作，物理删除后才释放站点实际字节 | 目标 1 小时，最长 24 小时；超时告警且持续重试，备份删除屏障也计入期限 |
| run_states、steps.payload、审批 args/edited_args | 以 run.created_at 起算，30 天清空，等待审批不能延期；来源失效后不得用于续跑 | 删除所属 Agent 会话/注销时立即清空；一般消息撤回后的历史运行副本仍按原期限保留 |
| agent_effects.result | 只保留实体 id、参数哈希、结果码，不保存正文；详情实时授权读取 | 最小去重账本随 run 元数据保留，清理不得使旧效果重做 |
| 滚动摘要、来源 manifest | 删除来源、编辑来源、范围变化立即失效；清理 summary | 最长 30 天；不因刷新摘要延长已删除来源副本寿命 |
| 记忆 | 用户显式保存，非普通运行临时副本；删除/注销清空正文与向量 | 活跃记忆保留至用户删除；已进入 run 的副本按 run 期限 |
| 提醒/定时消息正文 | scheduled 状态保留到执行；取消时清空，终态只留 id/状态/计费元数据 | sent/failed 后 30 天清空；注销立即取消清空；最长预约 365 天 |
| 通知、push 工作、同步日志 | 通知和工作仅存 id，不保存消息摘要；读取/发送时投影 | 通知 90 天；同步日志 7 天；终态工作 7 天 |
| 未验证账号与注册占用 | 按注册状态机处理，不按无关联的 pending 时间直接退款 | 未验证账号 7 天；reserved 10 分钟后先对账 |
| 认证凭证/投递密文 | 同用途重发撤旧，消费/到期/撤销后清密文；密码及token不进通用工作表 | 凭证1小时；无密文终态元数据7天 |
| 委托与来源设备 | 未完成任务保留可撤销来源；终态委托保留id/哈希不留正文 | 终态30天后可清；未被引用的origin再清，效果去重账本仍独立保留 |
| 异地删除 journal | 加密的id/动作/规则版本及截止时间，无正文/邮箱/密钥 | 至少35天且覆盖全部允许恢复的备份；备份先过期才可截断所需历史 |
| 未绑定附件 | 当前有效头像不属于孤儿，message/头像都按有效绑定判断 | 24 小时；失败预占按租约释放 |
| 幂等响应 | 只留资源 id/指纹，不缓存敏感 DTO、密码、令牌 | 一般创建键 24 小时；消息键随消息墓碑保留 |
| 审计、run/调用用量元数据 | id、状态、数量、脱敏错误，无正文/工具参数 | 长期保留；注销后关联匿名用户 |
| 浏览器缓存与外部副本 | no-store；应用管理的离线数据按账号世代隔离，联网撤权后清理 | 消息/草稿最多 7 天、待发 24 小时；失联设备、用户下载和外部已送达通知不能远程收回 |
| 备份 | 7 份日备份 + 4 份周备份，所有位置按时间上限清理 | 最大 28 天；清理失败告警并记录未满足物理清除时限 |

运行内容保留期缩短时立即安排到期清理，延长不恢复已删除内容。物理删除时限从首次 deleted_at 起算，重试、备份、换 generation 不能重置截止时间。privacy/cleanup 验收同时扫描所有上表副本，不只清 run_states。服务器日志、Sentry、队列和审计从一开始禁止写正文；旧备份不在线提供给管理员浏览。外部 AI 服务商的数据处置按其实际条款，不声称本站删除能替代供应商删除。

## 11. 可靠工作与幂等表（M1a 起）

- work_items：id、kind、dedupe_key（unique）、entity_id、entity_version、status（pending/leased/running/retry/done/dead/uncertain）、delivery_seq、attempts、available_at、lease_epoch、lease_until、last_error_code、created_at、finished_at。payload 仅存标识。索引 (status,available_at)，消费者只以当前 epoch 条件提交。
- idempotency_records：actor_key、operation、target_key、key（联合唯一）、request_hash、resource_type、resource_id、state、created_at、expires_at。普通操作的占位、业务写入和结果 id 同事务，未提交占位随回滚消失；长上传/注册用对应 durable 状态机。
- 回复重放重新授权并加载当前资源；相同键不同参数 409，原资源删除返回墓碑/410，不能创建替代资源。重新授权包括历史水位（INV-09）：发送者退出或被移出后重新加入，水位前移，原消息已在新水位之下的重放按「消息不存在」404，不返回原 DTO，也不用同一个 clientId 再写一条（D-138）；消息的投影对传入的行本身也按水位过滤，不论这一行是怎么找到的。已提交的唯一键冲突由读取已有行处理，不捕获错误后继续使用已失败的事务。
- backup_runs（M7）：id、epoch、status、snapshot_at、lease_until、manifest_key/hash、object_count、deletion_journal_applied_seq/hash、offsite_verified_at、last_error。已应用水位只推进到连续无缺口的applied序号，不能取最大完成项；与DB快照同读。全局删除屏障与删除器串行协调，等待在途删除完成；台账不代替加密备份。
- deletion_operations（M7）：id、actor_id、action、target_manifest（仅id/版本/截止时间）、request_hash、version、status（prepared/journaled/applied/failed）、journal_epoch/seq/hash、created_at、applied_at。准备时授权并冻结目标，相关实体记录delete_operation_id/待删除状态以拒绝并发编辑/绑定和目标扩展；journaled按不可撤回意图执行，不依赖原session。稳定operation id承接幂等键；清空数据、applied及version更新同事务。failed仅限确定未被异地接受的永久失败，网络未知保持pending对账，不能误解冻。
- 删除 journal 是独立异地对象链，顺序/完整性/保留/恢复规则以10第7节为准；本地 deletion_operations 或普通备份都不能冒充这个独立来源。无权查询 operation 返回404，status 响应不含待删内容。
- 两级预算、site_storage、work_items 的状态/计数均有非负 CHECK 和唯一键；租约和 CAS 失败不能仅记录日志后继续提交。

M3 的 `0006_m3_metadata_status` 增加可空的元数据清理结果，不把已有文件猜测成已清理。`0004_m3_attachments` 建表和延迟 ready 约束；`0005_m3_object_ledger_guards` 从对象侧复核 ready 账本，禁止更换对象身份或复活删除墓碑。ready / 对象 live 的提交不能分离；绑定只允许 ready 的 message 用途，重复绑定由事务锁和数据库约束共同拒绝。
