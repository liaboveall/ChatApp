# 09 本地开发环境

> 基础设施和工具链已在 2026-09-30 的"开发准备"中搭好并验证通过（验证方式：`bun run doctor`）。应用本身的脚本（`db:*`、`dev`、`test:*` 等）由 M1a 和 M1b 创建，**创建之前不要假定它们存在**。
> 开发机器：Windows 11。命令在 PowerShell 或 Git Bash 里都能运行。

## 1. 前置条件

| 工具 | 要求 | 本机状态（2026-09-30） |
|---|---|---|
| Bun | 与 `package.json` 中 `packageManager` 锁定的版本一致（1.4.2） | ✅ 已通过官方脚本安装到 `%USERPROFILE%\.bun\bin`，并写入了用户 PATH。**安装后新开的终端和编辑器才找得到 `bun`**，之前打开的需要重启 |
| Docker Desktop | Compose v2 及以上 | ✅ Docker 29.8.1，Compose 5.5.1 |
| Node | ≥ 24（Playwright、Storybook 等工具需要） | ✅ 26.8.1 |
| Git | 较新版本即可 | ✅ 本仓库已配置提交身份：`liaboveall <2628370933@qq.com>`，只在本仓库生效，没有改全局配置 |

**本机端口冲突**（两处都不要去关占用方）：
- **5432**：被原生的 PostgreSQL 服务占用 → 开发库用 **5434**。
- **1025**：被 Cisco VPN 客户端（`vpnagent`）占用 → Mailpit 的 SMTP 默认用 **2525**。2026-10-01 复核时，2525 落入 Windows 保留范围 2492–2591，本机已通过 `.env.local` 的 `SMTP_PORT` 改用 **12525**。

## 2. 首次搭建

```powershell
bun install                    # install dependencies; also installs the lefthook git hooks
bun run setup                  # create .env.local + infra/garage/garage.toml; generate local secrets (never printed)
bun run infra:up               # start postgres, valkey, garage, mailpit and wait until healthy
bun run infra:bootstrap        # Garage: layout + import key + buckets (idempotent)
bun run doctor                 # end-to-end checks; add --ai to also test the DeepSeek key
```

- **DeepSeek key**：打开 `.env.local`，自己填写 `DEEPSEEK_API_KEY=`，然后运行 `bun run doctor --ai` 验证。这个命令只调用免费的模型列表接口，不会打印 key。**不要把 key 发到聊天里，也不要提交到仓库。**
- **M1a 完成后**，接着执行 `bun run db:migrate`、`bun run db:seed`，再用 `bun run dev:api` 启动后端。
- **M1b 完成后**，用 `bun run dev` 同时启动前后端，然后打开 http://localhost:5173 。
- **收发邮件**：Mailpit 的网页界面在 http://localhost:8025 ，所有发出的邮件都会在这里显示。

## 3. 端口

| 服务 | 宿主机端口 | 说明 |
|---|---|---|
| web（Vite） | 5173 | M1b 起可用。会把 `/api` 和 `/ws` 代理到 3100，让前后端同源，Cookie 才能正常工作 |
| api | 3100 | M1a 起可用 |
| edge（Nginx） | 8443 | M2b 起可用。用生产站点配置提供一次构建产物，访问地址 `https://chat.localhost:8443`，用于 CSP 测试和彩排 |
| Postgres | **5434** → 容器内 5432 | 用户名 `chatapp`；开发库 `chatapp`，测试库 `chatapp_test`。两个库都已安装 `vector` 0.8.6 和 `pg_trgm` 1.6 |
| Valkey | 6379 | 开发用 db 0，测试用 db 1；配置为 `noeviction`，已开启 AOF。pub/sub 不区分 db，所以事件频道名带环境：`events:development`、`events:test`（D-044） |
| Garage | 3900（S3）、3903（管理接口） | region 为 `garage`；bucket `chatapp` 和 `chatapp-test` |
| Mailpit | **12525**（本机 SMTP）→ 容器内 1025；8025（网页界面） | Compose 从 `SMTP_PORT` 读取宿主机端口，模板默认 2525 |
| Storybook | 6006 | M1b 起可用 |

所有端口都只绑定在 `127.0.0.1` 上。

## 4. 基础设施：`infra/compose.dev.yml`

- **项目名**：`chatapp-dev`。
- **数据卷**：`chatapp-dev_pg`、`chatapp-dev_valkey`、`chatapp-dev_garage-meta`、`chatapp-dev_garage-data`。
- **postgres**：镜像 `pgvector/pgvector:0.8.6-pg18`，数据目录是 `/var/lib/postgresql/18/docker`，位于数据卷内。数据卷第一次初始化时，会执行 `infra/postgres/init/01-extensions.sql`：安装扩展并创建测试库。
- **valkey**：镜像 `valkey/valkey:9.1-alpine`。
- **garage**：镜像 `dxflrs/garage:v2.4.1`，配置文件由 `infra/garage/garage.toml.template` 渲染生成（生成的文件已被 git 忽略）。
- **mailpit**：镜像 `axllent/mailpit:v1.31.3`。
- **健康检查**：四个服务都有健康检查；`infra:up` 使用 `--wait`，会等所有服务变为健康状态后才返回。
- **持久化**：已实测 `infra:down` 之后再 `infra:up`，Postgres、Valkey 的数据及 Garage 的数据和配置都还在。Mailpit 使用临时数据库，没有持久卷，不能假定重启或重建后保留测试邮件。

## 5. 密钥与 Garage 初始化

- **`bun run setup`**：把 `.env.example` 复制为 `.env.local`，并为所有值为 `<generated>` 的项生成随机值，包括：
  - Postgres 密码和两个数据库连接串；
  - S3 访问密钥：key id 格式为 `GK` 加 24 位十六进制，secret 为 64 位十六进制；
  - Garage 的 RPC、管理、监控三个令牌；
  - Better Auth 密钥；
  - 演示账号的密码。
  
  已有的值不会被覆盖。值本身不会打印，终端里只显示生成了哪些项。
- **`bun run infra:bootstrap`**（可以重复执行）：
  1. 分配单节点布局：zone 为 `dc1`，容量 5G；
  2. 用 `garage key import` 导入 setup 生成的访问密钥，名称为 `chatapp-dev`；
  3. 创建 `chatapp` 和 `chatapp-test` 两个 bucket，并给这个密钥授予读、写和 owner 权限。
- **不要改 `POSTGRES_PASSWORD`**：Postgres 只在数据卷第一次初始化时读取这个密码。之后如果改了它，就连不上数据库了。需要换密码时，执行 `bun run infra:reset --yes`，再重新 `infra:up` 和 `infra:bootstrap`。

## 6. 环境变量文件

- **`.env.example`**：提交到仓库，列出所有变量及说明，不含真实密钥。
- **`.env.local`**：不提交，已被 `.gitignore` 忽略；`guard` 脚本也会拦截任何被 git 跟踪的 env 文件。它由 `bun run setup` 生成，只有 `DEEPSEEK_API_KEY` 需要自己填写。
- **读取方式**：
  - Bun 只会从**当前目录**自动加载 `.env.local`。在工作区子目录（比如 `apps/server`）里运行时，要显式传 `--env-file=../../.env.local`。M1a 在 `package.json` 的脚本里配好，同时确定测试使用哪些变量（比如 `DATABASE_URL_TEST`）。
  - 前端（M1b）：Vite 的 `envDir` 指向仓库根目录，`envPrefix` 设为 `VITE_PUBLIC_`，因此前端只能读取以它开头的变量。这些变量里不要放任何需要保密的内容。

## 7. 脚本清单（根目录 `package.json`）

### 故障测试环境（M1a计划新增，D-085）

现有chatapp_test、Valkey db1及chatapp-test桶只做不改实例状态的普通集成测试。M1a首次故障注入前创建`infra/compose.test.yml`与`test:infra:up`/`test:infra:down`/`test:fault`入口；目前这些文件/命令尚不存在。

- 每次生成随机runId，项目名chatapp-test-<runId>；独立Postgres/Valkey/Garage/Mailpit容器、卷、网络、密钥和loopback动态端口，不继承开发compose的name/container_name/卷/bind挂载。每个测试项目使用events:test:<runId>频道和独立实例标记。
- setup把实际容器ID、卷ID、networkID、端口和随机实例标记写入被忽略的本次运行manifest；DB/Valkey/S3各有可读标记。故障入口检查APP_ENV=test、project label、所有目标ID/标记、实际连接端点，不接受只凭库名或字符串前缀放行。
- stop/kill、全局flush/config、限内存、断网、磁盘故障只操作manifest列出的独立资源；验证失败立即停止。清理仅删除本run拥有的资源，禁止docker system prune/volume prune或模糊匹配。开发库中的哨兵及服务前后健康须保持不变（AT-34）。
- M3启用媒体时，Windows开发的worker也运行在Linux容器内，经内部网络访问开发依赖，与media共享私有Unix socket；不能假定宿主机Bun可访问Docker内Unix socket。故障套件使用同样的worker/media拓扑，凭据和卷仍隔离。纯后端热重载在M1a阶段可继续宿主机运行。
- M7本地删除journal使用第二套独立存储服务模拟故障；V-19最终证据仍须真实异地服务及原主机不可访问场景。只开本机第二桶不能证明灾难独立性。

### 命令状态

| 脚本 | 作用 | 状态 |
|---|---|---|
| `setup` | 生成 `.env.local`、本地密钥和 Garage 配置 | ✅ 可用 |
| `doctor` | 端到端检查环境（`--ai` 额外检查 DeepSeek key） | ✅ 可用 |
| `infra:up` / `infra:down` / `infra:ps` / `infra:logs` | 启动、停止、查看状态、查看日志 | ✅ 可用 |
| `infra:bootstrap` | 初始化 Garage | ✅ 可用 |
| `infra:reset --yes` | **删除所有开发数据卷**，不带 `--yes` 会拒绝执行 | ✅ 可用 |
| `lint` / `lint:fix` / `format` | Biome 检查、自动修复、格式化 | ✅ 可用 |
| `typecheck` | TS 7 类型检查（M1a 起覆盖所有工作区包） | ✅ 可用 |
| `guard` | 禁止 raw HTML 写法（SEC-05），禁止跟踪 env 文件和其他密钥文件 | ✅ 可用 |
| `check` | 依次运行 lint、typecheck、guard。M1a 起加入单元测试和集成测试。**提交前必须通过** | ✅ 可用 |
| `db:generate` / `db:migrate` / `db:check` / `db:seed` / `db:studio` | 数据库相关；seed 仅开发 | M1a |
| `db:bootstrap` | 生产也可用的幂等基础数据：机器人、保留名、配置；无演示账号 | M1a |
| `dev:api` / `dev:worker` | 启动后端开发服务 | M1a |
| `dev` / `dev:web` | 同时启动前后端 / 只启动前端 | M1b |
| `admin:create` / `admin:verify-email` | 创建管理员（密码在自己的终端里输入）/ 手动标记邮箱已验证 | M1a |
| `test` / `test:unit` / `test:integration` | 各层测试 | M1a 起 |
| `test:infra:up` / `test:infra:down` / `test:fault` | 每run独立拓扑、限定清理及故障矩阵 | M1a首次故障前新增 |
| `test:e2e` / `test:visual` | 端到端测试 / 视觉测试（在 Playwright 官方 Linux 镜像里运行，基线也在那里生成） | M1b 起 |
| `storybook` / `build` | 组件库、构建 | M1b |
| `edge:up` / `edge:down` | 用 Nginx 容器和生产站点配置提供一次构建产物 | M2b |
| `media:up` / `media:down` | worker容器与无网络media、私有IPC及资源限制；不重置开发依赖 | M3新增 |
| `eval` | Agent 评测 | M4 |

**Git 钩子**：lefthook 的 pre-commit 钩子会对暂存的文件运行 Biome（并自动修复）和 guard。

## 8. 仓库约定（Windows 相关）

- **换行符**：`.gitattributes` 设置了 `* text=auto eol=lf`，工作区和仓库里一律使用 LF。你全局配置里的 `core.autocrlf=true` 不影响这一点。
- **编辑器**：`.editorconfig` 统一 UTF-8、LF、2 空格缩进。
- **文件名**：一律小写，用连字符分隔。
- **生产部署**：使用 CI 构建的镜像，或者用 `git -c core.autocrlf=false archive` 打包源码。

## 9. 常见问题

| 现象 | 处理 |
|---|---|
| 终端提示找不到 `bun` | 刚装完 Bun 后，需要新开终端或重启编辑器（PATH 已经写入用户环境变量）。临时办法：`$env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"` |
| `infra:up` 提示连不上 Docker | 先启动 Docker Desktop，等它就绪 |
| `infra:up` 报 `ports are not available … 1025` | 1025 被 VPN 占用，已经改用 2525；如果还报错，检查 compose 文件是否是最新的 |
| Mailpit 显示 healthy，但 `doctor` 连不上；或启动时报端口访问权限错误 | 检查 `docker compose -f infra/compose.dev.yml --env-file .env.local ps` 是否有实际宿主机端口映射；用 `netsh interface ipv4 show excludedportrange protocol=tcp` 检查 Windows 保留范围。把 `.env.local` 的 `SMTP_PORT` 改为可绑定的端口，再运行 `bun run infra:up` 和 `bun run doctor`。端口变更会重建 Mailpit，需保留的测试邮件应先导出；不要停止 VPN 或重置其他服务的数据卷 |
| 连数据库被拒绝，或连到了别的库 | 端口要用 **5434**，5432 是本机原生的 PostgreSQL |
| 改了 `POSTGRES_PASSWORD` 后认证失败 | 见第 5 节：执行 `bun run infra:reset --yes`，然后重新 up 和 bootstrap |
| 在 Git Bash 里手动运行 `docker compose exec garage /garage …`，报错路径变成了 `C:/Program Files/Git/garage` | 这是 MSYS 的路径转换导致的，在命令前加 `MSYS_NO_PATHCONV=1`。项目里的脚本都通过 Bun 执行，不受影响 |
| Garage 报 layout 相关的错误 | 重新执行 `bun run infra:bootstrap` |
| S3 报签名错误 | 检查 `S3_ENDPOINT` 是否为 `http://localhost:3900`，`S3_REGION` 是否为 `garage` |
| 登录后 Cookie 不生效（M1b 起） | 必须通过 5173 端口访问（经过 Vite 代理），不要直接访问 3100 |
| 视觉测试的截图总是对不上 | 基线只在 Playwright 的 Linux 镜像里生成和比对，Windows 本机的字体不同。用 `bun run test:visual`，它会在容器里运行 |
| 开发服务和测试同时运行时，收到对方的事件 | 检查 `APP_ENV`：事件频道名按它区分（`events:development` / `events:test`） |
| 在手机上测试（v1.1 之后） | 通过局域网 IP 访问时，Passkey 和 Service Worker 要求 HTTPS。可以用 `edge:up` 的 Nginx 容器在本地提供 HTTPS，或者用内网穿透 |
