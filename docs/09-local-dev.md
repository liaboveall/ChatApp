# 09 本地开发环境

> 基础设施和工具链已在 2026-09-30 的"开发准备"中搭好并验证通过（验证方式：`bun run doctor`）。M1a 的后端脚本（`db:*`、`dev:api`、`dev:worker`、`admin:*`、`test`、`test:integration`、`test:infra:*`、`test:fault`）已可用，见第 7 节；`dev`、`dev:web`、`test:e2e` 等前端相关脚本由 M1b 创建，**创建之前不要假定它们存在**。
> 开发环境：自 2026-10-01 起在 **WSL（Ubuntu 26.04）** 中进行（D-093）。仓库在 `/home/mars/projects/ChatApp`，命令都在 WSL 的 bash 里运行；Docker 用 Docker Desktop 的 WSL 集成。Windows 上的 `D:\ChatApp` 已停用。

## 1. 前置条件

| 工具 | 要求 | 本机状态（2026-10-01，WSL） |
|---|---|---|
| Bun | 与 `package.json` 中 `packageManager` 锁定的版本一致（1.4.2） | ✅ 装在 `~/.bun/bin`（下载官方发布包并核对 SHA256），PATH 写在 `~/.bashrc`；`~/.local/bin/bun` 另有一个软链接，让非交互的登录 shell 和 git 钩子也找得到。**新装后要新开终端（或 `source ~/.bashrc`）才找得到 `bun`** |
| Docker Desktop | Compose v2 及以上；在 Docker Desktop 的 Settings → Resources → WSL integration 里对 Ubuntu 打开集成 | ✅ Docker 29.8.1，Compose 5.5.1。WSL 里的 `docker` 与 Windows 共用同一个引擎、容器和数据卷 |
| Node | ≥ 24（Playwright、Storybook 等工具需要） | ✅ 26.8.1（与迁移前 Windows 上的版本相同），装在 `~/.local/share/node`，软链接在 `~/.local/bin` |
| Git | 较新版本即可 | ✅ 2.53.0。本仓库已配置提交身份：`liaboveall <2628370933@qq.com>`，只在本仓库生效，没有改全局配置 |

**本机端口冲突**（两处都不要去关占用方）。冲突发生在 **Windows 主机**上：Docker Desktop 把容器端口发布在 Windows 主机上，所以搬到 WSL 后依然适用。2026-10-01 迁移时核对过：开发端口由 Windows 上的 `com.docker.backend` 发布，5432 由 Windows 上的 `postgres` 进程监听。
- **5432**：被 Windows 上原生的 PostgreSQL 服务占用 → 开发库用 **5434**。
- **1025**：被 Cisco VPN 客户端（`vpnagent`）占用 → Mailpit 的 SMTP 默认用 **2525**。2026-10-01 复核时，2525 落入 Windows 保留范围 2492–2591，本机已通过 `.env.local` 的 `SMTP_PORT` 改用 **12525**。

## 2. 首次搭建

```bash
bun install                    # install dependencies; also installs the lefthook git hooks
bun run setup                  # create .env.local + infra/garage/garage.toml; generate local secrets (never printed)
bun run infra:up               # start postgres, valkey, garage, mailpit and wait until healthy
bun run infra:bootstrap        # Garage: layout + import key + buckets (idempotent)
bun run doctor                 # end-to-end checks; add --ai to also test the DeepSeek key
```

- **DeepSeek key**：打开 `.env.local`，自己填写 `DEEPSEEK_API_KEY=`，然后运行 `bun run doctor --ai` 验证。这个命令只调用免费的模型列表接口，不会打印 key。**不要把 key 发到聊天里，也不要提交到仓库。**
- **后端（M1a 已完成）**，接着执行：
  ```bash
  bun run db:migrate         # 以拥有者账号迁移，并创建/授权无特权的应用账号 chatapp_app
  bun run db:seed            # 仅开发：bootstrap（Agent 账号、保留名）加 3 个演示成员（密码取自 SEED_DEMO_PASSWORD）
  bun run dev:api            # API 与 WebSocket，127.0.0.1:3100，热重载
  bun run dev:worker         # 另一个终端：派发器、邮件队列、定时对账与清理
  ```
  正式管理员用 `bun run admin:create --email <邮箱> --username <用户名> --name <显示名>`，密码在你自己的终端里输入（不回显，不经过聊天）。接口文档在 http://127.0.0.1:3100/api/docs（仅开发与测试环境）。
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
  - Bun 只会从**当前目录**自动加载 `.env.local`，而且 `bun test`（`NODE_ENV=test`）根本不自动加载它。所以根目录的脚本都显式传 `--env-file=.env.local`；测试的 `APP_ENV=test` 由 `bunfig.toml` 的 preload 强制设置，配置加载器在测试环境下改用 `DATABASE_(OWNER_)URL_TEST`、`VALKEY_URL_TEST`、`S3_BUCKET_TEST`，并拒绝库名不以 `_test` 结尾、与开发共用 Valkey 库号或桶的配置。
  - 前端（M1b）：Vite 的 `envDir` 指向仓库根目录，`envPrefix` 设为 `VITE_PUBLIC_`，因此前端只能读取以它开头的变量。这些变量里不要放任何需要保密的内容。

## 7. 脚本清单（根目录 `package.json`）

### 故障测试环境（M1a ✅，D-085、D-103）

现有 chatapp_test、Valkey db1 及 chatapp-test 桶只做不改实例状态的普通集成测试（`bun run test:integration`）。所有 stop/kill、FLUSHALL、限内存、断网、磁盘类故障只在 `infra/compose.test.yml` 起的独立实例里做：

- `bun run test:infra:up`：生成 runId，起 compose 项目 `chatapp-test-<runId>`（独立 Postgres/Valkey/Garage/Mailpit 容器、卷、网络，随机密码，每次运行选定后固定的随机回环端口），跑迁移与 bootstrap，写入随机实例标记，生成 `.test-runs/<runId>/manifest.json`（权限 600，已被 git 忽略）。`bun run test:infra:down <runId>`（或 `--latest`）只拆除这一个项目；清单核验不过就什么也不删，容器已停止（比如 Docker Desktop 重启后）也能拆。
- `bun run test:fault`：起一个新实例，跑 `apps/server/test/fault`，无论结果都拆除。故障套件先 `verifyFaultTarget`：`APP_ENV=test`、project 与 run-id 标签、完整容器 id、卷/网络标签、只绑 127.0.0.1 且无开发端口、库名 `chatapp_test`、三个服务里读回的随机标记；动作只经 `act()` 并每次重新核对标签。AT-34 的 11 项（开发服务带哨兵、伪造目标全部被拒、清理不越界）在这里。
- 不使用 `docker system prune` / `volume prune` 或按名字前缀删除；不继承开发 compose 的 name、container_name、卷或 bind 挂载。
- M3 启用媒体时，本地开发的 worker 也运行在 Linux 容器内，经内部网络访问开发依赖，与 media 共享私有 Unix socket；不能假定宿主机 Bun 可访问 Docker 内 Unix socket。故障套件使用同样的 worker/media 拓扑，凭据和卷仍隔离。纯后端热重载在 M1a 阶段继续在宿主机运行。
- M7 本地删除 journal 使用第二套独立存储服务模拟故障；V-19 最终证据仍须真实异地服务及原主机不可访问场景。只开本机第二桶不能证明灾难独立性。

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
| `check` | 依次运行 lint、typecheck（所有工作区包）、guard（含架构边界检查）、单元测试（不需要任何服务）。**提交前必须通过** | ✅ 可用 |
| `db:generate` / `db:migrate` / `db:migrate:test` / `db:check` | 生成迁移 / 以拥有者迁移并授权应用账号（开发库 / 测试库）/ drizzle-kit 一致性检查 | ✅ 可用 |
| `db:seed` | 仅开发：bootstrap 加 3 个演示成员（`db:studio` 未创建） | ✅ 可用 |
| `db:bootstrap` / `db:bootstrap:test` | 生产也可用的幂等基础数据：Agent 账号、保留名、bootstrap 标记；无演示账号 | ✅ 可用 |
| `dev:api` / `dev:worker` | 启动后端开发服务（API 与 WebSocket / 派发器、邮件队列、对账、清理） | ✅ 可用 |
| `dev` / `dev:web` | 同时启动前后端 / 只启动前端 | M1b |
| `admin:create` / `admin:verify-email` | 创建管理员（密码在自己的终端里输入）/ 手动标记邮箱已验证（写审计） | ✅ 可用 |
| `test` / `test:unit` / `test:integration` | 全部 / 单元（`check` 已包含）/ 集成、安全、契约、实时（需要先 `infra:up`、`infra:bootstrap`、`db:migrate:test`） | ✅ 可用 |
| `smoke:backend` | 对**正在运行**的 api 与 worker 做真实进程验收走查（管理员 → 邀请码 → 注册 → Mailpit 收邮件 → 验证 → 登录 → WebSocket → 退出即断开）。用法和前置条件见脚本头部注释；建议对测试环境（`APP_ENV=test`）运行，它会在目标库里留下账号；集成测试会清空测试库（连 bootstrap 数据一起），所以先 `bun run db:bootstrap:test` | ✅ 可用 |
| `test:infra:up` / `test:infra:down` / `test:fault` | 每 run 独立拓扑、限定清理及故障矩阵（AT-34） | ✅ 可用 |
| `test:e2e` / `test:visual` | 端到端测试 / 视觉测试（在 Playwright 官方 Linux 镜像里运行，基线也在那里生成） | M1b 起 |
| `storybook` / `build` | 组件库、构建 | M1b |
| `edge:up` / `edge:down` | 用 Nginx 容器和生产站点配置提供一次构建产物 | M2b |
| `media:up` / `media:down` | worker容器与无网络media、私有IPC及资源限制；不重置开发依赖 | M3新增 |
| `eval` | Agent 评测 | M4 |

**Git 钩子**：lefthook 的 pre-commit 钩子会对暂存的文件运行 Biome（并自动修复）和 guard。

## 8. 仓库约定

- **换行符**：`.gitattributes` 设置了 `* text=auto eol=lf`，工作区和仓库里一律使用 LF，与 `core.autocrlf` 的设置无关（Windows 的系统级 git 配置是 true，WSL 里没有设置）。
- **编辑器**：`.editorconfig` 统一 UTF-8、LF、2 空格缩进。
- **文件名**：一律小写，用连字符分隔。
- **生产部署**：使用 CI 构建的镜像，或者用 `git -c core.autocrlf=false archive` 打包源码。

## 9. 常见问题

| 现象 | 处理 |
|---|---|
| 终端提示找不到 `bun` | 新装后需要新开终端（或 `source ~/.bashrc`）。临时办法：`export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"`。非交互的登录 shell（如 git 钩子）靠 `~/.local/bin/bun` 这个软链接，确认它还在 |
| WSL 里提示 `docker` 命令找不到（电脑重启之后） | Windows 上的 Docker Desktop 没在运行，WSL 集成随之消失。启动 Docker Desktop，等引擎就绪；开发容器带 `unless-stopped`，会自动恢复，测试用的隔离实例不会（用 `bun run test:infra:down <runId>` 清掉即可） |
| `infra:up` 提示连不上 Docker | 先启动 Windows 上的 Docker Desktop，等它就绪；再确认 Settings → Resources → WSL integration 里对 Ubuntu 是打开的 |
| `infra:up` 报 `ports are not available … 1025` | 1025 被 VPN 占用，已经改用 2525；如果还报错，检查 compose 文件是否是最新的 |
| Mailpit 显示 healthy，但 `doctor` 连不上；或启动时报端口访问权限错误 | 检查 `docker compose -f infra/compose.dev.yml --env-file .env.local ps` 是否有实际宿主机端口映射；在 Windows 的 PowerShell 里用 `netsh interface ipv4 show excludedportrange protocol=tcp` 检查保留范围（端口是 Docker Desktop 在 Windows 主机上绑定的）。把 `.env.local` 的 `SMTP_PORT` 改为可绑定的端口，再运行 `bun run infra:up` 和 `bun run doctor`。端口变更会重建 Mailpit，需保留的测试邮件应先导出；不要停止 VPN 或重置其他服务的数据卷 |
| 连数据库被拒绝，或连到了别的库 | 端口要用 **5434**，5432 是 Windows 上原生的 PostgreSQL |
| 改了 `POSTGRES_PASSWORD` 后认证失败 | 见第 5 节：执行 `bun run infra:reset --yes`，然后重新 up 和 bootstrap |
| Garage 报 layout 相关的错误 | 重新执行 `bun run infra:bootstrap` |
| S3 报签名错误 | 检查 `S3_ENDPOINT` 是否为 `http://localhost:3900`，`S3_REGION` 是否为 `garage` |
| 登录后 Cookie 不生效（M1b 起） | 必须通过 5173 端口访问（经过 Vite 代理），不要直接访问 3100 |
| Windows 浏览器打不开 WSL 里的 `localhost:5173`（M1b 起） | 先在 WSL 里 `curl http://localhost:5173` 确认服务在监听。WSL 为 NAT 网络模式（`wslinfo --networking-mode` 输出 `nat`，Windows 用户目录下没有 `.wslconfig`），已用临时服务验证过：WSL 里监听 `127.0.0.1` 的端口，Windows 上用 `localhost` 和 `127.0.0.1` 都能访问 |
| 视觉测试的截图总是对不上 | 基线只在 Playwright 的 Linux 镜像里生成和比对，本机（WSL 与 Windows）的字体都不同。用 `bun run test:visual`，它会在容器里运行 |
| 开发服务和测试同时运行时，收到对方的事件 | 检查 `APP_ENV`：事件频道名按它区分（`events:development` / `events:test`） |
| 在手机上测试（v1.1 之后） | 通过局域网 IP 访问时，Passkey 和 Service Worker 要求 HTTPS。可以用 `edge:up` 的 Nginx 容器在本地提供 HTTPS，或者用内网穿透 |

## 10. 在 WSL 中开发的注意事项（2026-10-01 迁移，D-093）

- **项目放在 Linux 文件系统**（`/home/mars/projects/ChatApp`），不要放进 `/mnt/c`、`/mnt/d`。那里是 Windows 盘的 9p 挂载，权限位不可靠（例如 Windows 上的私钥文件显示为 777），`ssh` 会因权限过宽而拒绝这样的私钥。
- **Docker**：`docker` 命令在 WSL 里直接使用，引擎是 Docker Desktop 的，所以 Windows 上的 Docker Desktop 必须在运行。Compose 的 bind mount 源是 WSL 路径；开发容器已在迁移时用 WSL 路径重建，数据卷（`chatapp-dev_*`）保留。**不要在 Windows 的 `D:\ChatApp` 里再运行 `infra:up`，那会把容器改回 Windows 路径。**
- **浏览器**：Windows 浏览器直接访问 `http://localhost:<端口>`，见第 3 节和第 9 节。
- **git 推送**：仓库级配置了 `credential.helper = !gh.exe auth git-credential`，借用 Windows 上已登录的 GitHub CLI（依赖 WSL 默认可见的 Windows PATH）。已验证 helper 能返回 github.com 的凭据；2026-10-01 第一次真实推送（`64d5e57`）成功，CI 通过。令牌始终由 Windows 的 `gh` 保管，不写进仓库或 WSL 的配置文件。
- **Claude Code 与全局说明**：WSL 里的 Claude Code 读取 WSL 自己的 `~/.claude/`。2026-10-01 核对：`~/.claude/CLAUDE.md` 已是指向 `/mnt/c/Users/Mars/.claude/CLAUDE.md` 的软链接，Windows 的全局说明（含服务器信息）会被自动读到；但其中的 SSH 命令仍是 Git Bash 路径（`/c/Users/Mars/.ssh/…`），M8 前改成 WSL 里的路径。
- **SSH 私钥**：Windows 上的私钥经 `/mnt/c` 访问时权限显示为 777。M8 前由用户自己把私钥复制到 WSL 的 `~/.ssh` 并 `chmod 600`；Claude 不读取、不复制私钥内容。2026-10-01 核对：私钥已在 `~/.ssh/`，当时权限是 644（`ssh` 会拒绝），用户随后已改为 600。
- **软件安装**：迁移时没有使用 sudo，所有工具都装在用户目录，所以 WSL 里没有 `unzip`、`make`、`jq` 等 apt 包；需要时再装。
- **Windows 上的 `D:\ChatApp`**：已停用，不再提交。其中的 `.env.local` 和 `infra/garage/garage.toml` 仍是一份密钥副本，用户确认不再需要后自行删除整个目录即可；删除不会影响现在运行的容器和数据卷。
