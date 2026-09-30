# 进度与交接

> **每个会话开工时先读这个文件，收工前更新它。**
> 只记录真实发生的事：写明执行过的命令和结果，没跑过的检查不能写成"已通过"。

## 当前状态

- **当前阶段**：M0 ✅，开发准备 ✅。**下一步是 D 设计原型。**
- **分支**：
  - `v2`：已推送到 GitHub，本地跟踪 `origin/v2`，所有开发都在这里进行；
  - `main`：仍是旧版代码，已经过历史清理；
  - 标签 `v1-legacy`：指向 main 的最后一个提交。
- **CI**：`check` 工作流在 v2 上的第一次运行通过（run 36683294188）。
- **下一个会话**：做 **D 设计原型**，见 [11-roadmap.md](11-roadmap.md) 的 D 节和 [02-design-system.md](02-design-system.md) 第 9 节。D 定稿后，再开一个新会话做 M1（从第 4 步开始，第 1–3 步已在开发准备中完成）。

## 里程碑状态

| 里程碑 | 状态 | 备注 |
|---|---|---|
| M0 规格 | ✅ 完成 | 2026-09-30，提交 `35f3547` |
| 开发准备 | ✅ 完成 | 2026-09-30，提交 `8b74b5c`、`b28dbbe`、`a8f1456`、`77cd6db`、`d723d7b` |
| D 设计原型 | ⚪ 未开始 | **下一步** |
| M1 本地骨架 | ⚪ 未开始 | 第 1–3 步已提前完成 |
| M2 核心聊天 | ⚪ 未开始 | |
| M3 富消息 | ⚪ 未开始 | |
| M4 Agent 基础 | ⚪ 未开始 | |
| M5 Agent 进阶 | ⚪ 未开始 | |
| M6 通知与 PWA | ⚪ 未开始 | |
| M7 加固与彩排 | ⚪ 未开始 | |
| M8 上线 | ⚪ 未开始 | |

> 2026-09-30 清理历史之后，所有提交号都变了。本文件和 11-roadmap 里的提交号已经换成改写之后的。

## 等待用户确认

（暂无）

## 用户待办

- [x] 删除 Docker Hub 上的公开仓库 `abovealll/chatapp`（2026-09-30）。
- [x] 作废旧的 DeepSeek key，并把新 key 填进 `.env.local`（2026-09-30）。`bun run doctor --ai` 已验证可用。
- [ ] 可选：在 GitHub 上安装 Renovate App，让 `renovate.json` 生效。
- [ ] 可选：请 GitHub Support 清除已改写历史中旧提交的缓存（见 D-032 中的"残留风险"）。
- [ ] M8 前：购买域名，开通 Resend；如果需要异地备份，再开通 R2 或 B2。
- 注意：刚装完 Bun，之前已经打开的终端和编辑器要重启，才能直接找到 `bun`。

## 待验证事项

见 [12-decisions.md](12-decisions.md) 末尾的 V-01 到 V-07。每验证一项，就把结论补成一条新的决策记录。

## 交接记录

### 2026-09-30 · 会话 1（续 2）：推送、清理历史、指定模型（Claude）

**用户的指示**："推送"、"清理"，以及"key 已填好，目前直接指定用 V4.1-Flash"。

**完成**
- **模型**（D-031，提交 `d723d7b`）：
  - `bun run doctor --ai` 调用 DeepSeek 的模型列表接口，结果为 ✓，可用的模型是 `deepseek-flash` 和 `deepseek-v4-pro`。
  - 把 `AI_MODEL_FAST` 和 `AI_MODEL_DEEP` 都改为 `deepseek-flash`，深度模式的计价也改为 Flash 的价格；`.env.example` 和 `.env.local` 都已修改，只改了这几行。
  - 同步更新了 00、03、06、12 四份文档。
- **历史清理**（D-032）：
  1. 先把整个仓库备份成 bundle，放在当次会话的临时目录里（35 MB）。
  2. 在 `--no-local` 镜像克隆里执行 `uvx git-filter-repo --invert-paths`，删除 96 个用户上传的文件，保留 3 个应用素材。
  3. 推送前逐项核对：提交数量不变（main 14 个、v2 20 个）；v2 最新提交的内容与改写前逐字节相同；main 只少了 `media/` 下的文件；打包大小从约 35 MB 降到 264 KB。
- **推送**：
  - 执行 `git push --atomic --force-with-lease=main:99056e7 … main v2 v1-legacy`，凭据由 `gh auth git-credential` 提供，只在这条命令里生效。
  - 结果：main 从 `99056e7` 强制更新为 `9841352`；新增分支 v2（`d723d7b`）；新增标签 `v1-legacy`。
- **本地同步**：先确认本地 v2 和远程 v2 的内容完全一致，再执行 `reset --hard origin/v2`；并更新 main 和标签，设置好上游分支。`.env.local`、`garage.toml`、`node_modules` 都不受影响。
- **CI**：`check` 工作流通过，每一步都实际执行了：Bun 1.4.2 按锁文件安装依赖、Biome 检查 11 个文件、`tsc` 类型检查、guard、compose 配置校验。

**注意**
- 本地的 reflog 里还有旧的提交对象，大约 30 天后会自动清掉。
- 临时目录里的备份 bundle 是当次会话的，会话结束后就不在了。

### 2026-09-30 · 会话 1（续）：开发准备（Claude）

> 这一段里的提交号都是**清理历史之前**的。对应关系：`f5e9012`→`35f3547`，`694b5d7`→`8b74b5c`，`1c409e6`→`b28dbbe`，`3540ac7`→`a8f1456`，`917f173`→`77cd6db`；旧代码 `99056e7`→`9841352`（即标签 `v1-legacy`）。

**完成**
- **仓库**
  - 设置本仓库的 git 身份：`liaboveall <2628370933@qq.com>`，只在本仓库生效；
  - 提交文档；
  - 移除旧代码（删除 153 个文件），LICENSE 补上上游版权；
  - 提交工具链；
  - 提交本地基础设施和脚本。
- **环境**
  - 用官方脚本安装 Bun 1.4.2；
  - `bun install` 安装了 4 个开发依赖：Biome 2.5.14、`@types/bun` 1.4.2、lefthook 2.1.15、TypeScript 7.0.2；
  - 拉取了 4 个镜像：pgvector 0.8.6-pg18、Valkey 9.1、Garage v2.4.1、Mailpit v1.31.3。
- **意外情况**
  - 本机 1025 端口被 Cisco VPN 占用，Mailpit 的 SMTP 改用 2525（D-029）；
  - Biome 2.5 的配置写法已通过 `biome migrate` 更新。

**验证证据**
- `bun run check` 通过；两次提交时 lefthook 的 pre-commit 钩子都通过。
- `infra:up`：4 个容器都 healthy。
- `infra:bootstrap`：运行两次结果相同，可以重复执行。
- `bun run doctor`：除可选的 key 检查外全部 ✓，最终输出 `environment ok`。其中：
  - PostgreSQL 18.6，已装 pg_trgm 1.6 和 vector 0.8.6，`uuidv7()` 可用；
  - Valkey 配置为 `noeviction`，AOF 已开启；
  - Garage 的两个 bucket 用 Bun 的 S3 客户端读写删都正常；
  - Mailpit 的 SMTP 在 2525 端口返回 220。
- 执行 `infra:down` 再 `infra:up` 后，数据依然在。

### 2026-09-30 · 会话 1：分析与规划（Claude）

**完成**
- **分析旧版**：通读源码，在临时目录里实际运行，复现了 24 个缺陷和三类基础设施问题，写成 13。
- **查证资料**：核实了各组件的最新版本、DeepSeek 当前的模型，以及 Apple 在 WWDC 2026 对 Liquid Glass 的修正。
- **确定决策**：用户确定了几项关键决策：邀请制、DeepSeek、桌面优先、本地优先且最后上线、Apple 风格、技术栈只选最新最好。其余由 Claude 决定，记录在 12。
- **写文档**：`docs/00` 到 `docs/13`、本文件，以及根目录的 `CLAUDE.md`。
