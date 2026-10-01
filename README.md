# ChatApp

一个**邀请制**的实时聊天应用，内置可以调用工具的 **Agent**，界面采用 Apple Liquid Glass 风格，桌面优先。

> **状态：v2 重写中。** 旧版（Django + Channels）保存在标签 [`v1-legacy`](../../tree/v1-legacy)。当前进度见 [docs/PROGRESS.md](docs/PROGRESS.md)。

*An invite-only real-time chat app with a built-in tool-using Agent and an Apple Liquid Glass–style desktop UI. v2 is a ground-up rewrite in progress; the legacy Django version lives at the `v1-legacy` tag.*

## 计划中的功能

- 频道、私有群组、一对一私信；消息的回复、编辑、撤回、@提及；支持图片、视频和文件
- 即时送达，显示"正在输入"、在线状态和未读数，断线后自动补发，多端同步
- Agent：总结未读、搜索和翻译消息、起草回复、看图；代发消息、建群等影响他人的操作需要批准；个人提醒显示结果并可撤销
- 可以安装成桌面应用（PWA），支持浏览器推送、深色模式、中英双语

## 技术栈

TypeScript 7 · Bun · Hono · zod · Drizzle · PostgreSQL 18（pgvector）· Valkey · BullMQ · Garage（S3）· Better Auth · AI SDK（DeepSeek）· React 19 · Vite 8 · TanStack Router/Query · Tailwind CSS 4 · Base UI

## 本地开发

需要 [Bun](https://bun.sh) 1.4 和 Docker Desktop。

```bash
bun install
bun run setup            # 生成 .env.local 和本地密钥（不会打印出来）
bun run infra:up         # 启动 Postgres、Valkey、Garage、Mailpit
bun run infra:bootstrap  # 初始化 Garage 的存储桶和访问密钥
bun run doctor           # 检查各项服务是否正常
```

详见 [docs/09-local-dev.md](docs/09-local-dev.md)。应用本身的代码还在开发中，路线图见 [docs/11-roadmap.md](docs/11-roadmap.md)。

## 文档

从 [docs/00-overview.md](docs/00-overview.md) 开始阅读。

最新规划已将两轮独立审查落实到规格、决策和阶段验收，见[本轮修订对照](docs/15-planning-rereview-2026-10-01.md)。下一步为设计原型与M1a认证切片；规划完成不表示应用功能或故障验收已经通过。

## 许可证与来源

采用 [MIT](LICENSE) 许可证。v1 改编自 [rustyxlol/Django-ChatApp](https://github.com/rustyxlol/Django-ChatApp)（MIT），原作者的版权声明保留在 LICENSE 中。
