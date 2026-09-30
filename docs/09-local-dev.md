# 09 本地开发环境

> 本文件描述的是**目标环境**，由 M1 负责搭建。在对应脚本真正写好之前，不要假定这些命令已经存在。
> 开发机器：Windows 11。编辑器随意。所有命令都可以在 PowerShell 或 Git Bash 中运行。

## 1. 前置条件

| 工具 | 要求 | 2026-09-30 本机状态 |
|---|---|---|
| Bun | ≥ 1.4（用 `package.json` 的 `packageManager` 锁定具体版本） | **未安装**。官方安装方式：`powershell -c "irm bun.sh/install.ps1 \| iex"`，也可以用 `winget install Oven-sh.Bun`。安装前先征得用户同意 |
| Docker Desktop | 带 Compose v2 以上 | Compose 客户端版本为 5.5.1；**Docker 引擎当时没有运行**，开发前需要先启动 Docker Desktop |
| Node | ≥ 24（Playwright、Storybook 等工具需要） | 已安装 26.8.1 |
| Git | 任意较新版本 | 已安装 |

**端口冲突提醒**：本机有一个原生的 PostgreSQL 服务占用了 5432 端口，**不要停掉它**。开发用的 Postgres 容器映射到 **5434**。

## 2. 首次搭建（M1 完成后的样子）

```powershell
bun install                    # install all workspaces
bun run setup                  # create .env.local from .env.example, generate local secrets (never printed)
# → open .env.local and fill DEEPSEEK_API_KEY yourself (needed from M4; leave empty before that)
bun run infra:up               # docker compose -f infra/compose.dev.yml up -d --wait
bun run infra:bootstrap        # Garage: layout + key + bucket (idempotent); writes S3 keys into .env.local
bun run db:migrate             # apply migrations
bun run db:seed                # demo users/channels/messages (dev only)
bun run dev                    # web :5173 + api :3100 + worker, with hot reload
```

- 浏览器打开 http://localhost:5173 ，用种子数据里的演示账号登录（用户名见 `packages/db/seed/README.md`，密码是 `.env.local` 中的 `SEED_DEMO_PASSWORD`）。
- 注册、验证邮箱、找回密码的邮件都在 Mailpit 里查看：http://localhost:8025 。
- 开发环境下的 API 文档：http://localhost:5173/api/docs （由 Scalar 渲染）。

## 3. 端口

| 服务 | 端口 | 说明 |
|---|---|---|
| web（Vite） | 5173 | 把 `/api` 和 `/ws` 代理到 3100，因此前后端同源，Cookie 可以正常工作 |
| api | 3100 | |
| Postgres | **5434** → 容器内 5432 | 用户名 `chatapp`，库名 `chatapp`，测试库 `chatapp_test` |
| Valkey | 6379 | 开发用 db 0，测试用 db 1 |
| Garage | 3900（S3 接口）、3903（管理接口） | 开发用 bucket `chatapp`，测试用 `chatapp-test` |
| Mailpit | 1025（SMTP）、8025（网页界面） | |
| Storybook | 6006 | `bun run storybook` |

## 4. `infra/compose.dev.yml` 要点

- **项目名**：`chatapp-dev`。
- **数据卷**：`chatapp-dev_pg`、`chatapp-dev_valkey`、`chatapp-dev_garage`。
- **各个服务**：
  - `postgres`：镜像 `pgvector/pgvector:0.8.6-pg18`；带健康检查 `pg_isready`；第一次启动时，由初始化脚本额外创建测试库 `chatapp_test`，并安装 `vector` 和 `pg_trgm` 扩展。
  - `valkey`：镜像 `valkey/valkey:9.1-alpine`；启动参数 `--appendonly yes --maxmemory-policy noeviction`。
  - `garage`：镜像 `dxflrs/garage:v2.4.1`；配置文件 `infra/garage/garage.toml` 由 setup 脚本根据模板生成，里面的 `rpc_secret` 和 `admin_token` 都是随机值，这个文件不提交到仓库。
  - `mailpit`：镜像 `axllent/mailpit`。
- **端口只绑定到 `127.0.0.1`**，不对局域网开放。

## 5. Garage 初始化（`bun run infra:bootstrap`，可以重复执行）

1. 读取节点 id，执行 `garage layout assign -z dc1 -c 5G <node>`，再执行 `garage layout apply`。
2. 创建访问密钥 `chatapp-dev`，以及两个 bucket：`chatapp` 和 `chatapp-test`，并授予读写权限。
3. 把生成的 S3 访问密钥写入 `.env.local`，**不在终端里打印**。
4. 已经初始化过的步骤会自动跳过。

具体命令以 Garage v2 的文档为准。

## 6. 环境变量文件

- `.env.example`：提交到仓库。列出所有变量，附带说明和示例值，但不含真实密钥。
- `.env.local`：**不提交**，已在 `.gitignore` 中。由 `bun run setup` 生成，只有 `DEEPSEEK_API_KEY` 需要用户自己填写。
- `apps/server` 和 `apps/web` 都从仓库根目录读取环境变量。前端只能拿到带 `VITE_PUBLIC_` 前缀的变量，而且不应该有任何需要保密的内容。
- API key 等密钥**不要**贴在聊天里，也不要写进任何提交。

## 7. 脚本清单（在根目录 `package.json` 中，由 M1 创建）

| 脚本 | 作用 |
|---|---|
| `setup` | 首次初始化：生成 `.env.local`、本地密钥和 Garage 配置 |
| `infra:up` / `infra:down` / `infra:logs` | 启动、停止基础服务，查看日志 |
| `infra:bootstrap` | 初始化 Garage |
| `infra:reset` | **删除开发数据卷**。会丢失本地数据，执行前必须确认 |
| `db:generate` / `db:migrate` / `db:check` / `db:seed` / `db:studio` | 生成迁移、执行迁移、检查一致性、写入种子数据、打开 Drizzle Studio |
| `dev` | 同时启动 web、api、worker |
| `dev:web` / `dev:api` / `dev:worker` | 分别单独启动 |
| `lint` / `format` | Biome 检查 / 格式化 |
| `typecheck` | TS 7 类型检查（所有包） |
| `test` / `test:unit` / `test:integration` / `test:e2e` / `test:visual` | 各层测试 |
| `check` | lint、typecheck、单元测试、集成测试一起跑（提交前必须跑） |
| `eval` | Agent 评测（需要 DeepSeek key，会产生费用） |
| `storybook` | 组件目录 |
| `build` | 构建生产版本 |
| `admin:create` | 交互式创建站点管理员，密码在终端里输入 |

## 8. 仓库约定（Windows 相关）

- `.gitattributes` 中设置 `* text=auto eol=lf`，统一使用 LF 换行符。本地的 `core.autocrlf` 设置不影响这一点。
- 文件名一律用小写，以连字符分隔，避免在 Linux CI 上因大小写问题出错。
- 生产环境部署时，用 `git -c core.autocrlf=false archive` 打包，或者直接使用 CI 构建的镜像。

## 9. 常见问题

| 现象 | 处理 |
|---|---|
| `bun run infra:up` 报错连不上 Docker | 先启动 Docker Desktop，等它就绪后再执行 |
| 连接数据库时拒绝访问，或连到了别的库 | 检查 `DATABASE_URL` 的端口是不是 **5434**（5432 是本机原生的 PostgreSQL） |
| 登录后 Cookie 不生效 | 必须通过 5173 端口访问（Vite 代理），不要直接访问 3100 |
| 收不到验证邮件 | 打开 Mailpit（8025）查看；确认 `SMTP_PORT` 是 1025 |
| Garage 报 layout 相关的错误 | 重新执行 `bun run infra:bootstrap` |
| 上传时 S3 报签名错误 | 检查 `S3_ENDPOINT` 是否为 `http://localhost:3900`，以及 region 是否与 garage.toml 一致 |
| 在手机上测试（v1.1 以后） | Passkey、Service Worker 在局域网 IP 下需要 HTTPS，用 `infra/caddy` 在本地起 HTTPS，或者用内网穿透 |
