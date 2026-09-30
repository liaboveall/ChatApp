# 08 测试与质量

## 1. 原则

- **用真实的依赖测试。** 数据库、Valkey、Garage、Mailpit 都用真实服务，不做模拟，因为事务、并发、权限这些问题只有在真实环境里才测得出来。
- **只模拟外部服务**：DeepSeek、浏览器推送服务、生产环境的邮件服务商。Agent 的评测则直接调用真实的 DeepSeek。
- **测试是"完成"的一部分**：没有测试的功能不算完成。
- **只说跑过的结果**：不能把没跑过的检查写成"通过"。PROGRESS 里要记录实际执行的命令和结果。

## 2. 测试分层

| 层 | 工具 | 位置 | 覆盖什么 |
|---|---|---|---|
| 单元 | bun test（后端）、Vitest 5（前端） | 与源文件放在一起，文件名为 `*.test.ts` | 纯逻辑：权限策略、可见性判断、时限计算、Markdown 规则、seq 合并与跳号检测、预算计算、保留名规范化 |
| 集成（API） | bun test，加上真实的 Postgres、Valkey、Garage | `apps/server/test/integration/` | 每个接口的正常路径、校验失败、无权访问（404/403）、幂等、限流、并发（邀请名额、存储配额） |
| 实时（WS） | bun test 在随机端口启动 api，用真实的 WebSocket 客户端连接 | `apps/server/test/realtime/` | 认证、来源校验、会话失效断开、订阅隔离、事件结构、不泄露加入前的内容、正在输入和在线状态、多实例经 Valkey 转发 |
| 安全回归 | bun test 和 Playwright | `apps/server/test/security/`、`apps/web/e2e/security.spec.ts` | L-01 到 L-24，以及每条 SEC 要求（见 07） |
| 契约 | bun test | `apps/server/test/contract/` | 由路由生成 OpenAPI 快照并与上次比对，接口的变化必须是有意为之 |
| 数据库迁移 | CI 脚本 | — | 在空库上执行全部迁移、`drizzle-kit check`、跑种子数据 |
| 端到端 | Playwright 1.63 | `apps/web/e2e/` | 多人场景：用两到三个互相隔离的浏览器环境同时登录。Chromium 和 WebKit 全量运行，Firefox 只跑冒烟（场景 1、2） |
| 无障碍 | `@axe-core/playwright` | 与端到端测试一起 | 关键页面没有严重违规 |
| 视觉 | Playwright 截图，对象是 Storybook 中的关键组件 | `apps/web/visual/` | 防止设计还原走样；浅色和深色模式都要截。**基线只在 Playwright 官方 Linux 镜像里生成和比对**，Windows 本机的字体不同，直接截图永远对不上 |
| Agent 评测 | `bun run eval`（调用真实的 DeepSeek） | `apps/server/evals/` | 见 06 第 12 节 |
| 压力 | k6（Docker 镜像，锁定版本） | `infra/load/` | M7：500 个 WebSocket 连接、每秒 20 条消息，p95 < 300 ms；彩排时把容器的 CPU 限制到接近服务器的 2 核 |

## 3. 端到端测试必须覆盖的场景

1. 管理员生成邀请码 → 新用户通过注册链接注册 → 在 Mailpit 中打开验证邮件 → 登录。（M1b）
2. A 创建频道，B 加入；双方实时收发消息，都能看到"正在输入"，未读数正确。（M2b）
3. B 断线，A 在此期间发消息、编辑消息；B 恢复后，这些变化都补齐，没有重复。（M2b）断线用服务端测试接口或 `page.routeWebSocket` 模拟，不依赖 `context.setOffline`（V-14）。
4. A 在 2 分钟内撤回一条消息，B 看到撤回提示；超过时限后，撤回按钮不再出现。（M2b）
5. 私信和群组的隔离：C 不是成员，所有访问方式都返回 404；页面上也看不到这些会话。（M2b）
6. 上传图片：显示上传进度 → 出现缩略图 → 点开预览；下载该图片时带有正确的安全响应头。（M3）
7. 群里 @Agent 总结最近的讨论：看到流式输出和工具调用卡片，额度相应扣减；重新生成后，原回复被替换。（M4）
8. 让 Agent 代发一条消息 → 当前回复收尾并显示"等待批准" → 出现审批卡片 → 点批准 → 消息以本人身份发出，并标注"经助手代发"。（M5a）
9. C 关闭页面后收到私信推送（在测试中模拟推送服务来验证）。（M6）
10. D 在群里有一段历史之后才加入：D 看不到加入前的消息；引用了旧消息的回复显示"原消息不可见"；D 被"移出并封禁"后，用群邀请链接无法再加入。（M2b）
11. 用户在设备甲的设置里注销设备乙：设备乙的实时连接被关闭并跳转到登录页，之后收不到新消息。（M1b）
12. 用中文输入法组字时按回车，只确认候选词，不发送消息。Chromium 里通过 CDP 模拟输入法组字过程。（M2b）
13. 用户填写自带 key（模拟的模型提供方）：运行使用自带 key，不扣每日额度；key 失效时显示"改用站点额度重试"。（M5a）

## 4. 测试数据与隔离

- **数据库**：测试专用库 `chatapp_test`。
  - 每次测试运行开始时执行一遍迁移；
  - 集成测试文件串行执行（共用同一个测试库），每个文件结束后清空所有表（TRUNCATE … CASCADE）；
  - 需要严格隔离的测试，用"事务结束后回滚"的方式运行。
- **Valkey**：
  - 测试使用 db 1，每个测试文件用独立的 key 前缀；
  - 事件频道名是 `events:test`，因为 pub/sub 不区分 db 编号，这样开发服务和测试同时运行也不会串（D-044）。
- **Garage**：测试专用 bucket `chatapp-test`。
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
| `check` | 每次 push 和 PR | 安装依赖 → Biome 检查 → TS 7 类型检查 → 单元测试 → 构建前端 → 依赖边界检查（03 第 3 节）→ `guard` 扫描禁用写法和被跟踪的密钥文件 |
| `integration` | 每个 PR | 用 compose 启动 Postgres（带 pgvector）、Valkey、Garage、Mailpit → 在空库上执行迁移 → `drizzle-kit check` → 集成、实时、安全回归测试 |
| `e2e` | 合并到 main 的 PR，以及每晚 | 构建并启动整个应用 → Playwright（Chromium 和 WebKit 全量，Firefox 冒烟）→ 无障碍检查 → 在 Playwright 官方镜像里做视觉截图对比 |
| `security` | 每个 PR 和每周一次 | gitleaks、osv-scanner；M7 起加上 trivy 扫描镜像 |
| `eval` | 手动触发，以及每周一次 | Agent 评测，需要仓库密钥 `DEEPSEEK_API_KEY` |
| `load` | 手动触发 | k6 压力测试 |
| `image`（M7 起） | 推送到 main 或打版本标签时 | 在 GitHub 的 `ubuntu-24.04-arm` 机器上构建 arm64 镜像（另外构建 amd64，供本地彩排）→ 扫描 → 在同一台 arm64 机器上用 `compose.prod.yml` 启动整套服务，执行迁移和冒烟测试 → 推送到 GHCR |

- CI 里所有工具的版本都和本地一致：Bun 版本写在 `package.json` 的 `packageManager` 字段里，并且提交锁文件；Docker 镜像锁定精确版本。
- 合并到 main 之前，`check`、`integration`、`security` 必须全部通过。

## 6. 完成标准（Definition of Done）

**单个任务**
- [ ] 按规格实现；如果规格有变，先修改文档。
- [ ] 补上了测试：正常路径、异常路径，以及权限拒绝的路径。
- [ ] 本地 `bun run check` 通过（Biome 检查、类型检查、单元测试、集成测试）。
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
