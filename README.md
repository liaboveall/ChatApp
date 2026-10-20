# ChatApp

[在线使用](https://chatapp.software) · [开发指南](docs/09-local-dev.md) · [部署与运维](docs/10-deployment.md) · [文档索引](docs/00-overview.md)

邀请制实时聊天应用，内置可调用工具的 AI 助手。支持频道、群组、私信和文件分享，采用 Apple Liquid Glass 风格，提供中英双语、深浅主题和可安装的 PWA。

*An invite-only chat app with real-time messaging, a tool-using AI assistant, and an installable bilingual web client.*

## 功能

- **聊天**：频道、私有群组、一对一私信；回复、编辑、撤回、提及、未读、在线状态和正在输入提示；断线补齐与多端同步。
- **媒体**：图片、视频和文件上传，缩略图、预览、下载和头像；媒体在独立容器中处理。
- **AI 助手**：私有对话、会话面板、群内 `@Agent`、消息搜索、总结、翻译、起草和图片理解；支持流式输出、停止、重新生成。
- **工具与个人设置**：有副作用的助手操作需审批；支持提醒、定时消息、个人密钥（BYOK）、记忆、语义搜索和用量管理。
- **桌面与通知**：PWA、浏览器推送、通知中心、键盘快捷键、中英双语及外观设置。
- **管理与安全**：邀请注册、邮箱验证、Passkey、成员权限、举报、审计、账号注销，以及备份、删除 journal 和隔离恢复。

新成员只能查看加入后的消息。助手与搜索、附件共用权限规则；站点密钥与个人密钥的内容范围分别管理。具体行为见[产品规格](docs/01-product-spec.md)和[安全规范](docs/07-security.md)。AI、邮件、推送和向量检索的可用性取决于实例配置。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | React、Vite、TanStack Router / Query、Tailwind CSS、Base UI |
| 服务端 | TypeScript、Bun、Hono、Zod、Better Auth、AI SDK |
| 数据与任务 | PostgreSQL / pgvector、Drizzle、Valkey、BullMQ |
| 文件与媒体 | Garage（S3）、独立媒体容器 |
| 部署 | Docker Compose、Nginx、加密异地备份、systemd |

依赖版本以各工作区 `package.json`、`bun.lock` 和 `infra/` 中的镜像定义为准。

## 本地运行

需要 Bun **1.4.2**、Node.js **24 或更新版本**（CI 使用 26）和 Docker Compose。Windows 推荐在 WSL 的 Linux 文件系统中开发，并启用 Docker Desktop 的 WSL 集成。

```bash
git clone https://github.com/liaboveall/ChatApp.git
cd ChatApp
bun install --frozen-lockfile
bun run setup
bun run infra:up
bun run infra:bootstrap
bun run db:migrate
bun run db:seed
bun run admin:create
bun run dev
```

打开终端 `[dev] Open` 显示的地址。默认是 `http://localhost:5173`；遇到 Windows 保留端口时会自动选择可用端口。开发邮件可在 `http://localhost:8025` 查看。

`setup` 生成被 Git 忽略的 `.env.local` 和本地密钥；`db:seed` 仅用于开发数据。AI 凭据由维护者在本机配置，接入检查用 `bun run doctor --ai`。生产环境使用独立配置和 `db:bootstrap`，操作步骤见[部署指南](docs/10-deployment.md)。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `bun run check` | 格式、类型、架构边界、单元测试、对比度和双语文案一致性 |
| `bun run build` | 构建前端生产包 |
| `bun run test:integration` | 真实数据库、缓存和对象存储的集成回归 |
| `bun run test:e2e` | 真实服务的浏览器端到端测试 |
| `bun run test:review` | 审查问题的组件浏览器回归 |
| `bun run test:visual` | Storybook 视觉回归 |
| `bun run storybook` | 组件开发与预览 |
| `bun run doctor` | 本地环境与服务诊断 |

集成及浏览器测试需要先准备测试环境，共享测试库的套件应串行执行；详见[测试指南](docs/08-testing.md)。

## 项目结构

```text
apps/web/           Web / PWA 客户端、组件与浏览器测试
apps/server/        API、WebSocket、后台任务、Agent、管理 CLI 与评测
apps/media/         隔离媒体处理服务
packages/contracts/ 前后端共享的输入校验与协议
packages/db/        数据模型、完整迁移链、初始化与开发种子
infra/              Compose、镜像、Nginx 与 systemd 模板
scripts/            开发、测试、发布、备份恢复及诊断工具
docs/               当前维护文档
```

## 版本与归档

`main` 是当前上线版本的维护主线（原 `v2`）。旧版 Django + Channels 保存在只用于历史查阅的 [`archive/v1` 分支](https://github.com/liaboveall/ChatApp/tree/archive/v1)和 [`v1-legacy` 标签](https://github.com/liaboveall/ChatApp/tree/v1-legacy)。

上线前的规划、阶段报告、审查记录及 HTML 设计原型，完整保存在 [`v2-pre-cleanup-2026-10-20` 标签](https://github.com/liaboveall/ChatApp/tree/v2-pre-cleanup-2026-10-20)。归档与维护说明见[维护记录](docs/maintenance.md)。

## 许可证

[MIT](LICENSE)。旧版改编自 [rustyxlol/Django-ChatApp](https://github.com/rustyxlol/Django-ChatApp)，原作者的版权声明保留在许可证中。
