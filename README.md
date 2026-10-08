# ChatApp

一个**邀请制**的实时聊天应用，内置可以调用工具的 **Agent**，界面采用 Apple Liquid Glass 风格，桌面优先。

> **状态：v2 重写中。** 旧版（Django + Channels）保存在标签 [`v1-legacy`](../../tree/v1-legacy)。当前进度见 [docs/PROGRESS.md](docs/PROGRESS.md)。

*An invite-only real-time chat app with a built-in tool-using Agent and an Apple Liquid Glass–style desktop UI. v2 is a ground-up rewrite in progress; the legacy Django version lives at the `v1-legacy` tag.*

## 计划中的功能

- 频道、私有群组、一对一私信；消息的回复、编辑、撤回、@提及；支持图片、视频和文件
- 即时送达，显示"正在输入"、在线状态和未读数，断线后自动补发，多端同步
- Agent：总结未读、搜索和翻译消息、起草回复、看图；代发消息、建群等影响他人的操作需要批准；个人提醒显示结果并可撤销
- 可以安装成桌面应用（PWA），支持浏览器推送、深色模式、中英双语

M4 的只读助手已接入私有 Agent 会话、群/频道 `@Agent`、会话助手面板、⌘K 消息搜索和 `/总结`、`/翻译`、`/起草`。支持工具步骤、流式输出、停止、重新生成与用量查看；草稿由本人确认发送。审批操作、提醒、BYOK、记忆与语义搜索属于后续 M5。实现见 [M4 实施记录](docs/21-m4-implementation-2026-10-07.md)，修复后的本人复试与最新验证结果见 [M4 验收收尾](docs/23-m4-acceptance-2026-10-08.md)。

## 技术栈

TypeScript 7 · Bun · Hono · zod · Drizzle · PostgreSQL 18（pgvector）· Valkey · BullMQ · Garage（S3）· Better Auth · AI SDK（NUS SoCLaaS / GLM，D-182）· React 19 · Vite 8 · TanStack Router/Query · Tailwind CSS 4 · Base UI

## 本地开发

需要 [Bun](https://bun.sh) 1.4、Node 24 或更新（前端工具链需要）和 Docker Desktop。

```bash
bun install
bun run setup            # 生成 .env.local 和本地密钥（不会打印出来）
bun run infra:up         # 启动 Postgres、Valkey、Garage、Mailpit
bun run infra:bootstrap  # 初始化 Garage 的存储桶和访问密钥
bun run doctor           # 检查各项服务是否正常
bun run db:migrate       # 迁移，并创建无特权的应用数据库账号
bun run db:seed          # 仅开发：Agent 账号、保留名和 3 个演示成员
bun run dev              # api、worker 和前端一起启动；浏览器打开 http://localhost:5173
```

也可以分开启动：`bun run dev:api`（http://127.0.0.1:3100/api/docs）、`bun run dev:worker`、`bun run dev:web`。管理员用 `bun run admin:create` 创建；邮件在 Mailpit（http://localhost:8025）里看。

助手使用根目录 `.env.local` 的完整 `SOCLAAS_API_KEY`；默认 provider 为 SoCLaaS，快速/深度模型别名均为 `x-test-1`。检查接入用 `bun run doctor --ai` 和 `bun run test:m4:provider`；真实全量评测用 `bun run eval --concurrency 1`，人工标注校验用 `bun run eval:review <结果目录>`。评测使用独立临时数据库，并保存每次真实调用的账本；总结人工标注与用户试用仍须单独完成。

详见 [docs/09-local-dev.md](docs/09-local-dev.md)。后端骨架（M1a）已完成并验收；前端骨架（M1b：登录、注册、验证邮箱、找回密码、设置、应用外壳）已完成并验收；聊天功能的后端（M2a：会话、成员、消息、同步、实时提示、在线状态）已完成并验收；聊天界面（M2b：侧栏与会话页、时间线、输入栏、详情面板、Markdown 消息、断线补齐、本地网关测试）已完成并验收。路线图见 [docs/11-roadmap.md](docs/11-roadmap.md)。

## 文档

从 [docs/00-overview.md](docs/00-overview.md) 开始阅读。

设计原型（可点击的 HTML，D 阶段，已在 D4 确认）见 [design/README.md](design/README.md)；确认后的设计规范在 [docs/02-design-system.md](docs/02-design-system.md)。

最新规划已将两轮独立审查落实到规格、决策和阶段验收，见[本轮修订对照](docs/15-planning-rereview-2026-10-01.md)。当前进度与每项验收的证据见 [PROGRESS.md](docs/PROGRESS.md)：规划完成不表示功能已通过验收，以 PROGRESS 记录的实际运行证据为准。

## 许可证与来源

采用 [MIT](LICENSE) 许可证。v1 改编自 [rustyxlol/Django-ChatApp](https://github.com/rustyxlol/Django-ChatApp)（MIT），原作者的版权声明保留在 LICENSE 中。
