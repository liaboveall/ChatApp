# 进度与交接

> **每个会话开工时先读这个文件，收工前更新它。**
> 只记录真实发生的事：写明执行过的命令和结果，没跑过的检查不能写成"已通过"。

## 当前状态

- **当前阶段**：M0 ✅，开发准备 ✅。**下一步是 D 设计原型。**
- **分支**：`v2`（本地），当前 HEAD 是本文件所在的提交。旧代码 `99056e7` 已打上本地标签 `v1-legacy`。
- **尚未推送**：`v2` 分支和 `v1-legacy` 标签都还只在本地，推送到 GitHub（`liaboveall/ChatApp`）要等用户确认。
- **下一个会话**：做 **D 设计原型**，见 [11-roadmap.md](11-roadmap.md) 的 D 节和 [02-design-system.md](02-design-system.md) 第 9 节。D 定稿后，再开一个新会话做 M1（从 M1 的第 4 步开始，第 1–3 步已在开发准备中完成）。

## 里程碑状态

| 里程碑 | 状态 | 备注 |
|---|---|---|
| M0 规格 | ✅ 完成 | 2026-09-30，提交 `f5e9012` |
| 开发准备 | ✅ 完成 | 2026-09-30，提交 `694b5d7`、`1c409e6`、`3540ac7` 以及本次文档更新 |
| D 设计原型 | ⚪ 未开始 | **下一步** |
| M1 本地骨架 | ⚪ 未开始 | 第 1–3 步已提前完成 |
| M2 核心聊天 | ⚪ 未开始 | |
| M3 富消息 | ⚪ 未开始 | |
| M4 Agent 基础 | ⚪ 未开始 | |
| M5 Agent 进阶 | ⚪ 未开始 | |
| M6 通知与 PWA | ⚪ 未开始 | |
| M7 加固与彩排 | ⚪ 未开始 | |
| M8 上线 | ⚪ 未开始 | |

## 等待用户确认

- [ ] 推送 `v2` 分支和 `v1-legacy` 标签到 GitHub。这两个操作都只是新增，不会覆盖远程已有的内容。
- [ ] 是否清理 git 历史里的 `media/`（57 MB 用户上传文件）。这需要改写公开仓库的历史并强制推送（见 D-019），执行前必须单独确认。

## 用户待办

- [x] 删除 Docker Hub 上的公开仓库 `abovealll/chatapp`（用户 2026-09-30 告知已完成）。
- [x] 作废旧的 DeepSeek key，新建 v2 专用的 key（用户 2026-09-30 告知已完成）。
- [ ] **把新 key 填进 `.env.local` 的 `DEEPSEEK_API_KEY=`**，然后运行 `bun run doctor --ai` 验证。2026-09-30 时 `.env.local` 里这一项还是空的，但 M4 之前都用不到。
- [ ] 可选：在 GitHub 上安装 Renovate App，`renovate.json` 才会生效，之后依赖升级会自动开 PR。
- [ ] M8 前：购买域名、开通 Resend；如果需要异地备份，再开通 R2 或 B2。
- 注意：刚装完 Bun，之前已经打开的终端和编辑器需要重启，才能直接找到 `bun`。

## 待验证事项

见 [12-decisions.md](12-decisions.md) 末尾的 V-01 到 V-07。每验证一项，就把结论补成一条新的决策记录。

## 交接记录

### 2026-09-30 · 会话 1（续）：开发准备（Claude）

**完成**
- **仓库**
  - 设置本仓库的 git 身份：`liaboveall <2628370933@qq.com>`（沿用这个仓库以往的提交身份，只在本仓库生效）；
  - 提交文档：`f5e9012`；
  - 本地打标签 `v1-legacy` → `99056e7`；
  - 移除旧代码并整理仓库基础文件：`694b5d7`，删除了 153 个文件，LICENSE 加上了上游版权；
  - 提交工具链：`1c409e6`；
  - 提交本地基础设施和脚本：`3540ac7`。
- **环境**
  - 用官方脚本安装 Bun 1.4.2（`bun.sh/install.ps1 -Version 1.4.2`）；
  - `bun install` 安装了 4 个开发依赖：`@biomejs/biome` 2.5.14、`@types/bun` 1.4.2、`lefthook` 2.1.15、`typescript` 7.0.2；
  - 拉取了 4 个 Docker 镜像：`pgvector/pgvector:0.8.6-pg18`、`valkey/valkey:9.1-alpine`、`dxflrs/garage:v2.4.1`、`axllent/mailpit:v1.31.3`。
- **意外情况**：本机 1025 端口被 Cisco VPN 占用，Mailpit 的 SMTP 改用 2525（D-029）；Biome 2.5 的配置写法已通过 `biome migrate` 更新。

**验证证据**（实际执行的命令）
- `bun run check`：Biome 检查了 11 个文件，没有问题；`tsc -p tsconfig.json`（TypeScript 7.0.2）没有报错；guard 结果为 `guard: ok`。
- 两次提交都触发了 lefthook 的 pre-commit 钩子，guard 和 biome 都通过。
- `bun run infra:up`：4 个容器都进入 healthy 状态。
- `bun run infra:bootstrap`：
  - 第一次运行：分配布局（version 1），导入密钥，创建 2 个 bucket；
  - 第二次运行：每一步都显示"已存在"（可重复执行）。
- `bun run doctor`：11 项检查中 10 项通过（✓），第 11 项是 `DEEPSEEK_API_KEY` 尚未填写，属于可选项，最终输出 `environment ok`。其中包括：
  - PostgreSQL 18.6，开发库和测试库都装好了 pg_trgm 1.6 和 vector 0.8.6，`uuidv7()` 可用；
  - Valkey：PONG，`noeviction`，AOF 已开启；
  - Garage：用 Bun 的 S3 客户端在两个 bucket 里都完成了写、读、删；
  - Mailpit v1.31.3：SMTP 在 2525 端口返回了 220 欢迎信息。
- `infra:down` 之后再 `infra:up`，`doctor` 依然全部通过。Postgres 的数据目录是 `/var/lib/postgresql/18/docker`，位于数据卷 `chatapp-dev_pg` 中。

**没做**
- 没有推送任何东西到 GitHub。CI 的 `check` 工作流写好了，但还没在 GitHub 上跑过，推送后才会首次运行。
- 没有写任何业务代码。没有安装 Playwright 浏览器（M1 做）。

**下一步**：见上面的"当前状态"。

### 2026-09-30 · 会话 1：分析与规划（Claude）

**完成**
- **分析旧版**：通读全部源码，在临时目录里用 Python 3.10 实际运行，复现了 24 个缺陷，以及迁移、测试、生产启动三类基础设施问题，写成 13-legacy-analysis。
- **查证资料**：
  - 在 registry 上核实各个组件的最新版本；
  - 在 DeepSeek 官方文档核实当前模型；
  - 查了 Apple 在 WWDC 2026 对 Liquid Glass 做的修正。
- **确定决策**：用户确定了几项关键决策：邀请制、DeepSeek、桌面优先、本地优先且最后上线、Apple 风格、技术栈只选最新最好。其余由 Claude 决定，全部记录在 12-decisions。
- **写文档**：`docs/00` 到 `docs/13`、本文件，以及根目录的 `CLAUDE.md`。
