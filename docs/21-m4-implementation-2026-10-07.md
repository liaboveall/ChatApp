# M4 Agent 基础实现与验收交接（2026-10-07）

> **2026-10-08 更新**：用户已确认修复后本人复试无问题；D-186 的 V-01 余项已关闭。修复后源码的全量评测、反引号引用补修、最终自动回归与总结事实审核状态以 [23](23-m4-acceptance-2026-10-08.md) 和 PROGRESS 最新条目为准。下面保留原实施轮次的证据，不将旧源码结果替代新一轮结果；21 中旧 worker 的试用前提已由 22 的开发实例核验更新。

M4 的后端、worker、实时传输、前端和评测入口已全部接入，本地自动检查与稳定源码的真实全量评测均已完成并通过自动门槛。总结的人工事实标注、用户亲自试用与远端 CI 各有独立门槛，M4 尚未标为验收通过；V-01 剩余兼容性项已按 D-186 由用户决定不测并关闭。当前分支 `v2`，基线 `5fceefa`；本轮未提交、推送或部署。

## 1. 范围与实际入口

| 路线图范围 | 实现与入口 |
|---|---|
| 机器人和私有会话 | bootstrap 机器人不加入会话；私有 Agent 会话创建、列表、自动标题、改名、删除，其他用户请求为 404 |
| 群/频道 `@Agent` | 新消息事务创建 run；遵守会话开关、每会话每分钟 6 次限制；DM 与编辑不触发；机器人回复中的提及不另发通知 |
| 会话助手面板 | 绑定来源会话的私有面板，默认只读当前会话；显式切到全部可见会话会变更 context epoch 并终止旧运行 |
| ⌘K 和斜杠命令 | 普通消息搜索沿用当前成员水位；`/总结`、`/翻译`、`/起草` 走同一 Agent 运行时；草稿插入输入栏，由本人发送 |
| 只读工具 | read_conversation、read_unread、search_messages、get_message、list_conversations、list_members、get_user_profile；严格 Zod 参数和领域授权，无写工具 |
| 状态和恢复 | run/context/state/step/output 持久化；30 秒租约、5 秒心跳、取消、租约过期续跑、旧 epoch fencing；已保存最终回答恢复时不再调用模型 |
| 流式输出 | 75 毫秒聚合，约 1 秒持久快照；每批逐连接重查 session、权限、来源和租约；resumeSeq/index/revision 防旧片段覆盖新回答，缺口从快照修复 |
| 重新生成与删除 | 无副作用、无待审批的本人最近回复，共享回复另限 24 小时；替换原输出并绑定新 run；删除会话取消任务、清理完整内容和媒体来源，保留审计用量 |
| 预算和用量 | PostgreSQL 原子全额预占与 CAS 结算；每日 token、站点月货币额度、80% 提示、未知预占；跨午夜/取消后的迟到结算仍记原周期 |
| 图片 | 至多 4 张已处理图片，传入实际存储字节；不下载任意 URL；付费图片计费上界未验证时拒绝开放 |
| 评测与定时工作流 | 冻结中文语料、真实模型任务、完整调用账本、人工标注校验；每周一 UTC 02:30 工作流及手工触发入口已创建，未运行远端 CI |

主要代码在 `apps/server/src/domain/agent-*.ts`、`src/agent/`、`src/runtime/agent.ts`、`src/http/routes/agent.ts`、`src/jobs/agent.ts`、`apps/web/src/features/agent/`、`packages/contracts/src/agent*.ts`、`packages/db/src/schema/agent.ts`。HTTP、工具和作业均通过领域服务读取业务数据库。

快速模式上限 8 步 / 120 秒 / 4096 输出 token / 32768 输入 token；深度模式 16 步 / 300 秒 / 16384 输出 token / 131072 输入 token。worker 并发 4，每用户排队加运行最多 2 个、未结束任务最多 20 个。恢复不重置累计步数和活跃时间，最多 16 段。

## 2. 授权、数据和供应商边界

- 每次模型调用、工具执行、delta 与输出提交重新验证 origin、有效委托、账号/restore epoch、租约和完整来源清单；编辑、撤回、撤权与成员版本变化会阻断旧 run。普通退出不撤销已授权后台任务，但立即停止旧 session 收取 delta；安全撤销会终止对应委托。
- 共享回答的消息、附件与派生历史使用全部当前成员 `visibleFromSeq` 的最大值。默认面板不能读其他会话；site 输入排除 `byok_private`。旧 Agent 回答的传递来源失效时，从新运行历史中剔除。
- 搜索、读取与 get_message 排除本轮 prompt 和未完成输出，它们不充当回答问题的证据。列表预览逐条限正文长度，避免一条长消息挤掉其他来源；get_message 使用 Unicode 字符分页，保留正文总长度和版本。模型输入保留每条完整来源的首次出现，完全重复的邻近分页以消息 ID 引用；所有工具调用/结果配对、完整持久状态和授权来源清单仍保留，不提高输入上限。
- 0007–0010 已在开发库和测试库迁移并完成 bootstrap；数据保留。`db:check` 已通过。新增 trigram 索引，中文两字搜索仍可能使用顺序扫描，不能把索引存在写成所有中文查询都命中索引。
- SoCLaaS 使用固定 endpoint 和显式 key；快速/深度别名都是 `x-test-1`，实际模型写入每次 attempt。免费货币价格为 0，token、时间、并发和 provider 限流约束仍有效。没有付费降级。
- 429 属于已知拒绝，释放该次预占、记录 HTTP 状态/Retry-After 并建立全 provider 冷却；冷却只能延长，不能由短响应缩短。不确定 5xx、网络中断或已发出的未知请求保留预占且不自动重发；取消不能提前释放已发出的请求。
- worker 仅获得所选 AI key；media 容器仍无网络、AI/数据库/S3 凭据。现有固定开发 worker 环境与新白名单不一致，而且没有 detached ownership receipt，本轮保留该实例；新源码的进程启动由隔离 E2E 栈验证。开发试用前需由原拥有者结束旧开发 worker 会话并重建，不伪造 lease。

## 3. 本地执行证据

下列结果均来自实际执行，完整真实评测见第 4 节。

| 检查 | 已执行结果 | 本机证据 |
|---|---|---|
| root check | 400 后端/脚本等单元、596 前端单元全部通过；6 个 typecheck、guard、3018 对比度组、694 双语 key 通过 | `.test-runs/m4-check-context-final.log` |
| 完整覆盖率 | 801/801、14993 断言；domain 96.74%、agent 97.47%，均超过 90% 门槛 | `.test-runs/m4-coverage-context-final.log` |
| Agent 集成 | 21/21、117 断言；授权/范围/共享水位、预算/429、未知不重放、取消/恢复、重新生成/删除/清理、长正文分页、错误工具参数、本轮提问排除、逐执行器结账与迟到结算、四个相邻 SDK 读取的输入上限回归 | `.test-runs/m4-agent-context-integration.log` |
| 真实 WebSocket/总线 | 1 个用例、8 个断言：私有输出、无关用户、普通退出与安全撤销，每批重新鉴权 | `.test-runs/m4-agent-gateway.log` |
| UI 请求归属和轮询 | 定向用例通过：旧账号 404 不写新账号、当前 404 停轮询、更新步骤不反复重建轮询 | `.test-runs/m4-web-agent.log` |
| 完整 E2E | 250 通过 / 4 既有跳过 / 0 失败 / 0 重试，18.5 分钟；Chromium/WebKit 全量、Firefox 冒烟和性能场景。收发 p95 61 ms，T1 帧 p95 16.8 ms，T3 跳转 85.2 ms / 漂移 0，T2 100 次加载最大位移 0 | `.test-runs/m4-e2e-complete.log` |
| 压缩修复后 Agent E2E | 重建实际 API/worker 与生产前端后，Chromium/WebKit 场景 7 再次 6/6，50.4 秒；无失败/重试 | `.test-runs/m4-e2e-context-final.log` |
| 视觉 | 116/116，已使用独立 outputDir 与完整 E2E 同时运行；5 个新增 Agent 故事 × 双主题，账户用量和未选会话面板的基线已逐项核对 | `.test-runs/m4-visual-isolated.log` |
| V-01 正常请求 | 6/6，10 次实际 HTTP 200：两种模式非流式/流式工具循环和内联红色图片；input 1874、output 92（含 reasoning 10）、cache 0、费用 0 | `.test-runs/m4/1703c207-290d-44da-ad4b-feaa8ca3cd42/result.json` |
| V-01 推理回传补证 | 两模式 × 非流式/流式，8 次 HTTP 200 / settled；4/4 首次工具前推理原文与下一请求的 reasoning_content SHA256 一致。额外算术正确性 3/4，fast 非流式有一项错误，不算通过。raw reasoning 与 reasoning_content 两种兼容字段均核对，只保存长度/摘要；未获缓存明细 | `.test-runs/m4/20fddad4-593b-42cd-bafa-d1c7cfcb0742/fidelity.json` 与同目录 `probe.ts` |
| 真实 runtime 图片 | 处理后的实际图片字节识别红色，1 次 HTTP 200 / settled | `apps/server/evals/results/30163a77-8eca-4a16-b65e-168d1fa570d8/` |
| V-15 中文检索 | 50,000 条 / 20 会话；2 字全范围 seq scan 29.478 ms、限定会话 B-tree 1.555 ms、4 字 GIN 0.911 ms。本机数据形状实验，非生产/ARM 性能验收 | `.test-runs/m4/fa2860b3-b65c-4cfa-8e3b-806fb184cbac/search.json` |
| 开发迁移和 schema | 0007–0010 开发/测试迁移、bootstrap、db:check 成功；开发数据未重置 | `.test-runs/m4-migrate-dev.log`、`m4-bootstrap-dev.log`、`m4-db-check.log` |

测试库覆盖率/集成和完整 E2E 顺序执行。真实 eval 每次创建自己的数据库，结束后仅删除该次创建的数据库；不截断开发库或其他测试实例。

首次完整 E2E 为 247 通过 / 3 旧助手占位文案断言失败，第二次为 248 通过 / 2 trace 文件丢失失败，每轮均有 4 个既有跳过。修正文案后发现视觉 runner 的默认 outputDir 会清理正在写入的 E2E trace；改为独立 `.test-runs/visual/results`，第三次完整 E2E 和视觉同时执行均通过。首次日志 `m4-e2e-full.log`、第二次 `m4-e2e-final.log` 保留，不把失败算作通过。

## 4. 真实全量评测和人工事实复核

固定语料为 2400 条中文消息 / 24 会话、120 个检索查询（80 开发 / 40 留出，会话和意图隔离）、30 个总结 × 3 次、36 个容量任务（六类各 6 个），全量共 246 个任务。语料在 2026-10-07T05:52:57.971Z 冻结，SHA256 `20ba3f6ce2e2276226ec446bace6e1741f4cffb199cb0741d2ff515c7c0124f4`。已查看的留出结果不能再当盲测；后续模型/提示持续调优后的独立质量验收仍需新独立样本，原冻结集必须保留复测。

门槛不改：安全 100%、注入行为 ≥95%、工具选择 ≥90%、Recall@10 ≥85%、nDCG@10 ≥75%、无答案误报 ≤10%；总结人工覆盖率 ≥80%、事实准确率 ≥95%、关键编造 0，90 个输出均核对均值与最差重复。

结果分别保存 retrieval、summary、capacity phase，避免同名任务覆盖；每个真实 run 另外保留不可覆盖副本，重试成本不丢。源文件清单和哈希在开始/结束复核，运行中源代码改变不能获得 complete 质量证据。生产 PostgreSQL 账本和持久实验 SQLite 账本同时记录预占/settled/released/unknown，实验不能绕过领域预算准入。

`human-review.json` 是待人工填写的工作表：reviewer、时间、goldReviewed、事实总数/正确数/必需事实数、关键编造，以及逐输出 SHA256。自动匹配仅为候选覆盖率，不能替代人工事实准确率。`bun run eval:review <目录>` 检查 90 个实际输出、冻结哈希、门槛、身份时间和来源；没有人工标注时必须失败，不能补造数据。

### 保留的首次失败与修复证据

| 结果 ID | 真实观察与处理 |
|---|---|
| `34885d05-2357-4041-a751-da0088c1f73d` | 首次并发 4 执行 231/246，模型请求错误与 source-edit 控制超出编辑窗口；改为编辑新请求源、等待所有并发任务结束再清库。该轮没有逐 attempt HTTP 状态证据，不推断具体网关故障 |
| `291f5da7-83f6-4f52-bd61-e378420f5282` | 首轮串行 246 任务，421 attempts / 418 settled / 3 released / unknown 0；留出 Recall/nDCG 66.67%。发现 literal 搜索误用、无效 from、容量/总结任务同名覆盖；不计通过，不复用其被覆盖的总结证据 |
| `7e440232-aefe-49f3-b097-a89133d462ee` | 实际 HTTP 429 / Retry-After 60，166 HTTP 200 + 1 HTTP 429；domain 全 provider 冷却拦截后续任务。补实验有界等待、保留每次尝试，未知不重放 |
| `503d49d0-41c4-4487-84fa-30f79aec015a` | 完整 246 任务、1 次已知限流重开 run、420 attempts / unknown 0 / USD 0、源代码哈希不变；安全 245/246、结果断言 242/246、留出 Recall 76.67%。检索命中提问自身、长正文挤掉来源、JSON 格式/注入域名复述仍不达标；保留失败结果，修复后重跑 |
| `7f93cc14-7b73-41a7-ab19-0d4ad3b2dddd` | 修复后的开发集同义查询冒烟成功：2 次实际请求，严格 JSON 返回相关来源；不是全量质量通过 |
| `46d494f5-d9fe-4130-924b-1fce49d4eb86` | 246/246 结果/安全断言，注入/工具选择 100%，开发和原留出 Recall/nDCG 100%，误报 0；428 attempts 中 425 settled、3 started 尚未确认，源文件哈希不变。质量自动门槛已通过，但发现执行器退出后的三个账本状态尚未收尾，因此不采用该轮的最终容量账本；补 SDK 流关闭和逐执行器调用收尾后重跑 |
| `473609c4-f0d3-482e-838e-423dda68353a` | 真实模型取消冒烟：1 个 actual attempt 明确 unknown，保留 42853 token 预占、不重放；不再将尚未确认请求漏记成 unknown 0。免费金额仍为 0 |
| `5532faf4-56f1-448f-8dbe-32338e84621d` | 执行器结账后全量：423 attempts / 418 settled / 3 unknown / 2 released / 无残留 reserved；结果与安全 246/246，但运行期间改动源文件，sourceUnchanged=false，不作最终 complete 证据；补退出码及实验拒绝回归后重新运行 |
| `11e90e3d-0438-48f1-88b3-4ff0cff2b301` | 稳定源版本 246 项，安全 246/246、结果 245/246，开发/原留出检索 100%；435 attempts / 432 settled / 3 unknown / 无残留 reserved。一个快速容量总结选择四个相邻 get_message，重复邻近正文耗尽输入上限；补通用重复分页引用，SDK 强制四读取回归通过，原始持久正文不变。失败版本源码快照保存在 `.test-runs/m4/<此ID>/source.tar.gz` |

最终稳定版本结果为 `7bf43fd0-19e5-4811-b8e5-db76070f4912`（`.test-runs/m4-eval-context-final.log`），complete=true、sourceUnchanged=true，无已知限流重试、执行错误或残留 reserved/started。真实请求别名均为 `x-test-1`，逐 attempt 实际模型记录了 `glm-5.3-flash` 和 `ornith1.5:35b`；校方别名会路由不同实际模型，不能将该轮称为单一固定模型的盲测。

| 自动指标 | 实际结果 |
|---|---|
| 结果 / 安全断言 | 246/246 / 246/246 |
| 注入行为 / 工具选择 | 100% / 100% |
| 开发查询 / 原留出查询 | Recall@10、nDCG@10 均为 100%；无答案误报均为 0 |
| 同权限关键词对照 | 开发 nDCG 75%、原留出 76.67%；同义子集关键词 0、Agent 100%，其他可回答类别均 100% |
| 完整调用账本 | 407 attempts = 404 settled + 3 unknown；0 reserved/started；实验 SQLite 的全部 407 状态与领域证据逐 ID 一致 |
| 已结算 token | input 1,999,605 + output 55,508 = 2,055,113；reasoning 6,780 已包含于 output，不重复计数 |
| 未知占用 | 129,367 token 的完整预占上界保留；免费金额 0，不重放，不作已执行/未执行判断 |
| 人工总结 | 30 个任务 / 90 个实际输出；reviewer、时间、分数仍为空，goldReviewed=false，准确率/关键编造未给人工结论 |

36 个容量任务（六类各 6 个）包含全部尝试与未知预占，平均 10,798.44 token，P50 7,081、P95 43,122；任务耗时 P50 2,307 ms、P95 7,371 ms。按当前每日额度与样本均值估算每用户每日 46 个任务，不是保证份额：真实准入仍先预占完整输入/输出上界。低/中/高场景假设为 10×1、50×3、100×5 个 AI 活跃用户任务/天，30 天分别约 3,239,534 / 48,593,000 / 161,976,667 token；金额均为 0，按货币计算的任务数/耗尽时间为 null。这里没有证明供应商总配额、生产并发或 ARM 混合负载容量。

源码清单覆盖 164 个 runtime/合同/DB/SQL/eval 文件，SHA256 `9056e2190157d59fb4370d59cb08debff7e0b53c3007d23b324caa038394cd14`；开始/结束及归档时逐文件一致。运行源码、依赖锁文件与冻结语料快照在 `.test-runs/m4/<最终ID>/source.tar.gz`（181 个文件，SHA256 `70042a4702a19e41aa3ddc6157826e411bd1839b15022b6ea4d75d2a0444bc22`），没有 env 或凭据。最新实验账本的一致备份和本机核对结果在同目录 `experiment-ledger.sqlite`、`local-verification.json`；它们还包含后续独立准入探针，不能误当最终评测的 407 次调用总数。

额外核对早期已结束实验的 SQLite 账本，发现 10 个旧 started（9 个可对照保留的取消/来源编辑失败证据，1 个早于这些且无完整 run 证据）。仅将这些确定的旧实验条目标为 unknown，保留 441,020 token 上界，没有退款、补造 usage、改写历史报告或重发请求；回执 `.test-runs/m4/native-ledger-retirement-2026-10-07.json`。全局实验账本现在无 reserved/started，195 released / 2818 settled / 20 unknown；历史 unknown 与本轮 3 个分别记录，供应商执行结果仍待账单对账。

最终 eval 退出 2（自动通过、人工待复核）；对未填写的工作表实际执行 eval:review 退出 1，拒绝签发验收。30 个候选事实、原始来源和 90 个回答已整理成 [.test-runs 人工复核包](../.test-runs/m4/7bf43fd0-19e5-4811-b8e5-db76070f4912/human-review.md)，原 `human-review.json` 未填写。

候选覆盖率仍可能把 Markdown 的 `**没有**延期` 与 `没有延期` 判作不一致；因此自动最差候选数值不是事实覆盖率验收。保留原匹配结果，由人工结合实际正文与源事实核对，不将自动判断写成人工分数。

## 5. 剩余验收与复现

1. 人工核对 30 个总结的 required/optional/forbidden 事实及来源、90 份模型回答，填写最终结果目录的 human-review.json 后运行 eval:review；若事实门槛失败，仍记 M4 未验收。已查看的原留出集继续作固定回归，独立质量验收需补新独立样本。
2. ~~V-01 尚缺 low/high effort 的稳定行为差异、非零 cache 与供应商账单对未知请求的最终对账。~~ **已关闭（D-186）**：用户决定长期使用校方 LLM、思考保持开启、成本为零，这三项不再测试，状态是"决定不测"而非"已通过"。以下为关闭前的原记录：首次工具前推理原文回传已补实际证明；本轮四组 reasoning token 不同是样本观测，不能据此保证参数的因果效果。cache 明细未提供时计费保守按未命中处理，cachedTokens=0 不是供应商缓存命中为零的实测证明。
3. 原开发 worker 拥有者结束旧会话并重建后，用户试用私有会话、群/频道 @Agent、面板范围切换、三种斜杠操作、停止/重新生成和用量提示。不能用自动化浏览器测试填写用户验收。
4. 未获提交、推送、部署授权；当前远端工作流与 ARM 上的 M4 回归没有结果。现有 M3 的 CI 成功不能代替新 M4 代码的验证。

本地自动检查已跑完，无需重复等待开发许可。复现命令：`bun run check`；`bun run test:coverage`（独占测试库）；`bun run test:e2e`（独占测试库）；`bun run test:visual`；`bun run eval --concurrency 1`（新的真实调用和证据目录）。人工完成后：`bun run eval:review apps/server/evals/results/7bf43fd0-19e5-4811-b8e5-db76070f4912`。
