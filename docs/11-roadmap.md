# 11 路线图与里程碑

> 当前进度以 [PROGRESS.md](PROGRESS.md) 为准。本文件列出每个里程碑的任务和验收标准。
> 建议**一个里程碑用一个会话**。M2 和 M5 工作量较大，可以各拆成两个会话。

## 0. 总体顺序

```
M0 规格 ─▶ D 设计原型 ─▶ M1 本地骨架 ─▶ M2 核心聊天 ─▶ M3 富消息 ─▶ M4 Agent 基础
                                                                        │
            M8 上线 ◀─ M7 加固与彩排 ◀─ M6 通知与 PWA ◀─ M5 Agent 进阶 ◀─┘
```

- D 必须在 M1 的界面部分开工之前完成。M1 中与界面无关的工作（基础设施、后端骨架）可以和 D 同时进行。
- 上线（M8）放在最后。在此之前，所有开发和验收都在本地完成。

## 1. 会话工作流程

### 开工
1. 读仓库根目录的 `CLAUDE.md`，再读 `docs/PROGRESS.md`，确认当前里程碑和下一步要做什么。
2. 读本文件中当前里程碑的那一节，以及它引用到的规格文档。**不要一次读完全部文档。**
3. 检查环境：Docker Desktop 是否在运行；Bun 是否已安装（安装需要先征得用户同意）；`bun run check` 当前是否通过。
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

M1 的前三步提前做完了，都在 `v2` 分支上：
- [x] 仓库整理（`8b74b5c`）：移除旧代码；LICENSE 保留上游版权；重写 README；新增 `.gitignore`、`.gitattributes`（LF）、`.editorconfig`。
- [x] 工具链（`b28dbbe`）：
  - Bun 1.4.2 workspace；TS 7 严格模式；Biome 2.5；lefthook pre-commit；Renovate 配置；CI `check` 工作流；
  - `guard` 脚本：禁止 raw HTML 写法，禁止跟踪 env 文件。
- [x] 本地基础设施（`a8f1456`）：
  - `infra/compose.dev.yml`：Postgres 18 + pgvector、Valkey 9.1、Garage 2.4、Mailpit；
  - 脚本：`setup`、`infra:*`、`infra:bootstrap`、`doctor`、`infra:reset`；
  - `.env.example`。
- [x] 环境：已安装 Bun，基础设施已启动并初始化，`bun run doctor` 全部通过（证据见 PROGRESS）。
- [x] 模型指定为 V4.1-Flash（D-031，`d723d7b`）；DeepSeek key 验证可用。
- [x] 清理 git 历史中用户上传的文件（D-032），并推送 `main`、`v2` 和 `v1-legacy` 到 GitHub；CI `check` 首次运行通过。

## D 设计原型

按 [02 第 9 节](02-design-system.md) 的 D1 到 D4 进行：
- 用 Artifact 工具的 `quickstart`（intent 选 `design`）创建可点击原型，覆盖 02 第 9 节列出的全部界面。
- 桌面端，浅色和深色两套；同时测试 4 档透明度和 8 个强调色。
- 根据用户的反馈迭代，定稿后把设计令牌写回 02 第 4 节，原型链接记到 PROGRESS。

**验收**：用户确认视觉效果和交互。

## M1 本地骨架

1. ~~**整理仓库**~~ ✅ 已在"开发准备"中完成。
2. **工具链**：Bun、TS 7、Biome、lefthook、Renovate ✅ 已完成。M1 开工当天要做的是：从 npm 等源重新核对应用依赖的版本（03 第 2 节），如果 Drizzle 1.0 已正式发布就用 1.0；再把 `typecheck` 和 `check` 扩展到所有工作区包，并在 `check` 中加入测试。
3. **基础设施**：compose、`setup`、`infra:bootstrap`、`doctor` ✅ 已完成。M1 还要在 `apps/server/src/config/` 中用 zod 校验环境变量。
4. **数据层**：
   - `packages/db`：Drizzle 配置；Better Auth 的表加上扩展字段；`username_reservations`、`registration_invites`（含 `_uses`）、`app_settings`、`audit_logs` 表；第一批迁移（含 `vector` 和 `pg_trgm` 扩展）；种子数据；
   - 验证 Better Auth 能否使用 uuid 主键。
5. **contracts**：错误码、各项上限常量、基础数据结构、WebSocket 消息外层结构。
6. **server**：
   - Hono、OpenAPI 和 Scalar 文档页；`/healthz` 与 `/readyz`；
   - Origin 校验中间件、安全响应头、请求 id、pino 日志、统一错误处理；
   - Better Auth：邮箱密码（强制验证邮箱）、username、passkey、admin 插件，Valkey 存储，限流；
   - 凭邀请码注册（`/api/invites/check`、`/api/register`），邀请码管理（`/api/invites`），保留名；
   - 邮件：`email` 队列，本地发往 Mailpit；
   - WebSocket 网关骨架：认证、来源校验、`hello`、ping/pong、关闭码；Valkey 事件总线骨架；worker 骨架；
   - `admin:create` 命令。
7. **web**：
   - Vite 8、React 19.3 和 React Compiler；TanStack Router 和 Query；按 D 的定稿实现 Tailwind 4 设计令牌；Base UI、Motion、Paraglide；
   - 主题：浅色、深色、跟随系统，强调色，透明度四档；
   - 应用外壳：侧边栏、工具栏、Inspector 的占位；
   - 页面：登录、注册（邀请码）、验证邮箱、找回密码、设置（外观、账号、会话管理、Passkey、我的邀请码）；
   - WebSocket 客户端（单例，断线重连）；
   - Storybook：第一批组件，见 02 第 8 节的"基础"和"布局"两组。
8. **测试和 CI**：
   - 认证与邀请码的集成测试；
   - WebSocket 的认证和来源测试（L-13、L-14）；
   - E2E 场景 1（邀请 → 注册 → 在 Mailpit 验证邮箱 → 登录）；
   - 第一批组件的截图基线；
   - 建立 `check`、`integration`、`security` 三个 CI 工作流，包含"在空库上执行迁移"这一步。

**验收**：
- 按 09 的首次搭建步骤，从全新克隆开始就能跑起来。
- 完整走通一遍：管理员用命令行创建 → 生成邀请码 → 新用户注册 → 在 Mailpit 验证 → 登录 → 看到应用外壳。在 localhost 上注册和登录 Passkey 都可用。
- 未登录的 WebSocket 连接以 4401 关闭；来源不对的以 4403 关闭。
- `bun run check` 和 CI 全部通过。
- 用户看过应用外壳，确认与原型一致。

## M2 核心聊天（可以拆成 M2a 数据与接口、M2b 界面）

**M2a 数据与接口**
- 建表：`conversations`、`dm_pairs`、`conversation_members`、`conversation_invites`、`messages`、`message_hidden`。
- domain 层：
  - 会话：创建、加入、退出、转让、归档、修改设置；成员：拉人、踢人、任免、禁言；私信：获取或创建；
  - 注册邀请：前端要用的部分；群邀请链接；
  - 消息：发送、列表、补发、编辑、撤回、仅自己删除、管理员删除；已读位置；系统消息；
  - `authorize()` 和各项策略；审计日志。
- HTTP：05 第 3.2 到 3.4 节的全部接口，以及限流。
- 实时：
  - 连接时订阅频道，成员关系变化时动态订阅或退订；事件通过 Valkey 转发；
  - 正在输入；在线状态（Valkey 有序集合，加上 `presence.watch`）；已读位置同步。
- 测试：
  - 集成测试、实时测试；
  - 不变量 INV-01 至 04、07、08、09；
  - 安全回归：L-01 至 L-04、L-09、L-10、L-15 至 L-24（其中 L-19、L-20 在资料修改功能完成后补上）。

**M2b 界面**
- 侧边栏：分组、未读数、置顶；新建频道、群组、私信的对话框；频道发现页。
- 工具栏；时间线：虚拟列表、消息分组、时间分隔、未读分隔、回到最新、向上加载更多、定位到某条消息。
- 输入栏：
  - Enter 发送，Shift+Enter 换行；
  - 按 ↑ 编辑上一条；
  - 回复引用；
  - 发送时先显示、失败可重试。
- 右键菜单：回复、复制、编辑、撤回、仅自己删除、管理员删除。
- 状态显示：正在输入、在线状态、已读位置推进。
- Inspector：成员列表、会话设置、群邀请链接。
- 设置：资料（显示名、简介、用户名修改规则）、我的注册邀请码。
- 消息正文用 Markdown 渲染（和 Agent 输出用同一个安全渲染器）。
- E2E 场景 2 到 5。

**验收**：
- E2E 场景 2 到 5 在 Chromium 和 WebKit 上都通过。
- 本地收发延迟 p95 < 200 ms（用测试脚本测量）。
- 在 1 万条种子消息的会话里滚动流畅。
- 适用的安全回归测试全部通过。
- 用户亲自试用。

## M3 富消息

- 建 `attachments` 表；存储层实现 `BlobStore` 接口，底层是 Bun 的 S3 客户端连接 Garage。
- 上传接口 `/api/uploads`：边收边检查大小、判断真实类型、计算 sha256、检查配额、限流。
- `media` 队列：
  - 用 sharp 重新编码以去除 EXIF；
  - 生成缩略图、预览图和 thumbhash；
  - GIF 保留动画；
  - 头像裁剪。
- 下载接口：鉴权、支持 Range、安全响应头（SEC-08）；`cleanup` 定时任务。
- 头像：用户头像和会话头像。
- 界面：
  - 上传：附件按钮、拖拽、粘贴、进度条；
  - 展示：图片网格、大图预览、视频和音频播放器、文件卡片。
- @提及：自动补全弹窗、`<@user:id>` 格式、`message_mentions` 表、高亮"@我"。
- emoji 选择器；代码块高亮（Shiki）。
- 测试：
  - L-12；SEC-07、SEC-08；
  - EXIF 确实被去除；存储配额；清理任务；Range 请求；
  - E2E 场景 6；
  - 恶意文件样例：伪装成图片的 html、svg、超大文件。

**验收**：以上测试全部通过，用户试用确认。

## M4 Agent 基础

1. **先做技术验证**：完成 06 第 6 节列出的 5 项 DeepSeek 实测，把结论写进 12-decisions。
2. **机器人与会话**：Agent 机器人用户；Agent 会话的创建、列表、改名；标题自动生成。
3. **运行记录**：建 `agent_runs`、`agent_steps`、`ai_usage_daily` 表；三层预算检查；`agent` 队列。
4. **执行**：用 `ToolLoopAgent` 加 4.1 节的只读工具；按读取范围过滤工具；用"不可信"标记包裹聊天记录；对图片使用多模态输入。
5. **流式输出**：消息的 `streaming` 状态、`agent.delta`、`message.updated`；停止和重新生成。
6. **群里 @Agent**：读取范围限定为 `current_conversation`；遵守 `agentEnabled` 开关；频率限制。
7. **界面**：
   - 侧边助手面板（面板对话、快捷操作）；
   - ⌘K 命令面板和斜杠命令；
   - Agent 消息和工具调用卡片（02 第 6 节）；
   - 用量显示。
8. **搜索**：给 `messages.body` 建 pg_trgm 索引，供 `search_messages` 使用。
9. **测试**：
   - 用模拟的模型提供方跑集成测试和 E2E（配置 `AI_PROVIDER=mock`，保证结果确定）；
   - 读取范围相关的安全测试。
10. **评测第一版**：覆盖读取范围、注入、格式、工具选择、总结质量五类，用真实的 DeepSeek 运行。

**验收**：
- 评测达到 06 第 12 节的通过线。
- E2E 场景 7 通过。
- 当日额度用完后能正确拦截，并给出提示。
- 用户亲自试用。

## M5 Agent 进阶（可以拆成 M5a 审批与操作、M5b 记忆与语义搜索）

**M5a 审批与操作**
- 技术验证：`toolApproval` 流程，以及"修改后批准"的实现方式。
- 建 `agent_approvals` 表；审批接口、审批卡片、24 小时过期。
- 工具：
  - `send_message`（`clientId` 确定性生成）、`schedule_message`、`create_group`、`invite_members`；
  - `create_reminder`、`cancel_*`；建 `reminders` 和 `scheduled_messages` 两张表，用延迟任务在到点时执行。
- 评测第二版：审批门槛类用例必须 100% 通过，并扩充注入类用例。

**M5b 记忆与语义搜索**
- 技术验证：本地向量模型，按 06 第 10 节的标准评估。
- 建 `agent_memories` 表；实现 `remember`、`forget`、`recall_memories`；设置里的记忆管理界面。
- `embeddings` 队列、历史消息补算、`message_embeddings` 表；混合检索工具 `semantic_search_messages`。
- 长对话的滚动摘要。

**验收**：
- 所有影响他人的操作都必须经过审批。
- 注入类评测 100% 通过。
- 记忆可以查看和删除。
- 语义搜索通过质量检查。
- E2E 场景 8 通过。

## M6 通知与 PWA

- vite-plugin-pwa：应用清单（manifest）、图标、Service Worker、离线时能打开应用外壳；桌面安装后使用 Window Controls Overlay（Chromium 系浏览器）。
- 浏览器推送：
  - VAPID 密钥、订阅接口、`push` 队列；
  - 推送规则（私信、@、回复、审批）；当前正在看的会话不推送；遵守免打扰；
  - 通知设置界面；
  - 标题栏和应用角标显示未读数（Badging API）。
- 离线能力：
  - TanStack Query 缓存持久化到 IndexedDB（最近的会话）；
  - 输入框草稿持久化；
  - 离线时的待发送队列，恢复网络后自动发出。
- E2E 场景 9（使用模拟的推送服务）。

**验收**：
- 能安装成桌面应用。
- 关闭页面后能收到推送（手动在 Chrome 或 Edge 验证，另加自动化测试）。
- 断网后打开应用能看到最近的会话；网络恢复后，离线时写的消息自动发出。

## M7 加固与彩排

- 管理后台：用户、邀请、会话、举报、审计日志、AI 用量、预算与配置。
- 举报流程；注销账号（INV-11）。
- 对照 07 做一轮安全审查：CSP 和 Trusted Types 评估、安全响应头、Cookie、上传、WebSocket；CI 加入 trivy。
- 生产 Dockerfile：多阶段构建、非 root 用户；`compose.prod.yml`；用 Caddy 做本地 HTTPS 彩排（10 第 9 节）。
- k6 压力测试；备份和恢复脚本，并做一次演练。
- 接入 OpenTelemetry 和 Sentry。
- 无障碍审查：axe 自动检查，加上手动的键盘和读屏测试；和用户一起做一轮视觉打磨。

**验收**：
- 彩排环境的 E2E 全部通过。
- 压力测试达标。
- 恢复演练验证通过。
- 07 的安全自查清单全部通过。

## M8 上线

按 [10-deployment.md](10-deployment.md) 第 6 节和第 10 节执行。以下事项需要用户参与：
- 购买域名；
- 开通 Resend；
- 把 DeepSeek key 写入服务器；
- 同意 Let's Encrypt 条款；
- 创建第一个管理员的密码。

**验收**：上线检查清单全部完成，第一批受邀用户正常使用。

## v1.1 待办

- 手机和平板布局；
- 表情回应、置顶消息、收藏、转发；
- 链接预览（必须防 SSRF）；
- 语音消息；
- 消息搜索界面；
- 私信已读回执；
- 屏蔽用户、两步验证；
- 话题线程；
- 邮件摘要；
- HEIC 转换、视频封面；
- `@所有人`；
- 隐藏在线状态；
- Agent 联网与 MCP；
- 用户自建 Agent；
- 敏感词过滤。
