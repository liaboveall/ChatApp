# 03 架构

## 1. 总览

```
Browser (desktop, PWA)
  React SPA · TanStack Router/Query · one WebSocket per tab
        │  same origin:  /  (static)   /api/*  (REST + health)   /ws  (WebSocket)
        ▼
[dev] Vite dev server :5173 (proxies /api and /ws)   [prod] host Nginx (TLS, static, limits)
        │
        ▼
api  (Bun + Hono)  :3100
  ├─ http/      REST routes (thin) ──┐
  ├─ realtime/  WS gateway ──────────┤──▶ domain/  business services + authorize() + visibility
  └─ auth/      Better Auth          │
                                     ├──▶ PostgreSQL 18 (+pgvector)  source of truth
worker (Bun)                         ├──▶ Valkey 9.1   pub/sub bus · presence · rate limits · BullMQ
  ├─ jobs/   media · push · email · cleanup · scheduled · reconcile · embeddings
  └─ agent/  Agent runtime (AI SDK 7 ToolLoopAgent) ──▶ DeepSeek API (site key or the user's own key)
                                     └──▶ Garage (S3)  attachments (private bucket)
Events: api/worker ──publish──▶ Valkey channel "events:{APP_ENV}" ──▶ every api instance ──▶ local WS subscribers
```

核心原则：
1. **写操作走 HTTP，推送走 WebSocket。** 所有改变状态的操作（发送、编辑、撤回、加入等）都是带幂等键的 HTTP 请求。WebSocket 只负责服务端推送事件，以及"正在输入""在线状态""当前查看的会话"这类瞬时信号。
2. **只有 domain 层有业务逻辑。** HTTP 路由、WebSocket 网关、Agent 工具、后台任务都只是很薄的一层，直接调用 domain 里的服务。权限检查只在 `authorize()` 里做。
3. **事件在事务提交之后发布**（`after commit`），不用 outbox 表。发布失败时，由客户端兜底：按会话检测 `changeSeq` 是否跳号，缺号就调用补发接口；重连时也会整体补发（D-025、D-043）。
4. **慢活交给 worker。** AI、图片和视频处理、推送、邮件、定时任务都在 worker 里跑，不阻塞 api。
5. **数据库是唯一的事实来源。** Valkey 里的东西（队列、在线状态、限流计数、缓存）丢了都可以重建。需要持久的状态，比如定时消息、提醒、审批、run，都以数据库为准，由对账任务补回（D-044）。
6. **消息可见性只有一个判断：** 是会话成员，并且消息的 `seq` 大于自己的 `visible_from_seq`（D-035）。HTTP、WebSocket、搜索、Agent 工具、附件下载都调用同一个 domain 函数。

## 2. 技术栈与版本

以下版本于 2026-09-30 在 npm、Docker Hub、endoflife.date 上核实。**M1a 开工时要再核对一次**，锁定当时的最新稳定版（精确版本加锁文件）。原则上不用 beta 或 RC，例外会在表中注明。

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
| 队列与 Valkey 客户端 | bullmq + ioredis（应用里所有 Valkey 访问统一用 ioredis，D-044） | 6.3.10 / 6.0.0 |
| AI | `ai`（AI SDK）+ `@ai-sdk/deepseek` | 7.0.123 / 3.0.57 |
| 本地向量模型（M5b 验证） | `@huggingface/transformers` | 4.3.0 |
| 图片处理 | sharp | 0.35.5 |
| 视频元数据清理（M3） | ffmpeg（镜像里的系统包，只做重新封装） | 随 Debian 版本 |
| 文件类型识别 | file-type | 22.1.1 |
| 模糊占位图 | thumbhash | 0.1.1 |
| 邮件发送 | nodemailer（本地连 Mailpit，生产连 Resend 的 SMTP） | 10.0.13 |
| Web Push（M6） | web-push | 3.6.7 |
| 日志 | pino | 10.3.1 |
| 错误追踪（M7） | `@sentry/bun`、`@sentry/react` | M7 时核对 |
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
| 虚拟列表 | react-virtuoso（M2b 开头先验证聊天场景，V-09） | 4.18.16 |
| Markdown（流式也安全） | streamdown（代码高亮用 shiki 4.4.3，配置见 D-047） | 2.6.0 |
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
| 视觉测试运行环境 | Playwright 官方 Docker 镜像（与 `@playwright/test` 同版本） | 同上 |
| 压力测试 | grafana/k6（Docker 镜像） | M7 时锁定当时的精确版本 |
| Node（Playwright、Storybook 等工具需要） | Node | ≥ 24（本机为 26） |

### 2.4 基础设施镜像（均支持 arm64）

| 服务 | 镜像 |
|---|---|
| PostgreSQL 18 + pgvector | `pgvector/pgvector:0.8.6-pg18` |
| Valkey | `valkey/valkey:9.1-alpine` |
| 对象存储 | `dxflrs/garage:v2.4.1` |
| 本地邮件接收（仅开发） | `axllent/mailpit:v1.31.3` |
| 应用运行（api、worker 共用） | `oven/bun:1.4-slim`（Debian）。ffmpeg 和 onnxruntime 需要 glibc，所以不用 alpine（D-041） |
| 生产式网关（M2b 的 CSP 测试、M7 彩排） | `nginx`，与服务器同为 1.28 系列，锁定精确版本（D-045） |

## 3. 仓库结构（Bun workspaces 单仓库）

```
/
├─ apps/
│  ├─ web/                       React SPA
│  │  ├─ src/routes/             TanStack Router file routes
│  │  ├─ src/features/           auth, conversations, timeline, composer, attachments,
│  │  │                          presence, agent, command-palette, notifications, settings, admin
│  │  ├─ src/design/             design tokens (CSS), glass materials, motion presets
│  │  ├─ src/components/         design-system components (Apple style)
│  │  ├─ src/lib/                api client, ws client, query client, i18n, store
│  │  ├─ messages/               Paraglide translations (zh-CN, en)
│  │  ├─ e2e/ · visual/          Playwright specs (visual baselines are generated in the Linux container)
│  │  └─ .storybook/
│  └─ server/
│     ├─ src/api.ts              entry: Hono app + Bun.serve (HTTP + WS)
│     ├─ src/worker.ts           entry: BullMQ workers + schedulers
│     ├─ src/cli.ts              admin tools (create admin, verify email, migrate, reset budget, …)
│     ├─ src/http/               route modules (thin): me, users, invites, conversations,
│     │                          members, bans, messages, search, uploads, attachments, agent,
│     │                          notifications, push, reports, admin, health, test (APP_ENV=test only)
│     ├─ src/realtime/           gateway, hub (Bun pub/sub behind an interface), topics,
│     │                          presence, typing, focus, event bus, session binding
│     ├─ src/domain/             services + authorize() + visibility + policies (ONLY business logic)
│     ├─ src/agent/              runtime, tools/, prompts/, memory/, keys/ (user key crypto),
│     │                          effects ledger, policies, budget
│     ├─ src/jobs/               processors: agent, media, push, email, cleanup, scheduled,
│     │                          reconcile, embeddings
│     ├─ src/storage/            BlobStore interface + S3 (Garage) implementation
│     ├─ src/auth/               Better Auth config, invite gate hook, field guards, reserved names
│     ├─ src/config/             env schema (zod), fail-fast loading
│     ├─ src/lib/                logger, errors, ids, time (injectable clock), rate-limit, client-ip
│     ├─ evals/                  Agent eval datasets + runner
│     └─ test/                   integration, realtime, security regression, factories
├─ packages/
│  ├─ contracts/                 zod schemas: REST DTOs, WS events, error codes, limits, reserved names
│  └─ db/                        Drizzle schema, migrations, seed, client factory
├─ infra/
│  ├─ compose.dev.yml            postgres, valkey, garage, mailpit
│  ├─ compose.edge.yml           (M2b) Nginx container serving a production build with the real site config
│  ├─ compose.prod.yml           (M7) api, worker, postgres, valkey, garage
│  ├─ garage/                    garage.toml template + bootstrap script
│  ├─ nginx/                     (M2b) chatapp.conf + security-header snippet, shared by edge, rehearsal and prod
│  └─ load/                      (M7) k6 scripts
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
  - `domain/` 不知道 HTTP 和 WebSocket 的存在，只接收"当前用户 + 参数"，返回结果和待发布的事件，或抛出领域错误。
- **Bun 专有 API 的边界**（D-055）：Bun 专有的 API 只能出现在三处：`packages/db` 的客户端工厂、`realtime/hub`、`storage/`。
- **检查方式**：用 Biome 的 `noRestrictedImports`（按目录覆盖配置），或在 `guard` 脚本里检查，不引入依赖 TypeScript 编程接口的工具。

## 4. 进程与端口

| 进程 | 开发环境 | 生产环境 |
|---|---|---|
| web | Vite 开发服务器 :5173，把 `/api` 和 `/ws` 代理到 :3100（前后端同源，Cookie 才能正常工作） | 静态文件，由宿主机 Nginx 提供 |
| api | `bun --watch src/api.ts` :3100 | 容器，绑定 `127.0.0.1:3100` |
| worker | `bun --watch src/worker.ts` | 与 api 同一个镜像，只是启动命令不同。向量计算在 worker 里进行；如果 Bun 与 onnxruntime 不兼容（V-12），改为同一镜像里单独的 Node 进程 |
| edge（M2b 起） | Nginx 容器，`https://chat.localhost:8443`，加载生产站点配置，服务一次构建产物，用于 CSP 测试和彩排 | 宿主机 Nginx，配置文件相同 |
| postgres | 容器，宿主机端口 **5434**（本机 5432 已被原生 PostgreSQL 占用） | 仅容器内网 |
| valkey | 容器，宿主机端口 6379 | 仅容器内网 |
| garage | 容器，S3 接口 :3900，管理接口 :3903 | 仅容器内网 |
| mailpit | 容器；SMTP 用宿主机 **2525** 端口（映射到容器内 1025，因为本机 1025 被 VPN 占用），网页界面 :8025 | 不部署，改用 Resend |

## 5. 关键流程

### 5.1 发送消息
1. 客户端生成一个 `clientId`（UUIDv7），先把消息以"发送中"的状态显示出来。
2. 客户端调用 `POST /api/conversations/:id/messages`，请求体为 `{clientId, body, attachmentIds, replyToId}`。
3. api 依次检查：
   - 校验会话、限流；
   - 调用 `authorize(user, conv, 'message.send')`：是否为成员、是否被禁言、会话是否已归档；
   - 用 zod 校验正文长度和附件归属；
   - 被回复的消息必须在同一会话，而且发送者能看到它。
4. 在一个事务里依次完成：
   - `UPDATE conversations SET last_seq = last_seq + 1, last_change_seq = last_change_seq + 1, last_message_at = now() WHERE id = $1 RETURNING last_seq, last_change_seq`；
   - 插入消息，`seq` 和 `change_seq` 取上一步返回的值；
   - 把附件绑定到这条消息；
   - 写入 @提及；
   - 把发送者的 `last_read_seq` 推进到这个 seq。
5. 如果 `(sender_id, client_id)` 发生唯一约束冲突，说明是重试，直接返回已有的那条消息，状态码 200。
6. 事务提交后发布 `message.created` 事件，频道是 `conv:{id}`。新消息的 seq 比所有现有成员的 `visible_from_seq` 都大，所以总是带完整内容。
7. 如果消息 @了 Agent，就创建一个 agent run 并放入队列；M6 起还要给相关用户排推送任务（跳过正在看这个会话的用户）。
8. 返回 201 和消息内容。客户端用 `clientId` 把"发送中"的那条替换成正式消息。

编辑消息不会重新触发 Agent，也不产生新的通知。

### 5.2 补发与跳号检测
1. **重连后**：WebSocket 重连成功，服务端发来 `hello`。客户端立刻调用 `GET /api/conversations`，拿到每个会话的 `lastSeq`、`lastChangeSeq`、`visibleFromSeq` 和未读数。
2. **拉取变化**：对当前打开的会话，以及本地有缓存的会话，调用 `GET /api/conversations/:id/changes?sinceChangeSeq=X&hiddenSince=T`，分页拉取以下内容，逐条合并到本地缓存：
   - 所有 `change_seq > X`、而且我能看到的消息（新消息和被修改的都包括在内）；
   - 这段时间里我隐藏的消息 id。
3. **缺口太大**：接口返回 `resetRequired`（缺口超过 1000 条变更）时，丢弃这个会话的缓存，重新加载最新的一页。
4. **合并规则**：补发期间收到的实时事件先放进缓冲区。所有合并都按消息 `id` 进行，并且只接受 `change_seq` 更大的版本，重复或乱序都不影响结果。
5. **没有缓存的会话**：等用户打开时再加载，不在重连时拉取。
6. **连接没断时的跳号检测**（D-043）：
   - 客户端为每个会话记住已知的最大 `changeSeq`。
   - 收到的事件如果跳号，1 秒后仍未补上，就对这个会话执行第 2 步。
   - 收到 `message.changed` 时，随机延迟 0–2 秒后执行第 2 步，同一会话的多次通知合并成一次。
7. **回到前台时**：页面重新回到前台，做一次轻量对账（`GET /api/conversations`）。

### 5.3 编辑、撤回、删除
- **编辑和撤回**：在同一个事务里给 `last_change_seq` 加 1，更新消息，并把消息的 `change_seq` 设为新值。提交后按以下规则广播：
  - 消息的 `seq > conversations.last_join_seq`：发布带内容的 `message.updated`；
  - 否则：只发布不含内容的 `message.changed`，因为有成员看不到这条消息（INV-12）。
- **撤回的额外处理**：
  - 服务端判断时限时留 5 秒宽限；
  - 把 `body` 置空，删除 @提及，把附件标记为待删除，并在同一事务里减回存储用量；
  - worker 随后删除存储里的文件，并清除这条消息的向量。
- **仅自己删除**：只写入 `message_hidden` 表，并通过 `user:{me}` 同步到我的其他设备，其他人不受影响。离线的设备在补发时拿到。
- **客户端连带更新**：更新本地所有引用这条消息的回复，以及会话列表的预览。

### 5.4 上传
1. 客户端用 XHR 调用 `POST /api/uploads`（multipart，单个文件），这样能显示上传进度。
2. api 边接收边处理：
   - 按请求大小先原子地占用存储空间（`UPDATE users … WHERE storage_used_bytes + $size <= 配额`），超出直接拒绝；
   - 边接收边校验大小，把流写入存储；
   - 用文件开头的字节判断真实类型，再计算 sha256。
3. 创建 `attachments` 记录，状态为 `processing`。
4. worker 的 `media` 队列处理：
   - **图片**：按方向信息旋转 → 重新编码去除 EXIF → 生成缩略图和预览图 → 计算 thumbhash；
   - **视频**：用 `ffmpeg -map_metadata -1 -c copy` 重新封装，去掉位置等元数据；失败时改为 `file` 类型，只能下载；
   - **其他类型**：直接就是 `ready`；
   - 处理完成后，把状态改为 `ready`。
5. 处理完成后，通过 `user:{uploader}` 推送 `attachment.updated`。
6. 发送消息时带上 `attachmentIds`。服务端会检查：附件属于发送者本人、还没有绑定到其他消息、状态是 `ready`。
7. **下载**：按 `purpose` 鉴权（INV-09）：
   - 消息附件：跟随消息的可见性；
   - 用户头像：所有登录成员都能下载；
   - 会话头像：跟随会话的可见性。

### 5.5 Agent 运行
详见 [06-agent.md](06-agent.md)，这里只列骨架：
1. 触发 run 有四种方式：`POST /api/agent/runs`、消息里 @Agent、定时提醒、重新生成。
2. api 先检查并发和预算（预算只针对站点 key），然后在 `agent_runs` 里插入一条状态为 `queued` 的记录，放入 `agent` 队列。
3. worker 选定 key，把 run 标记为 `running`，构建上下文，再用 `ToolLoopAgent` 流式执行：
   - 文本增量合并后通过 `agent.delta` 推给前端；
   - 每一步写入 `agent_steps`（摘要）和 `agent_run_states`（完整内容），并推送 `agent.step` 事件；
   - 副作用工具通过 `agent_effects` 保证恰好执行一次；
   - 遇到需要审批的工具时，把当前消息收尾，状态存进数据库，run 改为 `awaiting_approval`，推送审批请求，本次任务到此结束；
   - 用户批准后，放入一个新任务，从 `agent_run_states` 恢复，输出写进一条新消息。
4. 对账任务负责把卡住的 run 重新放入队列（06 第 5.2 节第 9 步）。

### 5.6 在线状态
1. **建立连接**：WebSocket 建立后，在 Valkey 中写入两份数据：
   - `presence:conn:{connectionId}`：一个 hash，记录 userId、所在实例、活跃状态、过期时间；
   - `presence:conns:{userId}`：一个有序集合，成员是连接 id，分数是过期时间。
2. **续期**：心跳每 25 秒续期一次；`presence.activity` 更新这个连接的活跃状态。
3. **汇总**：
   - 任意一个连接活跃，用户就是"在线"；
   - 有连接但都不活跃，是"离开"；
   - 没有连接，是"离线"。
   - 状态变化时，发布到 `presence:{userId}`。
4. **清理**：worker 每 30 秒扫描一次过期的连接，比如 api 进程崩溃后留下的，并发布离线状态。
5. **最后在线时间**：用户的最后一个连接消失时，写入 `users.last_seen_at`。
6. **订阅**：客户端通过 `presence.watch` 声明自己关心哪些用户。服务端把这个连接订阅到那些用户的频道上，并立即回一条 `presence.snapshot`。

### 5.7 加入会话
事务内容见 04 第 2 节"加入会话"：
1. 检查封禁；
2. 把 `last_join_seq` 设为当前的 `last_seq`；
3. 新成员的 `visible_from_seq` 和 `last_read_seq` 也取这个值。

提交后：
- 向新成员的 `user:*` 发 `conversation.created`；
- 向 `conv:*` 发 `member.joined`；
- 网关把新成员的连接订阅到这个会话。

### 5.8 登录会话失效
1. 以下操作完成后，发布内部事件 `session.revoked`，内容为 `{sessionIds}` 或 `{userId}`：
   - 退出登录；
   - 注销其他设备；
   - 修改密码：同时注销其他所有会话；
   - 通过邮件重置密码：注销全部会话；
   - 账号被封禁。
2. 每个 api 实例查本机的连接表，把属于这些会话的连接以 4401 关闭，并删除这些会话的推送订阅（M6）。
3. 兜底：网关每 5 分钟复核一次每个连接的会话是否仍然有效（D-038）。
4. 不开启 Better Auth 的 `cookieCache`。开启后，已注销的会话在缓存有效期内，仍能通过 HTTP 接口的校验。

## 6. 实时设计

**频道（topic）**
- `user:{userId}`：发给个人的事件。包括会话列表变化、成员变化、已读同步、隐藏消息、审批请求、run 状态、通知。
- `conv:{conversationId}`：会话内的事件。包括消息的新增和变更、正在输入、Agent 流式输出、成员变化。
- `presence:{userId}`：某个用户的在线状态。

**订阅规则**
- 连接建立时，服务端查询该用户的全部成员关系，把连接订阅到 `user:{me}` 和每一个 `conv:{id}`。
- 之后成员关系变化时（加入、被移出、被封禁），由 `user:{me}` 上的事件触发动态订阅或退订。
- 客户端**不能**自己订阅会话频道。
- **已知并接受的窗口**：成员被移出后，网关收到事件再退订，中间有毫秒级的间隔。这段时间里发布的事件，仍可能送到被移出者的连接。之后的补发和读取都会按新的成员关系拒绝。

**不泄露加入前的内容**（INV-12）
- 新消息对所有现有成员都可见，可以直接广播内容。
- 更新和流式增量只在消息的 `seq > last_join_seq` 时才带内容；否则只广播 `message.changed`，客户端通过 HTTP 按自己的权限补拉。

**事件总线**
- api 和 worker 把事件 `{topic, event}` 发布到 Valkey 的 `events:{APP_ENV}` 频道。频道名里带环境，是因为 Valkey 的 pub/sub 不区分 db 编号（D-044）。
- 每个 api 实例都订阅这个频道，收到后通过 `realtime/hub` 转发给本机订阅了该 topic 的连接。hub 底层使用 Bun 的 `server.publish(topic, payload)`。
- 这样天然支持多个 api 实例同时运行。

**连接管理**
- 心跳：服务端每 25 秒发一次 ping；60 秒收不到 pong 就断开连接，关闭码 4408。
- 每个用户最多 10 个连接，超出时关闭最早的那个。
- 每个连接记下 sessionId 和最近一次 `focus` 上报。推送任务据此判断"用户是否正在前台查看这个会话"。

## 7. 后台任务（BullMQ 队列）

| 队列 | 任务 | 并发 | 重试 |
|---|---|---|---|
| `agent` | Agent 运行和续跑 | 4 | 模型调用出错时指数退避重试 2 次；副作用由 `agent_effects` 保证恰好一次 |
| `media` | 图片处理、视频重新封装、头像裁剪 | 2（服务器只有 2 个 CPU 核心） | 3 次 |
| `push`（M6） | Web Push 推送 | 8 | 3 次；推送地址返回 410 时删除该订阅 |
| `email` | 验证邮件、重置密码邮件 | 2 | 5 次 |
| `cleanup` | 每小时：孤儿附件、已撤回消息的文件、过期的邀请占用；每天：未验证账号（7 天）、Agent 运行内容（30 天）、通知（90 天） | 1 | 定时执行 |
| `reconcile` | 每分钟：把即将到点的定时消息和提醒放入队列（以实体 id 作为任务 id 去重）、处理过期审批、重新放入卡住的 run；worker 另每 30 秒清理过期的在线连接 | 1 | 定时执行 |
| `scheduled`（M5a） | 执行到点的定时提醒、定时消息 | 2 | 3 次；发送前再检查权限 |
| `embeddings`（M5b） | 为消息和记忆计算向量 | 1 | 3 次 |

- **Valkey 配置**：必须设置 `maxmemory-policy noeviction`，这是 BullMQ 的要求，否则内存满时队列数据会被淘汰；同时开启 AOF 持久化。
- **任务保留**：所有队列统一设置——已完成的任务保留 1 天或最近 1000 条，失败的保留 7 天。
- **内存告警**：Valkey 内存用到 `maxmemory` 的 80% 时，通知站点管理员（D-044）。

## 8. 配置（环境变量）

- 用 zod 在启动时校验所有环境变量，缺失或非法就立即退出。
- 生产环境下，如果密钥太短或仍是示例值，拒绝启动；如果测试专用接口被启用，也拒绝启动（SEC-29）。
- 仓库里提交 `.env.example`；真实值写在 `.env.local` 里，这个文件已加入 `.gitignore`。标"M1a 新增"等的变量，在对应里程碑加入 `.env.example` 和 zod schema。

| 变量 | 示例（开发） | 说明 |
|---|---|---|
| `APP_ENV` | `development` | development、test、production 三选一；也用作事件频道名的后缀 |
| `APP_ORIGIN` | `http://localhost:5173` | 同源校验、Cookie、Passkey 的 RP ID 都依赖它 |
| `APP_TIMEZONE` | `Asia/Shanghai` | 业务时区：每日额度重置、月度预算（M1a 新增，D-049） |
| `API_PORT` | `3100` | |
| `TRUSTED_PROXIES` | `127.0.0.1,::1` | 只信任这些地址转发的客户端 IP 头（M1a 新增，SEC-28） |
| `DATABASE_URL` | `postgres://chatapp:…@localhost:5434/chatapp` | 生产环境里应用用普通账号，迁移用拥有者账号 |
| `VALKEY_URL` | `redis://localhost:6379` | |
| `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` | `http://localhost:3900` / `garage` / `chatapp` | |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | 由 setup 脚本生成 | |
| `BETTER_AUTH_SECRET` | 由 setup 脚本生成 | ≥ 32 字节随机值 |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM` | `localhost` / `2525` / 空 / 空 / `ChatApp <noreply@chatapp.localhost>` | |
| `DEEPSEEK_API_KEY` | **用户自己填写** | 站点 key；不能出现在聊天记录和日志里 |
| `AI_PROVIDER` | `deepseek` | `deepseek` 或 `mock`；测试时用 `mock`（M4 新增） |
| `AI_MODEL_FAST` / `AI_MODEL_DEEP` | `deepseek-flash` / `deepseek-flash` | 模型名做成可配置项。当前两种模式都用 V4.1-Flash，深度模式开启思考（D-031） |
| `AI_USER_DAILY_TOKENS` / `AI_MONTHLY_BUDGET_USD` | `500000` / `20` | 只是初始值，之后以后台设置为准 |
| `AI_PRICE_*` | 按 DeepSeek 当前价格填写 | 用于估算费用 |
| `AI_KEY_ENCRYPTION_KEY` | 由 setup 脚本生成（M5a 加入） | 32 字节，加密用户自带的 key；丢失后用户需要重新填写 key |
| `PRODUCT_NAME` / `AGENT_DISPLAY_NAME` / `AGENT_USERNAME` | `ChatApp` / `助手` / `assistant` | |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | M6 生成 | |
| `SENTRY_DSN` | 空（M7） | 为空时不上报 |
| `LOG_LEVEL` | `info` | |
| `SEED_DEMO_PASSWORD` | 由 setup 脚本生成 | 仅开发环境，演示账号的密码 |

## 9. 错误处理、日志与可观测性

- **错误格式**：统一为 `{ error: { code, message, details?, requestId } }`，错误码定义在 `packages/contracts/errors.ts`（见 05）。`message` 是给开发者看的英文说明，界面文字由客户端按 `code` 本地化。
- **5xx 错误**：只返回错误码和请求 id，不暴露堆栈和内部信息。
- **日志**：用 pino 输出 JSON，每条日志带 `requestId`、`userId`、`conversationId`、`runId`。
  - **不记录**：消息正文、AI 的提示词和输出、密码、令牌、Cookie、API key（包括用户自带的 key）。
  - Agent 每一步的详细内容只存在 `agent_steps` 和 `agent_run_states` 里：
    - 本人可以查看；
    - 站点 key 的运行，站点管理员也可以查看，每次都写审计日志；
    - 自带 key 的运行，管理员只能看元数据；
    - 内容 30 天后清除。
- **客户端 IP**：只取 `TRUSTED_PROXIES` 写入的头，日志和限流都用它。
- **健康检查**：`/api/healthz` 表示进程存活；`/api/readyz` 检查数据库、Valkey、S3 是否都可用，对外只返回 200 或 503。
- **M7 起**：
  - 前后端接入 Sentry，前端经 `/api/monitoring` 转发，不开会话回放，上报前过滤正文；
  - AI SDK 的遥测不记录输入和输出（D-046）；
  - OpenTelemetry 推迟到 v1.1。

## 10. 性能设计

- **消息查询**只走 `(conversation_id, seq)` 和 `(conversation_id, change_seq)` 两个索引，分页每页 50 条。
- **会话列表**一次查询返回：未读数（`last_seq - last_read_seq`）、最后一条消息的预览、私信对方的资料，避免 N+1 查询。
- **前端**
  - 时间线用虚拟列表，在内存里保留最近 2000 条消息，更早的按需加载。
  - 图片先用 thumbhash 显示占位，缩略图懒加载。
  - 路由自动分割代码；React Compiler 自动做 memo 优化；Shiki 的语言包按需加载。
- **服务端**
  - 从数据库连接池取连接时，每个请求最多占用 1 个连接。未读数等计算都在 SQL 里完成。
  - Agent 的文本增量每 50–100 毫秒合并发送一次，减少事件数量。
  - `message.changed` 触发的补拉由客户端随机延迟，避免同时涌入。

## 11. 前端架构要点

- **服务端数据**：全部由 TanStack Query 管理。WebSocket 收到事件后直接修改 Query 缓存（`setQueryData`），不再重新请求。
- **消息缓存**：每个会话一份分页缓存，按 `seq` 排序，合并时以消息 id 去重，并以 `change_seq` 大的版本为准。
- **乐观更新**：发送、编辑、撤回都先更新界面，失败再回滚；未发出的消息用 `clientId` 标识。
- **一致性**：
  - 按会话检测 `changeSeq` 跳号（第 5.2 节）；
  - 收到消息更新时，同时更新引用它的回复和会话预览；
  - 收到 `conversation.removed` 时，删除该会话的本地缓存。
- **全局状态**（zustand）：当前会话、Inspector 是否打开、输入框草稿（按会话保存，M6 起持久化到 IndexedDB）、外观设置。
- **WebSocket 客户端**：
  - 单例；
  - 断线后按指数退避重连（1、2、4、8 秒，最长 30 秒，带随机抖动），每次重连都执行第 5.2 节的补发流程；
  - 用 `hello.serverTime` 校正本地时钟，撤回按钮等时限判断以校正后的时间为准；
  - 切换会话、页面前后台变化时，上报 `focus`。
- **输入法**：组字期间（`isComposing` 为 true，或 `keyCode` 为 229）回车不发送（D-050）。
- **退出登录或收到 4401**：清空 Query 缓存、IndexedDB 中的消息和草稿、Service Worker 缓存，并删除本设备的推送订阅（M6）。
- **表单**：每个输入框使用 contracts 里的同一份 zod schema，前后端校验规则保持一致。
