# 本地开发

## 1. 环境

- Bun 1.4.2，版本声明在根 `package.json`。
- Node.js 24 或更新版本；CI 使用 26。
- Docker Engine / Docker Desktop 与 Compose。
- Windows 推荐 WSL，在 Linux 文件系统中克隆，启用 Docker Desktop 的 WSL 集成。不要混用 Windows 与 Linux 的 `node_modules`。

## 2. 初始化

在仓库根目录运行：

```sh
bun install --frozen-lockfile
bun run setup
bun run infra:up
bun run infra:bootstrap
bun run doctor
bun run db:migrate
bun run db:seed
bun run admin:create
```

`setup` 根据 `.env.example` 生成 `.env.local`、缺失的随机密钥和 Garage 配置，已有凭据保持不变。数据库已有数据卷时不要重新生成数据库密码。`db:migrate` 同时准备低权限应用角色；`db:seed` 只用于开发，会创建助手、演示成员和会话。管理员密码在自己的终端隐藏输入。

首次使用 Playwright：

```sh
cd apps/web
bun x playwright install --with-deps chromium webkit firefox
```

后续命令从仓库根目录执行。

## 3. 启动与停止

```sh
bun run dev
bun run dev -- api web
bun run dev -- api worker pwa
bun run storybook
```

默认启动 API、容器化 worker 和 Web；已启用向量检索时同时启动 embeddings。PWA 模式使用生产构建，适合安装与真实推送检查。Ctrl+C 结束当前启动流程及其拥有的子进程和容器；切换 Web / PWA 模式前先结束原流程。

| 服务 | 默认入口 |
| --- | --- |
| Web | `http://localhost:5173`；以 `[dev] Open` 输出为准 |
| API / 开发文档 | `http://127.0.0.1:3100/api/docs` |
| PWA | `http://localhost:25173` |
| Mailpit | `http://localhost:8025` |
| Storybook | `http://localhost:6006` |

浏览器使用 `localhost`；API、worker 与前端必须使用一致的 `APP_ORIGIN`。Windows 保留端口会随环境变化，`dev` 与 `infra:up` 会检测端口并验证实际发布结果。

基础服务可用 `infra:ps`、`infra:logs` 排查，`infra:down` 停止。修改 PostgreSQL / Valkey / SMTP 主机端口后重新运行 `setup` 与 `infra:up`，并检查 `docker port`。`infra:reset --yes` 会删除本地数据，只在明确需要重置且获授权时使用。

## 4. AI 与向量检索

在自己的 `.env.local` 中填写所选 provider 的凭据。站点默认使用 SoCLaaS，模型别名由 `AI_MODEL_FAST` / `AI_MODEL_DEEP` 指定；配置缺失或失败不会自动切换到付费 provider。

```sh
bun run doctor --ai
bun run test:m4:provider
```

第二条会实际请求所配置的模型。完整评测用 `bun run eval --concurrency 1`，审核入口为 `bun run eval:review <结果目录>`；它们使用独立数据，保留真实调用账本。离线模型的准备与核验入口为 `bun run embeddings`；不要把本机缓存当作已验证的离源恢复材料。

## 5. 测试与构建

```sh
bun run check
bun run build
bun run db:migrate:test
bun run test:integration
```

前两项无需启动基础服务；后两项需要初始化完成的开发基础设施。测试库与开发库分开，共享测试库的套件串行运行。浏览器、媒体、网关及视觉回归见[测试指南](08-testing.md)。

改动双语文案后用 `bun run web:messages` 生成；设计令牌在 `apps/web/src/design/tokens.ts`，用 `bun run design:contrast` 检查。Storybook 是当前组件预览入口，历史 HTML 原型在归档标签中。

生产使用独立配置、数据与发布包，见[部署指南](10-deployment.md)。本地 `.env.local`、`.test-runs/`、运行账本与恢复材料均不提交。
