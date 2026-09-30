# 03 架构

## 1. 总览

```
Browser (desktop, PWA)
  React SPA · TanStack Router/Query · one WebSocket per tab
        │  same origin:  /  (static)   /api/*  (REST)   /ws  (WebSocket)
        ▼
[dev] Vite dev server :5173 (proxies /api and /ws)   [prod] host Nginx (TLS, static, limits)
        │
        ▼
api  (Bun + Hono)  :3100
  ├─ http/      REST routes (thin) ──┐
  ├─ realtime/  WS gateway ──────────┤──▶ domain/  business services + authorize()
  └─ auth/      Better Auth          │
                                     ├──▶ PostgreSQL 18 (+pgvector)  source of truth
worker (Bun)                         ├──▶ Valkey 9.1   pub/sub bus · presence · rate limits · BullMQ
  ├─ jobs/   media · push · email · cleanup · scheduled
  └─ agent/  Agent runtime (AI SDK 7 ToolLoopAgent) ──▶ DeepSeek API
                                     └──▶ Garage (S3)  attachments (private bucket)
Events: api/worker ──publish──▶ Valkey channel "events" ──▶ every api instance ──▶ local WS subscribers
```

核心原则：
1. **写操作走 HTTP，推送走 WebSocket。** 所有改变状态的操作（发送、编辑、撤回、加入等）都是带幂等键的 HTTP 请求。WebSocket 只负责服务端推送事件，以及"正在输入""在线状态"这类瞬时信号。
2. **只有 domain 层有业务逻辑。** HTTP 路由、WebSocket 网关、Agent 工具、后台任务都只是很薄的一层，直接调用 domain 里的服务。权限检查只在 `authorize()` 里做。
3. **事件在事务提交之后发布**（`after commit`）。万一发布失败，客户端还能靠 `change_seq` 补发来兜底，因此不需要 outbox 表。
4. **慢活交给 worker。** AI、图片处理、推送、邮件、定时任务都在 worker 里跑，不阻塞 api。

## 2. 技术栈与版本

以下版本于 2026-09-30 在 npm、Docker Hub、endoflife.date 上核实。**M1 开工时要再核对一次**，锁定当时的最新稳定版（精确版本加锁文件）。原则上不用 beta 或 RC，例外会在表中注明。

### 2.1 运行时与后端

| 用途 | 选型 | 版本 |
|---|---|---|
| 语言 | TypeScript（Go 原生编译器） | 7.0.2 |
| 运行时、包管理、后端测试 | Bun | 1.4.2 |
| Web 框架 | Hono（`hono/bun` 提供 WebSocket 升级） | 4.13.11 |
| OpenAPI | `@hono/zod-openapi` | 1.6.3 |
| 运行时校验、前后端契约 | zod | 4.6.5 |
| ORM 与迁移 | drizzle-orm / drizzle-kit，驱动用 `drizzle-orm/bun-sql` | 1.0（当前 RC4；GA 后用 1.0，否则先用 0.45.3，见 D-012） |
| 认证 | better-auth + `@better-auth/passkey` | 1.7.6 |
| 队列 | bullmq（依赖 ioredis） | 6.3.10 / ioredis 6.0.0 |
| AI | `ai`（AI SDK）+ `@ai-sdk/deepseek` | 7.0.123 / 3.0.57 |
| 本地向量模型（M5 验证） | `@huggingface/transformers` | 4.3.0 |
| 图片处理 | sharp | 0.35.5 |
| 文件类型识别 | file-type | 22.1.1 |
| 模糊占位图 | thumbhash | 0.1.1 |
| 邮件发送 | nodemailer（本地连 Mailpit，生产连 Resend 的 SMTP） | 10.0.13 |
| Web Push（M6） | web-push | 3.6.7 |
| 日志 | pino | 10.3.1 |
| API 文档界面（仅开发环境） | `@scalar/hono-api-reference` | 0.12.7 |

### 2.2 前端

| 用途 | 选型 | 版本 |
|---|---|---|
| UI 框架 | React + React Compiler（`babel-plugin-react-compiler`） | 19.3.0 / 1.0.0 |
| 构建 | Vite（基于 Rolldown）+ `@vitejs/plugin-react` | 8.3.1 / 6.1.1 |
| 路由 | `@tanstack/react-router` + `@tanstack/router-plugin`（按文件自动生成路由） | 1.170.40 / 1.168.41 |
| 服务端数据 | `@tanstack/react-query` + `react-query-persist-client`（M6 离线） | 5.104.0 |
| 客户端状态 | zustand | 5.0.15 |
| 样式 | tailwindcss + `@tailwindcss/vite` | 4.3.3 |
| 组件原语 | `@base-ui/react`（Radix 备选） | 1.8.0 |
| 动效 | motion | 13.4.6 |
| 图标 | lucide-react | 1.49.0 |
| 虚拟列表 | react-virtuoso | 4.18.16 |
| Markdown（流式也安全） | streamdown（代码高亮用 shiki 4.4.3） | 2.6.0 |
| 国际化 | `@inlang/paraglide-js` | 2.25.4 |
| PWA（M6） | vite-plugin-pwa | 1.3.0 |
| 本地存储（M6） | idb-keyval | 6.3.0 |
| 组件目录 | storybook + `@storybook/react-vite` | 10.6.1 |

### 2.3 工程工具

| 用途 | 选型 | 版本 |
|---|---|---|
| 代码检查与格式化 | `@biomejs/biome` | 2.5.14 |
| Git 钩子 | lefthook | 2.1.15 |
| 前端单元测试 | vitest | 5.0.2 |
| 端到端测试 | `@playwright/test` + `@axe-core/playwright` | 1.63.0 / 4.13.0 |
| 压力测试 | grafana/k6（Docker 镜像） | latest |
| Node（Playwright、Storybook 等工具需要） | Node | ≥ 24（本机为 26） |

### 2.4 基础设施镜像（均支持 arm64）

| 服务 | 镜像 |
|---|---|
| PostgreSQL 18 + pgvector | `pgvector/pgvector:0.8.6-pg18` |
| Valkey | `valkey/valkey:9.1-alpine` |
| 对象存储 | `dxflrs/garage:v2.4.1` |
| 本地邮件接收（仅开发） | `axllent/mailpit:v1.31.3` |
| 应用运行（生产） | `oven/bun:1.4-alpine`，或 `oven/bun:1.4-distroless` |
| 本地 HTTPS 彩排（M7） | `caddy:2`（官方镜像） |

## 3. 仓库结构（Bun workspaces 单仓库）

```
/
├─ apps/
│  ├─ web/                       React SPA
│  │  ├─ src/routes/             TanStack Router file routes
│  │  ├─ src/features/           auth, conversations, timeline, composer, attachments,
│  │  │                          presence, agent, command-palette, settings, admin
│  │  ├─ src/design/             design tokens (CSS), glass materials, motion presets
│  │  ├─ src/components/         design-system components (Apple style)
│  │  ├─ src/lib/                api client, ws client, query client, i18n, store
│  │  ├─ messages/               Paraglide translations (zh-CN, en)
│  │  └─ .storybook/
│  └─ server/
│     ├─ src/api.ts              entry: Hono app + Bun.serve (HTTP + WS)
│     ├─ src/worker.ts           entry: BullMQ workers + scheduler
│     ├─ src/cli.ts              admin tools (create admin, reset budget, …)
│     ├─ src/http/               route modules (thin): me, users, invites, conversations,
│     │                          members, messages, uploads, attachments, agent, push,
│     │                          reports, admin, health
│     ├─ src/realtime/           gateway, topics, presence, typing, event bus
│     ├─ src/domain/             services + authorize() + policies (ONLY business logic)
│     ├─ src/agent/              runtime, tools/, prompts/, memory/, policies, budget
│     ├─ src/jobs/               processors: agent, media, push, email, cleanup, scheduled
│     ├─ src/storage/            BlobStore interface + S3 (Garage) implementation
│     ├─ src/auth/               Better Auth config, invite gate, reserved names
│     ├─ src/config/             env schema (zod), fail-fast loading
│     ├─ src/lib/                logger, errors, ids, time, rate-limit
│     ├─ evals/                  Agent eval datasets + runner
│     └─ test/                   integration, ws, security regression
├─ packages/
│  ├─ contracts/                 zod schemas: REST DTOs, WS events, error codes, limits
│  └─ db/                        Drizzle schema, migrations, seed, client factory
├─ infra/
│  ├─ compose.dev.yml            postgres, valkey, garage, mailpit
│  ├─ compose.prod.yml           (M7) api, worker, postgres, valkey, garage
│  ├─ garage/                    garage.toml template + bootstrap script
│  ├─ caddy/                     (M7) local HTTPS rehearsal
│  └─ nginx/                     (M8) site template
├─ docs/                         specs (this folder)
├─ CLAUDE.md                     working agreement for coding sessions
├─ package.json                  workspaces + scripts
├─ biome.json · tsconfig.base.json · lefthook.yml · .env.example · .gitattributes
```

### 依赖规则（在 CI 中检查）
- `packages/contracts` 不依赖任何其他包；`apps/web` 和 `apps/server` 都依赖它。
- `apps/web` **不得**导入 `packages/db` 和 `apps/server` 的任何代码。
- 在 `apps/server` 内部：
  - `http/`、`realtime/`、`agent/tools/`、`jobs/` 只能调用 `domain/`，不能直接操作数据库表（查询也通过 domain 里的函数）。
  - `domain/` 不知道 HTTP 和 WebSocket 的存在，只接收"当前用户 + 参数"，返回结果或抛出领域错误。

## 4. 进程与端口

| 进程 | 开发环境 | 生产环境 |
|---|---|---|
| web | Vite 开发服务器 :5173，把 `/api` 和 `/ws` 代理到 :3100（前后端同源，Cookie 才能正常工作） | 静态文件，由宿主机 Nginx 提供 |
| api | `bun --watch src/api.ts` :3100 | 容器，绑定 `127.0.0.1:3100` |
| worker | `bun --watch src/worker.ts` | 同一个镜像，只是启动命令不同 |
| postgres | 容器，宿主机端口 **5434**（本机 5432 已被原生 PostgreSQL 占用） | 仅容器内网 |
| valkey | 容器，宿主机端口 6379 | 仅容器内网 |
| garage | 容器，S3 接口 :3900，管理接口 :3903 | 仅容器内网 |
| mailpit | 容器；SMTP 用宿主机 **2525** 端口（映射到容器内 1025，因为本机 1025 被 VPN 占用），网页界面 :8025 | 不部署，改用 Resend |

## 5. 关键流程

### 5.1 发送消息
1. 客户端生成一个 `clientId`（UUIDv7），先把消息以"发送中"的状态显示出来。
2. 客户端调用 `POST /api/conversations/:id/messages`，请求体为 `{clientId, body, attachmentIds, replyToId}`。
3. api 校验会话、限流、调用 `authorize(user, conv, 'message.send')`（检查是否为成员、是否被禁言、会话是否已归档），然后用 zod 校验正文长度和附件归属。
4. 在一个事务里依次完成：
   - `UPDATE conversations SET last_seq = last_seq + 1, last_change_seq = last_change_seq + 1, last_message_at = now() WHERE id = $1 RETURNING last_seq, last_change_seq`；
   - 插入消息，`seq` 和 `change_seq` 取上一步返回的值；
   - 把附件绑定到这条消息；
   - 写入 @提及；
   - 把发送者的 `last_read_seq` 推进到这个 seq。
5. 如果 `(sender_id, client_id)` 发生唯一约束冲突，说明是重试，直接返回已有的那条消息，状态码 200。
6. 事务提交后发布 `message.created` 事件，频道是 `conv:{id}`。如果消息 @了 Agent，就创建一个 agent run 并放入队列；M6 起还要给相关用户排推送任务。
7. 返回 201 和消息内容。客户端用 `clientId` 把"发送中"的那条替换成正式消息。

### 5.2 断线补发
1. WebSocket 重连成功后，服务端发来 `hello`。客户端立刻调用 `GET /api/conversations`，拿到每个会话的 `lastSeq`、`lastChangeSeq` 和未读数。
2. 对当前打开的会话，以及本地有缓存的会话，调用 `GET /api/conversations/:id/changes?sinceChangeSeq=X`，分页拉取所有 `change_seq > X` 的消息（新消息和被修改的都包括在内），逐条合并到本地缓存。
3. 补发期间收到的实时事件先放进缓冲区。所有合并都按消息 `id` 进行，并且只接受 `change_seq` 更大的版本，重复或乱序都不影响结果。
4. 没有缓存的会话等用户打开时再加载，不在重连时拉取。

### 5.3 编辑、撤回、删除
- **编辑和撤回**：在同一个事务里给 `last_change_seq` 加 1，更新消息，并把消息的 `change_seq` 设为新值；提交后发布 `message.updated`。
- **撤回的额外处理**：把 `body` 置空，删除 @提及，把附件标记为待删除。worker 随后删除存储里的文件，并清除这条消息的向量。
- **仅自己删除**：只写入 `message_hidden` 表，并通过 `user:{me}` 同步到我的其他设备，其他人不受影响。

### 5.4 上传
1. 客户端用 XHR 调用 `POST /api/uploads`（multipart，单个文件），这样能显示上传进度。
2. api 边接收边校验大小，把流写入存储；同时用文件开头的字节判断真实类型，再计算 sha256。
3. 创建 `attachments` 记录，状态为 `processing`。
4. 图片交给 worker 的 `media` 队列：生成缩略图和预览图、去除 EXIF、计算 thumbhash，然后把状态改为 `ready`；其他类型的文件直接就是 `ready`。
5. 处理完成后，通过 `user:{uploader}` 推送 `attachment.updated`。
6. 发送消息时带上 `attachmentIds`。服务端会检查：附件属于发送者本人、还没有绑定到其他消息、状态是 `ready`。

### 5.5 Agent 运行
详见 [06-agent.md](06-agent.md)，这里只列骨架：
1. 触发 run 有三种方式：`POST /api/agent/runs`、消息里 @Agent、定时提醒。
2. api 先检查预算，然后在 `agent_runs` 里插入一条状态为 `queued` 的记录，放入 `agent` 队列。
3. worker 把 run 标记为 `running`，构建上下文，再用 `ToolLoopAgent` 流式执行：
   - 文本增量通过 `agent.delta` 事件推给前端；
   - 每次工具调用都写入 `agent_steps`，并推送 `agent.step` 事件；
   - 遇到需要审批的工具时，把状态存进数据库，run 改为 `awaiting_approval`，推送审批请求，本次任务到此结束；
   - 用户批准后，放入一个新任务，从断点继续。

### 5.6 在线状态
1. WebSocket 建立连接后，在 Valkey 中写入 `presence:conns:{userId}`：这是一个有序集合，成员是连接 id，分数是过期时间。
2. 心跳每 25 秒续期一次。
3. 在线状态变化（在线、离开、离线）时，发布到 `presence:{userId}` 这个频道。
4. 客户端通过 `presence.watch` 声明自己关心哪些用户，服务端就把这个连接订阅到那些用户的频道上。

## 6. 实时设计

**频道（topic）**
- `user:{userId}`：发给个人的事件。包括会话列表变化、成员变化、已读同步、隐藏消息、审批请求、run 状态、通知。
- `conv:{conversationId}`：会话内的事件。包括消息增删改、正在输入、Agent 流式输出、成员变化。
- `presence:{userId}`：某个用户的在线状态。

**订阅规则**
- 连接建立时，服务端查询该用户的全部成员关系，把连接订阅到 `user:{me}` 和每一个 `conv:{id}`。
- 之后成员关系变化时（加入、被移出），由 `user:{me}` 上的事件触发动态订阅或退订。
- 客户端**不能**自己订阅会话频道。

**事件总线**
- api 和 worker 把事件 `{topic, event}` 发布到 Valkey 的 `events` 频道。
- 每个 api 实例都订阅这个频道，收到后调用 Bun 的 `server.publish(topic, payload)`，转发给本机订阅了该 topic 的连接。
- 这样天然支持多个 api 实例同时运行。

**连接管理**
- 心跳：服务端每 25 秒发一次 ping；60 秒收不到 pong 就断开连接，关闭码 4408。
- 每个用户最多 10 个连接，超出时关闭最早的那个。

## 7. 后台任务（BullMQ 队列）

| 队列 | 任务 | 并发 | 重试 |
|---|---|---|---|
| `agent` | Agent 运行和续跑 | 4 | 模型调用出错时指数退避重试 2 次；有副作用的步骤不自动重试 |
| `media` | 图片处理、头像裁剪 | 2（服务器只有 2 个 CPU 核心） | 3 次 |
| `push`（M6） | Web Push 推送 | 8 | 3 次；推送地址返回 410 时删除该订阅 |
| `email` | 验证邮件、重置密码邮件 | 2 | 5 次 |
| `cleanup` | 清理孤儿附件、过期邀请、已撤回消息的文件 | 1 | 定时执行（每小时） |
| `scheduled`（M5） | 定时提醒、定时消息 | 2 | 用延迟任务实现，到点执行 |
| `embeddings`（M5） | 为消息和记忆计算向量 | 1 | 3 次 |

Valkey 必须设置 `maxmemory-policy noeviction`，这是 BullMQ 的要求，否则内存满时队列数据会被淘汰；同时开启 AOF 持久化。

## 8. 配置（环境变量）

- 用 zod 在启动时校验所有环境变量，缺失或非法就立即退出。
- 生产环境下，如果密钥太短或仍是示例值，拒绝启动。
- 仓库里提交 `.env.example`；真实值写在 `.env.local` 里，这个文件已加入 `.gitignore`。

| 变量 | 示例（开发） | 说明 |
|---|---|---|
| `APP_ENV` | `development` | development、test、production 三选一 |
| `APP_ORIGIN` | `http://localhost:5173` | 同源校验、Cookie、Passkey 的 RP ID 都依赖它 |
| `API_PORT` | `3100` | |
| `DATABASE_URL` | `postgres://chatapp:…@localhost:5434/chatapp` | |
| `VALKEY_URL` | `redis://localhost:6379` | |
| `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` | `http://localhost:3900` / `garage` / `chatapp` | |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | 由 bootstrap 脚本生成 | |
| `BETTER_AUTH_SECRET` | 由 setup 脚本生成 | ≥ 32 字节随机值 |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM` | `localhost` / `2525` / 空 / 空 / `ChatApp <noreply@chatapp.localhost>` | |
| `DEEPSEEK_API_KEY` | **用户自己填写** | 不能出现在聊天记录和日志里 |
| `AI_MODEL_FAST` / `AI_MODEL_DEEP` | `deepseek-flash` / `deepseek-v4-pro` | 模型名做成可配置项 |
| `AI_USER_DAILY_TOKENS` / `AI_MONTHLY_BUDGET_USD` | `500000` / `20` | 只是初始值，之后以后台设置为准 |
| `AI_PRICE_*` | 按 DeepSeek 当前价格填写 | 用于估算费用 |
| `PRODUCT_NAME` / `AGENT_DISPLAY_NAME` / `AGENT_USERNAME` | `ChatApp` / `助手` / `assistant` | |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | M6 生成 | |
| `LOG_LEVEL` | `info` | |
| `SEED_DEMO_PASSWORD` | 由 setup 脚本生成 | 仅开发环境，演示账号的密码 |

## 9. 错误处理、日志与可观测性

- **错误格式**：统一为 `{ error: { code, message, details? } }`，错误码定义在 `packages/contracts/errors.ts`（见 05）。
- **5xx 错误**：只返回错误码和请求 id，不暴露堆栈和内部信息。
- **日志**：用 pino 输出 JSON，每条日志带 `requestId`、`userId`、`conversationId`、`runId`。
  - **不记录**：消息正文、AI 的提示词和输出、密码、令牌、Cookie、API key。
  - Agent 每一步的详细内容只存在 `agent_steps` 表里，只有本人和站点管理员能看，站点管理员查看时要写审计日志。
- **健康检查**：`/healthz` 表示进程存活；`/readyz` 检查数据库、Valkey、S3 是否都可用。
- **M7 起**：用 OpenTelemetry 记录请求和 Agent 调用链路，按 GenAI 语义约定标注；错误上报到 Sentry。

## 10. 性能设计

- **消息查询**只走 `(conversation_id, seq)` 和 `(conversation_id, change_seq)` 两个索引，分页每页 50 条。
- **会话列表**一次查询返回：未读数（`last_seq - last_read_seq`）、最后一条消息的预览、私信对方的资料，避免 N+1 查询。
- **前端**
  - 时间线用虚拟列表，在内存里保留最近 2000 条消息，更早的按需加载。
  - 图片先用 thumbhash 显示占位，缩略图懒加载。
  - 路由自动分割代码；React Compiler 自动做 memo 优化。
- **服务端**：从数据库连接池取连接时，每个请求最多占用 1 个连接。未读数等计算都在 SQL 里完成。

## 11. 前端架构要点

- **服务端数据**：全部由 TanStack Query 管理。WebSocket 收到事件后直接修改 Query 缓存（`setQueryData`），不再重新请求。
- **消息缓存**：每个会话一份分页缓存，按 `seq` 排序，合并时以消息 id 去重，并以 `change_seq` 大的版本为准。
- **乐观更新**：发送、编辑、撤回都先更新界面，失败再回滚；未发出的消息用 `clientId` 标识。
- **全局状态**（zustand）：当前会话、Inspector 是否打开、输入框草稿（按会话保存，M6 起持久化到 IndexedDB）、外观设置。
- **WebSocket 客户端**：单例；断线后按指数退避重连（1、2、4、8 秒，最长 30 秒，带随机抖动）；每次重连都执行 5.2 的补发流程。
- **表单**：每个输入框使用 contracts 里的同一份 zod schema，前后端校验规则保持一致。
