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
- 技术栈：TypeScript 7；后端 Bun + Hono + zod + Drizzle + PostgreSQL 18（pgvector）+ Valkey + BullMQ + Garage + Better Auth；AI 用 AI SDK 7；前端 React 19 + Vite 8 + TanStack Router/Query + Tailwind 4 + Base UI。

## 硬性规则

**安全**（完整要求见 docs/07）
- HTTP/WS用户身份只从服务端session获取；后台用户操作用服务端签发的持久delegation并检查origin/授权世代/当前业务权限。请求体不能指定Principal或冒用userId（D-079）。
- 所有与会话相关的读写都必须经过 `authorize()`；对无权访问的私有资源返回 404。
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
  - 5432 被 Windows 上原生的 PostgreSQL 占用，所以开发库用 **5434**；
  - 1025 被 Cisco VPN（`vpnagent`）占用；Mailpit 默认用 **2525**，但 2525 又落入 Windows 保留范围，现通过 `.env.local` 的 `SMTP_PORT` 改用 **12525**。Compose 与应用共用该变量。
- 其他端口：web 5173、api 3100、Valkey 6379、Garage 3900 和 3903、Mailpit 网页 8025。Windows 浏览器可以直接访问 WSL 里的 `localhost:<端口>`。
- `.env.local` 由 `bun run setup` 生成（WSL 里的这份是从迁移前的 Windows 副本原样复制来的），已被 git 忽略，**不要在输出中打印其中的值**。
- 本仓库的 git 提交身份在仓库级配置：`liaboveall <2628370933@qq.com>`。推送凭据由仓库级的 credential helper 通过 Windows 的 `gh.exe` 提供（见 docs/09 第 10 节）。

## 常用命令

- **已经可用**：`bun run setup` · `doctor`（加 `--ai` 可以检查 DeepSeek key）· `infra:up` / `infra:down` / `infra:ps` / `infra:logs` · `infra:bootstrap` · `infra:reset --yes`（会删除全部本地数据，执行前先征得用户同意）· `lint` / `lint:fix` · `typecheck` · `guard` · `check`
- **以下命令到对应的里程碑才会创建，在那之前不要假定它们存在**：
  - M1a：`db:*`（含生产安全的 db:bootstrap、仅开发的 db:seed）· `dev:api` · `dev:worker` · `test` / `test:unit` / `test:integration` · `admin:create` · `admin:verify-email`
  - M1a首次故障前：`test:infra:up` / `test:infra:down` / `test:fault`；M3：`media:up` / `media:down`（worker容器与私有IPC）
  - M1b：`dev` · `dev:web` · `test:e2e` · `test:visual` · `storybook` · `build`
  - M2b：`edge:up` / `edge:down`
  - M4：`eval`
- lefthook 的 pre-commit 钩子会运行 Biome 和 guard，提交时 PATH 里必须能找到 `bun`。

## 部署

M8 才涉及部署。服务器信息和多站点约定写在用户的全局 `~/.claude/CLAUDE.md` 中；ChatApp 的部署方案见 `docs/10-deployment.md`。在 WSL 里，`~/.claude/CLAUDE.md` 是指向 Windows 那份全局文件的软链接，会被自动读到；但其中的 SSH 命令仍是 Git Bash 路径，部署时要改用 WSL 里的私钥（`~/.ssh/`，权限须为 600），细节见 docs/09 第 10 节。
