# ChatApp v2 总览

> 状态：M0 与规划完善完成，M1a、M1b、M2 与 M3 的验收及复核历史见 [PROGRESS.md](PROGRESS.md)。M4 已验收通过（总结事实审核的最后一处来源时间错误由用户决定作为门槛例外接受，D-196；远端 CI 与原生 ARM 通过），详见 [M4 验收收尾](23-m4-acceptance-2026-10-08.md)。M5–M8 尚未开始，各阶段 AT/V 和远端验证以实际证据为准。
> 最后更新：2026-10-08

## 一句话

一个**邀请制**的实时聊天应用，内置可以调用工具的 **Agent**。先做**桌面端**，界面走 **Apple Liquid Glass** 风格。先在本地完整跑通，**上线放在最后一步**。

## 背景

旧版（v1）是 Django + Channels 写的，2022 年从开源项目 [rustyxlol/Django-ChatApp](https://github.com/rustyxlol/Django-ChatApp)（MIT）改来。2026-09-30 做了全面分析，结论是：
- 在全新数据库上迁移失败，测试跑不起来，生产方式启动失败；
- 实测复现了 24 个安全和功能缺陷，其中包括"任何登录用户都能读取所有私信"。

因此决定**重写**，而不是修补。旧代码保存在 git 标签 `v1-legacy` 中（2026-09-30 清理历史时，用户上传的文件已从中移除）；缺陷清单见 [13-legacy-analysis.md](13-legacy-analysis.md)。

## 已定决策（摘要）

完整记录见 [12-decisions.md](12-decisions.md)。

| 类别 | 决定 |
|---|---|
| 用户拍板 | 邀请制注册；站点 AI 长期使用校方 SoCLaaS（D-182、D-186）；先做桌面端；本地优先，最后上线；Apple 风格；技术栈只选"最新、最好"，不考虑熟悉程度；内存只要不超过服务器总量；新成员看不到加入前的历史；"重新生成"替换原回复；站点 key 的 Agent 运行内容管理员可查看，鼓励用户自带 key |
| 语言与运行时 | TypeScript 7 全栈；后端 Bun 1.4 + Hono 4 |
| 数据 | PostgreSQL 18（含 pgvector）+ Drizzle ORM；Valkey 9.1（事件总线、在线状态、限流、BullMQ 队列）；Garage（自托管 S3） |
| 认证 | Better Auth 1.7：邮箱密码 + Passkey，凭邀请码注册 |
| AI / Agent | AI SDK 7 的 `ToolLoopAgent`；站点 SoCLaaS 的模型别名为 `x-test-1`，快速与深度都开启思考，逐 attempt 保存实际模型；DeepSeek 仅显式选择。M4 只读工具与站点 key 已接入，用户自带 key / 审批属 M5a；同库业务效果事务去重、持久 run / 取消、来源范围世代、调用前预算预占 |
| 前端 | React 19.3 + React Compiler、Vite 8、TanStack Router/Query、Tailwind 4、Base UI、virtua |
| 实时 | HTTP 写入与按权限读取；普通 WS 仅发变更提示，流式逐接收者授权；同步日志固定上界，前台周期对账；撤权不依赖订阅缓存 |
| 权限 | HTTP/WS用服务端session，后台用受限持久delegation；统一authorize和可见性投影（当前成员且消息在加入之后），搜索/Agent/附件共同遵守 |
| 数据 | Postgres 业务+work_items 同事务，Valkey 仅运输/瞬态层；完整副本清理、对象删除时限与恢复隔离；保留期见 04 第 10 节、01 第 4.11 节 |

## 文档地图

| 文档 | 内容 | 什么时候读 |
|---|---|---|
| [PROGRESS.md](PROGRESS.md) | 当前进度、下一步、会话交接记录 | **每次开工先读** |
| [01-product-spec.md](01-product-spec.md) | 功能范围、行为规则、权限矩阵、默认值 | 做任何功能前 |
| [02-design-system.md](02-design-system.md) | Apple 风格设计规范、布局、令牌、组件清单 | 做设计与前端时 |
| [03-architecture.md](03-architecture.md) | 技术栈版本、目录结构、分层、关键流程 | 写代码前 |
| [04-data-model.md](04-data-model.md) | 表结构、约束、不变量 | 动数据库时 |
| [05-api-and-realtime.md](05-api-and-realtime.md) | REST 接口、错误格式、WebSocket 协议 | 写接口与前端数据层时 |
| [06-agent.md](06-agent.md) | Agent 入口、工具、运行机制、安全、评测 | M4、M5 |
| [07-security.md](07-security.md) | 威胁模型、安全要求（SEC 编号） | 每个里程碑验收前 |
| [08-testing.md](08-testing.md) | 测试策略、CI、完成标准 | 每次提交前 |
| [09-local-dev.md](09-local-dev.md) | 本地开发环境、端口、脚本 | 搭环境时 |
| [10-deployment.md](10-deployment.md) | 生产彩排（M7）与上线（M8） | M7、M8 |
| [11-roadmap.md](11-roadmap.md) | 里程碑任务、验收标准、会话划分 | 每个里程碑开始时 |
| [12-decisions.md](12-decisions.md) | 决策记录（含未选方案及原因） | 想改决策时 |
| [13-legacy-analysis.md](13-legacy-analysis.md) | 旧版缺陷清单（回归测试来源） | 写安全测试时 |
| [14-planning-review-2026-10-01.md](14-planning-review-2026-10-01.md) | 历史独立审查与 F01–F24 修订对照 | 核对设计变更与尚待实施的验收时 |
| [15-planning-rereview-2026-10-01.md](15-planning-rereview-2026-10-01.md) | 第二次独立复审及R01–R12/五项一致性问题的设计修订对照 | 核对D-076–D-092与阶段验收时 |
| [21-m4-implementation-2026-10-07.md](21-m4-implementation-2026-10-07.md) | M4 全量实现、原真实评测与证据边界 | 核对 M4 实现时 |
| [22-trial-fixes-2026-10-07.md](22-trial-fixes-2026-10-07.md) | 八项试用反馈、侧栏预览补修与本人复试确认 | 核对试用修复时 |
| [23-m4-acceptance-2026-10-08.md](23-m4-acceptance-2026-10-08.md) | 最新源码回归、真实评测、总结事实审核与验收收尾 | 完成 M4 验收或交接时 |

**文档冲突时的处理：** 先修正文档，再写代码，不要静默选其中一份。优先级为：用户最新指示 > 12-decisions > 其他规格文档。

## 术语

| 术语 | 含义 |
|---|---|
| 会话（conversation） | 消息的容器，分四种（`kind`）：频道 `channel`、群组 `group`、私信 `dm`、Agent 会话 `agent` |
| 频道 | 站内所有成员可见、可自由加入的公开会话 |
| 群组 | 私有会话，只能被邀请或通过群邀请链接加入 |
| 私信 | 两个人之间的会话，每对用户只有一个 |
| Agent 会话 | 用户与 Agent 的私有对话，一个用户可以有多个 |
| 成员关系（membership） | 用户与会话的关系，带会话内角色：群主 `owner`、管理员 `admin`、成员 `member` |
| 站点角色 | 站点管理员或普通成员，数据库字段 `users.role` 分别取值 `'admin'` / `'user'`（由应用 domain 管理，不开放原生 admin 端点） |
| `seq` | 会话内消息序号，新消息创建时 +1，永不改变，用于排序和计算未读 |
| `change_seq` | 会话内变更序号，任何消息的新增、编辑、撤回、删除都 +1，用于同步日志与消息版本合并 |
| `visible_from_seq` | 成员加入时会话的 `last_seq`。成员只能看到 seq 比它大的消息，即加入之后的消息 |
| 会话封禁 | 被"移出并封禁"的人不能再以任何方式加入这个会话，直到解除封禁 |
| 站点 key / 自带 key | 当前站点提供的 SoCLaaS key / 用户自带的 provider key（M5a）。前者的运行内容管理员可查看，私有自带 key 内容不可以 |
| 注册邀请码 | 注册账号必需的一次性码，由站点管理员或成员生成 |
| 群邀请链接 | 加入某个群组的链接，只有已注册用户能用 |
| Agent / 助手 | 内置的 AI 机器人用户（`is_bot = true`），界面名称可配置，默认"助手" |
| run / step | Agent 的一次运行，以及其中的每一步（模型调用、工具调用、审批等） |
| 审批（approval） | 有副作用的 Agent 工具在执行前，需要调用者本人点"批准" |
| 持久委托（delegation） | 后台任务的受限授权，绑定来源设备、账号/恢复世代、目标与参数；普通退出和安全撤销行为不同 |
| 实体版本 / 同步水位 | 前者决定是否接受响应中的某组字段，后者证明日志已完整消费，不能互相替代 |
| 私有BYOK来源 | 私有自带key对话及派生数据，不能自动带入site运行；用户主动发布的共享消息按普通权限处理 |
| 删除journal | 确认删除前写入独立异地的加密意图链；恢复必须重放，缺证据保持隔离 |
