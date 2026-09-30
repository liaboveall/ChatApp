# 12 决策记录

> 每条决策都写明：决定了什么、为什么、放弃了哪些方案。要改某个决策时，**新增一条**记录并注明它取代了哪条，不要直接删改旧记录。
> 标"用户"的是用户亲自拍板的；其余是用户授权 Claude 决定的（原话："其他的地方你自行决定"），日期均为 2026-09-30。

## 产品与范围

**D-001 重写，不修补**
旧版的问题是结构性的：迁移链断裂、数据模型导致越权、前端 JS 需要全部重写、技术栈落后两个大版本。在旧代码上修补，成本会高于重写。

**D-002 技术选型只看"最新、最好"（用户）**
不考虑用户是否熟悉，也不参考其他项目的技术栈。版本以 registry 上的最新稳定版为准，不用 beta 或 RC，例外会单独注明。

**D-010 邀请制注册（用户）**
- 注册必须持有邀请码。站点管理员可以无限邀请；普通成员有 5 个"成功邀请"名额，可以调整。
- 群邀请链接只对已注册用户有效，因此不能被当作注册的后门。
- 既然只有受邀者能注册，就不需要人机验证。

**D-016 桌面优先（用户）**
- 以 ≥ 1280px 为主，最低支持 1024px；手机和平板布局放到 v1.1。
- 桌面端的 PWA 仍然要做：可以安装成独立窗口，并使用 Window Controls Overlay。

**D-017 Apple Liquid Glass 风格（用户）**
- 以 2026 年 WWDC 修正后的版本为准，即可读性优先。
- 玻璃效果只用于导航层，内容层保持实底；提供四档透明度。
- 不打包 SF 字体，不使用 SF Symbols，也不使用任何 Apple 商标。原因是授权只允许在 Apple 平台上使用。

**D-018 本地优先，上线放在最后（用户）**
- M1 到 M7 都在本地开发和验收；M7 在本地用生产配置做一次 HTTPS 彩排，降低最后上线的风险。

**D-020 消息规则**
- 撤回：2 分钟内，与微信的习惯一致。
- 编辑：24 小时内，不保留历史版本。
- 超出撤回时限后，只能"仅对自己删除"。
- 群主或会话管理员、站点管理员可以删除任何消息，并写入审计日志。

**D-021 附件**
- 单个文件 100 MB，图片 20 MB，每人总空间 5 GB，均可在后台调整。
- 视频不做转码，因为服务器只有 2 个 CPU 核心。
- HEIC 格式、视频封面放到 v1.1。

**D-022 AI 预算默认值**
- 每人每天 50 万 token；全站每月 20 美元，用到 80% 时提醒，100% 时暂停。
- 按 DeepSeek 的价格，这些额度足够日常使用；均可在后台调整。

**D-026 频道里成员加入、离开不产生系统消息**
频道人多，这类消息会刷屏；成员变化只体现在成员列表里。群组和私信里照常产生。

**D-027 站点管理员不能读取私有会话的内容**
- 站点管理员可以对会话做管理操作，但读不到自己不在其中的群组、私信、Agent 会话的消息。
- 唯一的例外是处理举报时，可以看到被举报的消息及前后各 5 条，并且要写入审计日志。

## 架构与技术

**D-003 全栈 TypeScript；后端用 Bun 1.4 + Hono 4**
- 选择理由：
  - 前后端共享 zod 契约，类型和运行时校验都统一；
  - Bun 自带高性能的 WebSocket 发布订阅、S3 客户端和测试工具；
  - Hono 基于 Web 标准，万一需要，可以换回 Node 24 LTS 运行。
- 放弃的方案：
  - Django 6 + Channels 4：两种语言，实时能力偏弱；
  - Elixir/Phoenix：实时能力最强，但生态小，也无法和前端共享类型；
  - Go、Rust：性能不是这个项目的瓶颈；
  - Elysia：只能跑在 Bun 上。

**D-004 前端用 React 19.3 单页应用 + Vite 8**
- 选择理由：
  - 应用需要登录才能使用，用不到服务端渲染；
  - React 的组件生态最全（Base UI、react-virtuoso、Streamdown 等）；
  - React Compiler 1.0 可以自动处理大部分性能优化。
- 放弃的方案：
  - Next.js 16：对 WebSocket 支持不好，服务端渲染用不上；
  - TanStack Start：用不上服务端渲染；
  - Vue 3.6、Solid 2：还在 RC 阶段；
  - Svelte 5：可以用，但生态不如 React。

**D-005 实时模型：写操作走 HTTP，WebSocket 只推送；用 seq / change_seq 补发；自己实现 WebSocket 层**
- 放弃的方案：
  - Socket.IO：协议较重；
  - Centrifugo：为超大规模设计，对我们来说只是多维护一个服务；
  - Zero 1.9、Electric 这类同步引擎：聊天消息基本只追加，"序号 + 事件"已经够用；而"正在输入"、AI 流式输出这类瞬时事件，照样需要另开通道。

**D-006 PostgreSQL 18.6 + pgvector 0.8.6**
- PostgreSQL 19 目前还是 beta4，不用。
- 18 版原生支持 `uuidv7()`；pgvector 提供语义搜索和 Agent 记忆需要的向量能力。

**D-007 Valkey 9.1 + BullMQ 6**
- 用途：事件总线、在线状态、限流、任务队列。
- 放弃的方案：
  - Redis 8：Valkey 是 BSD 许可的社区版本，功能相当；
  - pg-boss：既然已经有 Valkey，BullMQ 更成熟，功能也更全。

**D-008 对象存储用 Garage 2.4（自托管 S3）**
- 选择理由：占用资源很小，支持 arm64；对外是 S3 接口，以后可以换成 R2 或 S3；下载统一经过应用鉴权。
- 放弃的方案：
  - 直接存本地磁盘：以后不方便迁移；
  - MinIO 社区版：已进入维护模式；
  - RustFS：9 月中旬才发布 1.0，还太新。

**D-009 认证用 Better Auth 1.7**
- 支持邮箱密码（必须验证邮箱）和 Passkey。
- 不做第三方登录：在邀请制下意义不大。
- 两步验证放到 v1.1。

**D-012 ORM 用 Drizzle**
- 选择理由：贴近 SQL，适合序号分配、未读数、部分索引、pgvector 这类场景。
- 放弃的方案：Prisma 7，可以用，但对 SQL 的控制力不如 Drizzle。
- 版本：Drizzle 1.0 目前是 RC4。M1 开工时如果 1.0 已经正式发布，就用 1.0；否则先用 0.45.x，并计划在 1.0 正式发布后升级。

**D-024 组件底层用 Base UI 1.8（Radix 作为备选）**
Base UI 提供无障碍的交互原语（菜单、弹窗、焦点管理等）；视觉部分按 02 整体重做。组件的组织方式参考 shadcn/ui。

**D-025 不使用 outbox 表**
事件在事务提交之后发布；万一发布失败，客户端会通过 `change_seq` 补发兜底，因此不会丢数据。

## AI 与 Agent

**D-011 AI 先用 DeepSeek（用户）；模型分两档**
- 快速模式用 `deepseek-flash`（V4.1-Flash），关闭思考，可以看图。
- 深度模式用 `deepseek-v4-pro`，开启思考。
- 模型名写在配置里，因为 DeepSeek 会退役旧名字：旧版代码里的 `deepseek-chat` 已经不在当前的模型列表中。
- ↪ 模型分工已被 **D-031** 取代：目前两种模式都用 flash。

**D-013 只有一个 Agent 运行时，基于 AI SDK 7 的 `ToolLoopAgent`**
- 聊天里的"AI 助手"就是只带只读工具的 Agent，不另外做一套。
- 用 `toolApproval` 实现审批；运行状态由我们自己存进数据库，并通过 BullMQ 执行。
- 放弃的方案：
  - Mastra：等于在 AI SDK 之上再套一层框架；
  - LangGraph.js：偏重；
  - OpenAI Agents SDK、Claude Agent SDK：还是 0.x 版本，而且各自偏向自家模型；
  - Workflow SDK：在自己的服务器上运行时，要依赖社区维护的 Postgres 支持。

**D-014 结果给谁看，决定 Agent 能读多少**
- 结果发到群组或频道时，Agent 只能读当前这个会话，也不使用调用者的个人记忆。
- 这是为了切断"在群里埋入指令，诱导 Agent 泄露调用者私信"这条攻击路径。

**D-015 语义向量用本地模型（待 M5 验证）**
- DeepSeek 不提供向量接口。
- 首选 Qwen3-Embedding-0.6B（int8 量化），备选 bge-small-zh-v1.5。评估标准见 06 第 10 节。

## 工程与部署

**D-019 仓库策略**
- 在 `v2` 分支上重写；旧代码打 `v1-legacy` 标签保存；M1 完成后合并回 main。
- 清理 git 历史里的 `media/` 目录需要强制推送、改写公开仓库的历史，所以执行前要单独征得用户确认。
- 仓库名暂时不改；产品名做成配置项。

**D-023 上线相关（M8 时最终确认）**
- 推荐购买自有域名：sslip.io 不在公共后缀列表里，而且发邮件需要配置 DNS。
- 邮件服务用 Resend。
- 由 CI 在 GitHub 的 `ubuntu-24.04-arm` 机器上构建镜像，推送到 GHCR；在服务器上构建作为备选方案。

**D-028 代码风格（开发准备，2026-09-30）**
- 统一使用 Biome 2.5 的默认规则集（`preset: recommended`），另外加几条更严格的：
  - `noExplicitAny` 设为 error；
  - 禁止 `dangerouslySetInnerHTML`；
  - 强制用 `import type` 导入类型。
- 格式：2 空格缩进；单引号；不写分号（Biome 的 `asNeeded` 模式）；多行列表末尾都加逗号；每行最长 100 字符；换行符用 LF。
- TypeScript 7：开启 `strict`、`noUncheckedIndexedAccess`、`verbatimModuleSyntax`；`module` 设为 `Preserve`，`moduleResolution` 设为 `Bundler`。

**D-029 Mailpit 的 SMTP 在宿主机上用 2525 端口（开发准备）**
开发机的 1025 端口被 Cisco VPN（`vpnagent`）占用，所以改用 2525，容器内部仍然是 1025。只影响本地开发，生产环境不部署 Mailpit。

**D-030 Garage 的访问密钥由 setup 生成，再导入 Garage（开发准备）**
- key id 为 `GK` 加 24 位十六进制，secret 为 64 位十六进制，由 `bun run setup` 生成，再用 `garage key import` 导入。
- 这样做的好处：初始化脚本可以反复执行，结果不变；重置数据卷后，密钥保持不变；密钥也不会出现在命令输出里。
- 已实测：用 Bun 自带的 `S3Client` 对 Garage v2.4.1 读、写、删都正常。Bun 自带的 `SQL` 连接 PostgreSQL 18.6、`RedisClient` 连接 Valkey 9.1 也都实测可用。这为 D-003（选用 Bun）提供了实际依据。

**D-031 目前只用 V4.1-Flash（用户，2026-09-30；取代 D-011 中的模型分工）**
- 快速和深度两种模式都用 `deepseek-flash`；快速模式关闭思考，深度模式开启思考。`deepseek-v4-pro` 暂不使用，以后要换只需改配置。
- `/models` 接口没有可以锁定版本的 ID，所以 `deepseek-flash` 会随着 DeepSeek 升级而变化。M4 起在 `agent_runs.model` 中记录每次调用实际使用的模型。
- 费用按 Flash 的价格估算（`AI_PRICE_DEEP_*` 与 `AI_PRICE_FAST_*` 取值相同）。
- 已在 2026-09-30 验证用户填写的 key 可用（`bun run doctor --ai`）。

**D-032 清理 git 历史中的用户上传文件（用户确认，2026-09-30；执行了 D-019 中待确认的那一步）**
- **删除范围**：所有历史中的 `media/chat_files/`、`media/room_icons/`，以及 `media/profile_pics/` 下除 `default.jpg` 以外的文件，共 96 个路径、约 41 MB。
- **保留**：3 个应用素材（`media/default.jpg`、`media/profile_pics/default.jpg`、`media/ai_avatar/ai_avatar.png`），这样 `v1-legacy` 仍然是完整的旧版代码。`.env` 只含默认配置，也不删。
- **做法**：在 `--no-local` 的镜像克隆里执行 `git filter-repo --invert-paths`（通过 `uvx` 运行）。推送前逐项核对：
  - 提交数量不变；
  - v2 最新提交的内容与改写前逐字节相同；
  - main 只少了 `media/` 下的文件；
  - 标签正确指向改写后的 main；
  - 仓库打包大小从约 35 MB 降到 264 KB。
- **推送**：以原子方式推送，main 使用 `--force-with-lease`（仅当远程仍是旧提交时才覆盖）。之后本地仓库也同步到了改写后的历史。
- **残留风险**：
  - GitHub 上已经没有任何分支或标签引用旧提交，但在 GitHub 做垃圾回收之前，知道旧提交号的人仍可能直接访问到它。如需彻底清除，要联系 GitHub Support。
  - 本地的 reflog 中还保留着旧提交，大约 30 天后会自动清掉，也可以手动执行 `git reflog expire --expire=now --all && git gc --prune=now` 立即清除。

## 待验证事项（结论出来后补成新的决策记录）

| 编号 | 事项 | 在哪个里程碑验证 |
|---|---|---|
| V-01 | DeepSeek 的五项实测：开启和关闭思考时能否调用工具、流式输出加工具调用、看图时图片怎么传、用量里有没有缓存命中字段、出错时怎么返回（见 06 第 6 节） | M4 |
| V-02 | AI SDK 的 `toolApproval` 能否和"修改后批准"配合 | M5 |
| V-03 | 本地向量模型能否达标，能否在 Bun 里运行 | M5 |
| V-04 | Better Auth 能否使用 uuid 主键和 UUIDv7 | M1 |
| V-05 | Better Auth 能否使用 `__Host-` 前缀的 Cookie | M1 / M7 |
| V-06 | 能否开启 Trusted Types | M7 |
| V-07 | Drizzle 1.0 是否已正式发布 | M1 |
