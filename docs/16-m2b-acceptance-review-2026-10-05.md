# M2b 验收独立复核（2026-10-05，Codex）

> **后续独立复验（2026-10-06）**：R1–R4 已关闭，R5 已通过独立复验并关闭；新增 R6/R7 两项会话隔离问题，M2b 整体仍不通过。最新结论见 [18 第二轮独立复验](18-m2b-final-recheck-2026-10-06.md)，上一轮见 [17](17-m2b-recheck-2026-10-06.md)。下文保留首轮发现及修复历史。

## 结论与基线

**复核不通过，修复以下四项后再验收。** 基线为 `v2` 的 `4352b05f00dfd925087d38ac1220c8674a2b82fe`，开始时工作区干净。保留先前用户试用、验收和推送的历史记录；本次发现的是常规测试没有覆盖的客户端内容隔离与乱序合并缺陷。

本轮没有修改业务代码、提交或推送。临时复现脚本、日志、截图和浏览器追踪保存在被 Git 忽略的 `.test-runs/m2b-review/`。临时测试中的 `SECRET` 都是本轮生成的测试正文，不是真实秘密。

## 阻塞项

### R3 · P1：前一账号的迟到发送响应进入后一账号的时间线

- **位置**：`apps/web/src/lib/sync/outbox.ts:139–150`、`apps/web/src/app/sync.ts:36–47`、`apps/web/src/lib/sync/engine.ts:426–438`。
- **根因**：发送队列清空时只删除存储中的项，没有废弃在途请求的回调；发送成功后无条件调用 `onSent`。`ingestMessage` 使用响应到达时的当前 scope 与 membership，而不是请求发起时的身份，也没有据当前 `visibleFromSeq` 拦住旧消息。
- **浏览器复现**：A 在频道发消息，服务端已提交但测试屏障暂扣成功响应；B 随后加入。A 在同一 SPA 中退出，B 登录并打开频道，再释放 A 的响应。
- **实际结果**：B 的 `GET /api/messages/{oldId}` 返回 **404**，时间线却显示 `R3_ACCOUNT_A_PRE_JOIN_SECRET`。页面同时显示“之前的消息不可见”。这不是服务端授权放行，而是前端将 A 的旧正文写入 B 的缓存并渲染。
- **证据**：`repro.test.ts` 的 R3；`browser-repro.spec.ts` 的 R3；`browser-repro.log`、`r3-browser.png`、对应 `browser-results/` 中的 trace。
- **修复要求**：所有外部读写响应在合并缓存、推进已读、处理访问错误前，校验发起时的账号、登录/恢复世代与成员世代。清空队列要使在途回调失效。检查同样直接调用 `ingestConversation`、`ingestMessage`、`ingestUsers` 的路径，例如 `features/conversations/api.ts:47–50` 和消息编辑/撤回；这些相邻路径本轮只做静态检查，未逐一声称已复现。
- **验收**：正常发送与同 `clientId` 重试仍成功；A→B、同账号改密/换世代、退出重入三类屏障测试都不能恢复旧内容，迟到的失败也不能清掉新 scope 的会话。对应 SEC-34、D-150 和客户端身份边界。

### R2 · P1：迟到的历史页覆盖已同步的撤回，之后对账不再修复

- **位置**：`apps/web/src/lib/sync/engine.ts:650–661`，调用方 `jumpTo`、`backToLatest`、首次加载。
- **根因**：`#installWindow` 用页面响应整体替换窗口，只继承 hidden/gone，不保留当前消息较新的实体版本；同时用 `Math.max` 保持已经前进的 `synced`。窗口内容回退了，同步水位却表示变化已经应用。
- **可控复现**：100 条消息，打开最新 50 条；发起跳到 seq 40 的请求并暂扣旧响应；服务端撤回 seq 55，客户端先同步到 `changeSeq=101`，确认正文为空；释放仍含 seq 55 原正文的旧页面。
- **实际结果**：seq 55 原正文 `message 55` 恢复，`observed=synced=101`。显式对账并推进虚拟时钟 35 秒后仍不恢复撤回状态。
- **证据**：`repro.test.ts` 的 R2 和 `repro.log`。这是实际 SyncEngine 加可控 transport 的确定性测试；**本项没有声称做过真实浏览器复现**。
- **修复要求**：定义窗口替换与在途增量的顺序，合并已知较新实体或从窗口请求的安全起点重新补拉；不能把未应用于新窗口的变化计入 `synced`。同样检查同时跳转、回到最新、首屏重复请求和 reset。
- **验收**：覆盖编辑、撤回、管理员删除的页面/增量乱序；窗口中重叠与不重叠消息均正确，最终状态收敛；不能只增加延时。对应 AT-12、AT-31。

### R1 · P1：旧源消息响应恢复已撤回的引用摘要

- **位置**：`apps/web/src/lib/sync/window.ts:214–218`。
- **根因**：消息本体经过 `mergeMessage` 的版本比较，但引用级联遍历原始 `items`，包含已因版本过旧被拒绝的源消息；`cascadeReplies` 把其正文重新写进引用。
- **浏览器复现**：A 发送源消息，暂扣 POST 成功响应；B 引用该消息；A 从另一会话撤回源消息。当前页面先正确显示“原消息已撤回”，随后释放原始发送响应。
- **实际结果**：消息本体仍是撤回状态，引用条却恢复 `R1_RECALLED_SECRET`。纯函数测试同样确认源消息 `body=null`、引用 `state=ok` 且带旧 excerpt。
- **证据**：`repro.test.ts` 和 `browser-repro.spec.ts` 的 R1，`repro.log`、`browser-repro.log`、`r1-browser.png`、对应 trace。
- **修复要求**：引用级联必须服从源消息的有效版本和当前隐藏/删除状态；对窗口外来源也要防止旧版本覆盖已知的新状态，不能仅调整当前循环顺序。
- **验收**：撤回/编辑/删除/隐藏后到达旧写响应或旧补拉页，不得恢复旧摘要；正常新版本仍可更新引用。对应 M2b 引用连带更新要求、AT-12、AT-31。

### R4 · P1：退出再加入后，输入栏仍保留加入前的引用正文

- **位置**：`apps/web/src/app/sync.ts:26–30`、`apps/web/src/lib/sync/compose.ts`、`apps/web/src/features/composer/composer.tsx:189–200`。
- **根因**：`onForgotten` 清理 outbox 和草稿，但没有清理 `useCompose` 的 reply/edit 模式；该模式按 conversationId 保存完整旧 Message，只在全账号 reset 时清空。输入栏直接显示这个旧 Message 的正文。
- **浏览器复现**：B 对频道旧消息点“回复”，在输入栏出现引用后退出频道，再加入同一频道；全过程不刷新页面。
- **实际结果**：服务端读取旧消息为 **404**，时间线没有该消息，但输入栏仍显示 `Test r4alice: R4_PRE_REJOIN_QUOTE_SECRET`。
- **证据**：`browser-repro.spec.ts` 的 R4，`browser-repro.log`、`r4-browser.png`、对应 trace。
- **修复要求**：所有会话级状态通过统一清理入口按 membership 失效，包括回复、编辑及其 stash；`#forgetMembership` 直接换成员世代的路径也要执行相同清理。评估引用源在编辑/撤回时，输入栏副本的更新策略。
- **验收**：回复态与编辑态下分别测试主动退出、被移出、直接换成员世代后重入；旧正文和编辑 stash 均不可重新出现。对应 D-035、SEC-34。

## 本轮验证

| 检查 | 结果与证据边界 |
|---|---|
| `bun run check` | 退出 0；139 个 Bun 单元测试、423 个 Web 单元测试通过；类型、lint、guard、3018 组对比度、620 键 × 2 语言检查通过 |
| `bun run db:migrate:test` | 退出 0，测试库迁移成功 |
| `bun run test:integration` | **516 通过 / 0 失败**，41 个文件、13,559 个断言；含安全、契约、实时及既有 M2a 回归 |
| `bun run db:check` | 退出 0 |
| 三个确定性复现测试 | **3 失败**，分别命中 R1、R2、R3 的安全/一致性断言；这是复现缺陷，不是门槛通过 |
| Chromium 生产构建 + 真实 API/worker 浏览器复现 | **3 失败**，分别命中 R1、R3、R4；R3、R4 另用真实 HTTP 404 交叉确认授权边界，日志和截图已保存 |
| 当前 SHA 的远端工作流 | 通过 GitHub CLI 实时核对 headSha；`check`、`integration`、`security`、`e2e` 均成功，链接见下 |
| 当前 SHA 的远端详细日志 | integration **611 通过 / 0 失败**、domain 行覆盖率 **99.28%**；E2E **178 通过 / 4 跳过**；视觉 **106 通过** |

当前 SHA 的远端结果：[check](https://github.com/liaboveall/ChatApp/actions/runs/37273016166)、[integration](https://github.com/liaboveall/ChatApp/actions/runs/37273016230)、[security](https://github.com/liaboveall/ChatApp/actions/runs/37273016237)、[e2e](https://github.com/liaboveall/ChatApp/actions/runs/37273016132)。这些成功结果不覆盖新增复现，也不能关闭以上阻塞。

本轮没有重新跑整套跨引擎 E2E、完整性能、网关、视觉、独立故障或真实设备验收；其中远端运行结果与本轮本地执行已明确分开。性能与 V-22 的限制仍按既有交接保留。

测试环境说明：依次执行测试库迁移、集成和浏览器测试，没有并行占用测试库。浏览器夹具按既有实现重置测试库，不修改开发库。发现既有 Garage 容器处于停止状态后启动了它；没有改 `.env.local`、端口配置或删除数据卷。临时测试配置最初有模块路径和工作目录错误，修正后才产生上述有效结果，配置启动失败不计为产品缺陷。

## 复现与修复交接

从仓库根目录执行（两组测试按顺序运行）：

```bash
bun run --cwd apps/web test --config ../../.test-runs/m2b-review/vitest.config.ts
bun run --cwd apps/web e2e --config ../../.test-runs/m2b-review/playwright.config.ts
```

临时浏览器脚本为了证明已发生正文恢复，会先等待缺陷现象，再断言应有状态；**迁入正式回归时应改为屏障释放后等待对应请求完成/状态提交，再断言安全结果**，不要保留“必须出现缺陷”的等待，也不要删掉安全断言来变绿。R2 的确定性脚本可以继续使用可控时钟和 transport。

先修四项并增加正式单元/浏览器回归，随后重跑 `check`、集成与 M2b 对应的跨引擎 E2E。修复影响同步和引用渲染，应复核重连、个人同步、历史边界及万条时间线性能。之后再作独立验收；本次复核没有授权提交、推送或推进 M3。

## 修复记录（Claude，同日）

> 本节是修复方的记录，不改变上面的复核结论：是否通过由独立复验决定。修复的决定与做法见 [D-171](12-decisions.md)；执行过的命令、结果和限制见 [PROGRESS](PROGRESS.md) 的「M2b 复核问题 R1 到 R4 的修复」。已提交并推送：`3eeb36d`（代码与单元测试）、`bc36903`（浏览器回归），外加记录它们的文档提交 `b241504`；`b241504` 的 `check`、`integration`、`security`、`e2e` 四个工作流在远端全部成功。

| 项 | 修在哪里 | 正式回归 |
|---|---|---|
| R3 迟到的发送响应进入后一账号 | 屏幕和发送队列的请求带发起时的凭据（账号范围、成员关系、水位），`ingestMessage`、`ingestConversation`、`ingestUsers`、`ingestMe`、`applyHidden`、`leftConversation`、`handleAccessError` 一律必填凭据，过期的回答和失败丢弃；发送队列清空后在途的回调失效；`start()` 遇到另一个用户清空引擎之外的存储；写 `me` 的回答只更新同一身份 | `engine.test.ts` 的 R3 一组、`outbox.test.ts`、`queries.test.ts`；E2E `late-answers.spec.ts` 的两条 R3（换账号、退出再加入） |
| R2 迟到的历史页覆盖已同步的撤回 | 用一页替换窗口时 `synced` 设成请求发起时的水位并从那里重放，被替换的窗口里更新的版本保留，替换使在途请求作废，后发起的替换算数；向上/向下翻页同样退回水位重放 | `engine.test.ts` 的 R2 一组（编辑、撤回、管理员删除各自对「窗口里已有」「只有页面有」两种消息，翻页，并发跳转，首屏重复请求，重置交错）；E2E `late-answers.spec.ts` 的 R2（真实跳转、暂扣 `aroundSeq` 页面） |
| R1 旧源消息响应恢复已撤回的引用摘要 | 引用只从源消息已知的最新版本级联，窗口记着引用已经跟到的版本（窗口外的源消息也受保护），窗口不接收的版本不级联；新进窗口的回复按窗口已知的撤回、删除、隐藏当场改正 | `window.test.ts`（窗口内、窗口外，撤回、编辑、管理员删除、隐藏、墓碑，旧版本与新版本）；`engine.test.ts` 的回复写响应；E2E `late-answers.spec.ts` 的 R1 |
| R4 重入后输入栏仍有加入前的引用正文 | 按会话存状态的 store 统一向 `registerConversationReset` 登记，引擎在会话被遗忘和成员关系换成另一个的每条路上调用；回复/编辑状态记着成员关系并跟随源消息的当前版本；旧成员关系下的已读声明一并清除 | `engine.test.ts` 的 R4 一组（回复态与编辑态各对四条路）、`compose.test.ts`；E2E `late-answers.spec.ts` 的 R4（退出再加入、被移出再加入，各对回复与编辑） |

复现你留下的三个确定性脚本（`.test-runs/m2b-review/repro.test.ts`）：现在三个都通过；R3 那条在脚本里用旧签名构造 `Outbox`（没有 `ticket`），所以它还会报一个未处理的异常，这是脚本的问题，不是产品的；已经按新签名迁入正式回归。三个浏览器脚本的内容已迁入 `late-answers.spec.ts`，按你的说明改成「释放屏障、等请求完成并让页面行动之后再断言安全结果」，没有保留「必须出现缺陷」的等待。

**没有做的**：同账号改密码、换世代的屏障没有浏览器用例（引擎层有）；复核里「相邻路径只做了静态检查」的那些，已经全部加上凭据，并有编译期的强制，但没有逐条做浏览器复现；真机、读屏等 V-22 的项不在本次范围。
