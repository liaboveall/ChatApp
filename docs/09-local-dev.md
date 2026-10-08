# 09 本地开发环境

> 基础设施、后端、前端、网关和媒体命令已可用，见第 7 节。M4 评测见 [21](21-m4-implementation-2026-10-07.md)；M5 新增审批/BYOK/记忆、离线 embedding、真实安全评测与原生 ARM 门槛命令，见 [24](24-m5-implementation-2026-10-08.md)。
> 开发环境：自 2026-10-01 起在 **WSL（Ubuntu 26.04）** 中进行（D-093）。仓库在 `/home/mars/projects/ChatApp`，命令都在 WSL 的 bash 里运行；Docker 用 Docker Desktop 的 WSL 集成。Windows 上的 `D:\ChatApp` 已停用。

## 1. 前置条件

| 工具 | 要求 | 本机状态（2026-10-01，WSL） |
|---|---|---|
| Bun | 与 `package.json` 中 `packageManager` 锁定的版本一致（1.4.2） | ✅ 装在 `~/.bun/bin`（下载官方发布包并核对 SHA256），PATH 写在 `~/.bashrc`；`~/.local/bin/bun` 另有一个软链接，让非交互的登录 shell 和 git 钩子也找得到。**新装后要新开终端（或 `source ~/.bashrc`）才找得到 `bun`** |
| Docker Desktop | Compose v2 及以上；在 Docker Desktop 的 Settings → Resources → WSL integration 里对 Ubuntu 打开集成 | ✅ Docker 29.8.1，Compose 5.5.1。WSL 里的 `docker` 与 Windows 共用同一个引擎、容器和数据卷 |
| Node | ≥ 24（Vite、Vitest、Playwright、Storybook 等工具需要；CI 的 web 相关作业用 26） | ✅ 26.8.1（与迁移前 Windows 上的版本相同），装在 `~/.local/share/node`，软链接在 `~/.local/bin` |
| Git | 较新版本即可 | ✅ 2.53.0。本仓库已配置提交身份：`liaboveall <2628370933@qq.com>`，只在本仓库生效，没有改全局配置 |

**本机端口冲突**（两处都不要去关占用方）。冲突发生在 **Windows 主机**上：Docker Desktop 把容器端口发布在 Windows 主机上，所以搬到 WSL 后依然适用。2026-10-01 迁移时核对过：开发端口由 Windows 上的 `com.docker.backend` 发布，5432 由 Windows 上的 `postgres` 进程监听。
- **5432**：被 Windows 上原生的 PostgreSQL 服务占用 → 开发库不用它。Postgres 和 Valkey 的主机端口是 `.env.local` 里的变量 `POSTGRES_PORT`、`VALKEY_PORT`，默认 **25434** 和 **26379**（见下面的「Windows 保留端口段」，D-172；2026-10-05 之前是 5434 和 6379）。
- **1025**：被 Cisco VPN 客户端（`vpnagent`）占用 → Mailpit 的 SMTP 默认用 **2525**。2026-10-01 复核时，2525 落入 Windows 保留范围 2492–2591，本机已通过 `.env.local` 的 `SMTP_PORT` 改用 **12525**。
- **Windows 保留端口段**（D-172）：Windows 把一段段 TCP 端口（每段 100 个，Hyper-V 和 WinNAT 划的）保留起来，谁也绑不了，**每次重启都不一样**（`netsh interface ipv4 show excludedportrange protocol=tcp`，不带星号的）。Docker Desktop 在 Windows 主机上发布端口，落进保留段的端口它**不报错**：容器在运行、健康检查通过，端口却不在那里（`docker port` 是空的），于是连库的命令只报 `ECONNREFUSED` 或 `migrate failed: Error`。2026-10-05 就是 5433–5532 和 6357–6456 挡住了当时的 5434 和 6379。这些保留段都是从**动态端口范围**里划出来的（`netsh int ipv4 show dynamicport tcp`：这台机器上是 1024–15000，系统默认 49152–65535），所以高于动态范围的端口不会被碰到，默认值就取在那里（常用端口加 20000）。`bun run infra:up` 启动前会拒绝落在保留段里的端口、启动后核对每个端口真的发布了并且连得上；`bun run doctor` 同样检查，并给出换成哪个端口。换端口：改 `.env.local` 里的变量，`bun run setup`（它把六个连接串里的端口改成一致，密码不动），`bun run infra:up`（数据卷保留，只重建端口变了的容器）。Garage（3900、3903）和 Mailpit 网页（8025）的端口写在 `infra/compose.dev.yml` 里，不是变量：它们落进保留段时 `doctor` 会指出来，改 compose（和 `S3_ENDPOINT`）。

## 2. 首次搭建

```bash
bun install                    # install dependencies; also installs the lefthook git hooks
bun run setup                  # create .env.local + infra/garage/garage.toml; generate local secrets (never printed)
bun run infra:up               # start postgres, valkey, garage, mailpit, wait until healthy, and check that every host port is published and answers
bun run infra:bootstrap        # Garage: layout + import key + buckets (idempotent)
bun run doctor                 # end-to-end checks; add --ai to test the selected AI key and configured models
```

- **当前 M4 的 SoCLaaS key（D-182）**：打开仓库根目录 `.env.local`，自己填写 `SOCLAAS_API_KEY=`。`AI_PROVIDER=soclaas`、两种 `AI_MODEL_*=x-test-1` 已配置。运行 `bun run doctor --ai` 检查认证与模型是否可用，再用 `bun run test:m4:provider` 做工具/流式/图片的合成验证。模型 ID 来自校方邮件，是可撤下的试用别名；以 `/v1/models` 的实际结果为准。检查只打印配置状态，不打印 key。**不要把 key 发到聊天里，也不要提交到仓库。**
- DeepSeek 保留为显式可选 provider；要使用时同时切换 `AI_PROVIDER`、模型 ID、付费价格及实验额度。学校认证失败不会自动用现有 DeepSeek key。
- **后端（M1a 已完成）**，接着执行：
  ```bash
  bun run db:migrate         # 以拥有者账号迁移，并创建/授权无特权的应用账号 chatapp_app
  bun run db:seed            # 仅开发：bootstrap（Agent 账号、保留名）、3 个演示成员（密码取自 SEED_DEMO_PASSWORD）和演示会话（两个频道、一个群、一个私信，59 条消息，D-135）
  bun run dev:api            # API 与 WebSocket，127.0.0.1:3100，热重载
  bun run dev:worker         # 另一个终端：派发器、邮件队列、定时对账与清理
  ```
  正式管理员用 `bun run admin:create --email <邮箱> --username <用户名> --name <显示名>`，密码在你自己的终端里输入（不回显，不经过聊天）。用户名只能用小写字母、数字和下划线（3–20 位，不能是保留名，例如 `god`）；密码至少 10 位，不能是常见密码、太简单，也不能包含邮箱 @ 前的部分、用户名、显示名（各自 4 位及以上时）或产品名。邮箱、用户名、显示名先按注册同样的规则校验，通不过会指出是哪个字段、什么规则；密码被拒会说明原因并允许重输（最多 3 次），任何提示都不会回显你输入的内容。接口文档在 http://127.0.0.1:3100/api/docs（仅开发与测试环境）。
- **前端（M1b 已完成）**：用 `bun run dev` 同时启动 api、worker 和 Vite（`bun run dev -- api web` 只启动其中几个），然后在浏览器打开 **http://localhost:5173**。必须用 `localhost`：服务端要求 `Origin` 等于 `APP_ORIGIN`，用 `127.0.0.1` 会被拒绝。管理员用 `admin:create` 创建，登录后在设置里生成邀请码，用邀请码注册新成员，验证邮件在 Mailpit（http://localhost:8025）里。
- **浏览器测试（M1b）**：`bun run test:e2e` 需要 Playwright 的浏览器。第一次：
  ```bash
  cd apps/web
  node_modules/.bin/playwright install chromium webkit firefox      # 下载到 ~/.cache/ms-playwright，不需要 sudo
  sudo node_modules/.bin/playwright install-deps                    # 浏览器依赖的系统库（libnspr4 等），WSL 里要装一次
  ```
  之后在仓库根目录运行 `bun run test:e2e`（需要先 `infra:up`、`infra:bootstrap`；它自己构建前端并启动测试环境的 api 与 worker，**不要同时跑集成测试**，两者共用测试库）。单个文件或浏览器：`bun run test:e2e -- e2e/shell.spec.ts --project=chromium`。视觉测试 `bun run test:visual` 在 Playwright 官方镜像里运行，需要 Docker Desktop 在运行，第一次会拉取镜像；M2b 起有 53 个故事 × 浅深两种主题共 106 张基线（新增的是输入栏、会话侧栏的行、时间线、Inspector 的各个面板与对话框，外壳和资料设置的基线随真实内容重做）。
  - **整套 `test:e2e` 约 16 分钟（M2b 起 182 个用例：Chromium 与 WebKit 全量，Firefox 冒烟，`perf` 项目单独）**，期间不要在同一台机器上做别的重活（编译、`check`、Docker 构建），性能用例对它敏感；管理员的接口会话在一次运行里只登录一次（存在 `apps/web/test-results/.administrator-session-<进程号>.json`，下一次运行开始时随目录清掉），所以一个用例失败不会因为换工作进程而撞上登录限流（D-165）。
  - 只跑性能：`bun run test:e2e -- --project=perf`；需要显卡合成才断言速度，在 WSL 里用 d3d12 的 Mesa 驱动（`e2e/support/gpu.ts` 的 `GPU_LAUNCH`，D-161）。
- **性能测试用的一万条消息（M2b，D-149）**：`bun run test:e2e` 启动测试栈时，`scripts/e2e-stack.ts` 在 API 启动之前建好 perf_a、perf_b、perf_c 三个人和群「性能 10k」（生成器在 `apps/server/test/support/perf-fixture.ts`，固定种子，内容逐字可重现；它的 5 个集成测试在 `test/integration/perf-fixture.test.ts`），人员和凭据写进被 git 忽略的 `.test-runs/e2e/perf.json`（权限 600）。`e2e/timeline-perf.spec.ts`（T1 到 T4）和 `e2e/latency.spec.ts` 用它测量；渲染速度相关的断言只在本机断言，CI 里量出来写进附件和作业摘要。
- **本地网关 edge（M2b，D-147）**：`bun run test:edge` 构建前端、组装 web root、用 openssl 生成 `chat.localhost` 的本地证书（只在 `.test-runs/edge/certs/`，权限 600，不导入任何信任库）、起 Nginx 容器（`infra/compose.edge.yml`，镜像按摘要锁定）并检查配置，再跑 `apps/web/edge/` 里的套件（AT-19 的头、AT-26/27 的网关部分、经网关的应用和 Passkey；25 个用例，第一个失败就停），无论结果如何最后拆掉容器。Playwright 等整条链（`https://chat.localhost:8443/api/readyz`）都通了才开始：容器是经 Docker Desktop 到宿主机再转进 WSL 的，宿主机发现新监听端口要晚一点，只看 127.0.0.1 上的 API 会让第一批请求拿到 502（D-167）。只想看看：`bun run edge:up`，然后自己起 API（`E2E_API_PORT=3104 E2E_APP_ORIGIN=https://chat.localhost:8443 bun --env-file=.env.local scripts/e2e-stack.ts`，它独占测试库）和浏览器打开 https://chat.localhost:8443（证书不被信任，忽略警告即可），用完 `bun run edge:down`（只删 `chatapp-edge` 项目的容器和网络）。CI 不跑这套，只跑 `bun scripts/edge.ts configtest`（compose 文件有效、镜像里 `nginx -t` 通过）。
- **收发邮件**：Mailpit 的网页界面在 http://localhost:8025 ，所有发出的邮件都会在这里显示。

## 3. 端口

| 服务 | 宿主机端口 | 说明 |
|---|---|---|
| web（Vite） | 5173 | M1b 起可用。会把 `/api` 和 `/ws` 代理到 3100，让前后端同源，Cookie 才能正常工作。浏览器用 `http://localhost:5173` |
| api | 3100 | M1a 起可用 |
| E2E：预览服务器 / API | 4173 / 3102 | 只在 `bun run test:e2e` 期间存在：`vite preview` 提供生产构建（带生产 CSP），API 与 worker 用测试环境（D-122） |
| edge：Nginx / API | 8443 / 3104 | M2b 起可用，只在 `bun run test:edge`（或 `edge:up` 加手动起栈）期间存在：Nginx 容器用生产站点配置提供构建产物，访问地址 `https://chat.localhost:8443`；它后面是测试环境的 API 与 worker（3104，`scripts/e2e-stack.ts`，D-147）。用于头与网关测试和 M7 彩排 |
| Postgres | `POSTGRES_PORT`，默认 **25434** → 容器内 5432 | 用户名 `chatapp`；开发库 `chatapp`，测试库 `chatapp_test`。两个库都已安装 `vector` 0.8.6 和 `pg_trgm` 1.6 |
| Valkey | `VALKEY_PORT`，默认 **26379** → 容器内 6379 | 开发用 db 0，测试用 db 1；配置为 `noeviction`，已开启 AOF。pub/sub 不区分 db，所以事件频道名带环境：`events:development`、`events:test`（D-044） |
| Garage | 3900（S3）、3903（管理接口） | region 为 `garage`；bucket `chatapp` 和 `chatapp-test` |
| Mailpit | **12525**（本机 SMTP）→ 容器内 1025；8025（网页界面） | Compose 从 `SMTP_PORT` 读取宿主机端口，模板默认 2525 |
| Storybook | 6006 | M1b 起可用：`bun run storybook` |

所有端口都只绑定在 `127.0.0.1` 上。主机端口可能被 Windows 保留，见第 1 节的「Windows 保留端口段」和第 9 节（D-172）。

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
- **`.env.local`**：不提交，已被 `.gitignore` 忽略；`guard` 脚本也会拦截任何被 git 跟踪的 env 文件。它由 `bun run setup` 生成，当前助手需自己填写完整 `SOCLAAS_API_KEY`；显式改用 DeepSeek 才填写对应 key 与价格。`POSTGRES_PORT`、`VALKEY_PORT` 是主机端口，连接串里的端口始终跟着它们，`setup` 重复运行是安全的（D-172）。
- **读取方式**：
  - Bun 只会从**当前目录**自动加载 `.env.local`，而且 `bun test`（`NODE_ENV=test`）根本不自动加载它。所以根目录的脚本都显式传 `--env-file=.env.local`；测试的 `APP_ENV=test` 由 `bunfig.toml` 的 preload 强制设置，配置加载器在测试环境下改用 `DATABASE_(OWNER_)URL_TEST`、`VALKEY_URL_TEST`、`S3_BUCKET_TEST`，并拒绝库名不以 `_test` 结尾、与开发共用 Valkey 库号或桶的配置。
  - 前端（M1b）：Vite 的 `envDir` 指向仓库根目录，`envPrefix` 设为 `VITE_PUBLIC_`，因此前端只能读取以它开头的变量。这些变量里不要放任何需要保密的内容。

## 7. 脚本清单（根目录 `package.json`）

### 故障测试环境（M1a ✅，D-085、D-103）

现有 chatapp_test、Valkey db1 及 chatapp-test 桶只做不改实例状态的普通集成测试（`bun run test:integration`）。所有 stop/kill、FLUSHALL、限内存、断网、磁盘类故障只在 `infra/compose.test.yml` 起的独立实例里做：

- `bun run test:infra:up`：生成 runId，起 compose 项目 `chatapp-test-<runId>`（独立 Postgres/Valkey/Garage/Mailpit 容器、卷、网络，随机密码，每次运行选定后固定的随机回环端口），跑迁移与 bootstrap，写入随机实例标记，生成 `.test-runs/<runId>/manifest.json`（权限 600，已被 git 忽略）。`bun run test:infra:down <runId>`（或 `--latest`）只拆除这一个项目；清单核验不过就什么也不删，容器已停止（比如 Docker Desktop 重启后）也能拆。
- `bun run test:fault`：起一个新实例，跑 `apps/server/test/fault`，无论结果都拆除。故障套件先 `verifyFaultTarget`：`APP_ENV=test`、project 与 run-id 标签、完整容器 id、卷/网络标签、只绑 127.0.0.1 且无开发端口、库名 `chatapp_test`、三个服务里读回的随机标记；动作只经 `act()` 并每次重新核对标签。AT-34 的 11 项（开发服务带哨兵、伪造目标全部被拒、清理不越界）在这里。M2a 起还有 AT-01（3 个）和 AT-02（2 个），共 16 个（D-140）：测试用 `apps/server/test/support/fault/instance.ts` 在这个实例上启动**真实的 api 与 worker 子进程**（它们的环境完整替换为实例的端点和密钥，不继承开发环境），对它们 SIGKILL / SIGSTOP / SIGCONT，并清空或停掉实例的 Valkey。**Docker Desktop 的偶发误报**（D-141）：刚创建的容器偶尔（本机约三分之一）会报告内部的 `/run/desktop/…` 绑定路径，核验按规则拒绝它；`test:fault` 与 `test:infra:up` 会把整个实例重新创建（最多 4 次，输出里有「creating the instance again」），其他任何核验失败都不重试。
- 不使用 `docker system prune` / `volume prune` 或按名字前缀删除；不继承开发 compose 的 name、container_name、卷或 bind 挂载。
- M3 启用媒体时，本地开发的 worker 也运行在 Linux 容器内，经内部网络访问开发依赖，与 media 共享私有 Unix socket；不能假定宿主机 Bun 可访问 Docker 内 Unix socket。故障套件使用同样的 worker/media 拓扑，凭据和卷仍隔离。纯后端热重载在 M1a 阶段继续在宿主机运行。
- M7 本地删除 journal 使用第二套独立存储服务模拟故障；V-19 最终证据仍须真实异地服务及原主机不可访问场景。只开本机第二桶不能证明灾难独立性。

### M3 富消息开发与验证（D-176–D-180）

- 首次使用 M3 先 `bun run db:migrate`（新增 0004/0005，不重置开发数据）；API 在宿主机，worker/media 由容器入口启动。`bun run dev` 启动全部服务，上传与头像须有 worker/media。
- `bun run media:configtest`：以合成配置核对 Compose、网络、挂载、资源上限和 worker 环境白名单，不启动服务，不输出业务密钥。
- `bun run media:up` / `bun run media:down`：启动固定 worker/media 栈，或只停止当前所有权凭据里的容器；保留 socket 卷和开发基础设施。`dev:worker` 与 `dev` 的 worker 从此走相同容器入口。先运行 `infra:up` 与 `infra:bootstrap`；已有健康栈会被复用，前台 Ctrl+C 不停止借用的容器。
- `bun run test:media`：每次创建并核验独立 `compose.test` 实例，从当前 checkout 构建 worker、runtime media、fault media 镜像；跑真实 sharp/ffmpeg、IPC、隔离、PID/tmpfs/OOM、进程组与恢复测试后只拆除本轮目标。不依赖开发镜像，不读取 `.env.local`；可用 `--phase runtime|fault` 和 `--case <pattern>` 选择用例。
- `bun run test:attachments`：独立真实 API → HTTP 上传 → Postgres work → BullMQ worker → 隔离 media → Garage → 受权限约束下载，结果在 `.test-runs/m3/<runId>/business-result.json`。
- `bun run test:m3:edge`：同一真实媒体业务链经本地 TLS/Nginx 网关执行，独立 API 为 26402；包括实际 100 MiB 上传、超限拒绝与 S3 尾部 Range。拒绝覆盖已有 `chatapp-edge`，结束后核验回收媒体实例并停止本轮网关。此命令使用 Docker Desktop 的 `host.docker.internal`，不计作原生 ARM 准入。
- `bun run test:m3:e2e`：独立媒体测试栈的浏览器场景 6（Chromium / WebKit），API 只发布到本机 26401，预览 4174；由外层 runner 在浏览器退出后核验回收实例。夹具账号仅在 `.test-runs/e2e-media/accounts.json`（0600），浏览器证据在该目录的 results，不能提交。
- `test:coverage` 与 `test:e2e` 共用测试库，必须顺序执行；原生媒体和 M3 浏览器各自创建隔离实例，但两套浏览器构建仍须顺序运行，防止覆盖同一 dist。
- Garage 的 `/metrics` 使用 `GARAGE_METRICS_TOKEN`，API 默认从本地 S3 endpoint 推导 3903；容器固定用 `http://garage:3903/metrics`。无需向业务进程传管理 token。新上传须有数据盘/元数据盘各至少 256 MiB 的余量，并扣除已预占处理峰值；逻辑站点预算默认 50 GiB，用户默认 5 GiB。
- 运行结果在 `.test-runs/m3/<runId>/result.json`：只含元数据、逐例结果、未执行项、cgroup 资源和清理状态。实例 manifest 含随机凭据，只留本机，不上传或提交。镜像构建上下文通过 `.dockerignore` 排除 env、Git、运行证据和宿主依赖。
- `.github/workflows/media.yml` 在原生 x64 与 ARM Linux 上分别执行相同套件，只上传 `result.json`。主机与 Docker 引擎架构必须一致，QEMU 结果不算 ARM 准入；新工作流尚未运行时，不能写 V-18 已通过。
- M3 已接入上传、数据库 generation fencing、对象账本、头像与附件界面；V-18 的本地证据和原生 ARM 剩余门槛见 `PROGRESS.md`，全量混合负载属于 M7。

### M4 助手开发与真实评测（D-182–D-184）

- `bun run db:migrate` / `db:migrate:test` 应用 0007–0010：Agent run、上下文、状态、步骤、输出、事务预算、调用账本、每日用量、trigram 索引与供应商状态证据。本次已在开发/测试库执行；不重置开发数据。
- 当前使用完整 `SOCLAAS_API_KEY`、固定校方 endpoint 和 `x-test-1`。API 只读模型/额度策略，执行模型调用的 worker 只获得所选 provider 的 key；media 解码容器没有 AI key、数据库、S3 凭据或网络。
- 更新 AI 配置后要重启原开发 worker 会话。固定 worker/media 已存在却没有本轮所有权凭据时，`media:up` 拒绝环境不一致，`media:down` 拒绝停止借用实例。先在原启动终端结束 `bun run dev` / `dev:worker`，由拥有该实例的启动流程清理，然后重新启动；不要手写 lease 或删基础设施卷。本次保留了该旧实例，浏览器验证使用本轮创建并清理的隔离栈。
- `bun run eval --concurrency 1`：真实 provider、冻结语料、独立临时数据库、完整调用与实验账本。默认并发 4 是 runner 上限；当前校方服务实测出现 HTTP 429，每周工作流使用并发 1。`Retry-After` 已知时释放该次预占并记录冷却；实验等待后创建新 run，保留失败尝试，未知结果不自动重放。
- `--mock` 仅验证协议；`--case <代表任务或检索查询ID>` 仅冒烟，不计全量质量通过。退出 0 表示冒烟/模拟通过；真实全量自动门槛失败退出 1，自动门槛通过但总结人工标注待完成退出 2。
- 结果在 `apps/server/evals/results/<runId>/`（Git 忽略）：report、独立 retrieval/summary/capacity 证据、每次尝试的不可覆盖副本、源文件哈希、`human-review.json`。人工核对 30 个总结 × 3 次的事实与来源后运行 `bun run eval:review <结果目录>`；不能用关键词命中率填成人工事实准确率。细节见 08 和 21。

### M5 审批、记忆与本地向量

`bun run setup` 幂等添加并生成本地 `AI_KEY_ENCRYPTION_KEY`，然后 `bun run db:migrate` / `db:migrate:test` 增量应用 0012–0015，不清空数据。用户自带 key 通过设置 → 助手输入；完整 key 不放到聊天、文档或版本库。

模型安装是显式操作：`bun run embeddings prepare bge` 下载固定 revision 的公开 q8 权重并生成大小/校验清单。该准备命令只读取本地 cache 路径，不加载服务凭据；运行时子进程不允许网络下载。当前 bge 门槛证据见 24，Qwen 的超限失败记录保留。

本地 `.env.local` 的 `EMBEDDING_ENABLED=true`、`EMBEDDING_MODEL=bge`；`EMBEDDING_CACHE_DIR` 指向准备完成的绝对缓存目录，`EMBEDDING_SOCKET_PATH` 指向本人私有目录下的 socket。当前开发环境使用 `.test-runs/m5/models` 和 `.test-runs/m5/dev-ipc/embedding.sock` 的绝对路径。`bun run dev` 会一并启动 API、隔离 worker/media、Vite 和宿主 embedding consumer；只启动它用 `bun run dev:embeddings`，或显式 `bun run dev -- embeddings`。固定开发 Docker worker 的 embedding 消费关闭，防止它用另一条 socket 消耗宿主模型的工作。生产只允许有资源上限的 worker 容器，宿主 consumer 拒绝 production。

索引迁移顺序：

1. `bun run embeddings stage bge`，保留旧 active。
2. 启动已准备模型的 consumer，再执行 `bun run embeddings backfill bge`；每批最多 100 条、durable cursor，重复分批执行并等待队列完成，不能把排队数当完成数。
3. 用 `bun run embeddings status bge` 查看 generation。创建包含绝对 `qualityPath/resourcesPath` 的本地 JSON，分别引用同源码的原生 ARM 留出质量和实际 Debian 两核混合负载原始 `result.json`。
4. `bun run embeddings activate bge <上述JSON路径>`。质量/资源不合格、源码/模型不一致或当前内容未全部回填时拒绝启用，旧 generation 保留。当前开发库 67 条历史适用消息已完成并启用。

`bun run eval:m5:agent` 默认使用现有站点 provider 和合成账号/独立库；`--mock` 只验证协议。`bun run eval:m5:search bge --dev` 和不带 `--dev` 的留出运行使用冻结新语料与独立临时库。`bun run test:m5:indexing` 验证实际 SQL/BullMQ/Unix/native 写回。资源命令 `bun run test:m5:mixed` 使用随机、所有权核验的独立 API/worker/media；`bun run test:m5:native` 仅原生 ARM，必须先有同源码的 mixed 结果，再在其实际 Debian worker 镜像运行开发/留出质量并核验合并门槛。模拟与 x64 都不代替 ARM 资源证据。

E2E 和普通故障实例固定 `AI_PROVIDER=mock`、`EMBEDDING_ENABLED=false`，不继承开发配置指向的实际模型 socket；真实索引/质量/资源走上述独立命令。测试 instance manifest 含临时凭据，只留本地，CI 只上传 `result.json` 和 `source-manifest.json`。

### 命令状态

| 脚本 | 作用 | 状态 |
|---|---|---|
| `setup` | 生成 `.env.local`、本地密钥和 Garage 配置 | ✅ 可用 |
| `doctor` | 端到端检查环境（`--ai` 额外检查所选 AI key 和配置模型） | ✅ 可用 |
| `infra:up` / `infra:down` / `infra:ps` / `infra:logs` | 启动并等健康、再核对每个主机端口真的发布且连得上（Windows 保留的端口 Docker 不会报错，D-172；`INFRA_SKIP_PORT_CHECK=1` 关掉）/ 停止 / 查看状态 / 查看日志 | ✅ 可用 |
| `infra:bootstrap` | 初始化 Garage | ✅ 可用 |
| `infra:reset --yes` | **删除所有开发数据卷**，不带 `--yes` 会拒绝执行 | ✅ 可用 |
| `lint` / `lint:fix` / `format` | Biome 检查、自动修复、格式化 | ✅ 可用 |
| `typecheck` | TS 7 类型检查（M1a 起覆盖所有工作区包） | ✅ 可用 |
| `guard` | 禁止 raw HTML 写法（SEC-05），禁止跟踪 env 文件和其他密钥文件 | ✅ 可用 |
| `check` | 依次运行 lint、typecheck（所有工作区包，含 `apps/web`）、guard（含架构边界检查）、单元测试（后端 bun test 加前端 Vitest，不需要任何服务）、令牌对比度自查、文案生成物一致性检查。**提交前必须通过** | ✅ 可用 |
| `db:generate` / `db:migrate` / `db:migrate:test` / `db:check` | 生成迁移 / 以拥有者迁移并授权应用账号（开发库 / 测试库）/ drizzle-kit 一致性检查 | ✅ 可用 |
| `db:seed` | 仅开发：bootstrap、3 个演示成员，加 M2a 的演示会话（综合讨论、技术闲聊、周末爬山、Alice 与 Bob 的私信，消息回溯三天，幂等；开发库要先 `bun run db:migrate`）（`db:studio` 未创建） | ✅ 可用 |
| `db:bootstrap` / `db:bootstrap:test` | 生产也可用的幂等基础数据：Agent 账号、保留名、bootstrap 标记；无演示账号 | ✅ 可用 |
| `dev:api` / `dev:worker` | 启动后端开发服务（API 与 WebSocket / 派发器、邮件队列、对账、清理） | ✅ 可用 |
| `dev` / `dev:web` | 同时启动 api、worker、Vite / 只启动前端（`bun run dev -- api web` 可选择进程） | ✅ 可用（M1b） |
| `admin:create` / `admin:verify-email` | 创建管理员（密码在自己的终端里输入；规则同注册，被拒时指出字段和原因）/ 手动标记邮箱已验证（写审计） | ✅ 可用 |
| `test` / `test:unit` / `test:integration` | 全部 / 单元（`check` 已包含）/ 集成、安全、契约、实时（需要先 `infra:up`、`infra:bootstrap`、`db:migrate:test`） | ✅ 可用 |
| `test:coverage` / `coverage:check` | 集成、安全、契约、实时测试加单元测试，带覆盖率运行并按目录检查行覆盖率（`domain/` ≥ 90%，`agent/` 有了之后同样，D-142）/ 只检查已有的 `coverage/lcov.info`。`test:coverage` 与 `test:integration` 一样用测试库，**不能同时跑**；输出写进被 git 忽略的 `coverage/` | ✅ 可用（M2a） |
| `smoke:backend` | 对**正在运行**的 api 与 worker 做真实进程验收走查（管理员 → 邀请码 → 注册 → Mailpit 收邮件 → 验证 → 登录 → WebSocket → 退出即断开；M2a 起再加两个成员，走一遍建频道、加入、消息提示、已读、typing、在线状态、编辑撤回、权限和移出，共 22 步）。用法和前置条件见脚本头部注释；建议对测试环境（`APP_ENV=test`）运行，它会在目标库里留下账号；集成测试会清空测试库（连 bootstrap 数据一起），所以先 `bun run db:bootstrap:test` | ✅ 可用 |
| `test:infra:up` / `test:infra:down` / `test:fault` | 每 run 独立拓扑、限定清理及故障矩阵（AT-34；M2a 起含 AT-01/02 的杀进程、清空队列、总线断开） | ✅ 可用 |
| `design:build` / `design:contrast` | 构建设计原型（`--minify` 为发布版）/ 令牌对比度自查（脚本在 `apps/web/tools/contrast.ts`，D-114），不需要任何服务 | ✅ 可用（D） |
| `test:e2e` / `test:visual` | 端到端测试（Playwright，对生产构建运行，需要 `infra:up`；M2b 起有会话场景、安全、Inspector、资料、一致性、性能与延迟，夹具对每个上下文断言零违规，D-148）/ 视觉测试（在 Playwright 官方 Linux 镜像里运行，基线也在那里生成；加 `-- --update-snapshots` 重新生成基线，提交前要逐张看过变化的 PNG） | ✅ 可用（M1b） |
| `storybook` / `build` | 组件库（:6006）/ 前端生产构建（`apps/web/dist`） | ✅ 可用（M1b） |
| `web:messages` | 由 `apps/web/tools/messages-source.ts` 生成 `messages/*.json`；加 `-- --check` 只核对是否过期（`check` 里已包含） | ✅ 可用（M1b） |
| `edge:up` / `edge:down` / `test:edge` | 用 Nginx 容器和生产站点配置提供一次构建产物（`up` 构建、组装 web root、生成本地证书、`nginx -t`；`down` 只删 `chatapp-edge` 的容器和网络，不 prune）/ 一条命令跑完整个 edge 套件（`up`、套件、`down`）。`bun scripts/edge.ts configtest` 只检查配置能加载（CI 用它）。edge 栈与 `test:e2e`、`test:integration` 一样独占测试库 | ✅ 可用（M2b） |
| `media:up` / `media:down` | worker容器与无网络media、私有IPC及资源限制；不重置开发依赖 | M3新增 |
| `test:m4:provider` / `test:m4:search` | 当前 provider 的工具、流式、图片与 usage 合成实测 / 中文 2 字关键词 EXPLAIN | ✅ 可用（M4） |
| `eval` / `eval:review` | 冻结语料的真实全量评测 / 90 份总结的人工标注、来源哈希与质量门槛检查 | ✅ 可用（M4；通过与否以运行结果为准） |
| `embeddings` / `dev:embeddings` | 显式模型准备、generation/回填/证据启用 / 本地宿主 consumer | ✅ 可用（M5；生产 consumer 限容器） |
| `eval:m5:agent` / `eval:m5:search` | 真实审批/注入用例 / 冻结中文混合检索与个人记忆质量 | ✅ 可用（M5；mock 不计真实质量） |
| `test:m5:indexing` / `test:m5:mixed` / `test:m5:native` | 实际异步索引链 / 独立混合资源 / 原生 ARM Debian 同源码质量+资源门槛 | ✅ 可用（M5；native 拒绝 x64） |

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
| 拉取新代码后 API 提示 `database is not bootstrapped`，或读到的 JSON 字段是字符串 | 先 `bun run db:migrate`（测试库用 `bun run db:migrate:test`）：`0002_normalize_jsonb` 会把旧的双重编码 JSON 值改成真正的 JSON（D-107） |
| 连数据库被拒绝（`ECONNREFUSED`、`migrate failed: Error`），容器却是 healthy | 多半是端口被 Windows 保留了，Docker 没有发布它也没有报错。运行 `bun run doctor`：「host ports」和「containers」两项会说出是哪个端口、落在哪一段、换成哪个。按它说的改 `.env.local` 的 `POSTGRES_PORT` 或 `VALKEY_PORT`，`bun run setup`，`bun run infra:up`（D-172） |
| 连到了别的库，或 `doctor` 说连接串的端口和变量不一致 | 开发库不在 5432（那是 Windows 上原生的 PostgreSQL）。`bun run setup` 会让连接串里的端口跟着 `POSTGRES_PORT`、`VALKEY_PORT` |
| 改了 `POSTGRES_PASSWORD` 后认证失败 | 见第 5 节：执行 `bun run infra:reset --yes`，然后重新 up 和 bootstrap |
| Garage 报 layout 相关的错误 | 重新执行 `bun run infra:bootstrap` |
| S3 报签名错误 | 检查 `S3_ENDPOINT` 是否为 `http://localhost:3900`，`S3_REGION` 是否为 `garage` |
| 登录后 Cookie 不生效，或注册、登录报来源不允许（M1b 起） | 必须通过 `http://localhost:5173` 访问（经过 Vite 代理，`Origin` 要等于 `APP_ORIGIN`），不要直接访问 3100，也不要用 `127.0.0.1:5173` |
| 浏览器测试启动失败，提示缺少共享库（libnspr4 等） | 装一次系统库：`cd apps/web && sudo node_modules/.bin/playwright install-deps`（需要 sudo） |
| `test:fault` / `test:infra:up` 报 `bind mount outside the run directory … /run/desktop/…` | Docker Desktop 对刚创建的容器偶尔报告内部路径，核验拒绝它是对的；命令会自动把实例重新创建（最多 4 次）。连续 4 次都这样才失败：重启 Docker Desktop 后重试，不要放宽核验（D-141） |
| 反复 `--repeat-each` 跑 E2E 时出现 `administrator sign-in failed: 429` | 测试辅助函数每次都以管理员身份登录，登录限流约 8 次之后回 429，是限流在起作用；每次 `playwright test` 启动都会清零计数，所以分批（每批不超过 7 次）运行 |
| `test:e2e` 一开始就报测试库或端口被占用 | E2E 与集成测试共用测试库，不能同时跑；3102、4173 被旧进程占着时先结束它们（`ss -ltnp` 查看） |
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

## 11. 设计原型与浏览器检查（D，2026-10-02）

设计原型在 `design/prototype/`，是评审用的参考实现，不是产品代码（M1b 已按它用 React 重新实现，在 `apps/web`；令牌的数据源也已移到那里，D-114）。构建、检查和发布方式见 [design/README.md](../design/README.md)。

- **为什么用 Windows 的 Edge 做浏览器检查**：WSL 是 NAT 网络模式，WSL 里连不到 Windows 上浏览器的调试端口。所以检查脚本由 Windows 的 `node.exe` 运行，用 CDP 驱动 Windows 的 Edge；原型由 WSL 里的静态服务提供，Windows 经 localhost 转发访问。调试端口由 Edge 自选，只绑 127.0.0.1。
- **运行**：`bun run design:build`，然后 `design/prototype/tools/browser-checks/run.sh keyboard|layout|media|flows|audit`。脚本会把检查脚本复制到 Windows 的临时目录、起静态服务、跑完后停止。截图和临时 profile 在 `%TEMP%\chatapp-d`。
- **前提**：Windows 上有 Edge 和 Node（脚本默认路径可用环境变量 `EDGE_PATH`、`NODE_EXE` 覆盖）。**不要**用开放远程调试端口到非回环地址的办法。
- **Playwright 接手后**：M1b 的 E2E 已在 Playwright 里做了其中一部分（键盘与快捷键、焦点、溢出、axe 检查，见 08 第 2 节）；输入法、对比度取样等这些脚本里的断言，等用到它们的里程碑再移植。原型的这套检查仍可单独运行。
- `biome.json` 为 `design/**` 单独关闭了四条风格规则（逗号表达式、表达式内赋值、`!important`、选择器特异性顺序），因为原型为简洁和"减少动态效果"有意这样写；产品代码不受影响。
