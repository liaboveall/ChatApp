# 上线前工程交付与本地核验（2026-10-13）

本轮范围由 D-212「先做到上线之前」确定。发布、运维、管理政策及本机 x64 候选归档已有实现与限定验证；最新候选是下方的 `b603a699…`。此前一次版本升回的 worker 不健康原因仍未明；本轮给回退/升回增加依赖就绪顺序、固定失败诊断和探针源码绑定，新候选的完整 45 阶段实测通过，仍不据此宣称找到原故障原因。未连接或变更服务器，未提交、推送、部署，也未调用真实 R2、Sentry、SMTP 或模型供应商。完整 M7、V-19/AT-33 与云端容量保持待验收。

## 1. 交付范围

| 范围 | 已有实现 | 实际界限 |
|---|---|---|
| 发布 | 锁定基础 index 的 server/media/ops、补丁版 PG18+pgvector/Nginx；原生镜像与前端/源码/独立 Bun 运维工具归档；构建前后源码指纹及 image ID/文件 hash；700/600 私有配置生成、核验和绑定 | 本机是 x64；ARM 目标、远端 CI、注册表发布和宿主软件仍未验证 |
| 生产 Compose | 随机独立项目/owner/卷、回环 API、普通应用角色与 owner 分离、健康/心跳；API 1GiB、worker 1536MiB、media 512MiB；media 无网络/业务密钥，只读、cap_drop 与64 PID | 本机独立环境实际核验；云端 ARM 同时负载及余量另测 |
| 备份恢复 | owner CLI 的一致 `pg_dump`、不可覆盖对象全集、原生 restic 上传与全量回读/保留/checkpoint、材料全集；空目标导入、可信重放、对象证明、完整权限清单、默认暂停、隐藏终端新凭证、writer CAS 解锁 | 本地 TLS/Garage 模拟异地；没有新真实 R2/独立设备/整机失效/全量 RPO/RTO 证据 |
| 管理与举报 | 用户/角色/验证/封禁/额度、邀请码元数据、群/频道归档与恢复、封禁、举报/有限当前可见上下文/处理/撤回、审计、站点 AI 用量；原四项政策之外新增十五项限制及站点存储预算，版本/幂等/当前管理员事务复核 | 本地接口/浏览器已有证据，目标环境与本人管理流程仍待验收；具体政策见31 |
| 保留与隐私 | 内容保留1–30天规则v2，不改历史v1；请求时拒绝到期内容；源删除擦除举报解释/处理笔记；注册/设置入口与公开双语说明 | 本人阅读/真机/读屏未验收；生产实际生命周期须云端复核 |
| 监控运维 | Cookie-free 固定类别 Sentry relay、隐私事件、变化/恢复/小时重复告警；备份/删除/journal/容量检查；持久有限 watchdog 及 systemd 定时模板 | 没有实际 Sentry 送达、timer 安装或跨周期运行证据 |
| 压测 | 锁定 k6、真实数据/对象/SDK私有Cookie fixture；80/15/5正常与单频道热点分开、200活跃发送者、450快/50真慢连接、500重连入口；本地四模拟运行/媒体/向量/一致备份混合 smoke | full入口和目标数据计划已有实现，百万消息/10GB及完整生产混合编排、故障矩阵、ARM容量仍未实跑 |

实操、材料保管与剩余云端步骤见 [31](31-prelaunch-operations-2026-10-13.md)。Git 仍为 `v2`，基线 `8f33c772b1eced9c0d2fbe1f84f6c2f32a9641ff`；dirty 候选用源码 hash 标识，不能说当前未提交代码已有该 SHA 的远端 CI。开工保存 116 个原有 dirty 文件及 1146 文件基线；原开发配置、数据和服务保留。0023/0024 已分别前向应用开发与测试库，没有重置数据；开发 journal 保持禁用。

## 2. 本轮接续与最新候选

核验根目录仍为 `.test-runs/m7-prelaunch-2026-10-12/e9c8c3d1-8e0b-49b8-a64f-df3491e2fdc8/`，以下都是本轮实际结果。

| 命令/检查 | 结果 | 证据及范围 |
|---|---|---|
| 完整 `bun run check` | 702 后端/脚本等 +750 前端；7项typecheck、guard、3018对比度、995双语key | `check-final-attempt2.log` |
| `bun run test:coverage` | 1277/1277、17881断言；domain93.75%、agent97.78% | `coverage-final-attempt1.log`；新增政策与完整规模数据计划回归均包含 |
| 政策/契约专项 | 10/10、71断言 | `policy-tests-attempt6.log`；含成员/邀请配额、拒绝请求各窗口计数、零上传预约及有限客户端视图 |
| 管理/举报/隐私浏览器 | Chromium+WebKit18/18，零重试；浅深主题、320/768/1440、axe；新增15项政策保存/接口/刷新/恢复 | `policy-e2e-attempt2.log`；前端与最终包相同，之后仅后端数据计划与注释调整；自动化不是本人试用 |
| 附件真实业务链 | 9上传、3头像、6消息附件；100MiB/超限/预约限制/不可变PUT重放/Range/撤回/账本通过 | `attachments-final-attempt1.log`、`.test-runs/m3/b2fb2ba0/business-result.json`；已核验归属并拆除。Docker Desktop两次挂载启动重建保留，不算业务重试通过 |
| 媒体运行时/故障完整重验 | 56/56、0失败/0未执行；真实解码、60s生产期限、PID/tmpfs/OOM、进程树、清理失败拒绝新任务与恢复 | `media-final-attempt1.log`、`.test-runs/m3/304f1b35/result.json`；归属核验后拆除 |
| 原生生产与兼容回退/升回 | 45阶段通过；原生一致备份/restic全读回/保留、干净库桶导入/重放/权限确认/新凭证/解锁及拆除 | `.test-runs/production/88b08887-a8b8-4f50-b3e3-2f4fe4408393/receipt.json`；8人/3对象/12KiB、1人确认7人拒绝；探针hash与结束不变证明包含在回执 |
| 生产HTTPS聊天 smoke | 4快速连接、30次发送、120次授权完整交付；p95=109.1ms、p99=134.43ms；错误/越权/重复/丢迭代0 | 上述生产目录的 `load-summary.json`；没有慢连接/完整混合容量外推 |
| 镜像与依赖门槛 | 最终7镜像HIGH/CRITICAL=0，未忽略unfixed/未豁免；1045依赖high门槛通过，原moderate1保留 | `candidate-attempt4/trivy-*.json`及`scanned-image-identities.json`、`scan-final-attempt1.log`、`dependency-audit-current-final.log` |
| 数据库结构 | `db:check`退出0，0024前向迁移已应用开发/测试库 | `db-check-current-final.log`，迁移无数据重置 |
| 最终混合 smoke | 四个同时运行的模拟Agent、6媒体任务、72次原生向量请求/7次背压、39次本地一致备份；6次媒体/备份/四运行重叠采样；源码/探针均前后不变 | `.test-runs/m7-mixed/7381f6b3/result.json`、`mixed-final-attempt1.log`；归属核验后拆除；不是生产镜像部署或异地备份证明 |
| 混合HTTPS聊天 | 3快/1真慢连接、4次重连、30次发送、90次授权完整交付；p95=143ms、p99=158.11ms；错误/权限/重复/丢迭代0 | 上述混合目录`load/summary.json`及慢连接回执；8人逻辑三档、小数据/30秒，没有完整规模外推 |

### 最新候选绑定

- `candidate-attempt4/release.json`：`APPLICATION_SOURCE_HASH=b603a699d1763c06ce0167ea5d3d25ed28557638b954d18b74b82bd20c4047fa`，x64、dirty基线8f33c772…；7原生image ID、892文件指纹、6归档/工具，源码tar888文件、镜像tar740924416字节。
- `selfcheck-2592328c-e557-4130-b36b-a1563c08cac2/receipt.json`：文件大小/hash、目录700/文件600、独立Bun运维工具、源材料选择性恢复、新恢复身份、密钥隔离均通过；source/web/工具1049文件的配置secret字面匹配0，配置检查networkRequests=0。不能扩大为全部历史/二进制的密钥审计。
- 三应用镜像10001/原生架构/版本及工具启动通过；BGE最终镜像query/passage两离线样本通过：`embedding-689261ed-23b7-48c9-9102-36d86ece961a/receipt.json`，无网络/1GiB，不是ARM或混合容量。
- 回退候选为 `candidate-attempt3` 的 `070207b2…`，与当前0024 migration文件完全一致。旧0023候选不能绕过 schema 兼容门槛。回退/升回分别先等数据库/Valkey/Garage/media就绪，再启动API/worker；不重跑初始化、不放宽健康期限。
- 最终混合回执 `7381f6b3` 与本候选源码一致，source/harness前后不变，正常聊天与真慢连接门槛通过。它使用当前源码构建的独立compose.test，不能冒充本候选生产镜像已完成完整混合容量。此前混合6/7通过属于各自旧source hash，保留各自证据。

### 混合资源与尚未解决的退化

约两分钟观察、聊天三十秒；原生子进程峰值187.12MiB，采样worker/media/API峰值500.81/44.37/157.31MiB，worker+media未越2GiB，三业务容器无OOM事件。API/worker/media固定CPU0,1，负载器与观察器仍在同一宿主，不能据此外推ARM总内存或500连接容量。主进程累计事件循环worker p95/p99/max=3.39/12.97/48.08ms，API=1.19/6.30/138.54ms；不是仅测量窗口内的重置直方图。

额外十个原生工作负载账号在同一会话发出111条消息，其POST完成p95=420.15ms、p99=545.90ms，采样队列最老35.70秒/数据库锁等待9。该组写入比正常容量门槛慢，**仍待诊断与目标环境复核**；不与k6的授权DTO交付143ms混算，也不能用正常聊天通过宣称共享上下文退化已修复。四运行重叠依据持久agent_runs的running计数，未直接逐帧证明四个真实供应商模型流。全量/ARM/真实异地备份/故障矩阵及独立恢复门槛保持待验收。

### 政策与负载的行为边界

服务端执行当前政策；客户端仅取撤回/编辑/文件/图片四字段，按账号/登录/恢复世代隔离且30秒刷新。变更成员/会话额度不驱逐已有成员，私信保持不计活动会话额度；下调站点存储预算保留已用/预约账。上传每小时额度只计新预约，保留原每分钟突发保护；0024保存预约时图片上限，后续收紧不改变已接受任务的处理约定。文件/图片政策只能收紧硬上限。

full计划的500人档改为频道，并验证200会话、成员唯一、1000账号均可达三档；此验证不生成百万消息/10GB。慢客户端使用真实TLS暂停读取，重连/发送次数和早退连接有独立门槛，不豁免每IP/每用户限制；完整规模来源需至少五个真实独立IP组。混合 smoke 的四个模拟运行使用仅测试环境允许的受限流节奏，不能据此宣称真实模型服务性能提升。

## 3. 前次候选的历史证据

核验根目录 `.test-runs/m7-prelaunch-2026-10-12/e9c8c3d1-8e0b-49b8-a64f-df3491e2fdc8/` 私有保存全部 attempt。下表不会将 prototype 镜像绑定当作最终候选绑定。

| 命令/检查 | 当前实测结果 | 证据与范围 |
|---|---|---|
| 完整 `bun run check` | attempt16：698 后端/脚本等 +749 前端；typecheck/guard/3018对比度/978双语key通过 | `check-attempt16.log`；之后仅回退探针增加schema/活数据/脱敏诊断，定向typecheck通过 |
| `bun run test:coverage` | attempt4：1267/1267，17003断言；domain93.64%、agent97.78% | `coverage-attempt4.log`；真实开发测试依赖，供应商/邮件/推送按既定模拟 |
| 管理/恢复权限/保留/监控专项 | 13/13、143断言；允许重新确认原恢复暂停标记，普通管理员不能绕过，原惩罚封禁保留 | `admin-retention-attempt3.log` |
| 管理/举报/隐私浏览器 | Chromium+WebKit18/18，零重试；浅深主题、320/768/1440、axe、真实处理/撤回/审计、会话归属迟到回答、归档恢复 | `e2e-admin-attempt8.log`；自动化不是本人试用 |
| HTTPS 网关 | 配置核验退出0、26/26 | `edge-configtest-final1.log`、`edge-final-attempt1.log`；日志哨兵、限流、异常 framing、CSP/HSTS |
| 新媒体运行时 | 56/56，0失败/0未执行；真实解码、恶意输入、60s期限、64 PID/tmpfs/OOM、进程树清理、恢复 | `.test-runs/m3/03bc4dc3/result.json`；仅已核验独立 compose.test，已拆除 |
| 原生生产组成 prototype | attempt11完成：最新 PG/Nginx 启动，TLS聊天、最小角色、一致导出/restic读回/保留、同镜像重建/重复迁移、干净第二库/桶导入/隔离/对象校验、权限/新凭证/writer解锁 | `.test-runs/production/4448510c-f6ca-4dce-bcc0-d8484fb29201/receipt.json`；8人/3对象、12KiB，1人确认/7人拒绝，归属核验后拆除。新密码由运维限定合成 fixture 发放，非本人终端流程实测 |
| 原生推理 prototype | BGE query/passage2个离线样本，UID10001、无网络、1GiB上限，真实 ONNX 向量有效 | `embedding-ed1ecad0-8424-4d2a-b3e3-39b1f5842e2b/receipt.json`；非 ARM/混合容量/真实语料质量 |
| 镜像扫描 prototype | 最新7个镜像全部检出 HIGH/CRITICAL=0；未忽略 unfixed/未豁免 | `prototype-scan6/trivy-*.json`、`scanned-image-identities.json`；自编译FFmpeg来源及扫描覆盖限制见下文 |
| 配置/权限绑定 | 私有准备、源材料选择性恢复、全部运行镜像绑定、恢复拒绝不同源码5/5、38断言；watchdog/文件/监控等纳入check | `bind-release-attempt1.log`；不声称材料已异地保存 |

### 前次候选绑定（历史）

`candidate-attempt2/release.json`（同一核验根目录）绑定：

- `APPLICATION_SOURCE_HASH=a72dd4c44fe43f2fefe3a15d7315191929481f476b549865038b116d79fa9b3e`；基线Git SHA仍是8f33c772…，dirty=true、baselineShaOnly=true、architecture=x64。
- 7个不可变原生image ID、887个绑定文件指纹，源码tar实际884个常规文件；6个归档/工具文件均600、目录700。`images.tar` 740,880,896字节，全部文件大小/hash和当前源码重新核对通过。
- `selfcheck-6316f05b-a996-4fe8-b35c-2223ee0e8663/receipt.json`：解包源码逐文件hash、独立`production.js`在没有node_modules的解包目录执行help/prepare/bind/storage-install/configtest/materials/recovery-prepare/bind-recovery全部通过；读取实际配置作source/web/工具/镜像ENV字面核验，1045个文件匹配0，配置检查networkRequests=0。不是全部二进制/历史证据的密钥审计。
- `candidate-attempt2/trivy-*.json` / `scanned-image-identities.json`：该候选7镜像HIGH/CRITICAL零发现，扫描退出0；三个应用镜像的原生架构/10001/版本绑定与工具启动通过。`dependency-audit-high-final.log`：1045包high门槛通过，仍有门槛下1项既有moderate；`db-check-final.log`退出0。
- 最终候选原生生产37阶段：`.test-runs/production/a8cf99d6-f233-4065-804f-76477484bcd2/receipt.json`通过并拆除；4个WS/30秒聊天120个已授权交付样本、p95=75ms，各错误/越权/重复/丢迭代为0。BGE最终镜像离线2样本通过：`embedding-6038c9a3-ba85-467a-ab27-c922c60b6243/receipt.json`，UID10001/无网/1GiB。
- 同migration候选82dbe14a…回退并升回a72dd4c4…后，活库8人/3对象与远端快照仍完整。两个独立43阶段复测均通过并清理：`.test-runs/production/51d48d4f-91df-42f5-a9a0-6916a077b35e/receipt.json`、`.test-runs/production/3dac17e2-c27d-448f-a301-65540df6fe13/receipt.json`；p95分别72.25/70ms。原首轮在升回时worker unhealthy失败（`273c0cd1-e6ec-40db-8837-02cbf82ff919`），当时缺worker日志，后续未复现，**原因未明、未宣称修复**。加入脱敏失败诊断及schema/活数据证明，保持原健康门槛；云端启动/多周期/资源验收须继续核查。

## 4. 实际发现与修复，失败保留

- 本轮浏览器首次17通过/1失败，trace明确显示Service Worker脚本拿到HTML；是本次执行中将混合网关重建与浏览器套件并行、覆盖共享dist造成。失败trace保留在`policy-e2e-attempt1-artifacts/`，改为串行后18/18零重试；没有删除console/CSP检查或添加应用豁免。最终check首轮新增数据计划的字符串字面类型报错也保留，修正类型推断后全量通过。
- 混合前五个失败attempt分别保留UUID、k6 hosts错误、准备顺序、JSONB控制状态被写成字符串、恢复清单文件约定、未被及时观察的后台promise、到达率调度边界、原生向量背压及延迟超限。修正探针和编排后分别记录真实拒绝/背压；额外到达率边界迭代单列，实际发送/重连必须精确达到目标，丢迭代门槛仍为0。模拟流改为测试环境受限节奏以形成重叠，这是负载定义变化，不能把旧短调用风暴的延迟失败称为生产性能修复。
- 生产 tmpfs 的 YAML 逗号被解析成独立挂载，初次 PG 启动失败；改为明确带引号的字符串后通过。
- restic 快照 metadata 的绝对路径与恢复树 `/payload` 不一致：按 metadata 设置 include 后命令退出0却恢复0文件。严格 payload 校验拒绝该结果；改为全树恢复到全新私有目录、逐文件/大小/hash核对，禁止成功退出码代替数据证明。
- PostgreSQL SDK 的 SQLSTATE 在 `.errno`；权限探针先前误用 `.code`。修正探针后实际证明普通角色不能创建表，未放宽权限。
- 新举报 menu 关闭动画与小屏 resize 竞态造成 WebKit 横向溢出；触发举报先关 menu，探针等退出完成后测量。空侧栏键盘可滚动焦点、迟到上下文哨兵和 ConfirmDialog 的 alertdialog 探针也已修正。保留初次失败，未用容差或重试通过来掩盖。
- Docker Desktop首次k6容器因在只读命名卷目录内再绑定脚本而挂载失败，未运行负载；改为由运维容器仅复制合成Cookie fixture/脚本到独立私有负载卷后运行。有效交付样本必须非零，避免没有交付数据的空延迟指标被误判通过。
- 实际 Trivy 首跑暴露98/216/199项，扩展基础镜像又发现PG125/Nginx3；镜像扫描还暴露只读缓存路径、1GiB缓存不足、私有归档UID读取等探针问题，已逐项修复。删除未被运行时使用的 drizzle-kit/esbuild/别名及数据库 gosu，使用 distroless 运行时/有包记录的库闭包、更新稳定 Go 与 restic安全依赖、重建签名FFmpeg9.0.2、补丁版PG18/Nginx；不是删除扫描记录或 ignore-unfixed。
- FFmpeg9可以封装 FFV1进MP4，但不代表浏览器能播放；增加编解码限制，FFV1保持原始字节下载。新媒体镜像的目录属主/700模式及固定公开CA环境与测试白名单也已核对，子解码进程仍用更窄的无业务环境。两个拒绝启动的遗留实例经完整归属/镜像/策略核验后拆除，回执 `startup-cleanup-attempt2.log`；开发服务未动。

签名 FFmpeg 源归档 hash 为 `8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e`，签名指纹 `FCF986EA15E6E293A5644F10B4322F04D67658D8`；原始归档/验证在 `ffmpeg-verification/`。运行镜像保留版本/hash标签与GPL声明，额外库保留 Debian inventory。Trivy 对自编译 C/C++ 不提供完整版本漏洞覆盖，不能据7个JSON的零发现断言不存在漏洞；正式07全清单仍需结合[FFmpeg安全公告](https://ffmpeg.org/security.html)、源码与实际能力复核，宿主Nginx另验。

## 5. 封闭部署后的门槛

域名、DNS、邮件/证书与服务器实际状态就绪后，先获取同一候选的原生 ARM 包及 exact-HEAD 远端工作流回执，复核宿主 Nginx 的支持版本和受限入口，再按31封闭部署。目标服务器的清空/更新信息由另一个会话记录在 PROGRESS，本轮没有连接确认；不能将其记作本轮实测。

随后完成真实R2原生运维链、生产定时/保留/容量/告警、多周期与轮换、08第9节完整数据和生产混合编排、ARM资源/故障与全部安全/视觉/本人项，实测已接入政策的目标环境效果。最终使整台云端源主机不可访问，在本机干净环境仅凭异地输入恢复全量数据，验证成功删除零复活、权限再确认和连续RPO/RTO。完成这些才关闭完整M7、正式开放、开始14天邀请内测观察。本文不更改28/29的历史证据或结论。
