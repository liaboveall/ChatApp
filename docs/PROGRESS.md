# 进度与交接

> **每个会话开工时先读这个文件，收工前更新它。**
> 只记录真实发生的事：写明执行过的命令和结果，没跑过的检查不能写成"已通过"。

## 当前状态

- **当前阶段**：M0 ✅，开发准备 ✅，规划完善 ✅，**M1a 后端骨架：✅ 完成（2026-10-02 用户验收），已提交并推送（`7f73cad` 到 `4fb26a5`），远端 CI 全部通过**。证据、限制和未做的事见交接记录。下一步：D 设计原型（可并行）；M1b 等 D 定稿。
- **本轮生效**：[15复审](15-planning-rereview-2026-10-01.md)的12项主问题与5项一致性问题全部落实D-076–D-092；新增AT-25–AT-37、V-18–V-21。M1a 范围内的部分已有运行证据（见 M1a 交接记录），其余仍为未开始。
- **2026-10-01 全面完善**：[独立审查](14-planning-review-2026-10-01.md) 的 11 项 P1、13 项 P2 已逐项落实 D-056–D-075，当前规格已同步；08 的 AT-01–AT-24 是待实施验收，不把设计完成视作运行时通过（M1a 范围内的运行证据见 M1a 交接记录）。
- **2026-10-01 Docker 补查**：已修复 Mailpit 保留端口冲突；本机 SMTP 为 12525，网页 8025。基础设施 doctor 通过证据见交接记录。
- **2026-10-01 开发环境迁到 WSL**：之后都在 WSL（Ubuntu 26.04）的 `/home/mars/projects/ChatApp` 开发，开发容器已用 WSL 路径重建，Windows 的 `D:\ChatApp` 停用（D-093）。迁移内容和验证见交接记录；之后的复核见后面的交接记录：环境可用；第一次从 WSL 的真实推送已成功（`64d5e57`，CI 通过）。
- **分支**：
  - `v2`：已推送到 GitHub，本地跟踪 `origin/v2`，所有开发都在这里进行；
  - `main`：仍是旧版代码，已经过历史清理；
  - 标签 `v1-legacy`：指向 main 的最后一个提交。
- **CI**：`v2` 上最近一次已核对的运行是 `4fb26a5`（run id 与 headSha 都核对过）：`check`（36962917864，含 `arm64-smoke`）、`integration`（36962917906：`integration` 作业 185 个测试通过，`fault` 作业 11 个通过）、`security`（36962917839：gitleaks 扫描这 2 个提交，无泄露）全部成功。更早的 `af8cfc0` 的 `security` 曾因 gitleaks 失败，已按 D-106 解决，之后的完整历史扫描（run 36956977511）也成功。之后的提交以各自对应的远端运行为准。
- **下一个会话**：
  - **M1a 已验收**（2026-10-02）。按 11 的范围冻结点，M1a 出口冻结认证/同步/幂等契约；之后要改，须同步产品、数据、接口、测试和决策。
  - **D 设计原型**：见 [11-roadmap.md](11-roadmap.md) 的 D 节和 [02-design-system.md](02-design-system.md) 第 9 节（与后端互不依赖）。
  - **M1b 前端骨架**要等 D 定稿；M1a 的认证契约与后端出口现已具备（见 05 第 3.1 节）。

## 里程碑状态

| 里程碑 | 状态 | 备注 |
|---|---|---|
| M0 规格 | ✅ 完成 | 2026-09-30，提交 `35f3547` |
| 开发准备 | ✅ 完成 | 2026-09-30，提交 `8b74b5c`、`b28dbbe`、`a8f1456`、`77cd6db`、`d723d7b` |
| 规划审查修订 | ✅ 文档完成 | D-056–D-092及17项复审对照已纳入规格；运行验收待实施 |
| D 设计原型 | ⚪ 未开始 | **下一步**，可以和 M1a 同时进行 |
| M1a 后端骨架 | ✅ 完成 | 2026-10-02 用户验收；单元 73 / 集成 185 / 故障 11 个测试通过，真实进程走查通过；远端 CI（`4fb26a5`）全部通过，含 arm64；Passkey 完整仪式、真实 ARM 资源数据等未验证（见交接记录） |
| M1b 前端骨架 | ⚪ 未开始 | 等 D 定稿及 M1a 出口 |
| M2 核心聊天（M2a / M2b） | ⚪ 未开始 | |
| M3 富消息 | ⚪ 未开始 | |
| M4 Agent 基础 | ⚪ 未开始 | |
| M5 Agent 进阶（M5a / M5b） | ⚪ 未开始 | |
| M6 通知与 PWA | ⚪ 未开始 | |
| M7 加固与彩排 | ⚪ 未开始 | |
| M8 上线 | ⚪ 未开始 | |

> 2026-09-30 清理历史之后，所有提交号都变了。本文件和 11-roadmap 里的提交号已经换成改写之后的。

## 等待用户确认

- 暂无。M1a 已于 2026-10-02 验收，D-094 到 D-107 随之生效；要改动其中任何一条，告诉我，我会新增取代它的记录。

## 用户待办

- [x] 删除 Docker Hub 上的公开仓库 `abovealll/chatapp`（2026-09-30）。
- [x] 作废旧的 DeepSeek key，并把新 key 填进 `.env.local`（2026-09-30）。`bun run doctor --ai` 已验证可用。
- [x] 管理员账号（2026-10-02，你让我直接创建）：用户名 `god`、显示名 `God`，在开发库里，已验证能登录。密码是我随机生成的，只存在 `~/.chatapp/god-admin-password`（权限 600，不在聊天、日志和仓库里）；请存进密码管理器，然后删除这个文件。现在还没有网页界面（M1b 才有），暂时用不上它。开发库里另有 bootstrap 的 Agent 账号和 `db:seed` 建的三个演示成员 alice / bob / carol（邮箱 `*@example.test`，密码是 `.env.local` 里的 `SEED_DEMO_PASSWORD`）。M8 上线时要在服务器上再创建一次生产管理员。
- [x] 推送之后核对远端 CI（2026-10-02，我用 `gh` 核对过，结果见交接记录）：`integration`、`fault`、`security`、`arm64-smoke` 都在远端跑过并通过；只有 `security` 首次运行因 gitleaks 失败，已按 D-106 修复。
- [ ] 可选：在 GitHub 上安装 Renovate App，让 `renovate.json` 生效。
- [ ] 可选：请 GitHub Support 清除已改写历史中旧提交的缓存（见 D-032 中的"残留风险"）。
- [ ] 迁移收尾：在 WSL 里用一阵、确认没问题后，自行删除 Windows 的 `D:\ChatApp`（里面还有一份 `.env.local` 密钥副本）。
- [x] 确认第一次从 WSL 的真实推送正常（2026-10-01）：`64d5e57` 已推送到 `origin/v2`，CI run 36820912601 通过。
- [x] 删除工作区根目录的 `sudo.txt`（2026-10-01，用户已处理；我核对过文件已不存在，没有读过它的内容）。
- [ ] M8 前：
  - 购买域名。这是硬性前提：没有域名就发不出验证邮件，也就无法开放注册（D-049）。
  - 开通 Resend。
  - 准备持续可用的异地备份和删除journal目标（优先验证R2，B2/其他目标须通过V-19）；偶尔下载备份不能满足恢复目标或journal要求。
- [ ] M8 前：准备一个 QQ 邮箱和一个 163 邮箱，用来测试验证邮件能否送达（V-11）。
- [x] 把 SSH 私钥放进 WSL 的 `~/.ssh` 并改成权限 600（2026-10-01，用户已处理；我核对过权限是 600，没有读取私钥内容）。
- [x] 全局 `CLAUDE.md` 的 SSH 命令改成 WSL 路径 `~/.ssh/ssh-key-2026-09-25.key`（2026-10-01；该文件是指向 Windows 那份的软链接，所以 Windows 侧也变了）。同日清掉了 `.git/info/exclude` 里的 `sudo.txt` 行。
- [ ] M8 时：把 restic 备份密码保存到自己的密码管理器里，不能只放在服务器上。
- 注意：WSL 里新装了 Bun 和 Node，已经打开的 WSL 终端要重新打开（或执行 `source ~/.bashrc`），才能直接找到 `bun`。

## 待验证事项

见[12-decisions.md](12-decisions.md)的V-01–V-21及[08-testing.md](08-testing.md)的AT-01–AT-37；V-06仍并入V-08。按11阶段记录负责人、状态、SHA、命令、结果和限制，不能把文档检查作为应用验收。V-04/V-05/V-07/V-13 以及 AT-25、AT-34 的 M1a 部分已有本地证据（见 M1a 交接记录，**远端 CI 与提交 SHA 尚未有**）；media/journal/质量/成本实验按所属阶段执行。

## 交接记录

### 2026-10-02 · M1a 验收，提交并推送两处修复（Claude）

**你的指示**：「M1a已验收，然后提交推送」。M1a 于 2026-10-02 由你验收，状态改为 ✅。
- **提交**：拆成两个独立的代码提交。每个提交先在临时目录里组装累积文件树，跑 `bun run check`（含 `--frozen-lockfile` 安装），通过后才提交；pre-commit 钩子（Biome、guard）真实运行：
  - `a1edf0c` `fix(server)`：`admin:create` 用注册规则校验输入，并说明被拒原因（见 “admin:create 修复” 一条）；
  - `4fb26a5` `fix(db)`：jsonb 值存成真正的 JSON，含迁移 `0002_normalize_jsonb`（D-107）。
- **推送**：`19adbde..4fb26a5`。提交前我用 gitleaks 默认规则的近似扫描检查了新增行，把测试里一个会被当成密钥的变量名改短（`builtFromUsername` 改为 `guess`）。
- **远端结果**（HEAD `4fb26a5`，run id 都核对过 headSha）：

| 工作流（run） | 结果 |
|---|---|
| `check`（36962917864） | ✓ 含 `arm64-smoke` |
| `integration`（36962917906） | ✓ `integration` 作业：空库迁移（含 `0002`）、`drizzle-kit check`、**185 个测试通过 / 0 失败（21 个文件）**；`fault` 作业：**11 个通过** |
| `security`（36962917839） | ✓ gitleaks 读到 `.gitleaks.toml`，扫描这 2 个提交，无泄露；osv-scanner、bun audit 通过 |

- **没有变化的未验证项**：Passkey 完整仪式（M1b）、真实 ARM 资源数据（V-12）、topic/Hub 与 presence/typing（M2）等，清单见 M1a 交接记录。
- **下一步**：D 设计原型（可并行）；M1b 等 D 定稿。

### 2026-10-02 · 创建管理员 god，并修掉 jsonb 双重编码（Claude）

**你的指示**：「你直接为我创建名为God的管理员账户」。这是你明确让我替你做（此前约定密码由你自己输入）。
- **做法**：用仓库自己的 `admin:create` 路径（密码走标准输入，不进命令行参数），在**开发库**里创建；用户名按规则必须小写，所以是 `god`，显示名 `God`，邮箱用你上一条命令里的那个。密码是 128 位随机值，**先写进私有文件**（`~/.chatapp/god-admin-password`，权限 600，只有你的用户能读）再创建账号，创建失败会删掉文件；全程没有打印，也不在聊天、日志和仓库里。
- **验证**：库里是已验证、已激活的 `admin`（来源 `cli`），有 1 条凭据和 1 条 `admin.account_created` 审计；用生成的密码真实登录得到 200、没有 token 出现在响应体里，`/api/me` 返回 `god` / `admin`，错误密码 401，退出登录后 `/api/me` 为 401，没有残留会话，API 已关闭。

**发现并修复的缺陷（D-107）**：核对审计行时，`metadata->>'role'` 取到空值。原因是 drizzle-orm 0.45.3 的 `jsonb()` 与 Bun 的 SQL 驱动叠加，所有 jsonb 值都被编码两次，存成“内容是 JSON 文本的 jsonb 字符串”。经 Drizzle 读回时会再解析一次，所以应用里和测试里都看不出来；`->>`、`@>`、索引和 SQL 层检索会读不到。4 列受影响：`audit_logs.metadata`、`work_items.payload`、`app_settings.value`、`users.settings`；应用代码里没有用 SQL 读 JSON 的地方，所以没有功能受损。
- **修复**：`packages/db/src/schema/json.ts` 的 `jsonbValue<T>()`（先序列化成文本，SQL 里 `::text::jsonb`，实验里对象、数组、字符串、数字、布尔、嵌套值和更新都正确）；4 列改用它；guard 拒绝非测试文件导入 Drizzle 的 `jsonb`；迁移 `0002_normalize_jsonb` 规范化已有行；回归测试 `jsonb-storage.test.ts`（6 项，用 SQL 直接读存储类型，并核对每个 jsonb 列都被覆盖）。**我把实现临时改回旧编码验证过，6 项里 5 项变红**，再原样恢复。
- **开发库**：已应用迁移，6 行被规范化，现在 4 列都是真正的对象，你账号的审计行能用 SQL 查到。**拉取代码后要 `bun run db:migrate`（测试库 `db:migrate:test`）**。
- **本地验证**（工作区，含上一条 admin:create 修复）：`bun run check` 通过，单元测试 73 个；`bun run test:integration` 185 个通过；`bun run test:fault` 11 个通过、无残留；`doctor` 正常；`db:check` 与 `db:generate`（无 schema 变更）正常；真实进程走查 11 步全过；你的账号在迁移后的开发库上重新验证登录正常。
- **状态**：已提交并推送（`a1edf0c` admin:create 修复、`4fb26a5` jsonb 修复），远端 CI 全部通过（见上一条记录）。drizzle-kit 的 `db:generate` 仍报告无 schema 变更，所以迁移文件是纯数据迁移。

### 2026-10-02 · admin:create 修复（Claude）

**起因**：你在自己的终端运行 `bun run admin:create --email … --username God --name God`，输完密码得到 `admin:create failed: AppError (VALIDATION_FAILED)`，看不出哪里错了。没有账号被创建（我核对过开发库和测试库里都没有这个邮箱）。

**原因**（M1a 的 CLI 里有三个缺陷）：
1. `admin:create` 没有用 contracts 里的 schema 校验邮箱、用户名和显示名，违反“所有外部输入都用 zod schema 校验”。`God` 含大写字母，注册接口会拒绝，CLI 却放行，要到数据库的 `users_username_format` 约束才会被拦，那时的报错同样不可读；显示名也没有 trim 就入库。
2. 报错只打印类名和代码，字段和原因被丢掉了。这次被拒的是**密码这一步**（用户名问题还没轮到检查）；具体是密码策略的哪一条（太短、太常见、太简单、含邮箱前缀或产品名），当时的输出看不出来。
3. 这条代码路径（`createAccountFromCli`）没有任何测试。

**修复**：
- `domain/admin.ts`：新增 `checkAccountFields`（注册同一份 schema 加保留名检查，返回规范化后的值，或“字段 + 规则”）和 `checkAccountPassword`；`createAccountFromCli` 复用它们、用规范化后的值入库，错误带 `details: {field, reason}`。
- `cli.ts`：先校验字段、再要密码；密码被拒时说明原因，并在终端里允许重输（最多 3 次）；`AppError` 的字段与原因会显示，数据库错误仍只显示类名和代码；任何提示都不回显你输入的内容。
- 测试：新增 `admin.test.ts`（9 个单元测试）和 `admin-cli.test.ts`（5 个集成测试，真实 Postgres），覆盖大写用户名、保留名、坏邮箱、显示名 trim、各种弱密码的原因、重复邮箱/用户名。
- 文档：docs/09 写明用户名和密码规则。

**验证**（本地）：`bun run check` 通过，单元测试 72 个（原 63）；`bun run test:integration` 179 个通过（原 174）；真实 CLI 进程：你的原命令行（`God`）现在在要密码之前就报 `--username` 的规则并退出 1，弱密码和含邮箱前缀的密码各自给出原因，三种情形都没有创建账号；用伪终端模拟交互：第一次输入太短的密码被拒并说明原因，重输合格密码后在测试库里建号成功，密码没有出现在会话记录里。

**状态**：已提交并推送（`a1edf0c`）。用法：`bun run admin:create --email <你的邮箱> --username god --name <显示名>`（用户名要小写）。

### 2026-10-01 至 02 · M1a 后端骨架（Claude）

**用户的指示**：「开始M1a」，中途因会话中断说了「继续」。按 CLAUDE.md 先读了 PROGRESS、11 的 M1a 节和 03/04/05/07/08/09/12 的相关部分。收工时我问是否提交并推送，你回复「提交并推送吧」，随后已提交并推送（见下面的“提交、推送与远端 CI”）。

**做出来的东西**（写于提交之前；提交与推送见下面的“提交、推送与远端 CI”）：
- **工具链**：`scripts/typecheck.ts`（根目录加每个工作区包各跑自己的 tsconfig）；`guard` 增加架构边界检查（`scripts/lib/boundaries.ts`）；`check` 现在含单元测试；根目录新增 `db:*`、`dev:api`、`dev:worker`、`admin:*`、`test`、`test:integration`、`test:infra:*`、`test:fault`、`smoke:backend` 脚本。
- **`packages/contracts`**：错误码、上限、保留名、身份字段 schema、认证端点允许清单、WS 外层结构、各 DTO。
- **`packages/db`**：15 张表、迁移 `0000_init` 与 `0001_extensions`、拥有者/应用账号分离、迁移运行器（advisory lock）、bootstrap。
- **`apps/server`**：config（zod、生产拒绝弱密钥、测试环境核验目标）、lib（allowlist 日志、IP 解析、crypto、限流、pg 错误解析）、domain（会话与设备撤销、注册状态机与对账、验证/重置/改密、邀请、work_items 状态机、邮件投递、清理）、auth（Better Auth 实例与钩子）、http（路由、请求预算、Origin、路径守卫、安全头、错误处理、OpenAPI + Scalar）、realtime（网关、事件总线、握手）、jobs（派发器、邮件消费者、对账与清理循环）、runtime（ids、`Bun.serve` 绑定）、api.ts、worker.ts、cli.ts（migrate、db:bootstrap、db:seed、admin:create、admin:verify-email）。
- **环境**：`.env.example` 新增 `DATABASE_OWNER_URL(_TEST)`、`APP_TIMEZONE`、`API_HOST`、`TRUSTED_PROXIES`、`AUTH_TOKEN_ENCRYPTION_KEY`、`RESTORE_EPOCH`；`bun run setup` 把旧布局一次性转成新布局并补齐模板新增的键（没有打印任何值；转换前备份在会话临时目录）。
- **故障环境**：`infra/compose.test.yml`、`scripts/lib/test-infra.ts`、`apps/server/test/support/fault/*`、AT-34 测试。
- **CI**：新增 `.github/workflows/integration.yml`（`integration` 与 `fault` 两个作业）、`security.yml`（gitleaks、osv-scanner、`bun audit`），`check.yml` 增加 test compose 文件校验和 `arm64-smoke` 作业；`osv-scanner.toml` 登记一条依赖告警例外（D-105）；`.gitleaks.toml` 只放行三个测试夹具字面值（D-106）。
- **文档**：12 新增 D-094–D-107 与 V-04/05/07/12/13 结论；05 第 3.1 节改成实际契约；04、03、09、01（隐私说明新增“登录设备与 IP”“邀请与注册”两行）、08、11、README、CLAUDE.md 同步。

**依赖**：Drizzle 1.0 仍是 RC，用 0.45.3 / drizzle-kit 0.31.11（V-07）；Better Auth 1.7.7；其余精确版本见 D-104 和 03 第 2 节。`bun audit` 全量有 1 条 moderate（drizzle-kit → 已废弃的 @esbuild-kit → esbuild 0.18.20，开发服务器告警，不可达），没有可升级路径，已在 `osv-scanner.toml` 登记带到期日 2027-01-01 的例外（D-105）。

**实际执行与结果**（最终状态，会话末尾逐条重跑）：
| 命令 | 结果 |
|---|---|
| `bun run check` | 退出 0：Biome 150 文件，4 个 tsconfig 的 tsc，guard ok，单元测试 **63 通过 / 0 失败** |
| `bun run test:integration` | **174 通过 / 0 失败**（19 个文件，898 个断言，两次完整运行分别 38.7 s、41.9 s）：数据库约束与角色、SDK 实验、注册/验证/重置/改密/设备、work_items、邮件与 BullMQ 全链路、限流、请求预算、路径与原生路由矩阵、日志哨兵、契约快照、WebSocket 网关（真实 Bun 服务） |
| `bun run test:fault` | **11 通过 / 0 失败**（94 个断言，三次运行中成功的两次都是 13–14 s），实例拆除后 0 个残留容器/卷/网络、`.test-runs` 为空；开发容器与哨兵未变（AT-34）。**第一次运行被自检拒绝**：Docker Desktop 偶发把 Garage 绑定挂载的 `Source` 报成内部路径，实例按设计被拆除、无残留；几分钟后重跑通过，原因未查明（D-103）。失败信息里现在带重跑提示 |
| `bun run smoke:backend`（真实 api + worker 进程，`APP_ENV=test`；先 `bun run db:bootstrap:test`，因为集成测试会清空测试库） | 11 步全过，退出码 0：管理员登录 → 邀请码 → 无码注册 400/有码 200 → worker 把验证邮件发进 Mailpit → 未验证登录 403 → GET 404/POST 消费 200 → 登录 → WebSocket hello/pong → 退出后 **58 ms** 连接以 4401 关闭 → 外来源 4403/无会话 4401。两份进程日志共 16 行、全是 JSON，管理员邮箱和密码出现 0 次，记录键全在白名单内；SIGTERM 后 19 ms 内 api 与 worker 都以 0 退出 |
| `bun run doctor` | `environment ok`（含两个应用账号检查） |
| `bun run db:check` / `bun audit --audit-level=high` | `Everything's fine` / 退出 0（high 及以上没有）。**不带级别的 `bun audit` 有 1 条 moderate**：drizzle-kit 间接依赖的 esbuild 0.18.20，是开发服务器告警、在这里不可达，已按 D-105 登记 osv 例外（osv-scanner 本机没装，配置未实跑） |
| 186 个将被提交的文件拷到全新目录（`git init`，无 `.env.local`）里 `bun install --frozen-lockfile`（124 个包）+ `bun run check` | 全过：Biome 150 文件、4 个 tsc、guard ok、63 个单元测试 |
| `bun run dev:api` / `dev:worker`（开发库，`--watch`） | 都在 1 s 内就绪，`/api/readyz`、`/api/healthz`、`/api/docs` 均 200；SIGTERM 后 29 ms 内两个进程以 0 退出，无残留进程。**这一类走查早先抓到过一个 bug**：`/api/docs` 在真实服务器上 500（进程内测试没覆盖），已修复并加了测试 |
| 把 `.env.local` 里 16 个密钥类的值逐个在 186 个将被提交的文件里搜索 | 没有密钥命中（只有 `VALKEY_URL`、`VALKEY_URL_TEST` 因名字含 KEY 被列入，值是无密码的本地地址，与示例文件相同） |

**提交、推送与远端 CI**（2026-10-02，你回复「提交并推送吧」之后）：
- 提交前，先在临时目录里按累积顺序组装每个提交的文件树，各跑一次 `bun run check`，7 个全部通过；从 `server` 提交起连 `bun install --frozen-lockfile` 也通过（`bun.lock` 随完整的工作区集合一起提交，更早的提交里它还是旧的）。pre-commit 钩子（Biome、guard）每次都真实运行，没有绕过。
- 推送：`a2c30df..af8cfc0`（7 个提交），随后 `af8cfc0..3cf4488`（1 个提交，修 gitleaks）。
- 远端结果（run id 都核对过 headSha）：

| 提交 | 工作流（run） | 结果 |
|---|---|---|
| `af8cfc0` | `check`（36956701933） | ✓ `check` 10 s、`arm64-smoke` 15 s |
| `af8cfc0` | `integration`（36956702415） | ✓ `integration` 1 分 7 秒（空库迁移、db:check、集成/安全/契约/实时）、`fault` 53 秒 |
| `af8cfc0` | `security`（36956701901） | osv-scanner ✓、bun-audit ✓、**gitleaks ✗：13 处 `generic-api-key`** |
| `3cf4488` | `check`（36956958013）、`integration`（36956957945）、`security`（36956957946） | 全部 ✓ |
| `3cf4488` | `security` 手动触发的完整历史扫描（36956977511） | ✓ gitleaks 读到 `.gitleaks.toml`，扫描 v2 完整历史的 34 个提交，no leaks found；osv-scanner 读到 `osv-scanner.toml`，扫描 238 个包，过滤 1 条（D-105），无问题；bun-audit ✓ |

- **gitleaks 失败的原因与处理**：13 处全是测试文件里的三个假字面值（假密码、测试应用的占位 secret、占位加密密钥），逐行核对过，不是任何环境的真实值；用 `.gitleaks.toml` 只放行这三个精确字符串，其余默认规则照旧（D-106）。**教训**：push 触发的 gitleaks 只扫这次推送的提交，所以修复推送后的绿灯不能证明配置有效；我给 `security` 加了 `workflow_dispatch` 并手动跑了一次完整历史扫描，才确认配置生效、旧历史里没有别的发现。
- `arm64-smoke` ✓ 说明：在 `ubuntu-24.04-arm` 上，`bun install --frozen-lockfile` 与 `bun run check` 都通过。这是 V-12 的一部分，原生依赖与真实资源数据仍未验证。

**验收证据对照**（状态用 11 的写法：通过 = 本地已执行且结果如上；限制写在后面）：
| 项 | 状态 | 证据 | 限制 |
|---|---|---|---|
| V-04 uuid/UUIDv7 | 通过 | `integration/auth-sdk.test.ts` | |
| V-05 `__Host-` Cookie | 通过 | 同上，https 下 Secure/Path=/ 无 Domain | 需 `useSecureCookies:false` + 自定义名；M7 在真实网关下复核 |
| V-07 Drizzle 1.0 | 结论 | `npm view`：latest 仍 0.45.3，1.0 只有 rc | |
| V-13 注册/认证收口 | 通过 | `security/auth-matrix.test.ts`、`integration/registration.test.ts`、`credentials.test.ts`、`sessions.test.ts`、契约快照 | **Passkey 完整仪式没有跑**（需要浏览器/认证器，留给 M1b） |
| AT-01 | 部分 | 业务回滚连同工作意图一起回滚；队列任务丢失后租约到期从 Postgres 恢复；陈旧重投只发一次（`worker-email`、`work-queue`、`registration`） | 杀 API 进程、清空队列等故障矩阵没做；35 秒收敛是 M2 的前端部分 |
| AT-02（会话部分） | 通过 | `realtime/gateway.test.ts`：hint 路径 < 2 s（真实进程走查 58 ms），默认 5 秒复核 ≤ 6 s，复核失败 1013，撤销与写入由用户行锁串行化（`sessions.test.ts`） | 消息写入与踢人的竞争属 M2a |
| AT-04 | 通过 | `auth-matrix.test.ts`：SDK 注册的 39 个 (方法, 路径) × 匿名/成员/管理员；plugin 路径；路径变体；bot/未激活/已删除账号；多余字段 | |
| AT-05 | 通过 | `registration.test.ts`：5 个写入点注入失败整体回滚；并发抢名额；同邮箱重建；验证与撤销竞争 8 轮；对账器 | |
| AT-13（M1a 部分） | 部分 | 同键同参重放无副作用、同键异参 409、非法键 422 | 跨会话 clientId、重放前撤权、离线队列属 M2a |
| AT-16（bootstrap） | 通过 | `db-schema.test.ts`；开发库连跑两次一致；无演示账号 | 转让/头像等属后续阶段 |
| AT-23 | 部分 | 本地空库迁移 + `db:check`；`integration` 工作流里同样的步骤已写好 | 工作流没在远端跑过；没有“上一版夹具”（还没有发布版） |
| AT-25 | 通过（M1a 部分） | 同邮箱撤销重建后旧链接失效、重发撤旧、并发只消费一次、GET 无副作用、过期、restore 世代不符 | 恢复演练与旧快照属 M7 |
| AT-26（应用） | 通过 | `http-boundary.test.ts`：10 个携带哨兵值的请求（body、query、路径、请求头、cookie、凭证形式的 token）产生 ≥ 5 种不同状态码，所有日志行都不含哨兵、键在白名单内、未知路径只记 `unknown`；500 响应不泄露内部信息、429 带 Retry-After 在同文件的另外两个测试里；真实进程日志抽查（见 smoke 行） | Nginx、Sentry 属 M2b/M7；哨兵测试本身没有逐个状态码断言 |
| AT-27（API） | 通过 | 128 KiB 精确边界、无长度流计数并取消、卡住的发送者 408、压缩/其他类型 415、自相矛盾的 framing 400、非法 JSON/UTF-8 422、敌意请求后小请求照常 | 网关路径属 M2b；**Passkey 请求体大小未校准**（D-078 要求 M1a 校准，缺真实认证器数据） |
| AT-28（契约） | 通过 | `sessions.test.ts`、`credentials.test.ts`：普通退出/撤销单台/注销其他/安全注销全部/改密/重置各格；“裸 userId 无法作为执行凭证”由类型系统保证（tsc），没有单独的测试 | 审批、子委托与 usage 属 M4/M5a |
| AT-34 | 通过 | `bun run test:fault`（见上） | |
| 其他 AT | 未开始 | | |

**07 第 4 节自查（M1a）**：接口都有 zod schema、写入走 principal 复核（还没有会话类资源，`authorize()` 属 M2a）；事件只有无内容的撤权提示；`guard` 通过；配置有 zod 校验且生产拒绝弱密钥/占位值（单测）；日志抽查通过；限流按真实 IP 计数，原生接口无绕过；依赖与密钥扫描：本地 `bun audit`（high）通过，远端 osv-scanner、gitleaks 也通过（D-105、D-106）；隐私说明已补两行。

**发现与处理**（实现过程中真实碰到的）：
- Better Auth 1.7.7 的 Drizzle 适配器带运行时 schema 检查，会拒绝“SDK 从不写入的 NOT NULL 列”（`users.username`），所以 username 要声明为 `required, input:false` 的附加字段（D-095）。
- Hono 在路由前会对路径做百分号解码，而 SDK 不会；URL 解析器又会规范化点段与反斜杠。所以路径守卫拒绝 `%`、`//`，其余规范化后所有层看到同一个 URL（D-101）。
- Hono 里：处理器如果自己重新赋值 `c.res`，Hono 会忽略它返回的 Response；Cookie 统一在最外层的响应整理中间件里追加。
- Drizzle 包装的错误消息含 SQL 和**参数值**；日志与响应从不读 `message`。
- Docker 重启后容器端口会被重新分配；故障实例的端口因此在每次运行开始时选定并固定。拆除时必须能处理已停止的容器。
- 我写进工具参数里的 `\uXXXX` 转义（`\u200B`、`\u202E` 等）会被写成不可见的真实字符；已发现并改回显式转义，之后涉及不可见字符的源码都用脚本生成并复核。
- 会话中途电脑/Docker Desktop 重启过一次：开发容器自动恢复，上一次中断的故障实例用校验过的 `test:infra:down` 拆除，开发库里没有残留哨兵。

**没有验证 / 未做**：Passkey 完整仪式；真实 ARM 资源数据（V-12；`arm64-smoke` 只证明工具链、锁文件和单元测试在 arm64 Linux 上可用）；topic/Hub、presence、typing（M2）；Passkey 请求体大小校准；`db:studio`；V-01 的 DeepSeek 冒烟（需实验预算）；V-11 邮件送达（缺域名）；除 Postgres 杀死与 Valkey FLUSHALL 外的其他实例故障（杀 API、断网、磁盘满、OOM）；Bun 的 `maxRequestBodySize` 暂为 1 MiB（M3 上传要放宽，D-101）。

**给下个会话的提示**：开工前先确认 Windows 上 Docker Desktop 在运行（`docker` 命令在 WSL 里找不到就是没起来）；集成测试每个文件之后都会清空测试库（含 bootstrap 数据），之后要对测试库起 api/worker 或跑 `smoke:backend`，先 `bun run db:bootstrap:test`；`test:fault` 若报“bind mount outside the run directory (/run/desktop/...)”，是 Docker Desktop 偶发报告内部路径，实例已被拆除，重跑即可（D-103）；M1b 要把 Vite 代理配成 `x-forwarded-for` 透传（现在开发环境所有请求在 API 看来都来自 127.0.0.1）；认证页面按 05 第 3.1 节的契约写，登录失败沿用 `{code,message}`、其余错误是统一的 `{error:{code,message,details,requestId}}`。 测试里新增“像密钥”的字面值（带 password/secret/key 之类变量名的随机串）会被 gitleaks 的 generic-api-key 规则命中：优先运行时生成，必须写死时加行内 `gitleaks:allow`，不要放宽 `.gitleaks.toml`（D-106）。

### 2026-10-01 · 推送与勾掉复核待办（Claude）

**用户的指示**：先说“先推送”，随后又说“sudo.txt 和私钥权限我都处理了，先把待办勾掉然后再推送一次”。

**完成**：
- **第一次从 WSL 的真实推送**：`git push origin v2`（普通推送，没有 force），`a4918c7..64d5e57`，提交为 `docs: move development to WSL and record the post-migration check`。推送后远端 `v2` 的 SHA 与本地 HEAD 一致；该提交的 CI（`check`，run 36820912601）经 headSha 核对，结论 success。提交前对工作区 diff 和暂存区各扫描过密钥，没有匹配。
- **核对用户处理的两项**（只看元数据，没有读内容）：`sudo.txt` 已不存在；`~/.ssh/ssh-key-2026-09-25.key` 权限是 600，`~/.ssh` 是 700，两个 `.Zone.Identifier` 文件也不在了。
- **待办**：勾掉“第一次真实推送”“删除 `sudo.txt`”“私钥权限”；全局 `CLAUDE.md` 的 SSH 命令仍是 Git Bash 路径（`/c/Users/Mars/.ssh/…`），这一项保留为 M8 前的待办。
- **文档**：“当前状态”、CI 行、09 第 10 节和 12 的 D-093 中“真实推送结果待确认”的说法改为已成功；09 里“私钥权限仍需 chmod 600”改为已处理。

**边界**：`.git/info/exclude` 里还留着 `sudo.txt` 这一行（只在本机生效，不进提交，无害，想清掉可以手动删）。本条记录随用户的指示提交并推送，推送与 CI 结果以远端记录为准，本记录不预先宣称通过。

**下一步**：不变，D 原型与 M1a。

### 2026-10-01 · WSL 迁移后的开发前环境复核（Claude）

**用户的指示**：“我刚刚将项目从windows迁移到WSL，现在看一下环境什么的开发前的准备工作做好了没有”；核对完后用户回复“先推送”。核对阶段没有安装软件或修改配置，只更新了文档；提交和推送在用户回复之后进行，见“提交与推送”。

**实际执行与结果**：
- `bun run check`：退出 0（Biome 11 文件、tsc、guard ok）。
- `bun run doctor --ai`：退出 0，`environment ok`。bun 1.4.2、Docker 29.8.1、`.env.local` 8 项必需值齐全、DeepSeek key 已设置、4 个容器 healthy、开发/测试库 PostgreSQL 18.6（pg_trgm 1.6、vector 0.8.6、uuidv7）、Valkey（noeviction、AOF）、两个 Garage 桶读写删、Mailpit SMTP 12525、DeepSeek 模型列表可用（`--ai` 只调用免费的模型列表接口）。
- Docker：`compose ps` 显示 4 个服务 healthy；4 个 `chatapp-dev_*` 数据卷都在；`docker inspect`（只取挂载和标签，不碰环境变量）显示 compose 工作目录是 `/home/mars/projects/ChatApp/infra`，`garage.toml` 的 bind mount 源在 WSL 路径。
- 端口：`netsh` 列出的 Windows 保留范围不含 3100、5173、5434、6379、3900、3903、8025、12525；5173 和 3100 空闲。5432 由 Windows 的 `postgres.exe` 监听，开发端口由 `com.docker.backend.exe` 发布（`tasklist` 核对）。
- Windows 到 WSL：临时 `python3 -m http.server`（绑定 127.0.0.1:5173，根目录在临时目录）经 WSL、Windows 的 `localhost` 和 `127.0.0.1` 访问，均返回 200；服务已退出，端口已释放。
- git：HEAD `a4918c7` 与 `origin/v2` 一致；`git push --dry-run origin v2` 返回 `Everything up-to-date`（没有发送任何内容）；`gh.exe auth status` 显示已登录 `liaboveall`，权限含 `repo`、`workflow`。CI 结果见“当前状态”。
- lefthook：直接执行 `.git/hooks/pre-commit` 退出 0（没有暂存文件，biome 和 guard 都因无匹配文件而跳过，只证明钩子能启动）。登录 shell 和交互 shell 找得到 `bun`；极简 PATH（`/usr/bin:/bin`）下找不到，即钩子依赖启动 git 的环境带有 `~/.local/bin`。
- 机器与网络：32 核、约 15.5 GiB 内存、磁盘可用约 936 GB、inotify watches 1048576、systemd 已开；npm registry 可访问（HTTP 200）。
- `.env.local`：键集合与 `.env.example` 一致，权限 600；值为空的只有 `SMTP_USER`、`SMTP_PASS`（Mailpit 不需要认证）和 `VAPID_*`（M6 才生成）。

**发现（都不阻塞 D 和 M1a）**：
- 工作区根目录有 `sudo.txt`（4 字节，13:03）。`.git/info/exclude` 里已排除它，注释写明是用户放进工作区的；我没有读它的内容。现在 `sudo -n -l` 显示 `(ALL) NOPASSWD: ALL`，这个文件已无用，见用户待办。
- `~/.ssh/ssh-key-2026-09-25.key` 已存在，但权限是 644，`ssh` 会拒绝；旁边还有两个 `.Zone.Identifier` 文件（Windows 复制时产生，可删）。
- `~/.claude/CLAUDE.md` 是指向 `/mnt/c/Users/Mars/.claude/CLAUDE.md` 的软链接，WSL 里能读到全局说明。CLAUDE.md 和 09 第 10 节里“不会被自动读到”的说法已据此改正；其中的 SSH 命令仍是 Git Bash 路径。
- WSL 里没有 `unzip`、`make`、`gcc`、`uv`、`psql`、`redis-cli`、`valkey-cli` 和 WSL 版 `gh`（用 `gh.exe`），暂时都不需要。`curl`、`jq`、`python3`、`openssl` 来自 `~/anaconda3/bin`，排在系统路径前面。

**没有验证**：Safari/macOS 等 D 的评审环境；任何应用级测试（还没有应用代码）。

**提交与推送**：用户回复“先推送”后，CLAUDE.md、03、08、09、11、12、PROGRESS 共 7 个文档（迁移时的改动加上本次记录）作为一个 `docs:` 提交推送到 `origin/v2`。提交前核对过 diff 没有密钥，`bun run check` 通过。这是第一次从 WSL 的真实推送；推送与该提交的 CI 结果以远端记录为准，本记录不预先宣称通过。

**下一步**：不变，D 原型与 M1a（M1a 先做 V-13 注册 adapter/原生路由收口实验，以及 compose.test 独立故障环境）。

### 2026-10-01 · 开发环境迁到 WSL（Claude）

**用户的指示**：“将项目迁移到WSL中，我将在WSL中完成开发”，开发目录 `/home/mars/projects/ChatApp`；随后授权直接进行软件安装和环境配置，不再逐项过问。

**完成**：
- **仓库**：`git clone https://github.com/liaboveall/ChatApp.git`，切到 `v2`。HEAD `a4918c7`、目录树 `2d492f7` 与 Windows 副本一致；`main`、`v1-legacy` 也在。没有复制 `.git`（reflog 里还有 D-032 清理前的旧对象）。仓库级身份设为 `liaboveall <2628370933@qq.com>`，全局 git 配置没动。
- **本地文件**：`.env.local` 和 `infra/garage/garage.toml` 按字节复制（`cmp` 一致，权限 600，内容未打印）。已跟踪文件与 Windows 副本逐文件比对（`diff -rq`）无差异。
- **工具链**（没有使用 sudo，全部装在用户目录，下载后核对 SHA256）：Bun 1.4.2 → `~/.bun/bin`，并按官方脚本的做法追加 `~/.bashrc`；Node 26.8.1（与 Windows 上的版本相同）→ `~/.local/share/node`；`~/.local/bin` 里放软链接。官方 Bun 脚本需要 `unzip`，WSL 里没有，所以改用 python3 解压同一个发布包。
- **依赖与钩子**：`bun install --frozen-lockfile` 装了 11 个包，lefthook 的 pre-commit 钩子随 `prepare` 安装；`git status` 仍干净，`bun.lock` 未变。
- **容器**：迁移前 4 个容器的 bind mount 和 compose 标签都指向 `D:\ChatApp`。先 `up --dry-run` 预览，再执行 `docker compose -f infra/compose.dev.yml --env-file .env.local up -d --wait --force-recreate`。4 个服务均 healthy，4 个数据卷（`chatapp-dev_pg`、`_valkey`、`_garage-meta`、`_garage-data`）原样保留，bind mount 和标签现在指向 WSL 路径。重建前 Mailpit 里有 0 封邮件。
- **推送凭据**：仓库级 `credential.helper = !gh.exe auth git-credential`，借用 Windows 上已登录的 GitHub CLI。验证了 helper 能为 github.com 返回凭据（用户名和密码在输出中打码，未落盘）。
- **文档**：CLAUDE.md 的“本机环境”和“部署”、09（前置条件、端口说明、FAQ、新增第 10 节）、03/08/11 各一处措辞、12 新增 D-093，均改为 WSL 版本；本文件的状态和待办同步。

**验证**：
- `bun run check`：退出码 0（Biome 11 文件、tsc、guard；应用本身尚无测试）。
- `bun run doctor --ai`：退出码 0，`environment ok`。bun 1.4.2、Docker 引擎 29.8.1、四个容器 healthy、开发/测试库 PostgreSQL 18.6（pg_trgm 1.6、vector 0.8.6、uuidv7）、Valkey（noeviction、AOF）、两个 Garage 桶读写删、Mailpit SMTP 12525、DeepSeek 模型列表（key 可用）。
- Windows 到 WSL 的 localhost：在 WSL 里用 python3 临时起 `127.0.0.1:5173`，Windows 上 `127.0.0.1` 和 `localhost` 都返回 HTTP 200，随后服务已退出。

**边界和下一步**：
- 没有提交、推送；从 WSL 实际 `git push` 尚未验证。Windows 的 `D:\ChatApp` 没有删除，也没有改动；Docker 数据卷本来就由 Docker Desktop 在 Windows 和 WSL 间共用，没有搬运动作。
- 没有安装 apt 包（`unzip`、`make`、`jq` 等缺失，需要 sudo 时再装）；WSL 里没有安装 Claude Code。
- 下一步不变：D 原型与 M1a。

### 2026-10-01 · 规划修订提交与推送准备（Codex）

- 用户明确授权“推送吧”。核对本轮17份文档改动，未包含密钥、运行配置或业务代码。
- `git fetch origin`成功，提交前`v2`与`origin/v2`一致，无远端新增提交需要合并。
- 重新执行`bun run check`、`git diff --check`、临时规划校验器及Compose配置解析，均通过；校验器仍为17项映射、83个本地链接、94张表格且无错误。
- 本次提交后推送`origin/v2`并按确切SHA检查GitHub Actions；推送与CI结果以对应远端提交和运行记录为准。本记录不预先宣称远端检查通过。

### 2026-10-01 · 第二次复审后的全面规划完善（Codex，基线9a85687）

用户授权：“全面优化完善项目规划”。本轮完成规划修订，没有开始应用实现。

**已落实**：
- 15的12项主发现和5项一致性问题全部对应D-076–D-092、生效规格及验收。同步00–12、CLAUDE、README、15修订表与本记录；原始审查及旧决策保留历史并标明取代关系。
- 认证改为绑定原注册/恢复世代的一次性凭证；受控POST及邮件fragment确认页；解析前请求预算、网关/应用/Sentry日志允许字段；区分session和后台delegation、安全撤销真值表。
- 私有BYOK内容带传递隐私标签，切换site新开空白上下文；独立无网/无业务凭据media容器，后台2GiB拆分1536MiB worker与512MiB media；实体版本/移除墓碑/异步合并、自动代发不标已读。
- 独立异地删除journal、202待完成状态、连续已应用水位/链校验/恢复隔离；独立故障测试拓扑与实例标记；中文固定语料和质量指标、真实任务成本容量模型。恢复权限/凭据不以旧快照自动视为仍有效。
- 永久免打扰枚举、统一固定时区和DST确认、Bun适配器边界、M3头像阶段、可读secondary/placeholder与独立disabled令牌。
- 新增AT-25–AT-37及V-18–V-21，当前均是待实施要求。路线图重新计入实际工作项：68–115专注人日，加25%缓冲约85–144人日，另加至少14天观察与外部等待；首个切片后重新估算，不承诺交付日期。

**实际验证**：
- `bun run check`退出0：Biome 11文件、tsc、guard通过；仅覆盖当前准备脚本，不包含尚不存在的应用测试。
- `docker compose -f infra/compose.dev.yml --env-file .env.local config --quiet`退出0；仅配置可解析，不代表当前容器健康。
- 临时校验器`%TEMP%/chatapp-planning-20261001-validate.mjs`检查19份Markdown的本地链接、表格、编号引用与17项修订映射；D=92、V=21、SEC=41、INV=30、AT=37、A=15均唯一；工期求和正确。校验器最初未匹配带标题的R行，修正其正则后17/17通过，未用修改文档绕过校验。
- sRGB静态计算：12组次要/占位文字最低4.87977:1，16组气泡最低5.56664:1，均≥4.5:1；实际玻璃、交互、缩放和读屏仍待AT-21。
- `git diff --check`通过。定向复核Docker Compose约束、R2一致性、Hono请求限制和WCAG官方资料；没有因此声称目标环境已验证。

**边界和下一步**：没有新增业务代码、安装依赖、修改密钥/运行配置、执行付费模型调用、故障注入、部署、提交或推送。先做V-13及AT-34独立故障环境，再完成M1a认证纵向切片；D原型可以推进。M3媒体、M4/M5质量与成本、M7删除journal及恢复均按各自准入/出口门槛实测，不再仅以文档完善代替实现证据。

### 2026-10-01 · 最新规划独立复审（Codex，基线 9a85687）

- 用户请求再次全面深入分析项目规划。按 D-056–D-075 复核现行规则，没有把 14 中已修订的旧方案重复算作当前缺陷。
- 新增 [15-planning-rereview-2026-10-01.md](15-planning-rereview-2026-10-01.md)：12 项发现（6 项 P1、6 项 P2），附反例、建议和验收场景；另列 5 项较小的一致性问题。内容属于审查建议，尚未成为新决策或生效规格。
- 定向核对规划锁定的 Better Auth 1.7.6 邮箱验证源码，以及 Nginx、Hono、Docker、DeepSeek 官方资料。重点补充注册令牌绑定、日志泄露、HTTP 请求预算、后台授权和跨 key 内容继承的边界。
- 实际执行 `bun run check` 通过（Biome 11 文件、tsc、guard）；开发 Compose 的 `config --quiet` 退出码 0。独立计算未读反例、成本场景、工期和初稿文字对比度，均不属于应用运行时测试。
- 报告的 12 项编号、6/6 优先级统计、28 个本地链接及交接链接校验通过；`git diff --check` 通过。
- 应用尚未实现，未运行应用集成/E2E、付费模型请求、破坏性故障或恢复演练。只新增审查报告和本交接记录，未修改既定规格、配置与代码，未提交或推送。
- 下一步：先处理 15 的 R01–R04 和故障环境契约，再落实 M1a 首个认证切片；D 原型可继续。

### 2026-10-01 · 授权提交与推送前复核（Codex）

- 用户明确要求推送；本次提交包含规划完善、独立审查报告和 Mailpit SMTP 端口可配置修复。
- `git fetch origin` 后本地 HEAD 与 `origin/v2` 无差异；`bun run check`、规划文档校验（18 篇文档、47 个本地链接、24 项问题对应验收）、`git diff --check` 均通过。
- 再次执行 `bun run doctor` 全部通过：四个容器健康，开发/测试数据库和对象存储、Valkey、Mailpit SMTP 12525 可用；未执行付费 AI 探测。
- 本记录写入时尚待推送触发远端 CI；最终推送与 CI 结果按本次提交 SHA 核验。应用功能验收仍待后续实现。

### 2026-10-01 · 全面优化完善规划（Codex）

**用户授权**：“现在全面优化完善项目规划”。本轮落实规划与验收设计，未开始应用实现。

**完成**：
- 新增 D-056–D-075，共 20 条决策；对被取代的旧决策标注新依据，保留历史记录。F01–F24 全部有设计修订与 AT 对照，见 14 顶部。
- 同步 00–12、CLAUDE、README 和本进度记录：持久工作与同步日志、事务授权、认证允许清单、注册激活状态机、Agent 来源/范围世代/租约/审批/取消、预算预占、上传对象账本、完整副本清理、推送 SSRF、本地账号隔离、生产 bootstrap、一致备份及恢复隔离。
- 设计新增 8 色 × 深浅的 16 个可读气泡组合，以及桌面缩放至 320 CSS px 的重排要求。实际渲染、键盘/读屏与跨平台视觉验收仍属 D/M1b/M2b。
- 08 新增 AT-01–AT-24 故障验收目录与混合负载基准；11 改为纵向切片，给出初估工作量、25% 缓冲、技术实验退路、范围冻结点和 14 天真实内测门槛。工期是假设下的待校准估算，不是承诺日期。
- 定向复核 Better Auth 管理插件/hooks、BullMQ jobId 和 Nginx headers 的官方资料；尚未安装应用依赖，不把文档说明作为锁定版 adapter/SDK 兼容性证据。

**验证**：
- `bun run check`：退出码 0，Biome 11 文件、tsc、guard 均通过；这仍只覆盖现有准备脚本。
- 临时规划校验脚本（`%TEMP%/chatapp-plan-validate.mjs`）：18 份 Markdown、47 个本地链接、86 张表的结构检查通过；D 定义 75、SEC 35、INV 23、AT 24 均唯一且引用可解析，F→AT 对照 24/24；现行规格中列入检查的旧规则残留为 0。
- 16 个气泡正文组合按 sRGB 相对亮度公式计算均 ≥4.5:1；最低为浅色蓝 5.567:1，深色蓝为 5.757:1。此项不代替实际玻璃背景/控件/交互状态的无障碍验收。
- `git diff --check` 通过。未运行应用集成/E2E/故障测试（尚无应用实现），未进行收费模型请求、部署、提交或推送。保留上一轮 SMTP 配置修复。

**下一步**：D 可做原型；M1a 先完成 V-13 的注册关联事务与认证路由允许清单实验，再做 work_items/幂等及完整注册切片。V-01、V-02、ARM、真实邮箱/网络、恢复与混合负载按 11 的前置/出口门槛验证，不能直接勾选通过。

### 2026-10-01 · Docker 启动后的环境补查（Codex）

**用户补充**：已经启动 Docker。

**检查与修复**：
- Docker Engine 29.8.1 可用；初次 `bun run doctor` 中 Postgres、Valkey、Garage 均通过，但 Mailpit 无法从宿主机连接，尽管容器显示 healthy。
- Mailpit 的 `HostConfig.PortBindings` 有配置，`NetworkSettings.Ports` 却为空；仅重启 Mailpit 后仍失败。单独重建时，Docker 明确报告 2525 端口绑定权限错误。
- `netsh interface ipv4 show excludedportrange protocol=tcp` 显示 2492–2591 被 Windows 保留，覆盖 2525。实测 127.0.0.1:12525 可绑定。
- Compose 的 SMTP 映射改为读取 `${SMTP_PORT:-2525}`；仅将本机 `.env.local` 的 `SMTP_PORT` 改为 12525，模板默认仍为 2525。同步本机环境说明和 D-029 的环境补充。
- 重建前将停止后仍留在旧 Mailpit 容器中的临时 SQLite 文件复制到 `C:\Users\Mars\AppData\Local\Temp\chatapp-mailpit-recovery-20261001-095526`。Mailpit 默认没有持久卷，当前容器未导入这些旧文件。没有执行 `infra:reset` 或删除数据卷，没有重启其他三个服务、原生 Postgres 或 VPN。

**最终验证**：
- `docker compose -f infra/compose.dev.yml --env-file .env.local config --quiet`：退出码 0。
- 单独重建 Mailpit 并等待健康后，四个服务均 healthy；Mailpit 实际映射为 `127.0.0.1:12525->1025` 和 `127.0.0.1:8025->8025`。
- `bun run doctor`：退出码 0，`environment ok`。开发与测试库均为 PostgreSQL 18.6，`pg_trgm` 1.6、`vector` 0.8.6 和 `uuidv7()` 正常；Valkey PING、noeviction、AOF 正常；两个 Garage 桶均完成临时探针写入、读取、删除；Mailpit API 和 SMTP 220 横幅通过。
- `bun run check`：退出码 0，Biome 检查 11 个文件，`tsc` 通过，`guard: ok`。
- 本次未调用 DeepSeek 接口；应用集成测试尚不存在。以上只证明当前基础设施可用，不代表 24 项规划发现已经解决。未提交或推送。

### 2026-10-01 · 项目规划独立审查（Codex）

**用户请求**：全面深入分析项目规划，看是否完美。

**完成**：
- 审查 `v2` 的 `92f22a3`：00–13、PROGRESS、CLAUDE.md、开发脚本、Compose、CI 和工具链配置。
- 新增 `14-planning-review-2026-10-01.md`：24 项规划发现，区分确定的矛盾、设计缺口与尚待工程验证的事项，附修正建议、优先阶段和故障验收清单。
- 定向核对 Valkey、Better Auth、BullMQ、Docker、Nginx、Web Push、W3C、DeepSeek 官方资料，以及八个 npm 包版本。
- 仅新增审查交付和本交接记录；未修改既定决策、规格、依赖及应用代码，未提交或推送。

**本次验证**：
- `bun run check` 通过：Biome 检查 11 个文件，`tsc` 通过，`guard: ok`。当前没有应用业务测试。
- `docker compose -f infra/compose.dev.yml --env-file .env.local config --quiet` 退出码 0。
- 初次审查的 `docker compose ... ps` 失败：当时找不到 Docker Desktop Linux 引擎管道。用户随后启动 Docker 后的补查和修复见上方记录，不能将此历史失败作为当前状态。
- 用最小逻辑模型验证四个文档反例：尾事件丢失、提交后加入再广播、可见回复携带不可见引用、注册账号创建后确认占用前崩溃。这些不是 v2 应用的运行时复现。
- 计算默认气泡白字对比度：`#007AFF` 为 4.017:1，`#0A84FF` 为 3.647:1，均低于普通正文 AA 的 4.5:1。

**下一步**：先将报告 F01–F08 的可靠交付、权限边界、认证收口、注册和 Agent 状态设计补入规格及相应验收；其余问题按里程碑处理。报告中的方案是审查建议，并非已生效的新决策。

### 2026-09-30 · 会话 2：规划审查与修订（Claude）

**用户的指示**
- 先要求"全面深入的分析项目规划，看是否完美"。
- 看完审查结果后，拍板四项：
  - 内存只要不超过服务器总量；
  - 管理员可以看到使用官方 API 的 Agent 的全部原文消息；鼓励用户使用自己的 API，但鼓励时不说管理员能看到；
  - 新成员不用看到之前的历史；
  - "重新生成"替换原回复。
- 其余交给 Claude："其他的要优化完善的地方你自己决定，现在全面优化完善当前规划"。

**完成**
- **审查**：通读 00–13、两份 CLAUDE.md，以及已落地的脚本、compose、CI 配置，找出 45 条问题和若干小问题。所有结论都已并入下列文档。
- **决策**：
  - 新增 D-033 到 D-055，前四条是用户的决定；
  - 在 D-003、D-015、D-021、D-022、D-023、D-025、D-027 后标注补充关系；
  - 新增待验证项 V-08 到 V-17，V-06 并入 V-08。
- **文档**：重写 01、03、04、05、06、07、08、10、11；修改 00、02、09、12、CLAUDE.md。
- **主要变化**：
  - M1 拆成 M1a（后端，可以和 D 并行）和 M1b（前端）；
  - 消息可见性（`visible_from_seq`、`last_join_seq`，不广播新成员看不到的内容）；会话封禁；
  - 副作用恰好一次（`agent_effects`）、完整运行状态（`agent_run_states`）；
  - WebSocket 与登录会话绑定；Better Auth 原生接口收口；邀请名额原子占用；
  - 自带 key；数据保留（04 第 10 节）与隐私说明（01 第 4.11 节）；
  - 面向中国网络与中文输入的处理；内存预算约 6 GB；公开文档不再写服务器细节。
- **代码**（两处小改动）：
  - `.gitignore` 增加 `*.env`；
  - `scripts/guard.ts` 同样拦截被跟踪的 `*.env` 文件，并增加 `setHTMLUnsafe`、`createContextualFragment`、`srcdoc` 等禁用写法。

**验证证据**
- `bun run check`：Biome 检查 11 个文件无问题，`tsc` 通过，输出 `guard: ok`。
- 用临时脚本核对新的 guard 规则：
  - `.env`、`.env.local`、`app.env`、`infra/db.env`、`x/.env.production` 会被拦截，`.env.example`、`docs/env.md` 不会；
  - `innerHTML`、`srcDoc`、`createContextualFragment`、`setHTMLUnsafe`、`document.write(` 都能识别，`innerHTMLish` 这样的名字不会误报。
- `git check-ignore`：`app.env`、`infra/db.env` 被 `*.env` 规则忽略；`.env.example` 没有被忽略。
- 文档一致性检查（临时脚本，均在会话临时目录中）：
  - 所有 D、V、SEC、INV 编号都能对上；
  - 表格单元格内的代码里没有未转义的 `|`。05 中原有 8 处会让 GitHub 表格错列，已改为 `\|`；
  - 逐个核对了重写前后消失的代码标记，确认都是有意的改动：改名的接口、删除的服务器细节、替换掉的 Caddy 等。
- 修改完文档后，再次执行 `bun run check`，结果通过。
- **逐条核对**（用户追问是否全部改完之后，2026-10-01）：
  - 用临时脚本核对审查中提出的全部问题——45 条主要问题、14 条小问题，以及 V-08 到 V-17——逐条确认文档里有对应的修改，共 107 项检查，缺失 0 项；
  - 自查时另外发现 11 处原清单之外的缺口，已一并补上：
    - 修改密码时注销其他会话，重置密码时注销全部会话；关闭 `cookieCache`；
    - 工作区子目录里 env 文件的加载方式；
    - Agent 输出消息在恢复运行时不重复创建；
    - 群里 @Agent 被额度拦下时，只提示调用者；
    - "仅自己删除"的措辞；
    - 播放不了的视频改为文件卡片；
    - 读屏播报限流；
    - 测试环境显式开启 Better Auth 的限流；
    - 附件下载关闭 Nginx 代理缓冲；
    - `/api/monitoring` 不需要登录；
    - 写明移出成员后退订之间的毫秒级窗口是已知并接受的风险；
  - 补完后再次执行 `bun run check`，结果通过；表格检查结果为 0 处问题。

**请用户留意**
- **历史可见性**："新成员看不到加入前的历史"同时适用于频道和群组。如果希望频道保留公开历史，告诉我即可修改。
- **隐私说明**：隐私说明页（01 第 4.11 节）会如实写明"使用站点 key 时，Agent 运行内容管理员可以查看"；鼓励自带 key 的文案里不提这一点。原因是原规格对用户承诺过"管理员不能读取私有内容"，说明必须与实际行为一致。
- **提交**：2026-10-01 用户回复"推送"，同意把本次修改提交并推送到 `origin/v2`。

**下一步**
- D 设计原型和 M1a 后端骨架可以同时开始，各开一个会话；M1b 等 D 定稿后再做。

### 2026-09-30 · 会话 1（续 2）：推送、清理历史、指定模型（Claude）

**用户的指示**："推送"、"清理"，以及"key 已填好，目前直接指定用 V4.1-Flash"。

**完成**
- **模型**（D-031，提交 `d723d7b`）：
  - `bun run doctor --ai` 调用 DeepSeek 的模型列表接口，结果为 ✓，可用的模型是 `deepseek-flash` 和 `deepseek-v4-pro`。
  - 把 `AI_MODEL_FAST` 和 `AI_MODEL_DEEP` 都改为 `deepseek-flash`，深度模式的计价也改为 Flash 的价格；`.env.example` 和 `.env.local` 都已修改，只改了这几行。
  - 同步更新了 00、03、06、12 四份文档。
- **历史清理**（D-032）：
  1. 先把整个仓库备份成 bundle，放在当次会话的临时目录里（35 MB）。
  2. 在 `--no-local` 镜像克隆里执行 `uvx git-filter-repo --invert-paths`，删除 96 个用户上传的文件，保留 3 个应用素材。
  3. 推送前逐项核对：提交数量不变（main 14 个、v2 20 个）；v2 最新提交的内容与改写前逐字节相同；main 只少了 `media/` 下的文件；打包大小从约 35 MB 降到 264 KB。
- **推送**：
  - 执行 `git push --atomic --force-with-lease=main:99056e7 … main v2 v1-legacy`，凭据由 `gh auth git-credential` 提供，只在这条命令里生效。
  - 结果：main 从 `99056e7` 强制更新为 `9841352`；新增分支 v2（`d723d7b`）；新增标签 `v1-legacy`。
- **本地同步**：先确认本地 v2 和远程 v2 的内容完全一致，再执行 `reset --hard origin/v2`；并更新 main 和标签，设置好上游分支。`.env.local`、`garage.toml`、`node_modules` 都不受影响。
- **CI**：`check` 工作流通过，每一步都实际执行了：Bun 1.4.2 按锁文件安装依赖、Biome 检查 11 个文件、`tsc` 类型检查、guard、compose 配置校验。

**注意**
- 本地的 reflog 里还有旧的提交对象，大约 30 天后会自动清掉。
- 临时目录里的备份 bundle 是当次会话的，会话结束后就不在了。

### 2026-09-30 · 会话 1（续）：开发准备（Claude）

> 这一段里的提交号都是**清理历史之前**的。对应关系：`f5e9012`→`35f3547`，`694b5d7`→`8b74b5c`，`1c409e6`→`b28dbbe`，`3540ac7`→`a8f1456`，`917f173`→`77cd6db`；旧代码 `99056e7`→`9841352`（即标签 `v1-legacy`）。

**完成**
- **仓库**
  - 设置本仓库的 git 身份：`liaboveall <2628370933@qq.com>`，只在本仓库生效；
  - 提交文档；
  - 移除旧代码（删除 153 个文件），LICENSE 补上上游版权；
  - 提交工具链；
  - 提交本地基础设施和脚本。
- **环境**
  - 用官方脚本安装 Bun 1.4.2；
  - `bun install` 安装了 4 个开发依赖：Biome 2.5.14、`@types/bun` 1.4.2、lefthook 2.1.15、TypeScript 7.0.2；
  - 拉取了 4 个镜像：pgvector 0.8.6-pg18、Valkey 9.1、Garage v2.4.1、Mailpit v1.31.3。
- **意外情况**
  - 本机 1025 端口被 Cisco VPN 占用，Mailpit 的 SMTP 改用 2525（D-029）；
  - Biome 2.5 的配置写法已通过 `biome migrate` 更新。

**验证证据**
- `bun run check` 通过；两次提交时 lefthook 的 pre-commit 钩子都通过。
- `infra:up`：4 个容器都 healthy。
- `infra:bootstrap`：运行两次结果相同，可以重复执行。
- `bun run doctor`：除可选的 key 检查外全部 ✓，最终输出 `environment ok`。其中：
  - PostgreSQL 18.6，已装 pg_trgm 1.6 和 vector 0.8.6，`uuidv7()` 可用；
  - Valkey 配置为 `noeviction`，AOF 已开启；
  - Garage 的两个 bucket 用 Bun 的 S3 客户端读写删都正常；
  - Mailpit 的 SMTP 在 2525 端口返回 220。
- 执行 `infra:down` 再 `infra:up` 后，数据依然在。

### 2026-09-30 · 会话 1：分析与规划（Claude）

**完成**
- **分析旧版**：通读源码，在临时目录里实际运行，复现了 24 个缺陷和三类基础设施问题，写成 13。
- **查证资料**：核实了各组件的最新版本、DeepSeek 当前的模型，以及 Apple 在 WWDC 2026 对 Liquid Glass 的修正。
- **确定决策**：用户确定了几项关键决策：邀请制、DeepSeek、桌面优先、本地优先且最后上线、Apple 风格、技术栈只选最新最好。其余由 Claude 决定，记录在 12。
- **写文档**：`docs/00` 到 `docs/13`、本文件，以及根目录的 `CLAUDE.md`。
