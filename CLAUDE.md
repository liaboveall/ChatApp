# ChatApp v2 开发约定

用中文与用户交流。本仓库正在**整体重写**：
- 旧版是 Django 写的，保存在 git 标签 `v1-legacy`（也就是 main 分支当前的最后一个提交）；
- 新版在 `v2` 分支上开发。

## 开工前必读（按顺序）

1. `docs/PROGRESS.md`：当前阶段、下一步、用户待办、交接记录。
2. `docs/11-roadmap.md` 中当前里程碑的那一节。
3. 该里程碑引用到的规格文档。**只读需要的部分，不要一次全部读完。**

文档索引见 `docs/00-overview.md`。规格是开发依据：冲突或缺漏先按用户既有授权修订文档，再写代码；已授权的完善无需重复确认，改变用户明确决定或超出授权范围时才提出具体选择。优先级为：用户最新指示 > `docs/12-decisions.md` > 其他规格。

## 已定方向（细节见 docs/12）

- 邀请制注册；AI 使用 DeepSeek；桌面优先；Apple Liquid Glass 风格；先在本地完成，上线放在最后（M8）。
- 2026-09-30 规划审查后，用户又定了四项（D-033 到 D-036）：
  - 内存只要不超过服务器总量；
  - 新成员看不到加入前的历史；
  - "重新生成"会替换原回复；
  - 使用站点 key 的 Agent 运行内容，管理员可以查看；鼓励用户自带 key，但鼓励文案只讲好处，不提管理员能看到内容。
- 技术选型只看"最新、最好"，不考虑熟悉程度。新增依赖时，先到 registry 核对最新稳定版，锁定精确版本，不用 beta 或 RC（例外须记录在 12）。
- 技术栈：TypeScript 7；后端 Bun + Hono + zod + Drizzle + PostgreSQL 18（pgvector）+ Valkey + BullMQ + Garage + Better Auth；AI 用 AI SDK 7；前端 React 19 + Vite 8 + TanStack Router/Query + Tailwind 4 + Base UI；M2b 起加时间线 virtua、Markdown 渲染 streamdown + Shiki（D-144、D-145；代码高亮是自己的插件加预编译语法，D-168），页面开着 Trusted Types（D-146）。
- 设计（D）已在 2026-10-02 由用户在 D4 确认（D-113）：令牌、玻璃材质和字体（拉丁字母用 Inter）以 `docs/02` 的第 2 到 7 节为准。`design/` 里的原型只是参考实现，M1b 已用 React、Tailwind 和 Base UI 重做（不是搬代码）；令牌的数据源是 `apps/web/src/design/tokens.ts`，改令牌要先过 `bun run design:contrast`（D-114）。

## 硬性规则

**安全**（完整要求见 docs/07）
- HTTP/WS用户身份只从服务端session获取；后台用户操作用服务端签发的持久delegation并检查origin/授权世代/当前业务权限。请求体不能指定Principal或冒用userId（D-079）。
- 所有与会话相关的读写都必须经过 `authorize()`（实现是 `domain/authorize.ts` 的 `decide` / `enforce`）；对无权访问的私有资源返回 404，且回答与「根本没有这个资源」逐字相同，按消息 id 的接口同理。新增任何会话、消息、同步或目录路由，必须同时在 `apps/server/test/security/conversation-matrix.test.ts` 加一行，否则测试失败（D-136）。
- 消息可见性基础是当前成员且 seq > visible_from_seq；引用、预览、附件也逐项投影。普通 WS 无正文，流式每批复核授权与来源；共享 Agent 只读当前成员共同可见历史（D-057、D-060）。
- WS 绑定 session，持久撤权+5 秒复核；业务写入在事务锁内复核授权。Better Auth method/path 默认拒绝、禁止代登，注册确认+验证才激活（D-057–D-059）。
- 业务变更、同步日志和 work_items 同事务；Valkey 丢队列由独立 Postgres 扫描恢复。observed 不等于 synced（D-056）。
- 最新规划决策D-076–D-092补充/修正D-056–D-075；08的AT-01–AT-37分阶段验收，设计完成不等于运行通过。15顶部有本轮17项修订对照。
- 验证/重置使用绑定注册实例及恢复世代的一次性凭证；原生JWT回调关闭。JSON解析前限128KiB，日志只记录白名单字段/规范化路由，不能落原始URL。
- 普通退出不撤销长期任务；安全撤销按03真值表取消委托。自动发送不推进人的已读。所有HTTP响应按05实体版本合并，through不是实体版本。
- 私有BYOK传递来源不自动进入site上下文，key切换新开空白段；媒体解码只在无网络/无业务凭据的独立media容器。生产成功删除先有独立异地journal，缺删除证据不能开放恢复数据。
- stop/kill、OOM、网络/磁盘故障只在独立compose.test项目且核验实际实例后执行；当前共享测试库/db1/bucket不构成实例隔离。
- 隐私说明（01 第 4.11 节）必须与实际行为一致；改动数据保留期或管理员能看到的内容时，同步修改说明。
- 前端禁止用 `innerHTML` 或 `dangerouslySetInnerHTML` 渲染用户内容；Markdown 不允许原始 HTML。
- 写操作走 HTTP，并带幂等键；WebSocket 只负责推送事件和瞬时信号。
- Agent 的规则（docs/06）：
  - 以调用者本人的权限执行；
  - 输出到共享会话时，只能读取当前会话；面板和 ⌘K 默认也只读当前会话；
  - 影响他人的操作必须经过用户审批；
  - 同库业务效果与 agent_effects 同事务去重；外部模型/推送/邮件不得宣称恰好一次；预算先预占、未知调用不盲重试。

**代码**
- TS 严格模式。不引入新的 `any`、`@ts-ignore`，不跳过测试；确有必要时写明原因。
- 所有外部输入都用 `packages/contracts` 里的 zod schema 校验。
- 业务逻辑只写在 `apps/server/src/domain/`，其他层只调用它（分层规则见 docs/03 第 3 节）。
- 集成测试使用真实的 Postgres、Valkey、Garage；只模拟外部服务（DeepSeek、推送服务、生产环境的邮件服务商）。
- 前端同步层（D-171，SEC-34）：屏幕和发送队列自己发的请求，发之前取 `engine.ticket()`，回答与失败带着它进 `engine.ingest*` 等入口，账号或成员关系变了的会被丢弃（必填参数，漏了编译不过）；任何按会话存状态的前端 store（草稿、待发、回复/编辑、输入提示……）必须向 `lib/sync/stores.ts` 的 `registerConversationReset` 登记，成员关系结束时才会一起清除；用一页替换窗口或把页面并入窗口时，日志位置要退回到请求发起时的水位（见 `engine.ts` 的 `#installWindow`、`#rewind`）。回答回来之后的界面收尾（结束编辑、放回草稿等）同样受它约束（D-173）：`await` 之后不用渲染时的闭包做决定，拿发起时的身份（回复/编辑的编号、成员关系、发出的文本）去问 store 现在的状态（`compose.ts` 的 `settleEdit`、`endCompose` 的编号参数）；引擎拒绝的回答（`ingestMessage` 返回 false）不算成功。屏幕发的写请求一律经 `app/sync.ts` 的 `forScreen`（D-174）：回答和失败只在同一次登录会话、同一个成员关系时交给屏幕，否则是 null，屏幕拿到 null 什么也不做（跳转、提示、结束会话都不做）；新写的请求如果不经它，`features/screen-writes.test.ts` 会失败。

**流程**
- 没跑过的检查不能说"通过"。收工前在 `docs/PROGRESS.md` 记录执行过的命令、结果和下一步。
- 提交、推送、打标签、改写历史之前，先征得用户同意（用户在本会话中已明确授权的除外）。
- 安装软件（比如 Bun）、删除数据卷等不可逆或影响环境的操作，先征得用户同意。

**密钥**
- API key 和各种密钥都不能出现在聊天、日志和提交里。
- `.env.local` 不提交；`DEEPSEEK_API_KEY` 由用户自己填写。

## 本机环境（2026-10-01 起在 WSL 中开发，详见 docs/09 和 D-093）

- **开发目录**：WSL（Ubuntu 26.04）里的 `/home/mars/projects/ChatApp`，放在 Linux 文件系统上。Windows 上的 `D:\ChatApp` 已停用，不要再在那里改代码或提交。
- **Docker** 29.8.1 来自 Docker Desktop 的 WSL 集成，和 Windows 共用同一个引擎、容器和数据卷；使用前 Windows 上的 Docker Desktop 必须在运行。
- **Bun** 1.4.2 在 `~/.bun/bin`，**Node** 26.8.1 在 `~/.local/share/node`，软链接放在 `~/.local/bin`。如果当前 shell 找不到 `bun`，新开一个终端，或先执行：`export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"`。
- **端口冲突，两个占用方都不能停**。它们都在 Windows 主机上，而 Docker Desktop 把端口发布在 Windows 主机上，所以搬到 WSL 后依然适用：
  - 5432 被 Windows 上原生的 PostgreSQL 占用，所以开发库不用它：Postgres 和 Valkey 的主机端口是 `.env.local` 里的变量 `POSTGRES_PORT`、`VALKEY_PORT`，默认 **25434** 和 **26379**（D-172；2026-10-05 之前是 5434 和 6379）；
  - 1025 被 Cisco VPN（`vpnagent`）占用；Mailpit 默认用 **2525**，但 2525 又落入 Windows 保留范围，现通过 `.env.local` 的 `SMTP_PORT` 改用 **12525**。Compose 与应用共用该变量。
  - Windows 还会动态保留端口段（`netsh interface ipv4 show excludedportrange protocol=tcp`，重启后会变；它们都从动态端口范围 `netsh int ipv4 show dynamicport tcp` 里划，这台机器上是 1024–15000）。落进保留段的端口 Docker Desktop 既不发布、也不报错：容器 healthy，`docker port` 却是空的，连库的命令报 `ECONNREFUSED` 或 `migrate failed: Error`（2026-10-05 就是这样）。所以默认端口取在动态范围之外；`bun run infra:up` 启动前拒绝保留段里的端口、启动后核对端口真的发布了并连得上，`bun run doctor` 同样检查并建议换成哪个端口。换端口：改变量，`bun run setup`（连接串里的端口跟着变，密码不动），`bun run infra:up`（D-172）。
- 其他端口：web 5173、api 3100、Garage 3900 和 3903、Mailpit 网页 8025、Storybook 6006；`bun run test:e2e` 期间另有预览服务器 4173 和测试环境 API 3102。Windows 浏览器可以直接访问 WSL 里的 `localhost:<端口>`；访问应用必须用 `http://localhost:5173`（不是 127.0.0.1，服务端要求 Origin 等于 `APP_ORIGIN`）。
- `.env.local` 由 `bun run setup` 生成（WSL 里的这份是从迁移前的 Windows 副本原样复制来的），已被 git 忽略，**不要在输出中打印其中的值**。
- 本仓库的 git 提交身份在仓库级配置：`liaboveall <2628370933@qq.com>`。推送凭据由仓库级的 credential helper 通过 Windows 的 `gh.exe` 提供（见 docs/09 第 10 节）。

## 常用命令

- **已经可用**：
  - 环境与基础设施：`bun run setup` · `doctor`（加 `--ai` 可以检查 DeepSeek key）· `infra:up`（启动、等健康、再核对每个主机端口真的发布且连得上）/ `infra:down` / `infra:ps` / `infra:logs` · `infra:bootstrap` · `infra:reset --yes`（会删除全部本地数据，执行前先征得用户同意）
  - 检查：`lint` / `lint:fix` · `typecheck`（所有工作区包，含 `apps/web`）· `guard`（含架构边界）· `check`（以上加单元测试、令牌对比度、文案一致性，不需要任何服务）
  - 数据库（M1a）：`db:generate` / `db:check` · `db:migrate` / `db:migrate:test` · `db:bootstrap`（生产也可用）/ `db:bootstrap:test` · `db:seed`（仅开发；M2a 起还会建演示会话和 59 条消息，幂等，开发库要先 `db:migrate`）
  - 后端（M1a）：`dev:api` · `dev:worker` · `admin:create`（密码在用户自己的终端输入）· `admin:verify-email`
  - 测试（M1a）：`test:integration`（集成、安全、契约、实时；需要先 `infra:up`、`infra:bootstrap`、`db:migrate:test`；单个文件用 `bun --env-file=.env.local test ./apps/server/test/<目录>/<文件>`，要从仓库根目录运行）· `test` · `test:coverage`（集成类测试加 `domain/` 行覆盖率 ≥ 90% 的检查，D-142；和 `test:integration` 一样用测试库，不能同时跑）/ `coverage:check`（只检查已有的 lcov）· `test:infra:up` / `test:infra:down <runId>` · `test:fault`（只在独立实例里做故障注入，D-085；M2a 起含 AT-01/02 的杀进程、清空队列、总线断开；Docker Desktop 偶发的内部路径误报会自动重建实例，D-141）· `smoke:backend`（对运行中的 api/worker 做真实进程验收走查，M2a 起共 22 步，用法见脚本头部）
  - 前端（M1b）：`dev`（api、worker、Vite 一起；`-- api web` 选进程）· `dev:web` · `build` · `storybook` · `web:messages`（生成文案，`-- --check` 只核对）· `test:e2e`（Playwright 对生产构建运行，需要先 `infra:up`、`infra:bootstrap`；**不能和集成测试、edge 套件同时跑**，共用测试库；第一次要装浏览器和系统库，见 docs/09 第 2 节；性能场景（`@perf`，D-161）在 WSL 里用显卡，`E2E_NO_GPU=1` 关掉显卡、照 CI 的软件合成方式跑（D-170）；本机 32 个核而 CI 只有 4 个，只在 CPU 吃紧时才出现的竞态本机复现不了，把整条命令用 `taskset -c 0,1` 限在两个核上就能复现（D-170）；M2b 起夹具对每个浏览器上下文断言零违规，新建上下文必须用 `support/fixtures.ts` 的 `newContext()`，控制台里确实会出现的错误用 `allowConsole(pattern, reason)` 声明（D-148）；E2E 里模拟断线用 `e2e/support/network.ts` 的 `controlNetwork`，不要单独用 `context.setOffline`，它断不开已建立的 WebSocket，D-134；写 E2E 要先等页面到位再量、再填：点链接后地址栏先变而旧页面还在，量尺寸要等入场动画结束（`e2e/support/ui.ts` 的 `animationsFinished`），都不用加容差，D-143；用 `--repeat-each` 重复跑会撞管理员登录限流，分批、每批不超过 7 次）· `test:visual`（在 Playwright 官方镜像里比较 Storybook 截图，需要 Docker；`-- --update-snapshots` 重新生成基线）
  - 设计原型（D，见 `design/README.md`）：`design:build`（`-- --minify` 是发布版）· `design:contrast`（令牌对比度自查，脚本在 `apps/web/tools`）；用真实 Windows Edge 做的浏览器检查：`design/prototype/tools/browser-checks/run.sh <keyboard|layout|media|flows|audit>`
  - 本地网关（M2b）：`edge:up` / `edge:down`（Nginx 容器用生产站点配置提供构建产物，`https://chat.localhost:8443`；`down` 只删 `chatapp-edge` 项目）· `test:edge`（一条命令：起网关、跑 `apps/web/edge/` 套件、拆网关；它的 API 是测试环境的 3104，**独占测试库**，CI 不跑，CI 只跑 `bun scripts/edge.ts configtest`）
- **以下命令到对应的里程碑才会创建，在那之前不要假定它们存在**：
  - M3：`media:up` / `media:down`（worker容器与私有IPC）
  - M4：`eval`
- lefthook 的 pre-commit 钩子会运行 Biome 和 guard，提交时 PATH 里必须能找到 `bun`。

## 部署

M8 才涉及部署。服务器信息和多站点约定写在用户的全局 `~/.claude/CLAUDE.md` 中；ChatApp 的部署方案见 `docs/10-deployment.md`。在 WSL 里，`~/.claude/CLAUDE.md` 是指向 Windows 那份全局文件的软链接，会被自动读到；但其中的 SSH 命令仍是 Git Bash 路径，部署时要改用 WSL 里的私钥（`~/.ssh/`，权限须为 600），细节见 docs/09 第 10 节。
