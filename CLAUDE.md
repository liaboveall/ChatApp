# ChatApp v2 开发约定

用中文与用户交流。本仓库正在**整体重写**：
- 旧版是 Django 写的，保存在 git 标签 `v1-legacy`（也就是 main 分支当前的最后一个提交）；
- 新版在 `v2` 分支上开发。

## 开工前必读（按顺序）

1. `docs/PROGRESS.md`：当前阶段、下一步、用户待办、交接记录。
2. `docs/11-roadmap.md` 中当前里程碑的那一节。
3. 该里程碑引用到的规格文档。**只读需要的部分，不要一次全部读完。**

文档索引见 `docs/00-overview.md`。规格文档是开发依据：遇到冲突或缺漏时，先和用户确认，改好文档，再写代码。优先级为：用户最新指示 > `docs/12-decisions.md` > 其他规格。

## 已定方向（细节见 docs/12）

- 邀请制注册；AI 使用 DeepSeek；桌面优先；Apple Liquid Glass 风格；先在本地完成，上线放在最后（M8）。
- 技术选型只看"最新、最好"，不考虑熟悉程度。新增依赖时，先到 registry 核对最新稳定版，锁定精确版本，不用 beta 或 RC（例外须记录在 12）。
- 技术栈：TypeScript 7；后端 Bun + Hono + zod + Drizzle + PostgreSQL 18（pgvector）+ Valkey + BullMQ + Garage + Better Auth；AI 用 AI SDK 7；前端 React 19 + Vite 8 + TanStack Router/Query + Tailwind 4 + Base UI。

## 硬性规则

**安全**（完整要求见 docs/07）
- 用户身份**只**从服务端会话获取；请求体和 WebSocket 消息里声称"我是谁"的字段一律忽略。
- 所有与会话相关的读写都必须经过 `authorize()`；对无权访问的私有资源返回 404。
- 前端禁止用 `innerHTML` 或 `dangerouslySetInnerHTML` 渲染用户内容；Markdown 不允许原始 HTML。
- 写操作走 HTTP，并带幂等键；WebSocket 只负责推送事件和瞬时信号。
- Agent 以调用者本人的权限执行；输出到共享会话时只能读取当前会话；影响他人的操作必须经过用户审批（docs/06）。

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

## 本机环境（2026-09-30 已搭好，详见 docs/09）

- Windows 11，Node 26，Docker 29.8.1。
- Bun 1.4.2 安装在 `%USERPROFILE%\.bun\bin`。如果当前 shell 找不到 `bun`，先把这个目录加到 PATH 前面：
  - Git Bash：`export PATH="$HOME/.bun/bin:$PATH"`
  - PowerShell：`$env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"`
- **端口冲突，两个占用方都不能停**：
  - 5432 被原生的 PostgreSQL 占用，所以开发库用 **5434**；
  - 1025 被 Cisco VPN（`vpnagent`）占用，所以 Mailpit 的 SMTP 在宿主机上用 **2525**。
- 其他端口：web 5173、api 3100、Valkey 6379、Garage 3900 和 3903、Mailpit 网页 8025。
- 在 Git Bash 里手动执行 `docker compose exec garage /garage …` 时，要加 `MSYS_NO_PATHCONV=1`，否则路径会被改写。
- `.env.local` 由 `bun run setup` 生成，已被 git 忽略，**不要在输出中打印其中的值**。
- 本仓库的 git 提交身份在仓库级配置：`liaboveall <2628370933@qq.com>`。

## 常用命令

- **已经可用**：`bun run setup` · `doctor`（加 `--ai` 可以检查 DeepSeek key）· `infra:up` / `infra:down` / `infra:ps` / `infra:logs` · `infra:bootstrap` · `infra:reset --yes`（会删除全部本地数据，执行前先征得用户同意）· `lint` / `lint:fix` · `typecheck` · `guard` · `check`
- **M1 才会创建，在那之前不要假定它们存在**：`db:*` · `dev` · `test:*` · `eval` · `storybook` · `build` · `admin:create`
- lefthook 的 pre-commit 钩子会运行 Biome 和 guard，提交时 PATH 里必须能找到 `bun`。

## 部署

M8 才涉及部署。服务器信息和多站点约定写在用户的全局 `~/.claude/CLAUDE.md` 中；ChatApp 的部署方案见 `docs/10-deployment.md`。
