# M2b 第二轮独立复验（2026-10-06，Codex）

## 结论与基线

**R1–R5 已验证修复并关闭；D-174 的九类既有浏览器场景通过，但新增 R6、R7 两项 P2 会话隔离问题，M2b 整体仍不通过。** 先前用户验收记录保留，本次不代替新的用户试用。

基线为干净的 `v2`：`6684e650e218f54695c3f345585a987be2d9d307`，包含 R5 / D-174 修复 `5f07b51`、浏览器回归 `ee8735e` 和 D-172 基础设施改动。与 `283cb92` 相比只有 `docs/PROGRESS.md` 的记录变化。本轮只写复验文档，未修改业务代码、提交、推送或开始 M3。

证据保存在被 Git 忽略的 `.test-runs/m2b-final-recheck/`；以前的 `m2b-review`、`m2b-recheck`、修复方的证据均保留。所有数据库测试串行执行，使用既有测试库重置夹具；没有删除数据卷、修改 `.env.local` 或做故障注入。`doctor` 包括既有的开发/测试 S3 写读删探针。

## R6 · P2：旧请求的 401 在凭据检查之前结束新账号的客户端会话

**位置**：`apps/web/src/lib/api.ts:165–170`，`apps/web/src/lib/session.ts:64–70,83–85`；外层 `apps/web/src/lib/sync/for-screen.ts:33–38` 的检查已经太晚。

**触发**：A 在页面提交新建群组请求，屏障保留原请求及其原始 Cookie。A 在同一 SPA 退出；让原请求携带原身份到真实服务端，取得真实 `401 / UNAUTHENTICATED`，暂扣响应。B 登录并打开自己的频道、输入草稿，然后释放 A 的响应。

**结果**：Chromium、WebKit 都进入 `/login?reason=expired`。为分离下面 R7 的 Cookie 问题，第二组实验只移除响应的 `Set-Cookie`，保留真实状态码与错误体：B 在响应前后 `/api/me` 都能返回 200，页面仍被退出。失败发生在“应留在原频道”的断言，不是服务端拒绝 B。最后用页面自身的 `fetch` 复核（`diagnostic.spec.ts`），双引擎均记录 `status: 200` 与 `/login?reason=expired`，排除了 Playwright APIRequestContext 与页面 Cookie 状态不同的解释。

**根因**：`api()` 在抛出错误前直接调用全局 `unauthenticatedHandler`，它无条件针对当前活跃会话执行 `endSession('expired')`，清查询缓存、草稿等客户端 store、导航并广播退出。随后 `forScreen` 才能捕获错误并检查 ticket；此时吞掉错误不能撤销已经发生的退出。既有失败测试模拟的是 Promise 拒绝，未经过真实 `api()` 的 401 分支。

**影响边界**：这是误退出与客户端状态清空，没有观察到跨账号正文泄露。广播会影响其他标签页是代码路径，本轮只做了单标签页浏览器复现，不声称已经执行多标签页实验。

**修复与复验要求**：

1. 在任何全局认证失败副作用之前，校验失败属于发请求时的登录会话。保护必须覆盖底层 API，不能只在 `forScreen` 或某个界面 catch 里补判断。
2. 旧账号、同账号退出再登录的迟到 401 不得退出新会话、清草稿或广播退出；当前会话真实失效的 401 仍须正常清理与退出。普通拒绝、匿名身份探针、登录错误不能被误判。
3. 正式回归必须实际经过 `api()` 与 session handler；至少增加真实浏览器屏障及当前会话 401 的对照。R7 需要单独修复，不能用“拦住 JS 退出”代替。

## R7 · P2：迟到的注销响应通过 Set-Cookie 删除后一账号的认证 Cookie

**位置**：`apps/server/src/http/routes/me.ts:172–175`（revoke-all 成功响应）；`apps/server/src/http/middleware/session.ts:34–37`（旧 Cookie 的 401）；共同调用 `apps/server/src/auth/cookies.ts:6–23`。

**触发**：A 在设置中点击“在所有设备上退出”，真实服务端完成撤销，暂扣成功响应。A 经已有撤销信号回到登录页，B 在同一页面登录并打开自己的频道、输入草稿，再释放 A 的成功响应。

**结果**：原始响应在 Chromium、WebKit 均使 B 的后续 `/api/me` 从已登录状态变成 401。最终 `diagnostic.spec.ts` 用页面自身的 `fetch` 明确断言屏障前为 200、屏障后却为 401；此时页面还可能停留在频道，不能把认证 Cookie 丢失与立即跳转混为同一个观察结果。保持相同操作顺序、只去掉旧响应的 `Set-Cookie` 后，两个浏览器均通过“仍在频道、仍有草稿、身份接口 200”断言。这也证明 D-174 对这条成功回调的 null 检查已经生效；剩余影响发生在浏览器处理响应头的阶段。

**根因**：服务端按固定 Cookie 名和 Path 发出 `Max-Age=0` 删除指令；浏览器应用它时不会区分它原来属于 A 还是已被 B 的登录替换。`forScreen` 检查运行在 JavaScript 收到响应之后，无法阻止这项浏览器副作用。旧身份 401 同样带删除头；第一组原始 401 实验的 Chromium 也观察到身份接口 401，但不据此宣称该变体在所有引擎表现相同。

**影响边界**：本轮确认认证 Cookie 丢失，未声称 B 的服务端 session 行被撤销，也未声称 Cookie 值泄露。迟到的普通 sign-out、自设备撤销、刷新 Cookie 等相邻路径需检查；本轮没有逐一浏览器复现。

**修复与复验要求**：

1. 设计并记录认证切换与旧响应 Cookie 写入/删除的顺序，保证新登录建立后，旧请求不能删除或覆盖新 Cookie。仅检查 ticket、吞错或取消 React 回调都不够。
2. 同页 A→B、同账号退出再登录、revoke-all 与旧身份 401 都应覆盖。通过原始响应头验证 B 在屏障前后身份接口 200、频道与草稿保留；不能在正式通过用例里删掉 `Set-Cookie`。
3. 仍须保持当前身份的注销、设备撤销及过期会话拒绝有效；服务端撤销语义与浏览器 Cookie 清理分别验证。

## 已修复项与本地证据

R5 的三道防线已核查：`editMessage` 只返回引擎接受的保存版本；`settleEdit` 核对成员关系、编辑编号与实际输入；`endCompose` 不匹配时无副作用。原脚本仅改变证据输出路径，在两个引擎均通过。正式 R5 七类场景各在两个引擎通过，覆盖跨账号、同账号重新登录、退出重入、取消或切换编辑、正常恢复 stash 与保存期间继续输入。R1–R4 的正式 16 条回归通过，D-174 的九类既有成功响应隔离场景也在两个引擎全部通过；这不涵盖本轮新增的底层认证副作用。

| 检查 | 本轮结果 |
|---|---|
| `bun run doctor` | 通过；Postgres / Valkey / Garage / Mailpit 正常，端口发布正常 |
| `bun run check` | 通过；Bun 单元 160、Web 单元 560，类型、guard、对比度与文案检查通过 |
| `bun run db:check` | 退出 0 |
| `bun run test:integration` | 516 通过 / 0 失败，41 文件，13,559 断言 |
| 原独立确定性复现，`vitest.config.ts` | 3 通过 / 0 失败，无未处理异常 |
| `bun run test:e2e -- late-answers late-effects` | **48 通过 / 0 失败 / 0 跳过**，4.7 分钟、无重试：原 R1–R4 16 条、R5 14 条、D-174 18 条 |
| `playwright.config.ts`：原 R5 + 原始 401 + revoke-all | 2 通过 / 4 失败：R5 双引擎通过，两条新增场景各双引擎失败 |
| `isolation.config.ts -g 'R6\|D-174 extra'`：只去掉 Set-Cookie | 2 通过 / 2 失败：revoke-all 双引擎通过，R6 双引擎仍因误退到登录页失败 |
| `diagnostic.config.ts -g 'R6\|R7'`：用页面 fetch 验证登录状态 | **4 失败**：R6 双引擎身份接口仍 200 但页面误退出；R7 双引擎身份接口从 200 变成 401 |
| 文档收尾：`bun run guard`、`git diff --check` | 通过 |

独立复现命令（会重置测试库，不与其他集成/E2E 并行）：

```bash
bun run --cwd apps/web test --config ../../.test-runs/m2b-final-recheck/vitest.config.ts
bun run --cwd apps/web e2e --config ../../.test-runs/m2b-final-recheck/playwright.config.ts
bun run --cwd apps/web e2e --config ../../.test-runs/m2b-final-recheck/isolation.config.ts -g 'R6|D-174 extra'
bun run --cwd apps/web e2e --config ../../.test-runs/m2b-final-recheck/diagnostic.config.ts -g 'R6|R7'
```

`adjacent.log`、`isolation.log`、`diagnostic.log` 与各自 `browser-results/`、`isolation-results/`、`diagnostic-results/` 含失败断言、截图和 trace。Cookie 隔离组是定位实验，其通过不能替代原始响应场景的通过。

## 远端证据与限制

本轮通过 GitHub CLI 实时核对了以下 run 的完整 `headSha`，均为本轮基线 `6684e650e218f54695c3f345585a987be2d9d307`：

- [check 37400781007](https://github.com/liaboveall/ChatApp/actions/runs/37400781007)：成功。
- [integration 37400780923](https://github.com/liaboveall/ChatApp/actions/runs/37400780923)：成功；详细日志 611 通过、domain 行覆盖率 99.28%，fault 16 通过。
- [security 37400780885](https://github.com/liaboveall/ChatApp/actions/runs/37400780885)：成功。
- [e2e 37400780989](https://github.com/liaboveall/ChatApp/actions/runs/37400780989)：成功；详细日志全套 226 通过 / 4 跳过，视觉 106 通过。该次没有报告 flaky；不抹掉上一提交 Firefox 曾重试的历史记录。

远端成功不覆盖本轮新增 R6/R7。四项既有跳过仍是非 Chromium 的虚拟认证器用例和 WebKit IME 的 CDP 限制，不写成实测通过。本轮未在本地重跑完整 E2E、性能、视觉、edge、fault、独立进程 smoke 或 V-22 真机/读屏验收；已有远端结果和既往人工记录与本轮本地执行分开计算。D-171 / D-173 / D-174 已记录的其他限制继续保留。

**下一步**：修复并正式覆盖 R6、R7，再独立复验；M3 保持未开始。

---

## 修复方记录（2026-10-06，Claude；未经独立复验）

本节由修复方追加，不改变上面的复验结论。2026-10-06 用户回复「提交推送，不需要再复验了」：修复已提交并推送，不再做独立复验；上面的复验结论没有被新的独立结论取代，R6、R7 的关闭依据是本节和 PROGRESS 记录的本地证据。

- **决定与做法**：[D-175](12-decisions.md)（认证切换的顺序、放弃的做法、限制）。要点：每个请求属于发起它的那次登录会话；会话结束或新的登录开始时，浏览器被告知放弃该会话发出的所有请求，所以迟到响应的状态、正文和 `Set-Cookie` 到不了页面，也到不了 Cookie 罐；全局的 401 处理在 `api()` 层先确认请求仍属于当前会话；退出请求自己被放弃时不提示、不再结束会话。服务端没有改（当前身份的退出、撤销、过期会话的 Cookie 清理仍靠服务端发的删除指令）。
- **正式回归**：`apps/web/src/lib/api.test.ts`、`session.test.ts`（会话归属两组，经过真实的 `api()` 与 session 处理器），和 `apps/web/e2e/late-session.spec.ts` 九条（Chromium、WebKit 各九）：真实服务端的 401 和「退出所有设备」「普通退出」的响应带着原始响应头暂扣（用例里断言响应确实带删除指令，没有去掉 `Set-Cookie`），同一页面换人和同一人重新登录，另有一条把迟到的响应放在「新 Cookie 已设下、页面还没完成登录」的窗口里；身份接口在屏障前后都是 200、频道与草稿保留，也没有提示、另一个标签页没有被带回登录页；另有当前会话的 401 仍结束会话、退出与退出所有设备时服务端撤销与浏览器 Cookie 清理分别验证的对照。
- **复验人原来的脚本**（复制到 `.test-runs/m2b-r6r7-fix/reviewer-scripts/` 运行，没有覆盖原证据）修复后：原独立确定性复现 3 通过；`adjacent` 6 通过（R5、原始 401、revoke-all，两个引擎）；`diagnostic` 4 通过。
- 命令、数字和没做的检查见 [PROGRESS](PROGRESS.md) 的「M2b 第二轮复验遗留问题 R6、R7 的修复」。
