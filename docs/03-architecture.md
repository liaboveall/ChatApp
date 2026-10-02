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
2. **只有 domain 层有业务逻辑。** HTTP 路由、WebSocket 网关、Agent 工具、后台任务都只是很薄的一层，直接调用 domain 里的服务。权限策略集中在 `authorize()`；事务内的调用持有业务锁，查询和投影也必须复用策略。
3. **业务与工作意图同事务持久化**（D-056）：写业务、同步日志、`work_items` 后再由 dispatcher 派发。Pub/Sub 仅作唤醒；队列可重建；消费者业务去重；前台每 30 秒对账补尾事件。
4. **慢活交给后台。** AI、推送、邮件和调度由 worker 执行；媒体解码由独立无网络 media 容器执行，worker 只编排和存取对象（D-081），不阻塞 api。
5. **Postgres 是在线业务事实来源。** 队列和缓存可重建；M7 的删除意图另有异地 journal 保障灾难恢复（D-084）。在线状态重新汇总，丢失的限流计数保守收紧，不声称精确恢复瞬态数据。
6. **基础消息可见性统一：** 当前成员且 seq > visible_from_seq；有效 session、账号状态、删除状态另外检查。引用和预览逐项投影；共享 Agent 采用全体成员共同可见范围。HTTP、WS、搜索、工具、附件复用 domain 策略。

## 2. 技术栈与版本

以下版本于 2026-09-30 在 npm、Docker Hub、endoflife.date 上核实。**M1a 开工时要再核对一次**，锁定当时的最新稳定版（精确版本加锁文件）。原则上不用 beta 或 RC，例外会在表中注明。M1a 已于 2026-10-01 核对并锁定，见 D-104。

### 2.1 运行时与后端

| 用途 | 选型 | 版本 |
|---|---|---|
| 语言 | TypeScript（Go 原生编译器） | 7.0.2 |
| 运行时、包管理、后端测试 | Bun | 1.4.2 |
| Web 框架 | Hono（路由与中间件；WebSocket 升级由 `runtime/server.ts` 直接用 `Bun.serve` 处理） | 4.13.12 |
| OpenAPI | `@hono/zod-openapi` | 1.6.3 |
| 运行时校验、前后端契约 | zod | 4.6.5 |
| ORM 与迁移 | drizzle-orm / drizzle-kit，驱动用 `drizzle-orm/bun-sql` | 0.45.3 / 0.31.11（1.0 仍是 RC，D-104；GA 后另开决策迁移） |
| 认证 | better-auth + `@better-auth/passkey` | 1.7.7 |
| 队列与 Valkey 客户端 | bullmq + ioredis（应用里所有 Valkey 访问统一用 ioredis，D-044） | 6.3.11 / 6.0.0 |
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
| API 文档界面（仅开发环境） | `@scalar/hono-api-reference` | 0.12.8 |

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
│     ├─ src/auth/               Better Auth config, route allowlist, registration adapter/state, field guards
│     ├─ src/runtime/            Bun adapters: ids, server (Bun.serve + WebSocket binding), process/IPC; injected into auth/domain
│     ├─ src/startup.ts · health.ts   start-up self-checks (bootstrap, unprivileged role), readiness probe
│     ├─ src/config/             env schema (zod), fail-fast loading
│     ├─ src/lib/                logger, errors, ids, time (injectable clock), rate-limit, client-ip
│     ├─ evals/                  Agent eval datasets + runner
│     └─ test/                   integration, realtime, security, contract snapshots, fault (isolated instance only), support
├─ packages/
│  ├─ contracts/                 zod schemas: REST DTOs, WS events, error codes, limits, reserved names
│  └─ db/                        Drizzle schema, migrations, bootstrap, dev seed, client factory
├─ infra/
│  ├─ compose.dev.yml            postgres, valkey, garage, mailpit
│  ├─ compose.test.yml           (M1a) isolated per-run services, volumes, network and credentials
│  ├─ compose.media.yml          (M3) network-free media service + private Unix socket
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
  - `domain/` 不知道 HTTP 和 WebSocket 的存在，只接收服务端构造的 Principal 和参数（第5.9节），在事务中写业务、日志和工作意图后返回结果，或抛出领域错误；不接受裸 userId 冒充授权。
- **Bun 专有 API 的边界**（D-090）：只允许 `packages/db` 客户端工厂、`realtime/hub`、`storage/`、`runtime/` 及 api.ts/worker.ts/cli.ts 组装入口；脚本和测试框架单列例外。UUID 工厂由 runtime/ids 注入认证 adapter。domain/contracts 不引用 Bun；更换运行时须替换全部适配器并重跑集成验收。
- **检查方式**：用 Biome 的 `noRestrictedImports`（按目录覆盖配置），或在 `guard` 脚本里检查，不引入依赖 TypeScript 编程接口的工具。

## 4. 进程与端口

| 进程 | 开发环境 | 生产环境 |
|---|---|---|
| web | Vite 开发服务器 :5173，把 `/api` 和 `/ws` 代理到 :3100（前后端同源，Cookie 才能正常工作） | 静态文件，由宿主机 Nginx 提供 |
| api | `bun --watch src/api.ts` :3100 | 容器，绑定 `127.0.0.1:3100` |
| worker | M1a宿主机热重载；M3起Linux容器热重载，以便和media共享Unix socket | 与api同server镜像；1536MiB。向量若不兼容Bun（V-12），在本容器内用Node子进程，仍受总预算 |
| media（M3） | Linux 容器，network_mode=none，无TCP端口 | 独立镜像；仅私有Unix socket，512 MiB上限；不挂应用密钥或对象卷 |
| edge（M2b 起） | Nginx 容器，`https://chat.localhost:8443`，加载生产站点配置，服务一次构建产物，用于 CSP 测试和彩排 | 宿主机 Nginx，配置文件相同 |
| postgres | 容器，宿主机端口 **5434**（Windows 主机的 5432 已被原生 PostgreSQL 占用） | 仅容器内网 |
| valkey | 容器，宿主机端口 6379 | 仅容器内网 |
| garage | 容器，S3 接口 :3900，管理接口 :3903 | 仅容器内网 |
| mailpit | 容器；SMTP 从 `SMTP_PORT` 读取（默认 2525，本机 12525），映射到容器内 1025；网页 :8025 | 不部署，改用 Resend |

## 5. 关键流程

### 5.1 发送消息及事务边界
1. 客户端生成稳定 clientId 并乐观显示。API 做格式、会话、限流检查，这些不是最终授权。
2. 事务按统一顺序锁涉及的用户（UUID排序）→ 身份/注册行（origin、session、delegation、registration、challenge按固定表序与id排序）→ 会话（UUID排序）→ 成员/任务/run/其他业务行；封禁、注销和写入共用顺序。未创建的注册按邀请人/邀请码/registration排序，首次关联账号后统一用户优先，具体锁矩阵在V-13验证。死锁有限重试，不能先返回成功。
3. 锁内按 SessionPrincipal 或 DelegatedPrincipal 复核凭据及账号、成员、禁言、归档、回复可见性、附件归属及配额。分配seq/change_seq，插入消息和提及、绑定附件。只有可信 interactive 入口推进人的已读；Agent/调度/提醒/系统与 offline_replay 均不推进。版本、conversation_changes、必要的 user_changes 同事务写入。
4. 同一事务插入去重的 work_items（实时提示、通知派生、向量处理）；@Agent 时同事务创建 queued run 或可解释的 failed run 以及工作意图。额度不足不回滚用户消息，失败原因只给调用者。M3/M4/M6 各阶段启用对应工作类型。
5. clientId 冲突时核对发送者、目标会话和请求哈希；相同请求重新鉴权后返回原消息，不同请求 409。事务提交才返回 201；dispatcher 后续发不含正文的 message.changed。

编辑不再次触发 Agent 或通知，但必须产生版本、同步日志、向量更新意图，并使引用和预览重新投影。

### 5.2 补发、固定上界与尾事件对账
- Postgres 的 conversation_changes 是只含实体 id、操作和 change_seq 的追加日志；user_changes 记录成员增删、隐藏、已读、设置、通知等个人状态变更。日志保留 7 天，不保存旧正文。
- 客户端分别记录 observed（收到提示的最大值）和 synced（已完整消费日志的水位）。收到提示只调度补拉，不能把 observed 直接当作 synced。
- 首次请求固定through；签名游标绑定actor、auth_epoch、restore_epoch、conversation、membership_id、after、through及过期时间。按日志序号扫描，过滤空页也推进scannedThrough；只有末页才把synced提到through。恢复/授权世代改变拒绝旧游标。
- 每页读取实体的当前授权投影，允许返回比 through 更新的实体版本；它不推进日志水位。实体合并只接收更新版本，流式另比较 streamRevision。不存在/已删实体返回墓碑，引用不可见时不带 sender、seq、摘要或附件。
- 用户资料、会话metadata、本人关系/设置、通知和附件各有05规定的实体版本。移出墓碑保存在 user_conversation_states；重新加入有新membership和更大的viewerVersion。预览依赖消息与本人投影的复合版本，不比较更新时间，不把through当实体版本。
- 日志已过期、成员世代变化、缺口超过 1000 条时返回 resetRequired。客户端清掉对应缓存，使用一致性读取的会话详情、最新页及 baseline 水位重建，再从 baseline 补变化；禁止先取水位后用不一致旧快照覆盖。
- 重连、回前台立即对账；前台每 30 秒查询轻量 sync-heads（带抖动）。当前会话和有缓存的会话补拉；无缓存的按需加载。正常依赖下尾事件丢失 35 秒内收敛；后台节流/离线不计入此目标，显示离线或未同步。
- 新提示合并，补拉并发最多 2，同一会话最多 1；补拉期间的更高 observed 留待下一轮，不因旧请求完成而倒退水位。

### 5.3 编辑、撤回、删除
- 编辑使用 expectedChangeSeq；事务内重新授权，冲突返回 409，不静默覆盖他人的更新。正文变化增加 content_version 和 change_seq。
- 撤回/管理删除在同事务清空正文、提及和向量，附件进入 deleting，释放用户计费字节，写同步日志和对象删除工作。API 立即拒绝附件读取，物理删除目标 1 小时、最长 24 小时；不在请求事务里等待 S3。
- 仅自己删除写 message_hidden 与 user_changes；这是视图偏好，不撤销该用户已有内容授权。离线恢复用个人序号，不用 hiddenSince 时间戳。
- DTO 每次重建 replyTo、会话预览；客户端使被引用项和最后消息预览失效后补拉。所有副本与清理截止规则见 04 第 10 节。
- M7 发布前接入D-084：删除/撤回先准备并冻结目标，异地 journal 确认后才执行上述清空事务并返回成功；超时返回202操作状态，UI不假装删除完成。journaled 的删除不因session失效丢弃；清理和恢复复用同一幂等操作。已确认的删除不能被备份屏障拖回可读状态。

### 5.4 上传与对象恢复
1. 客户端先 POST /uploads/reservations，带 purpose、声明大小和 Idempotency-Key；无可靠长度时预占该类型上限。事务插入 attachments(uploading)、upload_reservations 和临时 object 记录。用户预占主文件上限，站点另外预占处理峰值（原始输入 + 输出上限 + 衍生图上限，衍生图默认合计不超过 10 MiB），不能把一份用户计费空间当成原始与处理后对象同时存在的磁盘空间。没有持久身份不接收大流。
2. PUT /uploads/:id/content 接收单文件流，令牌/归属、实际字节、魔数、截止时间均校验。实际接收不得超过 reservation.maxBytes/已预占字节，声明偏小则中止，不能继续写入未预占空间；续租和写入代次也必须有效。写随机且不可覆盖的 staging key；中断、取消、重复请求都定位到同一 reservation。重复已完整上传直接返回状态，内容哈希不同返回 409。
3. 完成后条件更新 uploaded → processing，并同事务写 media 工作。worker 读取固定 generation，经私有IPC交给独立 media 容器处理；输出写入该 generation 的新 key，校验成功后才在事务内切换附件对象引用为 ready。旧 generation 不能发布。
4. 记录 raw_size_bytes、size_bytes（处理后主文件）、charged_bytes（等于主文件大小）、各衍生对象大小/hash。输出增大需补占配额，失败则失败清理；成功把 reserved 转为 used。衍生文件不计用户额度，但计全站实际容量。
5. 绑定前检查 ready、用途、上传者和未被占用；头像必须在所属用户/会话字段中成为当前有效绑定。消息删除不会把附件变成“未发送、上传者又可读”，deleting 状态优先拒绝。
6. 独立对账扫描过期 reservation、对象账本、失败 generation 和未完成删除；物理删除成功后才释放全站实际字节。未知孤儿 key 经两次清单扫描和 24 小时宽限删除，备份屏障期间暂停。不能以数据库回滚代替对象补偿。

媒体默认并发 1；静态图最多 40MP、单边 16384px；动画最多 200 帧且累计 100MP；音视频元数据解析最多 30 分钟时长；每任务 60 秒、子进程内存 512 MiB、输出主文件仍受该类型上限。无网络、非 root、临时目录 256 MiB，超时/OOM 杀进程且失败回收，不无限重试恶意样例。视频元数据清理失败不内嵌，下载时明确“元数据未清理”。参数在 M3 的真实样例和 ARM 实验中收紧或有据调整。

**隔离实施（D-081、V-18）**：media 固定容器 network_mode=none、非root、只读根文件系统、cap_drop=ALL、no-new-privileges、默认seccomp、pids_limit=64、mem_limit=memswap_limit=512MiB。唯一可写数据区为合计256MiB的tmpfs（计入512MiB）；只共享Unix socket目录，不共享文件对象/主机路径/业务密钥。worker以白名单协议传jobId、generation、nonce、操作枚举、大小受限字节，media返回有上限的元数据/文件；不接受shell命令、URL或路径。

media单任务执行，60秒到期终止整个进程组；OOM/重启由generation租约恢复，结果必须经worker核对nonce、大小、hash、允许变体和当前generation。每任务清除临时文件；故障后未清理成功不得接下一任务。ffmpeg输入协议仅file/pipe，媒体进程环境只有必要的locale/临时目录变量；任何业务API key/DB/S3密码都不传入。worker=1536MiB加media=512MiB仍是后台2GiB总预算，媒体tmpfs也计入；向量任务仅在足够余量时准入。不得给worker挂Docker socket来创建任意容器；独立Compose编排负责启动固定服务。

### 5.5 Agent 运行
- run、resume_seq、执行租约、取消、审批和预算均以 Postgres 为准；06 第 5、7、8 节定义状态转换、上下文和调用预占。
- 工作 id 区分续跑和重新投递，业务效果 id 保持稳定；创建每段输出与 run_outputs 的唯一键同事务。
- 每步和每次流式发布都复核当前 lease_epoch、取消及来源版本，旧 worker 不得覆盖新状态。共享输出在成员变化后立即停止继续提交；已生成内容的读取仍按该输出消息的 seq 授权。
- 不声称模型、邮件和外部推送恰好执行一次；未知模型调用保守计费并暂停自动续跑，避免无界重试。

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

### 5.7 加入、退出与授权世代
- 加入持有会话锁，检查封禁并原子设置 visible_from_seq、last_read_seq、随机 membership_id；推进 conversations.membership_version。重复加入不重置可见水位。
- 成员增加、移出、重新加入、角色/禁言变化、归档均推进权限版本，取消受影响的共享 Agent run，写 user_changes、成员提示和撤权 work_items。
- 退订事件用于迅速刷新 UI，不承担最终授权。网关每批内容派发查询当前 session 和成员，查询失败停止派发；事件总线重连先重新读取本机连接的授权。

### 5.8 登录会话失效
- 普通退出/到期只终止相关session及push绑定，不提升全账号auth_epoch；安全撤销按下表更新origin/epoch/委托并写持久撤销工作。改密保留当前session时，同事务刷新其epoch并换绑新的origin，旧origin仍撤销，避免新任务继承已撤销来源。认证适配须原子完成，不能靠事后hook撤权；独立扫描补齐关闭/取消通知。
- 不开启 cookieCache。普通 HTTP 每次查当前有效 session；授权查询开始在撤权提交之后时不得返回敏感内容。
- 网关收到撤销即 4401 关闭，兜底每 5 秒复核一次；查询超时或依赖不可用时停止敏感帧并以 1013 关闭。目标 5 秒内停止连接授权，调度容差在测试中明确为额外 1 秒。
- 已经授权并进入网络的响应无法收回；客户端缓存清理也不能当成服务端保障。

### 5.9 身份、设备与后台委托（D-079）

SessionPrincipal来自当前服务端session；DelegatedPrincipal从04的委托/来源记录加载，包含user、origin、账号auth_epoch、restore_epoch、目的、目标/参数哈希及期限；SystemPrincipal仅用于已列明的清理、对账、投递工作，不能任意指定用户冒充其发送。HTTP不能提交principal类型或委托内容。

| 操作 | 登录会话 | 未完成run/待审批 | 已提交提醒/定时消息 |
|---|---|---|---|
| 普通退出、自然过期 | 终止该session | 在有效委托期内继续，审批仍需新的本人有效session | 继续，执行时复核权限 |
| 明确撤销某设备 | 终止该origin的session | 撤销该origin委托并取消 | 取消该origin任务 |
| 注销其他设备 | 保留当前origin | 取消其他origin的任务 | 同左 |
| 安全注销全部设备 | 全部终止，auth_epoch+1 | 全部撤销 | 全部取消 |
| 修改密码 | 其他session终止，当前session更新epoch | 全部旧委托撤销 | 全部取消 |
| 重置密码、封禁、注销 | 全部终止，auth_epoch+1 | 全部撤销 | 全部取消，解封不恢复 |
| 灾难恢复 | 全部终止，restore_epoch更新 | 全部撤销，不自动恢复模型调用 | 隔离并默认取消，核对后只能重新授权 |
| 取消单个run | 不变 | 取消该run，拒绝待审批 | 已提交效果保留；独立任务列表可取消 |

每次模型准入、工具执行、输出/效果提交检查委托、当前账号及业务权限；撤销与提交锁内串行化。委托到期run取消，未来任务到点超过24小时failed；不能把期限续长来绕过重新授权。已发出外部调用的usage仍结算，禁止向失权接收者发布迟到内容。删除意图一经异地确认属于必须完成的维护动作，不受此表普通委托生命周期影响。

## 6. 实时设计

- topic 仍分 user、conv、presence；连接只能由服务端依据当前关系订阅。topic 是路由，不是授权凭证。
- 普通消息一律 message.changed，不携带消息正文、引用、发送者资料或附件地址。客户端合并通知后通过 HTTP 获取按本人权限投影的数据，消除“先提交后加入再广播”的竞态。
- user 事件中的 run、步骤、审批、附件等改为 id/版本提示；通过对应接口读取。成员变化与会话变化同样发失效提示，内容不直接复用给全部成员。
- Agent 文本增量是唯一敏感实时正文：每 50–100ms 合并一次，由 hub 批量查询当前 session、membership_id、消息可见性、run lease_epoch、context_epoch、源会话 membership_version 后逐连接发送；不使用 server.publish 盲播正文。每次真正 drain 发送前重查，丢弃过期授权队列。所有引用来源在运行中按 06 检验。
- 撤权提交前已完成授权的在途帧可能到达；不得把这种情况扩大成依赖“之后总会收到移出事件”。撤权后新授权批次一律拒绝。
- api/worker 通过 events:{APP_ENV} 发布工作提示；Pub/Sub 中断不损坏数据，恢复由数据库日志和工作表承担。typing、presence 可丢弃，不写 outbox，派发前也检查当前会话/登录权限。
- 25 秒心跳，60 秒无 pong 关闭；每用户最多 10 连接。每连接缓冲最多 256 KiB，慢连接以 1013 断开后补发，不积压敏感正文。focus 只抑制通知，不用于授权。

## 7. 后台任务与恢复

work_items 唯一 dedupe_key 与业务事务关联；payload 只存 id、版本和非敏感参数，不复制正文或凭据。需要邮件令牌时从受保护的 auth_challenges 投递密文读取，过期/撤销就作废。worker裸 user_id 不能授权，用户动作必须加载delegation。

| 类型 | 并发 | 恢复与去重 |
|---|---|---|
| realtime | 1 个 dispatcher 批处理 | 发布可重复；客户端靠版本合并，30 秒对账兜底 |
| agent | 最多 4、每用户最多 2 | 06 的租约和 attempt；awaiting_approval 不占 worker，但每用户未结束 run 总数最多 20 |
| media | 默认 1 | generation、对象账本及资源闸门；永久格式错误不重试 |
| push | 8 | 发送前复核权限，404/410 删除订阅；同通知/订阅唯一任务，网络未知可重复投递 |
| email | 2 | 最多 5 次，稳定 Message-ID；不承诺邮件仅投递一次；令牌过期作废 |
| scheduled | 2 | 锁定实体与权限，发送消息/写 sent/效果账本同事务 |
| embeddings | 1 | content_version + model_version 条件写回，旧结果丢弃 |
| cleanup | 1 | 以 durable cursor 和实体状态推进，失败重试并监测截止时间 |

- 正常路径在提交后 best-effort 唤醒 dispatcher，立即领取和派发；唤醒不保存业务事实，丢失时由每秒扫描兜底，不能让正常收发固定等待一秒。dispatcher 用 FOR UPDATE SKIP LOCKED 领取短租约；BullMQ jobId 为 workId-deliverySeq（无冒号）。派发不等于完成，消费者提交业务状态后才标 done。入队后崩溃可重复投递。
- 独立 worker 定时循环每分钟直接扫描 Postgres，修复过期租约、丢队列任务、过期注册/审批和到期调度；每次重投增加 delivery_seq，避免已保留的 completed job 阻止新投递。业务去重依靠表约束，而不是 BullMQ 的保留时间。
- 暂时故障最多按类型退避重试，达到上限进入 dead 并告警；人工重投保留原业务标识。运行结果未知的外部调用进入 uncertain，不无限重试。
- 准入上限初值：未执行 Agent 工作 100、媒体 1000、所有未完成 work_items 50000；达到类型上限拒绝该类新任务（503/Retry-After），达到总上限拒绝会新增可靠工作的写操作，读取、注销和清理仍保留。M7 用积压/恢复实测调整，不能任队列无限增长。
- Valkey 设置 noeviction、AOF；80% 内存告警。限流数据丢失时临时收紧准入，不能声称历史限流计数可精确恢复。业务任务、预算、权限均能从 Postgres 恢复。
- 队列只保留无正文标识：完成 1 天/1000 条，失败 7 天；数据库终态工作元数据保留 7 天，业务唯一键按其生命周期保留。清理不得删除仍用于防重复外部效果的待核对记录。

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
| `DATABASE_URL` | `postgres://chatapp_app:…@localhost:5434/chatapp` | 应用运行时的无特权账号（D-097） |
| `DATABASE_OWNER_URL` | `postgres://chatapp:…@localhost:5434/chatapp` | 拥有者账号：迁移、bootstrap、CLI 和测试清表；运行中的生产应用不持有它。测试环境读 `DATABASE_(OWNER_)URL_TEST` |
| `API_HOST` | `127.0.0.1` | API 监听接口；只有容器内才设为 `0.0.0.0` 并把端口只发布到 127.0.0.1 |
| `VALKEY_URL` | `redis://localhost:6379` | |
| `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` | `http://localhost:3900` / `garage` / `chatapp` | |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | 由 setup 脚本生成 | |
| `BETTER_AUTH_SECRET` | 由 setup 脚本生成 | ≥ 32 字节随机值 |
| `AUTH_TOKEN_ENCRYPTION_KEY` | M1a由setup生成 | 独立32字节密钥，仅加密待投递认证凭证，版本化轮换 |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM` | `localhost` / `12525`（模板默认 2525）/ 空 / 空 / `ChatApp <noreply@chatapp.localhost>` | |
| `DEEPSEEK_API_KEY` | **用户自己填写** | 站点 key；不能出现在聊天记录和日志里 |
| `AI_PROVIDER` | `deepseek` | `deepseek` 或 `mock`；测试时用 `mock`（M4 新增） |
| `AI_MODEL_FAST` / `AI_MODEL_DEEP` | `deepseek-flash` / `deepseek-flash` | 模型名做成可配置项。当前两种模式都用 V4.1-Flash，深度模式开启思考（D-031） |
| `AI_USER_DAILY_TOKENS` / `AI_MONTHLY_BUDGET_USD` | `500000` / `20` | 只是初始值，之后以后台设置为准 |
| `AI_PRICE_*` | 按 DeepSeek 当前价格填写 | 用于估算费用 |
| `AI_KEY_ENCRYPTION_KEY` | 由 setup 脚本生成（M5a 加入） | 32 字节，加密用户自带的 key；丢失后用户需要重新填写 key |
| `PRODUCT_NAME` / `AGENT_DISPLAY_NAME` / `AGENT_USERNAME` | `ChatApp` / `助手` / `assistant` | |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | M6 生成 | |
| `SENTRY_DSN` | 空（M7） | 为空时不上报 |
| `SITE_STORAGE_BUDGET_BYTES` | M3 新增；本地填写测试预算 | 生产必填，与磁盘/备份预留核对，不用总用户配额推导 |
| `RESTORE_MODE` / `RESTORE_EPOCH` | `isolated` / 独立随机世代 | epoch从M1a纳入认证/委托；M7隔离模式禁止外发，恢复不复用旧epoch |
| `DELETION_JOURNAL_*` | M7新增，生产必填 | 独立异地endpoint/bucket/凭据/加密密钥；不用应用Garage冒充异地，备份外保存恢复材料 |
| `LOG_LEVEL` | `info` | |
| `SEED_DEMO_PASSWORD` | 由 setup 脚本生成 | 仅开发环境，演示账号的密码 |

## 9. 错误处理、日志与可观测性

- **错误格式**：统一为 `{ error: { code, message, details?, requestId } }`，错误码定义在 `packages/contracts/errors.ts`（见 05）。`message` 是给开发者看的英文说明，界面文字由客户端按 `code` 本地化。
- **5xx 错误**：只返回错误码和请求 id，不暴露堆栈和内部信息。
- **日志**：pino按允许字段重建记录：服务端requestId、规范化route、method/status/duration及有需要的userId/conversationId/runId；不得序列化原始request/error对象。
  - **不记录**：消息正文、AI 的提示词和输出、密码、令牌、Cookie、API key（包括用户自带的 key）。
  - 原始URL、query、Referer、路径参数、User-Agent自由文本、请求/响应body、认证header、重定向Location不进入日志；未知route只记unknown。Nginx同样执行10的安全模板，不能依赖pino清另一层日志。
  - Agent 每一步的详细内容只存在 `agent_steps` 和 `agent_run_states` 里：
    - 本人可以查看；
    - 站点 key 的运行，站点管理员也可以查看，每次都写审计日志；
    - 自带 key 的运行，管理员只能看元数据；
    - 内容 30 天后清除。
- **客户端 IP**：只取 `TRUSTED_PROXIES` 写入的头，日志和限流都用它。
- **健康检查**：`/api/healthz` 表示进程存活；`/api/readyz` 检查数据库、Valkey、S3 是否都可用，对外只返回 200 或 503。
- **M7 起**：
  - 前后端接入 Sentry，前端经 `/api/monitoring` 转发，不开会话回放；beforeSend和breadcrumb过滤采用允许字段重建，服务端再次过滤，不接纳原始URL/请求体/日志附件；
  - AI SDK 的遥测不记录输入和输出（D-046）；
  - OpenTelemetry 推迟到 v1.1。

## 10. 性能设计

- **消息查询**使用 (conversation_id,seq)，变更扫描走 conversation_changes 的联合主键，实体按 id 批量读取；额外索引按搜索/附件/权限查询的 EXPLAIN 验证，不假定只需两个索引。分页每页 50 条。
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

- **服务端数据**：由 TanStack Query 管理。WS 的 id/版本提示合并后重新请求；HTTP 返回按本人权限投影的数据。仅经授权的 Agent 增量可直接拼接，最终以持久快照为准。
- **消息缓存**：每个会话一份分页缓存，按 `seq` 排序，合并时以消息 id 去重，并以 `change_seq` 大的版本为准。
- **乐观更新**：发送、编辑、撤回都先更新界面，失败再回滚；未发出的消息用 `clientId` 标识。
- **一致性**：
  - 区分 observed/synced，固定上界补发并每 30 秒对账（第 5.2 节）；
  - 所有GET/写响应/补发使用05的实体版本合并；请求捕获账号/恢复世代/membership/本地cacheGeneration。reset、退出或重入后旧响应直接丢弃；移除墓碑不能被旧HTTP覆盖；
  - 收到消息更新时，同时更新引用它的回复和会话预览；
  - 收到conversation.removed提示先对账；仅接受较新viewerVersion且匹配关系的移除墓碑后清缓存，迟到提示不能删除重新加入后的关系。
- **全局状态**（zustand）：当前会话、Inspector 是否打开、输入框草稿（按会话保存，M6 起持久化到 IndexedDB）、外观设置。
- **WebSocket 客户端**：
  - 单例；
  - 断线后按指数退避重连（1、2、4、8 秒，最长 30 秒，带随机抖动），每次重连都执行第 5.2 节的补发流程；
  - 用 `hello.serverTime` 校正本地时钟，撤回按钮等时限判断以校正后的时间为准；
  - 切换会话、页面前后台变化时，上报 `focus`。
- **输入法**：组字期间（`isComposing` 为 true，或 `keyCode` 为 229）回车不发送（D-050）。
- **本地身份隔离（D-070）**：Query key、IndexedDB、草稿和离线队列使用 userId + authEpoch + membershipId 命名空间。退出先设置共享注销墓碑，通过 BroadcastChannel/SW 通知其他标签页停止渲染、发送和重连，再清缓存及订阅；远程失效在联网复核时执行同样流程。SW 只缓存公共外壳。
- **离线边界**：初次冷启动未联网验证时只显示外壳；已验证且仍打开的标签页可看已缓存内容。消息缓存最多 7 天/每会话 200 条/总 50 MiB，草稿 7 天，待发纯文本 24 小时。重新联网先验证身份与成员世代再发；换账号、重新入群、过期项保留为需人工处理的草稿，不自动发送。不能清除失联设备或用户另存的副本。
- **表单**：每个输入框使用 contracts 里的同一份 zod schema，前后端校验规则保持一致。
