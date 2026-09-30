# 11 路线图与里程碑

> 当前进度以 [PROGRESS.md](PROGRESS.md) 为准。本文件列出每个里程碑的任务和验收标准。
> 建议**一个会话做一个里程碑**。M1、M2、M5 工作量较大，已经各拆成 a、b 两个会话。

## 0. 总体顺序

```
M0 规格 ─▶ 规划审查修订 ─┬─▶ D 设计原型 ───────┐
                         └─▶ M1a 后端骨架 ─────┴─▶ M1b 前端骨架 ─▶ M2a ─▶ M2b ─▶ M3 富消息 ─▶ M4 Agent 基础
                                                                                                    │
            M8 上线 ◀─ M7 加固与彩排 ◀─ M6 通知与 PWA ◀─ M5b 记忆与语义搜索 ◀─ M5a 审批、操作与自带 key ◀─┘
```

- D 和 M1a 可以同时进行（D-053）；M1b 必须等 D 定稿。
- 上线（M8）放在最后。在此之前，所有开发和验收都在本地完成。

## 1. 会话工作流程

### 开工
1. 读仓库根目录的 `CLAUDE.md`，再读 `docs/PROGRESS.md`，确认当前里程碑和下一步要做什么。
2. 读本文件中当前里程碑的那一节，以及它引用到的规格文档。**不要一次读完全部文档。**
3. 检查环境：
   - Docker Desktop 是否在运行；
   - Bun 是否已安装（安装需要先征得用户同意）；
   - `bun run check` 当前是否通过。
4. 如果发现规格有冲突或缺漏，先跟用户确认，改好文档，再开始写代码。

### 收尾
1. 运行这个里程碑相关的全部检查，如实记录命令和结果。
2. 更新 `docs/PROGRESS.md`：完成了什么、证据、遗留问题、下一步。
3. 如果有决策变动，写进 `docs/12-decisions.md`。
4. 提议提交（提交和推送前征得用户同意），并告诉用户下一个会话从哪里开始。

## M0 规格定稿 ✅ 完成（2026-09-30）

- [x] 分析旧版，写成 13-legacy-analysis。
- [x] 写 00 到 13 号文档，以及 PROGRESS 和 CLAUDE.md。
- [x] 用户审阅通过，并要求开始开发准备。
- [x] 文档已在 `v2` 分支提交（`35f3547`）。
- [x] 给旧代码打上 `v1-legacy` 标签，并已推送到 GitHub（2026-09-30）。历史清理后，它指向 `9841352`。
- [x] 用户已删除 Docker Hub 上的公开镜像，并更换了 DeepSeek key。

## 开发准备 ✅ 完成（2026-09-30）

原 M1 的前三步提前做完了，都在 `v2` 分支上：
- [x] **仓库整理**（`8b74b5c`）：
  - 移除旧代码；LICENSE 保留上游版权；重写 README；
  - 新增 `.gitignore`、`.gitattributes`（LF）、`.editorconfig`。
- [x] **工具链**（`b28dbbe`）：
  - Bun 1.4.2 workspace；TS 7 严格模式；Biome 2.5；lefthook pre-commit；Renovate 配置；CI `check` 工作流；
  - `guard` 脚本：禁止 raw HTML 写法，禁止跟踪 env 文件。
- [x] **本地基础设施**（`a8f1456`）：
  - `infra/compose.dev.yml`：Postgres 18 + pgvector、Valkey 9.1、Garage 2.4、Mailpit；
  - 脚本：`setup`、`infra:*`、`infra:bootstrap`、`doctor`、`infra:reset`；
  - `.env.example`。
- [x] **环境**：已安装 Bun，基础设施已启动并初始化，`bun run doctor` 全部通过（证据见 PROGRESS）。
- [x] **模型**：指定为 V4.1-Flash（D-031，`d723d7b`）；DeepSeek key 验证可用。
- [x] **清理与推送**：清理 git 历史中用户上传的文件（D-032），并推送 `main`、`v2` 和 `v1-legacy` 到 GitHub；CI `check` 首次运行通过。

## 规划审查修订 ✅ 完成（2026-09-30）

- [x] 全面审查 00–13，用户拍板四项（D-033 到 D-036），其余由 Claude 决定（D-037 到 D-055）。
- [x] 新增待验证项 V-08 到 V-17；各规格文档同步修订；M1 拆成 M1a 和 M1b。

## D 设计原型

按 [02 第 9 节](02-design-system.md) 的 D1 到 D4 进行：
- **做法**：用 Artifact 工具的 `quickstart`（intent 选 `design`）创建可点击原型，覆盖 02 第 9 节列出的全部界面。
- **范围**：桌面端，浅色和深色两套；同时测试 4 档透明度和 8 个强调色。
- **评审平台**：Windows 的 Chrome、Edge，以及 macOS 的 Safari 都要看。Windows 上没有 SF 字体，在那里比较系统字体和自托管 Inter（OFL 协议）的效果，结论写回 02 第 4.3 节。
- **应用图标**：给出草案，M6 的 PWA 要用。
- **收尾**：根据用户的反馈迭代，定稿后把设计令牌写回 02 第 4 节，原型链接记到 PROGRESS。

**验收**：用户确认视觉效果和交互。

## M1a 后端骨架（可以和 D 同时进行）

1. **工具链**：
   - 从 npm 等源重新核对应用依赖的版本（03 第 2 节），如果 Drizzle 1.0 已正式发布就用 1.0（V-07）；
   - 把 `typecheck` 和 `check` 扩展到所有工作区包，并在 `check` 中加入测试。
2. **配置**：
   - 在 `apps/server/src/config/` 中用 zod 校验环境变量，包括新增的 `APP_TIMEZONE`、`TRUSTED_PROXIES`；
   - 生产环境拒绝弱密钥；
   - 测试专用接口只在 `APP_ENV=test` 时注册，生产环境启动时自检（SEC-29）。
3. **数据层**（`packages/db`）：
   - Drizzle 配置；数据库账号分为拥有者和应用两种；
   - Better Auth 的表，加上扩展字段：`invites_used`、`timezone`、`last_seen_at`、`storage_quota_bytes`、`ai_daily_tokens`；
   - 新表：`username_reservations`、`registration_invites`、`registration_invite_uses`（pending / confirmed）、`app_settings`、`audit_logs`；
   - 第一批迁移（含 `vector` 和 `pg_trgm` 扩展）；种子数据；
   - 验证 Better Auth 能否使用 uuid 主键（V-04）。
4. **contracts**：错误码（含新增的几个）、各项上限常量、保留名单、基础数据结构、WebSocket 消息外层结构。
5. **server**：
   - Hono、OpenAPI 和 Scalar 文档页；`/api/healthz` 与 `/api/readyz`；
   - Origin 校验中间件、API 的安全响应头、请求 id、pino 日志、统一错误处理、真实客户端 IP（SEC-28）；
   - **Better Auth**：
     - 邮箱密码（强制验证邮箱，可以重发）、username、passkey、admin 插件；
     - 会话以 Postgres 为准，限流计数存 Valkey（ioredis）；
     - 原生接口收口（D-039），`__Host-` Cookie（V-05），并完成 V-13 的验证；
   - **邀请**：
     - 注册时原子占用和确认名额（D-040）；
     - `POST /api/invites/check`；
     - 我的邀请码（列表、创建、撤销），以及撤销未验证的注册；
     - 未验证账号的清理任务；
     - 保留名检查（用户名和显示名）；
   - **邮件**：`email` 队列，本地发往 Mailpit；
   - **WebSocket 网关骨架**：
     - 认证、来源校验；
     - 连接与登录会话绑定：会话失效时以 4401 断开，每 5 分钟复核（D-038）；
     - `hello`（带 `serverTime`）、ping/pong、关闭码；
   - **事件总线骨架**：频道名带环境（`events:{APP_ENV}`）；
   - **worker 骨架**：BullMQ 任务保留的默认值；`cleanup` 和 `reconcile` 的骨架；
   - **命令行**：`admin:create`、`admin:verify-email`、`migrate`。
6. **测试和 CI**：
   - 认证与邀请的集成测试，重点覆盖：
     - 同一个单次邀请码被两人并发使用时，只有一人成功；
     - 名额计数准确，未验证账号的清理会释放名额；
     - 不带邀请码直接调用 `/api/auth/sign-up/email` 会失败；
     - 通过 `update-user` 改用户名会失败；
     - 修改密码后，其他会话的 HTTP 请求和 WebSocket 都失效；
   - WebSocket：L-13、L-14 的 WebSocket 部分；来源不对时以 4403 关闭；注销会话后，连接在几秒内被关闭；
   - L-24（用户名部分）；
   - 建立 `integration` 和 `security` 两个 CI 工作流，包含"在空库上执行迁移"这一步。

**验收**：
- 按 09 的首次搭建步骤，从全新克隆开始就能跑起来（后端部分）。
- 在接口层完整走通一遍：
  1. 用命令行创建管理员；
  2. 生成邀请码；
  3. 新用户带邀请码注册（不带邀请码会失败）；
  4. 在 Mailpit 中验证邮箱；
  5. 登录并建立 WebSocket 连接；
  6. 注销这个会话，连接被关闭。
- `bun run check` 和 CI 全部通过；V-04、V-05、V-07、V-13 的结论已写入 12。

## M1b 前端骨架（D 定稿之后）

1. **新技术栈冒烟**：Vite 8、React 19.3 与 React Compiler、TanStack Router 和 Query、Tailwind 4、Base UI、Motion、Paraglide、Storybook 10、Vitest 5 能一起正常工作。兼容性结论写入 12。
2. **web**：
   - 按 D 的定稿实现 Tailwind 4 设计令牌；主题（浅色、深色、跟随系统）、强调色、透明度四档；
   - 应用外壳：侧边栏、工具栏、Inspector 的占位；
   - 页面：
     - 登录；
     - 注册：邀请码从 `#invite=` 读取；
     - 验证邮箱：可以重发；
     - 找回密码；
     - 设置：外观、账号、登录设备、Passkey、时区、我的邀请码（包括还没验证的注册）；
   - WebSocket 客户端：单例、断线重连、用 `serverTime` 校正时钟、上报 `focus` 的骨架；
   - 退出登录或收到 4401 时，清空本地缓存。
3. **快捷键**：在 Chrome、Edge、Safari、Firefox 的标签页里实测（V-16）。
4. **Storybook**：只做 M1b 页面用到的组件，其余组件在用到它们的里程碑再做。
5. **测试**：
   - E2E 场景 1（Chromium 和 WebKit，外加 Firefox 冒烟）和场景 11；
   - 在 Playwright 的 Linux 镜像里生成第一批截图基线（L-08）；
   - 建立 `e2e` CI 工作流。

**验收**：
- 在浏览器里完整走通一遍：
  1. 管理员用命令行创建；
  2. 生成邀请码；
  3. 新用户通过注册链接注册；
  4. 在 Mailpit 验证邮箱；
  5. 登录，看到应用外壳。
- 在 localhost 上，注册和登录 Passkey 都可用。
- 未登录的 WebSocket 连接以 4401 关闭，来源不对的以 4403 关闭；注销设备后，另一端被踢回登录页。
- `bun run check` 和 CI 全部通过。
- 用户看过应用外壳，确认与原型一致。

## M2 核心聊天（M2a 数据与接口、M2b 界面）

**M2a 数据与接口**
- **建表**：
  - `conversations`（含 `last_join_seq`，以及为 M4 预留的 `panel_for_conversation_id`）；
  - `dm_pairs`；
  - `conversation_members`（含 `visible_from_seq`）；
  - `conversation_bans`、`conversation_invites`、`messages`、`message_hidden`。
- **domain 层**：
  - 会话：创建、加入、退出、转让、归档、恢复（名称被占用时要求改名）、修改设置；
  - 成员：拉人、移出、封禁与解封、任免、禁言；私信：获取或创建；
  - 群邀请链接：创建者失去权限时自动作废；
  - 消息：发送、列表、补发（含隐藏的消息和 `resetRequired`）、编辑、撤回（5 秒宽限）、仅自己删除、管理员删除；已读位置（从加入时开始）；系统消息；
  - `authorize()`、统一的可见性判断、各项策略；审计日志。
- **HTTP**：05 第 3.2 到 3.4 节中 M2 的全部接口，以及按人计算的限流。
- **实时**：
  - 连接时订阅会话频道，成员关系变化时动态订阅或退订；
  - 事件通过 Valkey 转发；
  - 广播规则：更新的消息 `seq ≤ last_join_seq` 时，只发 `message.changed`；
  - 正在输入；`focus` 上报；已读位置同步；
  - 在线状态：按连接记录并汇总、定时清理过期连接、`presence.snapshot`、`last_seen_at`。
- **测试**：
  - 集成测试、实时测试；
  - 不变量：INV-01 至 04、07、08、09、12、13；
  - 安全回归：L-01 至 L-04、L-07（服务端）、L-09、L-10、L-16 至 L-18、L-19（改名部分）、L-20、L-21、L-23、L-24（显示名部分）；
  - V-14：确定模拟断线的方式。

**M2b 界面**
- **先做两个技术验证**：
  - V-09：虚拟列表的聊天场景小实验；
  - V-08：在 Nginx 容器（`bun run edge:up`，用生产站点配置）上，用最终的 CSP 验证 Markdown 渲染，并决定是否开启 Trusted Types。
- **侧边栏**：分组、未读数、置顶；新建频道、群组、私信的对话框；频道发现页；"已归档"列表。
- **工具栏与时间线**：
  - 虚拟列表、消息分组、时间分隔、未读分隔；
  - 加入前历史的边界提示；
  - 回到最新、向上加载更多、定位到某条消息。
- **输入栏**：
  - Enter 发送，Shift+Enter 换行；输入法组字期间回车不发送（D-050）；
  - 按 ↑ 编辑上一条；回复引用；
  - 发送时先显示，失败可以重试。
- **右键菜单**：回复、复制、编辑、撤回、仅自己删除、管理员删除。
- **状态显示**：正在输入、在线状态、已读位置推进。
- **Inspector**：成员列表、会话设置、群邀请链接、封禁名单。
- **设置**：资料（显示名、简介、用户名修改规则、时区）。
- **消息正文**：用 Markdown 渲染（和 Agent 输出用同一个安全渲染器，D-047），自动识别链接时遇到中日韩文字就截断。
- **客户端一致性**：
  - 按会话检测跳号；
  - 连带更新引用摘要和会话预览；
  - 同步隐藏的消息；
  - 离开会话时清缓存。
- **测试**：
  - E2E 场景 2 到 5、10、12；
  - L-05（私信页）、L-07（界面）、L-11。

**验收**：
- E2E 场景 2 到 5、10、12 在 Chromium 和 WebKit 上都通过，Firefox 冒烟通过；E2E 期间没有 CSP 违规。
- 本地收发延迟 p95 < 200 ms（用测试脚本测量）。
- 在 1 万条种子消息的会话里滚动流畅。
- 适用的安全回归测试全部通过。
- 用户亲自试用。

## M3 富消息

- **存储**：建 `attachments` 表；存储层实现 `BlobStore` 接口，底层是 Bun 的 S3 客户端连接 Garage。
- **上传接口** `/api/uploads`：边收边检查大小、判断真实类型、计算 sha256、原子地占用存储配额、限流。
- **`media` 队列**：
  - 图片：先按方向旋转，再用 sharp 重新编码以去除 EXIF；生成缩略图、预览图和 thumbhash；GIF 保留动画；
  - 视频：用 ffmpeg 重新封装，去除元数据；失败时改为只能下载；
  - 头像裁剪。
- **下载接口**：按 `purpose` 鉴权、支持 Range、安全响应头（SEC-08）、缓存头；另有 `cleanup` 定时任务。
- **头像**：用户头像和会话头像。
- **界面**：
  - 上传：附件按钮、拖拽、粘贴、进度条；
  - 展示：图片网格、大图预览、视频和音频播放器、文件卡片。
- **@提及**：自动补全弹窗、`<@user:id>` 格式、`message_mentions` 表、高亮"@我"；编辑时新增的提及不产生通知。
- **其他**：emoji 选择器；代码块高亮（Shiki，CSS 变量主题）。
- **测试**：
  - L-12；SEC-07、SEC-08；
  - EXIF 确实被去除，且图片方向正确；视频里的位置元数据确实被去除；
  - 存储配额在并发上传时不超用；清理任务；Range 请求；
  - 按用途的读权限：头像所有成员可见；消息附件跟随消息可见性，新成员拿不到加入前的附件；
  - E2E 场景 6；
  - 恶意文件样例：伪装成图片的 html、svg、超大文件。

**验收**：以上测试全部通过，用户试用确认。

## M4 Agent 基础

1. **先做技术验证**：
   - V-01：06 第 6 节列出的 5 项 DeepSeek 实测；
   - V-15：pg_trgm 对 2 个字中文查询的 EXPLAIN。
   - 结论写进 12-decisions。
2. **机器人与会话**：
   - Agent 机器人用户（不是任何会话的成员）；
   - Agent 会话的创建、列表、改名、删除；标题自动生成。
3. **运行记录**：
   - 建 `agent_runs`（含 `key_source`，目前固定为 `site`；`regenerated_from_run_id`、`timezone`、`heartbeat_at`）、`agent_run_states`、`agent_steps`、`ai_usage_daily`（含 `key_source`，按 `APP_TIMEZONE` 计日）；
   - 三层预算检查；`agent` 队列；对账任务处理卡住的 run；运行内容 30 天清理。
4. **执行**：
   - 用 `ToolLoopAgent` 加 4.1 节的只读工具；
   - 按读取范围过滤工具；面板和 ⌘K 默认只读当前会话，并提供切换开关（D-051）；
   - 所有工具遵守可见性；
   - 用"不可信"标记包裹聊天记录；对图片使用多模态输入。
5. **流式输出**：
   - 消息的 `streaming` 状态；
   - 增量每 50–100 毫秒合并一次，写库时记 `streamIndex`；
   - `agent.delta`、`message.updated`，以及新成员加入后改发 `message.changed`；
   - 停止；
   - 重新生成：替换原回复，遵守 D-036 的各项限制。
6. **群里 @Agent**：
   - 读取范围限定为 `current_conversation`；遵守 `agentEnabled` 开关；频率限制；
   - 编辑不触发；Agent 消息中的 @提及不产生通知。
7. **搜索**：
   - 给 `messages.body` 建 pg_trgm 索引；
   - `search_messages` domain 函数，供 ⌘K 的普通搜索和 Agent 共用。
8. **界面**：
   - 侧边助手面板（面板对话、快捷操作、读取范围开关）；
   - ⌘K 命令面板（含消息搜索）和斜杠命令；
   - Agent 消息和工具调用卡片（02 第 6 节）；
   - 用量显示；
   - 开启了助手的会话里，显示把消息发给 AI 服务的提示。
9. **测试**：
   - 用模拟的模型提供方跑集成测试和 E2E（`AI_PROVIDER=mock`，保证结果确定）；
   - 读取范围和可见性相关的安全测试；
   - L-05（Agent 页）、L-06、L-14（接口部分）、L-15、L-19（Agent 会话部分）、L-22；
   - 重新生成的各项限制。
10. **评测第一版**：
    - 覆盖读取范围、注入、面板注入外泄、格式、工具选择、总结质量；
    - 结果断言和行为断言分开统计，用真实的 DeepSeek 运行；
    - 建立每周定时运行的 `eval` 工作流。

**验收**：
- 评测达到 06 第 12 节的通过线。
- E2E 场景 7 通过。
- 当日额度用完后能正确拦截，并给出提示。
- 用户亲自试用。

## M5 Agent 进阶（M5a 审批、操作与自带 key，M5b 记忆与语义搜索）

**M5a 审批、操作与自带 key**
- **技术验证**：
  - V-02：`toolApproval` 流程，以及"修改后批准"的实现方式；
  - V-17：自带 key 出错时接口的返回。
- **审批**：
  - 建 `agent_approvals` 表；审批接口、审批卡片；
  - 24 小时过期，由对账任务处理；
  - 暂停时当前消息收尾，续跑时新建消息（D-051）。
- **副作用**：建 `agent_effects` 表；所有副作用工具走"恰好一次"的流程（D-037）。
- **工具**：
  - `send_message`（`clientId` 确定性生成）、`schedule_message`、`create_group`、`invite_members`；
  - `create_reminder`、`cancel_*`；
  - 建 `reminders` 和 `scheduled_messages` 两张表，由对账任务按时入队；提醒发到"提醒"会话。
- **自带 key**：
  - 建 `user_ai_keys` 表；在 `setup` 中生成 `AI_KEY_ENCRYPTION_KEY`；
  - `PUT/DELETE /api/me/ai-key` 与验证；
  - 设置界面，鼓励文案只讲好处；
  - 按 key 选择 provider；出错时提供"改用站点额度重试"；
  - 用量按 key 来源分开统计。
- **评测第二版**：审批门槛类用例的结果断言必须 100% 通过，并扩充注入类用例。
- **测试**：
  - 在崩溃注入下，副作用恰好执行一次；
  - 自带 key 不出现在日志和任何响应里；
  - 管理员接口拿不到自带 key 运行的内容；
  - E2E 场景 8、13。

**M5b 记忆与语义搜索**
- **技术验证**：V-03、V-12，在 Debian 镜像中按 06 第 10 节的标准评估本地向量模型。
- **记忆**：
  - 建 `agent_memories` 表（含 `created_by_run_id`）；
  - 实现 `remember`（按本轮意图决定是否提供，D-051）、`forget`、`recall_memories`；
  - 设置里的记忆管理界面。
- **向量**：
  - `embeddings` 队列、历史消息补算、`message_embeddings` 表（含 `seq`）；
  - 混合检索工具 `semantic_search_messages`，遵守可见性。
- **滚动摘要**：长对话的滚动摘要，存进 `agent_conversation_state`。
- **评测**：补充"记忆投毒"类用例。

**验收**：
- 所有影响他人的操作都必须经过审批；副作用在崩溃注入下恰好执行一次。
- 注入类评测的结果断言 100% 通过。
- 记忆可以查看和删除。
- 语义搜索通过质量检查。
- E2E 场景 8、13 通过。

## M6 通知与 PWA

- **PWA**：
  - vite-plugin-pwa：应用清单（manifest）、图标（来自 D 的草案）、Service Worker、离线时能打开应用外壳；
  - 桌面安装后使用 Window Controls Overlay（Chromium 系浏览器）；
  - 在 PWA 窗口里实测快捷键（V-16）。
- **站内通知中心**：`notifications` 表、接口、侧边栏的铃铛界面、`notification` 事件；预算提醒从横幅改为通知。
- **浏览器推送**：
  - VAPID 密钥、订阅接口（与登录会话绑定，会话失效时删除）、`push` 队列；
  - 推送规则：私信、@、回复、审批；当前正在看的会话（按 `focus` 判断）不推送；遵守免打扰；
  - 通知设置界面；
  - 标题栏和应用角标显示未读数（Badging API）；
  - V-10：在不开代理的中国大陆网络下，分别测 Chrome、Edge、Safari，把结论写进文档。
- **离线能力**：
  - TanStack Query 缓存持久化到 IndexedDB（最近的会话）；
  - 输入框草稿持久化；
  - 离线时的待发送队列，恢复网络后自动发出；
  - 退出登录时，清空以上所有本地数据。
- **测试**：E2E 场景 9（使用模拟的推送服务）。

**验收**：
- 能安装成桌面应用。
- 关闭页面后能收到推送（手动在 Chrome 或 Edge 验证，另加自动化测试）；中国大陆网络下的表现已记录。
- 断网后打开应用能看到最近的会话；网络恢复后，离线时写的消息自动发出。
- 退出登录后，本地缓存和推送订阅都已清除。

## M7 加固与彩排

- **管理后台**：
  - 用户：封禁、各项限额、手动验证邮箱；
  - 邀请；
  - 会话：归档、恢复、封禁名单；
  - 举报、审计日志；
  - AI 用量、预算与配置（包括运行内容的保留天数）；
  - **AI 运行记录**：站点 key 的运行可以查看内容，自带 key 的运行只有元数据；每次查看都写审计日志（D-034）。
- **举报与注销**：举报流程；注销账号（INV-11）。
- **隐私说明页**：按 01 第 4.11 节，内容与实际行为一致；在注册页和设置页都有入口。
- **安全审查**：对照 07 做一轮审查，覆盖安全响应头、Cookie、上传、WebSocket、保留期清理；CI 加入 trivy。
- **生产镜像与彩排**：
  - 生产 Dockerfile：基于 `oven/bun:1.4-slim`，含 ffmpeg，多阶段构建，非 root 用户；
  - `compose.prod.yml`；数据库账号分离；
  - 用 Nginx 容器和生产站点配置做本地 HTTPS 彩排，限制 CPU 近似 2 核（10 第 9 节）；
  - CI 在 arm64 上跑冒烟测试。
- **压测与备份**：k6 压力测试（锁定版本）；备份和恢复脚本，并做一次演练（restic 密码保存在服务器之外）。
- **监控**：接入 Sentry，经 `/api/monitoring` 转发（D-046）。OpenTelemetry 推迟到 v1.1。
- **无障碍与打磨**：axe 自动检查，加上手动的键盘和读屏测试；和用户一起做一轮视觉打磨。

**验收**：
- 彩排环境的 E2E 全部通过。
- 压力测试达标。
- 恢复演练验证通过。
- 07 的安全自查清单全部通过。
- CI 的 arm64 冒烟通过。

## M8 上线

按 [10-deployment.md](10-deployment.md) 第 6 节和第 10 节执行。以下事项需要用户参与：
- 购买域名（硬性前提）；
- 开通 Resend；
- 把站点 DeepSeek key 写入服务器；
- 同意 Let's Encrypt 条款；
- 创建第一个管理员的密码；
- 把 restic 密码保存到自己的密码管理器；
- 用 QQ 邮箱和 163 邮箱测试收信（V-11）。

**验收**：上线检查清单全部完成，第一批受邀用户正常使用。

## v1.1 待办

- 手机和平板布局；
- 表情回应、置顶消息、收藏、转发；
- 链接预览（必须防 SSRF）；
- 语音消息；
- 高级搜索（按人、时间、会话筛选的独立界面）；
- 私信已读回执；
- 屏蔽用户、两步验证；
- 话题线程；
- 邮件摘要；
- HEIC 转换、视频封面（ffmpeg 已在镜像里，成本很低）；
- `@所有人`；
- 隐藏在线状态；
- Agent 联网与 MCP；
- 用户自建 Agent；
- 自带 key 支持更多模型服务商（只允许白名单里的固定地址）；
- OpenTelemetry 链路追踪；
- 敏感词过滤。
