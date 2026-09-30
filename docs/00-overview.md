# ChatApp v2 总览

> 状态：规划定稿（M0），尚未开始编码。进度见 [PROGRESS.md](PROGRESS.md)。
> 最后更新：2026-09-30

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
| 用户拍板 | 邀请制注册；AI 先用 DeepSeek；先做桌面端；本地优先，最后上线；Apple 风格；技术栈只选"最新、最好"，不考虑熟悉程度 |
| 语言与运行时 | TypeScript 7 全栈；后端 Bun 1.4 + Hono 4 |
| 数据 | PostgreSQL 18（含 pgvector）+ Drizzle ORM；Valkey 9.1（事件总线、在线状态、限流、BullMQ 队列）；Garage（自托管 S3） |
| 认证 | Better Auth 1.7：邮箱密码 + Passkey，凭邀请码注册 |
| AI / Agent | AI SDK 7 的 `ToolLoopAgent`；按用户指定，目前只用 `deepseek-flash`（V4.1-Flash）：快速模式关闭思考，深度模式开启思考 |
| 前端 | React 19.3 + React Compiler、Vite 8、TanStack Router/Query、Tailwind 4、Base UI、react-virtuoso |
| 实时 | 写操作走 HTTP（带幂等键），WebSocket 只负责推送；每个会话维护序号（seq），断线后按序号补发 |
| 权限 | 一个 `authorize()`，HTTP、WebSocket、附件下载统一走它；身份只从服务端会话获取 |

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
| 站点角色 | 站点管理员或普通成员，数据库字段 `users.role` 分别取值 `'admin'` / `'user'`（Better Auth admin 插件的默认值） |
| `seq` | 会话内消息序号，新消息创建时 +1，永不改变，用于排序和计算未读 |
| `change_seq` | 会话内变更序号，任何消息的新增、编辑、撤回、删除都 +1，用于断线补发 |
| 注册邀请码 | 注册账号必需的一次性码，由站点管理员或成员生成 |
| 群邀请链接 | 加入某个群组的链接，只有已注册用户能用 |
| Agent / 助手 | 内置的 AI 机器人用户（`is_bot = true`），界面名称可配置，默认"助手" |
| run / step | Agent 的一次运行，以及其中的每一步（模型调用、工具调用、审批等） |
| 审批（approval） | 有副作用的 Agent 工具在执行前，需要调用者本人点"批准" |
