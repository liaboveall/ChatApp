# 08 测试与质量

## 1. 原则

- **用真实的依赖测试。** 数据库、Valkey、Garage、Mailpit 都用真实服务，不做模拟，因为事务、并发、权限这些问题只有在真实环境里才测得出来。
- **只模拟外部服务**：DeepSeek、浏览器推送服务、生产环境的邮件服务商。Agent 的评测则直接调用真实的 DeepSeek。
- **测试是"完成"的一部分**：没有测试的功能不算完成。
- **只说跑过的结果**：不能把没跑过的检查写成"通过"。PROGRESS 里要记录实际执行的命令和结果。

## 2. 测试分层

| 层 | 工具 | 位置 | 覆盖什么 |
|---|---|---|---|
| 单元 | bun test（后端）、Vitest 5（前端） | 与源文件放在一起，文件名为 `*.test.ts` | 纯逻辑：权限策略、可见性判断、时限计算、Markdown 规则、版本合并与完整同步水位、预算计算、保留名规范化 |
| 集成（API） | bun test，加上真实的 Postgres、Valkey、Garage | `apps/server/test/integration/` | 每个接口的正常路径、校验失败、无权访问（404/403）、幂等、限流、并发（邀请名额、存储配额） |
| 实时（WS） | bun test 在随机端口启动 api，用真实的 WebSocket 客户端连接 | `apps/server/test/realtime/` | 认证、来源校验、会话失效断开、订阅隔离、事件结构、不泄露加入前的内容、正在输入和在线状态、多实例经 Valkey 转发 |
| 安全回归 | bun test 和 Playwright | `apps/server/test/security/`（M2a：`conversation-matrix.test.ts` 权限矩阵、`legacy.test.ts` 的 L-xx 回归）、`apps/web/e2e/`（M1b：`isolation`、`realtime`、`scenario-11-devices`） | L-01 到 L-24，以及每条 SEC 要求（见 07）。权限矩阵把每个会话、消息、同步和目录接口按六类调用者对群、频道、私信各调一遍，并要求每个路由在表里都有一行（D-136） |
| 契约 | bun test | `apps/server/test/contract/` | 由路由生成 OpenAPI 快照并与上次比对，接口的变化必须是有意为之 |
| 数据库迁移 | CI 脚本 | — | 空库迁移、上一发布版含真实关系的数据夹具升级、bootstrap 幂等、新旧应用兼容、drizzle-kit check；演示 seed 单独验证 |
| 端到端 | Playwright 1.63 | `apps/web/e2e/` | 多人场景：用两到三个互相隔离的浏览器环境同时登录。Chromium 和 WebKit 全量运行，Firefox 只跑冒烟（带 `@smoke` 标记的用例）。**对生产构建运行**：`vite preview` 发送生产的 CSP，API 与 worker 用测试环境，邮件取自 Mailpit 的 API，每个测试自动断言零 CSP 违规和零意外控制台错误（D-122）。M1b 有 8 个文件：`scenario-1-registration`、`scenario-11-devices`、`auth-flows`、`shell`、`isolation`、`realtime`、`passkey`、`a11y`；M2a 加了 `network`（模拟断线的辅助函数 `support/network.ts` 与它的验证，V-14、D-134）。M2b 起夹具对**每个**浏览器上下文断言零违规（D-148：`newContext()` 登记并在测试结束关闭；`allowConsole`、`claimViolation` 必须匹配到才算数；文档响应的 CSP 头逐字等于 `tools/csp.ts`），并新增 `scenario-2-chat`、`scenario-3-reconnect`、`scenario-4-recall`、`scenario-5-isolation`、`scenario-10-boundary`、`scenario-12-ime`、`security`、`inspector`、`profile`、`consistency`、`timeline-perf`、`latency`、`accessibility`（`support/chat.ts` 是 API 与界面两类助手，`support/perf.ts` 是性能探针，`support/network.ts` 另有 `muteHints`）。带 `@perf` 标记的用例（`timeline-perf`、`latency`）只在单独的 `perf` 项目里跑（Chromium，有显卡时用显卡合成，D-161），其余项目都不跑它们；WebKit 和 Firefox 在截图时往页面里塞的内联样式、断网期间浏览器对失败请求的控制台报告、Firefox 里 `fill` 之后紧跟的回车，夹具和助手各有处理（D-165）。`apps/web/edge/` 是只在本机跑的网关套件（`bun run test:edge`，D-147） |
| 无障碍 | `@axe-core/playwright` | 与端到端测试一起（`a11y.spec.ts`） | 关键页面没有 WCAG 2.2 A/AA 与 best-practice 违规；M1b 覆盖登录前的页面、外壳及其对话框、设置面板，浅色与深色各一遍；M2b 加会话页（时间线、输入栏）、详情面板及其菜单与对话框、侧栏与消息菜单、私信资料、新建会话对话框、频道发现与已归档页、读屏分页模式、找不到会话的页面、没人写过消息的会话（空的 feed 会被 axe 判严重违规，D-164）（弹层里的菜单关掉 axe 的 `region` 规则，其余全开）。`accessibility.spec.ts` 补 axe 查不出来的两件事（AT-21）：在一万条消息的会话里用键盘走（↑ 三十次、PageUp、滚轮拉走很远、End、Home、Esc），焦点任何时刻都不落到 `<body>`；320 CSS 像素宽（桌面 400% 缩放的等价布局）下从抽屉里选会话、发消息、看详情，页面不横向溢出（D-166）。Storybook 的 a11y 面板是 `todo` 模式，只报告不阻断 |
| 视觉 | Playwright 截图，对象是 Storybook 中的关键组件 | `apps/web/visual/` | 防止设计还原走样；浅色和深色模式都要截。**基线只在 Playwright 官方 Linux 镜像里生成和比对**（`bun run test:visual`），本机（WSL 与 Windows）的字体不同，直接截图永远对不上。M1b：64 张基线，逐像素严格比较，只有 Chromium（D-123） |
| Agent 评测 | `bun run eval`（调用真实的 DeepSeek） | `apps/server/evals/` | 见 06 第 12 节 |
| 压力 | k6（Docker 镜像，锁定版本） | `infra/load/` | M7：500 个 WebSocket 连接、每秒 20 条消息，p95 < 300 ms；彩排时把容器的 CPU 限制到接近服务器的 2 核 |

## 3. 端到端测试必须覆盖的场景

1. 管理员生成邀请码 → 新用户通过注册链接注册 → 在 Mailpit 中打开验证邮件 → 登录。（M1b ✅ `scenario-1-registration.spec.ts`，Chromium、WebKit、Firefox 都通过）
2. A 创建频道，B 加入；双方实时收发消息，都能看到"正在输入"，未读数正确。（M2b ✅ `scenario-2-chat.spec.ts`）
3. B 断线，A 在此期间发消息、编辑消息；B 恢复后，这些变化都补齐，没有重复。（M2b ✅ `scenario-3-reconnect.spec.ts`，另含 AC-06：只吞掉提示、连接和 HTTP 都正常，35 秒内靠对账补齐）断线用 `apps/web/e2e/support/network.ts` 的 `controlNetwork`（HTTP 用 `context.setOffline`，WebSocket 用 `page.routeWebSocket`：断开已建立的连接、离线时拒绝重连、恢复后放行；要在页面第一次连接之前安装）或服务端测试接口 `/api/test/realtime/disconnect` 模拟：`setOffline` 单独用在三个引擎里都断不开已经建立的 WebSocket（V-14 已验证，D-134）。
4. A 在 2 分钟内撤回一条消息，B 看到撤回提示；超过时限后，撤回按钮不再出现。（M2b ✅ `scenario-4-recall.spec.ts`：A 的浏览器时钟拨慢 10 分钟，消息用 `POST /api/test/messages/{id}/age` 变老 3 分钟）
5. 私信和群组的隔离：C 不是成员，所有访问方式都返回 404；页面上也看不到这些会话。（M2b ✅ `scenario-5-isolation.spec.ts`，页面文字和每个 API 路径的回答都与「根本没有这个 id」逐字相同；L-05 在同一个文件）
6. 上传图片：显示上传进度 → 出现缩略图 → 点开预览；下载该图片时带有正确的安全响应头。（M3）
7. 群里 @Agent 总结共同可见的讨论：所有有权成员看到流式回复，只有调用者能看工具调用卡片；额度按预占/结算显示；重新生成原位替换。（M4）
8. 让 Agent 代发一条消息 → 当前回复收尾并显示"等待批准" → 出现审批卡片 → 点批准 → 消息以本人身份发出，并标注"经助手代发"。（M5a）
9. C 关闭页面后收到私信推送（在测试中模拟推送服务来验证）。（M6）
10. D 在群里有一段历史之后才加入：D 看不到加入前的消息；引用了旧消息的回复显示"原消息不可见"；D 被"移出并封禁"后，用群邀请链接无法再加入。（M2b ✅ `scenario-10-boundary.spec.ts`）
11. 用户在设备甲注销设备乙：设备乙的实时连接被关闭，HTTP 会话接口拒绝并跳转登录页（M1b ✅ `scenario-11-devices.spec.ts`）；“注销后收不到聊天内容”在 M2b 消息功能存在后扩展验证。
12. 用中文输入法组字时按回车，只确认候选词，不发送消息。Chromium 里通过 CDP 模拟输入法组字过程。（M2b ✅ `scenario-12-ime.spec.ts`，仅 Chromium）
13. 用户填写自带key（模拟模型）：不扣站点额度；key失效时“使用站点额度发起新请求”打开空白新段。原私有prompt/图片/摘要/记忆不能通过历史或全范围工具进入site运行。（M5a）
14. 本人普通退出后定时消息仍执行但不推进已读；撤销发起设备/改密后相应任务取消，已提交效果不重复。（M5a）
15. 删除返回202时显示待完成，异地journal确认后才显示成功；重连补齐操作状态。（M7）

## 4. 测试数据与隔离

- **普通数据库集成**：可用开发实例中的专用库chatapp_test，但只准测试表级数据；入口检查APP_ENV=test、库名、bucket/prefix并拒绝开发/生产数据集。
  - 每次测试运行开始时执行一遍迁移；
  - 集成测试文件串行执行（共用同一个测试库），每个文件结束后清空所有表（TRUNCATE … CASCADE）；
  - 需要严格隔离的测试，用"事务结束后回滚"的方式运行。
- **Valkey**：
  - 测试使用 db 1，每个测试文件用独立的 key 前缀；
  - 事件频道名是 `events:test`，因为 pub/sub 不区分 db 编号，这样开发服务和测试同时运行也不会串（D-044）。
- **Garage**：测试专用 bucket `chatapp-test`。
- **实例故障隔离（D-085）**：所有kill/stop、FLUSHALL、实例配置、OOM、网络/磁盘故障及恢复演练，必须使用09定义的compose.test.yml，chatapp-test-<runId>独立容器/卷/网络/密钥/端口。核验project label、容器ID、连接端点和三服务实例标记；允许目标清单落运行manifest。故障清理只能操作该清单，不能因库名带test就中断共享开发实例。CI每job/shard同样隔离；先通过AT-34再允许其他破坏性矩阵。
- **测试数据**：用工厂函数生成，比如 `makeUser`、`makeConversation`、`sendMessage`，统一放在 `apps/server/test/factories.ts`。
- **时间**：窗口期类测试（撤回、编辑、邀请码过期、未验证账号清理）都要注入可控的时钟，**不要**真的等待。
  - 后端单元和集成测试：直接注入时钟。
  - E2E：服务端在 `APP_ENV=test` 时提供 `/api/test/clock`，浏览器端用 Playwright 的 `page.clock`。
  - 这些测试接口在生产环境不存在，启动时会检查（SEC-29）。
- **Agent**：集成测试和 E2E 用 `AI_PROVIDER=mock`，结果确定；评测才调用真实的 DeepSeek。
- **限流**：Better Auth 的限流可能默认只在生产环境开启。测试环境要显式开启，否则限流相关的测试没有意义（M1a 确认）。
- **崩溃注入**：副作用工具"恰好一次"的测试，要在"写入步骤之后、执行之前"和"执行之后、返回之前"两个时刻分别杀掉 worker，再验证结果（INV-10）。

## 5. CI（GitHub Actions）

| 工作流 | 什么时候跑 | 内容 |
|---|---|---|
| `check` | 每次 push 和 PR | 安装依赖 → Biome 检查 → TS 7 类型检查 → 单元测试（含前端 Vitest）→ 令牌对比度与文案一致性 → 依赖边界检查（03 第 3 节）→ `guard` 扫描禁用写法和被跟踪的密钥文件 → 构建前端 → 确认 `routeTree.gen.ts` 是最新的 → Storybook 构建 |
| `integration` | 每个 PR | 真实 Postgres/Valkey/Garage/Mailpit → 空库及上一发布夹具升级 → bootstrap 幂等/旧版兼容 → drizzle-kit check → 集成、实时、安全与契约测试，并按第 7 节检查 `domain/`（和将来的 `agent/`）的行覆盖率（`bun run test:coverage`，M2a 起；本地通过，远端 `78e0cf5` 上第一次运行就通过）→ 故障矩阵（独立的 `fault` 作业） |
| `e2e` | M1b 起每个目标为 v2/main 的 PR，以及每晚 | 构建并启动整个应用 → Playwright（Chromium 和 WebKit 全量，Firefox 冒烟）→ 无障碍检查 → 在 Playwright 官方镜像里做视觉截图对比。**M1b 已写好**（`e2e`、`visual` 两个作业，推送到 main/v2、PR、每晚和手动触发），2026-10-03 在 `d214415` 上首次远端运行成功（`e2e` 作业 106 通过 / 3 跳过，`visual` 作业 64 通过） |
| `security` | 每个 PR 和每周一次 | gitleaks、osv-scanner；M7 起加上 trivy 扫描镜像 |
| `eval` | 手动触发，以及每周一次 | Agent 评测，需要仓库密钥 `DEEPSEEK_API_KEY` |
| `load` | 手动触发 | k6 压力测试 |
| `image`（M7 起） | 推送到 main 或打版本标签时 | 在 GitHub 的 `ubuntu-24.04-arm` 机器上构建 arm64 镜像（另外构建 amd64，供本地彩排）→ 扫描 → 在同一台 arm64 机器上用 `compose.prod.yml` 启动整套服务，执行迁移和冒烟测试 → 推送到 GHCR |

- CI 里所有工具的版本都和本地一致：Bun 版本写在 `package.json` 的 `packageManager` 字段里，并且提交锁文件；Docker 镜像锁定精确版本。
- 合并到 v2/main 前，当前合并 SHA 的 check、integration、security，以及 M1b 起启用的 e2e 必须通过；M7 的发布候选另要求 image/arm64 与恢复、混合负载证据。未创建的工作流必须在对应里程碑建立；现有 `check`、`integration`、`security`、`e2e`（M1b 创建，`d214415` 上首次远端运行成功），`eval`、`load`、`image` 未创建。
- CI 必过项与路径过滤保持一致，不能因为跳过工作流就显示完成；失败后的修复必须重跑修复 SHA。只改文档时允许契约/链接检查替代业务重跑，但不得据此更新运行时通过记录。

## 6. 完成标准（Definition of Done）

**单个任务**
- [ ] 按规格实现；如果规格有变，先修改文档。
- [ ] 补上了测试：正常路径、异常路径，以及权限拒绝的路径。
- [ ] 本地 check 与该切片必需的独立 integration/e2e/迁移检查通过；命令以实际 package.json 为准，不把尚未接入 check 的测试算入通过。
- [ ] 界面有 loading、空、错误、无权限、长内容、深色模式这几种状态。
- [ ] 没有引入新的 `any`、`@ts-ignore`，也没有跳过的测试；确实需要时，写明原因和后续处理计划。

**里程碑**
- [ ] [11-roadmap.md](11-roadmap.md) 中列出的验收标准逐条通过，并记下证据（命令、结果、截图）。
- [ ] 07 第 4 节的安全自查清单通过。
- [ ] 更新 PROGRESS.md：做了什么、证据是什么、有哪些遗留问题、下一步做什么。
- [ ] 用户确认（涉及界面的里程碑，需要用户在浏览器里亲自看过）。

## 7. 覆盖率

- 不设全局的覆盖率门槛。
- `domain/`（尤其是 `authorize()`、可见性判断和各项策略）以及 `agent/` 里的策略、预算和副作用账本代码，行覆盖率要达到 90% 以上，由 CI 检查。
- bun test 的覆盖率门槛只能设全局值，所以按目录的检查用一个小脚本读取 lcov 结果来完成。
- **已实现（M2a，D-142）**：`bun run test:coverage` 跑服务端的单元、集成、安全、契约、实时测试，写出 `coverage/lcov.info`，再由 `scripts/coverage-check.ts` 按 `scripts/lib/coverage.ts` 里的门槛检查：`apps/server/src/domain/` ≥ 90%；`apps/server/src/agent/` ≥ 90%（目录还不存在时跳过，M4 起生效；存在却没有数据则失败）。退出码 0 通过、1 不达标（列出拖后腿的文件）、2 没有 lcov。`bun run coverage:check` 只检查已有的 lcov。脚本本身有单元测试。`integration` 工作流的集成作业调用它（远端 `78e0cf5` 上第一次运行就通过：595 个测试，`domain/` 99.28%）。测试文件、`test/` 目录和依赖不计入。故障测试（`test/fault/`）需要独立实例，不在这次覆盖率运行里。

## 8. 独立复审故障验收矩阵

AT-01–AT-24对应14的历史F发现，AT-25–AT-37覆盖15的复审与一致性修订；下列都是要求；**应用验收只执行了 M1a、M1b、M2a、M2b 范围内的部分**（M1a：AT-04、05、25、26 应用部分、27 API 部分、28 契约部分、34，以及 01/02/13/16/23 的 M1a 子集，证据和限制见 PROGRESS 的 M1a 交接记录；M1b：AT-17 的账号命名空间、AT-21 的自动化部分、AT-37 的时区部分，以及 AT-23 的 `e2e` 工作流，证据和限制见 PROGRESS 的 M1b 交接记录；M2a：AT-03 的消息与可见性部分、AT-12 与 AT-31 的服务端部分、AT-13 的发送、创建与重放前撤权部分、AT-16 的转让与最后 owner、AT-32 的策略部分、AT-37 的免打扰部分，以及 AT-01/02 的服务端部分（持久提示；隔离实例里的杀进程与清空队列；总线断开；写入与撤权的锁序竞争；订阅刷新的乱序，D-137 到 D-140；前台 35 秒收敛的客户端部分属 M2b），证据和限制见 PROGRESS 的 M2a 交接记录与「M2a 复核问题的修复」），**M2b**：AT-01 的前台 35 秒收敛（`scenario-3-reconnect` 的 AC-06 用例）；AT-03 的界面部分（`scenario-10-boundary`：加入前的内容不在页面上，引用读作「原消息不可见」）；AT-12、AT-31 的客户端部分（`lib/sync/engine.test.ts` 与 `merge.test.ts`，E2E `consistency`、`profile`）；AT-19 的响应头部分、AT-26 与 AT-27 的网关部分（`apps/web/edge/` 25 个用例，只在本机跑，D-147、D-167；AT-19 的 watchdog 与旧哈希资源属 M7 彩排，AT-27 的上传 100 MiB 属 M3、信封 256 KiB 与并发超限没测）；AT-21 的自动化部分（axe 浅色与深色、`accessibility.spec.ts` 的键盘用例与 320 px 用例；读屏和真机属 V-22）；证据和限制见 PROGRESS 的 M2b 交接记录），其余尚未执行。使用可控屏障/时钟和真实依赖，实例故障先通过AT-34隔离门槛。每项证据记录负责人、SHA、测试名/命令、环境、结果和限制，未创建测试不可标通过。

| 编号 | 最晚阶段 | 故障/输入 | 必须断言 |
|---|---|---|---|
| AT-01 | M1a/M2a | 业务提交后杀 API；仅丢最后提示；清空隔离队列 | 每项业务都有 durable 工作；可恢复派发，前台 35 秒内收敛，无重复业务效果 |
| AT-02 | M1a/M2a | 丢撤权事件、总线断开、写入鉴权后踢人 | 5 秒复核+1 秒容差关闭；撤权提交后新授权拒绝；写入与撤权按锁顺序只产生合法结果 |
| AT-03 | M2a/M4 | 提交→加入→发布；引用旧消息；流式中加入 | 原始 WS/HTTP 不含无权正文、摘要、发送者/附件；旧 run 不提交后续输出 |
| AT-04 | M1a | 直接调用全部原生端点，含路由编码变体 | 普通/管理员/bot/未激活/注销账号均无法代登、改别人凭证、越权赋扩展字段 |
| AT-05 | M1a | 占用、首次账号 INSERT、确认各点崩溃；验证与撤销竞态 | 无无邀请 active 账号、不超名额、不重复释放，孤立 pending 可对账 |
| AT-06 | M4/M5b | all→current；暂停后退群重入；摘要来源编辑 | 新世代无旧私聊上下文，旧来源 run 终止；共享输入只含共同可见内容 |
| AT-07 | M4/M5a | 批准后入队前崩溃、保留旧 job、两 worker、取消后重启 | 合法续跑可恢复、每段仅一输出；旧 epoch 无法提交，效果与取消有确定先后 |
| AT-08 | M4 | 余额只够一次时四路并发；usage 落库前崩溃；跨日审批 | 只有一次准入，unknown 保守占用，无重复结算，周期归属正确 |
| AT-09 | M3–M7 | 同一标识写入所有内容副本再撤回/删除/注销/到期 | 对照 04 完整清单检查在线授权、字段、对象、缓存与备份；最长清理期限告警可测 |
| AT-10 | M3 | 无长度、断流、对象写完 DB 未提交、输出变大、旧任务晚到、解码炸弹 | 预占最终结算，无不记账活对象、无已删附件复活；API 可用且子进程受限 |
| AT-11 | M6 | 非公网端点、DNS 重绑定、重定向、排队后退群/撤回/注销 | 外网测试代理证实未访问禁用目标；发送前权限与绑定有效，失效通知无正文 |
| AT-12 | M2a/M2b | 并发编辑分页、空过滤页、同时隐藏、补发中来新提示 | 固定 through、scannedThrough 正确，observed 不越过 synced，终态一致且不倒退 |
| AT-13 | M1a/M2a | 同键异参/跨会话、并发重试、重放前撤权、过期离线项 | 409 或权限拒绝、不泄露原 DTO、不重复创建；已过期队列不自动发 |
| AT-14 | M5b | 编辑/撤回后旧向量写回、模型维度迁移 | 条件写回拒旧版本、联表过滤、切换/回滚索引有效 |
| AT-15 | M4/M5a | run 已设提醒/写记忆后重新生成，超长 token 输出 | 所有业务效果都禁止重做；20k 码点截断且 usage 照实结算 |
| AT-16 | M1a–M4 | 并发转让、最后 owner 退出/恢复、头像替换、删除 Agent | 约束一致、无越权孤儿附件；生产 bootstrap 重跑无重复且无演示账号 |
| AT-17 | M6 | A 多标签页退出→B 登录、SW 迟到消息、离线远程撤权 | B 看不到 A 的缓存/草稿/队列/推送；重新联网先校验身份，旧队列不自动发 |
| AT-18 | M7 | 备份期间并发删除、屏障失效、缺对象、恢复旧快照 | 失败备份不标成功；成功清单全通过；恢复 session 失效且未核实外发为零；RPO/RTO 实测 |
| AT-19 | M2b/M7 | 子 location/错误页安全头、进程活着卡死、旧页面懒加载 | HSTS/CSP 按职责覆盖且无重复；watchdog 有限恢复；旧哈希资源可读 |
| AT-20 | M3/M5b/M7 | 混合负载、磁盘阈值、队列满、慢 WS、重连风暴 | 资源上限/背压触发，聊天可用，无无界缓冲，恢复不重放效果 |
| AT-21 | D/M1b/M2b | 全配色/透明度、200% 字号/400% 缩放、键盘/读屏 | 正文≥4.5:1、控件≥3:1；320 CSS px 可完成主流程，焦点不被虚拟列表吞掉 |
| AT-22 | M3/M5a/M6 | 共享文件分页、取消与执行竞争、通知级别真值表 | 接口/表/事件/前端都有实现和错误状态，行为符合 05 的映射 |
| AT-23 | M1a–M7 | 空库与上一版夹具迁移、旧客户端/应用、CI required checks | 当前 SHA 全套门槛通过，不以旧 CI 或固定 eval 100% 代替系统保证 |
| AT-24 | 每阶段/M8 | 切片验收、风险实验超时、14 天内测 | 有负责人/证据/失败退路，未完成外部 gate 如实阻塞，不把会话数当工期 |
| AT-25 | M1a/M7恢复 | 同邮箱撤销重建、重发旧链接、消费竞态、GET扫描、恢复旧凭证 | 仅原注册/用途/epoch有效；消费与激活/重置原子且至多一次，GET无副作用，恢复旧链接全部拒绝 |
| AT-26 | M1a应用/M2b网关/M7监控 | 假token/搜索词置body/query/path/header/fragment；成功/400/413/超时/502/重定向及Sentry | 所有日志/事件/breadcrumb无哨兵，未知路径无原文，requestId仍能追踪；不使用真实秘密 |
| AT-27 | M1a/M2b | JSON128KiB/envelope256KiB边界、上传100MiB、无长度/慢请求/异常framing/压缩、并发超限 | 直连API与网关都在解析前拒绝；413/415/408有界；合法中文/Passkey/审批请求成功，小请求保持服务 |
| AT-28 | M1a契约/M4/M5a | 03身份真值表每格；session已删但origin仍存、撤销与效果竞争、子任务越期 | 普通退出任务继续；安全撤销对应origin/epoch任务失效；裸userId拒绝，审批不重绑，usage仍结算 |
| AT-29 | M4基础/M5a/M5b | 私有BYOK→site历史/摘要/记忆/图片/向量/all工具；替换key；显式共享发布 | site输入及admin输出无私有哨兵；新空白epoch；明确发布只有获批正文可被按普通权限读取 |
| AT-30 | M3/M7 | media恶意测试进程探测网络/DB/S3/云元数据/假凭据、任意路径/IPC、fork/OOM/超时/临时盘 | 无网络/业务secret/主机访问；512MiB与64pid硬限可证；进程组和tmpfs清理，worker/API仍可用，后台总量≤2GiB |
| AT-31 | M2a/M2b | 旧GET晚于新PATCH/补发；资料改名、预览隐藏、移出重入、reset时在途响应 | 逐实体/字段组版本不倒退，removed墓碑不复活；不可比预览失效重取；through不作实体版本 |
| AT-32 | M2a策略/M5a/M6 | read50/last100后后台发101；本人在线发送、离线补发、提醒/Agent | 后台/离线补发read仍50且unread51；本人交互才推进，总结未读仍含中间消息 |
| AT-33 | M7 | journal对象/head/本地应用各点崩溃、双writer、断链/过期截断；彻底禁用源主机恢复 | 确认成功删除零复活；202不冒充完成；可信链/独立head全重放，缺证据不开放；等待也计入RTO |
| AT-34 | M1a故障准入 | 开发服务带哨兵，杀测试实例；伪造APP_ENV/库名/manifest/label | 只有真实独立目标可受故障；开发健康和哨兵不变，错误目标拒绝且无副作用，清理不越界 |
| AT-35 | M4/M5b | 冻结中文开发/留出集、关键词对照、记忆阈值、人工总结事实 | 达到06第10.1/12节指标，隐私与权限泄漏0；数据/阈值在看留出前冻结，保存分项失败与模型版本 |
| AT-36 | M4/M8 | ≥30代表任务成本、辅助调用/unknown/eval、低中高人数场景、预算耗尽 | 全attempt入账且实验预留不双算；容量计算可复核，20美元不宣传保证份额；聊天/关键词仍可用 |
| AT-37 | M1b/M2/M5a | off/until/forever往返；固定时区跨设备、跨午夜、DST缺失/重复时刻 | 无infinity/非法日期；固定时区不被浏览器覆盖，歧义要求确认，改时区不改已有UTC任务；预算业务时区独立 |

## 9. 容量与混合负载验收

- 基准数据：1000 用户、100 万消息、200 个会话、群大小 20/100/500 三档、10 万个附件及衍生对象元数据；对象字节测试集至少 10 GB。恢复另使用上线预估的全量字节集，不能用 10 GB 结果外推 5 TB。
- 500 WS / 200 活跃用户、总 20 条用户消息/秒，分布为 80% 私信/≤20 人群、15% 100 人群、5% 500 人频道；另测 500 人单频道集中突发，记录退化而不混进正常均值。
- 稳态先预热 5 分钟、测 30 分钟，消息从发送 HTTP 开始到接收方拿到已授权完整 DTO 的 p95 <300ms（本地专用测试 <200ms），错误率 <1%，权限错误/重复效果必须为零。记录 p99、最老工作年龄、数据库锁等待及事件循环延迟。
- 同时开 4 个模型模拟流、1 个媒体处理、1 个向量请求和后台备份；至少 10% 慢连接，100 个连接/秒重连持续 5 秒；观察缓冲上限、退避与查询并发。普通聊天不得因媒体/向量 OOM 连带退出。
- worker≤1536MiB、media≤512MiB，两者合计≤2GiB（包括tmpfs/IPC），api≤1GiB，ChatApp总量约6GiB；向量子进程≤1GiB且计入worker。宿主机其他站点/OS另留实测余量；只在真实ARM上判资源通过。
- 向量/媒体队列最老任务>5分钟或worker cgroup使用量>其上限80%时暂停批量索引；>90%拒绝新AI/媒体任务并告警，低于70%持续1分钟恢复。media独立上限及两者合计同时检查，不只看RSS忽略tmpfs。模型并发可从4降至2，实际可用并发写配置与决策。
- 磁盘与站点 quota、Valkey 内存、模型 unknown、备份超时均做故障注入；允许明确的 429/503 背压，不允许先返回成功再丢工作。

## 10. 手工验收清单（真机与辅助技术，V-22）

自动化测试替代不了这些：Playwright 的按键不经过浏览器自己的快捷键层，虚拟认证器不是真实硬件，axe 只能发现一部分无障碍问题。M1b 已于 2026-10-03 验收，但这份清单没有结果记录，仍待做，M7 前补齐。做法：`bun run dev`，浏览器打开 `http://localhost:5173`（必须是 `localhost`，D-122），用管理员生成邀请码、注册一个新账号。把结果（浏览器和版本、通过与否、报错文字或截图）告诉我，我记入 PROGRESS。

1. **外壳与原型对比（M1b 验收项）**：浅色、深色各看一遍登录页、外壳和设置的三页，对照原型；换几个强调色和透明度档位，把窗口从宽拖到窄（到 320 宽）。哪里与原型不一致，写下来。
2. **V-16 快捷键，逐浏览器**（Chrome、Edge、Firefox、Safari，在普通标签页里；PWA 窗口属 M6）。在应用里依次按：⌘K / Ctrl+K（命令面板）、⌘J / Ctrl+J（助手面板）、⌘, / Ctrl+,（设置）、⌘/ / Ctrl+/（快捷键帮助）。每个键记录两件事：应用的面板有没有出现；浏览器有没有先把它用掉（比如聚焦地址栏或搜索栏、打开下载或设置页）。有冲突就告诉我，我给出替代键并更新 02 第 7 节。
3. **Passkey 真实硬件**：设置 → 账号 → Passkey → 添加；退出；在登录页点「使用 Passkey 登录」；重命名；移除。至少在 Windows Hello（Edge 或 Chrome）上做一遍；有 Mac 时再做 Touch ID（Safari）；有手机时试跨设备（扫码）。记录浏览器、认证器、是否成功、失败时的提示。
4. **读屏**：NVDA（Windows，Firefox 或 Chrome）或 VoiceOver（macOS，Safari）读登录页、注册页、外壳、设置面板和命令面板：阅读顺序合理，按钮和表单字段有名字，错误提示与操作结果（toast）会被播报。
5. **缩放与对比度**：浏览器缩放到 400%（窗口约 320 CSS 像素宽）、把字号调到最大一档，登录、进入外壳、打开设置都能完成；Windows 的高对比度主题下仍可读。
6. **macOS Safari 与 Firefox 的真机渲染**：玻璃（模糊与透明）、圆角、容器查询在这两个浏览器里是否与 Chromium 一致。
7. **真实照片垫在玻璃后面**：图片上传在 M3 才有，那时再补。
