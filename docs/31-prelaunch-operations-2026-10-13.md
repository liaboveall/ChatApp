# 上线前工具与封闭部署操作手册（2026-10-13）

本手册是 D-212 的工程交付。当前没有执行 SSH、服务器安装、证书申请、部署、提交或推送。封闭部署按 D-211 接续，最终恢复按 D-210 用现有本机；正式开放仍须全部 M7 门槛通过。实际本地结果见 [30](30-prelaunch-implementation-2026-10-13.md)。

> 2026-10-15 最新域名/邮件及新对话接续见 [32](32-launch-handoff-2026-10-15.md)。主站使用 `https://chatapp.software`；本人已收到 Resend 测试邮件，生产 SMTP 私有字段和完整应用邮件流程仍待部署时核验。没有因本次交接执行服务器变更或关闭 M7。

> 后续实际服务器操作与当前接续见 [33](33-closed-launch-2026-10-15.md)：原生 ARM 候选及四个生产依赖已准备，API/worker、HTTPS、真实异地服务和当前源码 CI 仍待完成。本文的 2026-10-13 交付描述保留历史时点。

## 1. 候选归档与版本绑定

在受控、原生架构的构建机运行，输出目录必须不存在：

```sh
bun --no-env-file scripts/production.ts package .test-runs/release-candidate
bun --no-env-file scripts/production-image-smoke.ts .test-runs/release-candidate/release.json
bun --no-env-file scripts/test-production.ts .test-runs/release-candidate/release.json
bun --no-env-file scripts/production-scan.ts .test-runs/release-candidate/release.json
```

包内有 `release.json`、`source.tar.gz`、`web.tar.gz`、`images.tar`、`production.js`、`watchdog.js`、`load.js`。镜像归档包含应用、媒体、运维、数据库、Valkey、Garage 和用于恢复/核验的 Nginx 原生镜像，以不可变 image ID 绑定，不依赖恢复时重新下载镜像。`source.tar.gz` 供部署工具、迁移与源代码核验；它不是带 Git 历史的完整开发 checkout。构建或测试需要完整仓库及开发依赖。

`APPLICATION_SHA` 是 Git HEAD；dirty 时它只是基线，实际未提交内容由 `APPLICATION_SOURCE_HASH` 和逐文件指纹标识。打包器在构建后重新核对源码，改变即拒绝生成成功清单。`release.json` 列出全部归档的 SHA-256 和大小；上传前及落盘后逐个核验。x64 包不能用于 ARM 服务器。云端和本机恢复分别需要同一源码的原生 ARM/x64 包；`images` 工作流已编写，远端实际通过回执仍须另外取得。

`production-image-smoke` 只证明三个应用镜像的 UID、版本绑定与二进制可启动；`test-production` 用独立随机项目验证实际生产 Compose、TLS 网关与聊天、原生备份及干净库/桶恢复，异地服务由本地 TLS/Garage 模拟。可选第三个参数提供上一份完整原生候选清单，只有migration文件完全一致才运行版本回退/升回和活数据核验。它不证明 R2、整机失效、独立设备或云端容量。正式扫描不使用 `ignore-unfixed`，自编译 C/C++ 的版本/来源另须人工复核；容器 Nginx 扫描不能证明云端宿主软件安全。

## 2. 配置与初次启动

以下是准备后的部署流程示例，当前只编写和本地验证工具。宿主需要 Docker/Compose、与镜像一致的 Bun；可以从已核验的本架构服务器镜像提取 `/usr/local/bin/bun`，放到 `/opt/chatapp/bin/bun`，不在生产机安装 Node/npm 包。私有配置目录 `/opt/chatapp/private` 由 root 管理，目录 700、文件 600；`runtime/` 中供容器读取的 keyring、restic 密码、Garage TOML 属主为 10001。

```sh
/opt/chatapp/bin/bun --no-env-file /opt/chatapp/tools/production.js prepare /opt/chatapp/private https://chatapp.software
docker load --input /opt/chatapp/release/images.tar
/opt/chatapp/bin/bun --no-env-file /opt/chatapp/tools/production.js bind /opt/chatapp/private /opt/chatapp/release/release.json
```

在自己的终端编辑 `app.env` 的 SMTP、MAIL_FROM、所选 AI、journal R2 和可选 Sentry 字段；编辑 `backup.env` 的独立备份 R2 字段。现有 R2 账号已准备；本地已有目标实际是测试桶，生产需要独立新桶/凭据，按 [34](34-r2-production-setup.md)填写单独的生产私有配置，不在聊天发送密钥。生产桶/随机前缀与历史测试前缀分开，权限只覆盖指定桶；journal 和 backup 使用独立访问凭据。`compose.env` 的回环 API 端口及私有 /24 要避免冲突，改变子网时同步 `TRUSTED_PROXIES` 的网关。不要把 owner、备份或 Garage 管理凭据放进 `app.env`。

工具默认生成 `deny all;` 的访问策略。指定本人/验收人员真实出口 IP 后，用 `production.js edge /opt/chatapp/private <IP或CIDR...>` 生成允许清单；拒绝 `/0` 和配置注入。所有页面、API、WebSocket、附件均受同一封闭策略限制。宿主 Nginx 升级/证书/DNS 按 10、D-169 和实际服务器核对后完成；本站点不设 `default_server`。

在 `/opt/chatapp/source` 使用以下参数运行所有运维命令：

```sh
docker compose --env-file /opt/chatapp/private/compose.env -f infra/compose.prod.yml run --rm --no-deps initialize
docker compose --env-file /opt/chatapp/private/compose.env -f infra/compose.prod.yml up -d --wait postgres valkey garage media
docker compose --env-file /opt/chatapp/private/compose.env -f infra/compose.prod.yml run --name chatapp-storage-setup --no-deps tools storage:init
docker cp chatapp-storage-setup:/var/lib/chatapp/backup/storage-initialized.json /opt/chatapp/private/storage.json
chmod 600 /opt/chatapp/private/storage.json
/opt/chatapp/bin/bun --no-env-file /opt/chatapp/tools/production.js storage-install /opt/chatapp/private /opt/chatapp/private/storage.json
```

`storage:init` 的回执同时绑定部署 owner 和桶，重复运行保留已有 key；工具只把 key 写入私有暂存文件。核对容器归属后再移除这个一次性 setup 容器。后续 `tools migrate` 建表和最小应用角色；`tools journal:init` 仅用于空库、空远端前缀的第一次初始化，恢复时禁止使用；`tools backup:init` 初始化独立加密仓库。初次助手初始化使用运维容器的应用 CLI：`run --rm --no-deps --entrypoint bun tools --no-env-file /app/apps/server/src/cli.ts db:bootstrap`；管理员使用同一 CLI 的 `admin:create` 和隐藏终端密码输入。先完成 `production.js configtest`，再启动 API/worker，核对 `/api/readyz`、容器 cgroup、挂载、环境隔离和最小角色。

数据卷的 `CHATAPP_DATA_SOURCE_HASH` 是首次绑定时保存的创建标识，更新/回退应用不得改变。采用此修复前已经更新过旧模板的现场，先只读核对每只现有卷的 owner、项目、角色及创建版本，在私有配置保存实际一致的创建版本；不可仅以当前应用源码推断，遇到混合身份即停止核对。Compose 提示重建卷时不得接受或删除卷。2026-10-16 已部署现场采用额外的私有 `volume-identity.compose.json` 覆盖保证旧候选使用原标签，所有命令须同时传入该文件；换到支持固定标识的新模板后，须先渲染并核对全部实际卷定义。该覆盖不更改卷名或现有数据，细节见 [35](35-closed-deployment-2026-10-16.md)。

向量模型通过运维容器显式运行 `/app/apps/server/src/runtime/embedding-command.ts prepare bge`，模型目录是独立 `embedding-models` 卷；运行时挂只读模型、禁止自行下载。准备、核验和索引世代证据齐备后启用 `EMBEDDING_ENABLED` 并重建 worker/API。初始配置的禁用状态不算 M5/云端容量验收通过；模型与混合资源门槛仍要在 ARM 目标上补证。

前端解压到按源码 hash 命名的版本目录，哈希 assets 追加到共享目录，保留至少 7 天和 3 版，原子切换 `current`。发布前核验 CSP/HSTS、媒体流式下载和默认封闭策略。普通回退只使用兼容迁移的已验证版本；不可逆 schema 变更先取一致备份，不能用回滚应用掩盖数据库不兼容。

管理页可修改十五项站点限制及站点存储预算，保存受版本检查、当前管理员身份和审计保护：

| 政策 | 默认值与边界 |
|---|---|
| 撤回/编辑窗口 | 2 分钟/24 小时；可设 0，分别最多 7/30 天 |
| 文件/图片 | 100/20 MiB；只能收紧底层硬上限，图片不大于文件 |
| 群/频道成员 | 500/5000；分别可设 2–10000/2–50000，收紧不驱逐已有成员 |
| 消息频率 | 单会话每10秒10条、每用户每分钟60条；拒绝请求仍计入各窗口 |
| 上传预约 | 每用户每小时30次；0 可禁止新预约，原每分钟20次突发保护保留，PUT 不重复消耗小时额度 |
| 活动会话/未来任务 | 每用户200/100；私信不占活动会话额度，未来任务可设0 |
| 快速/深入 AI | 8/16步、120/300秒；步数上限64/128、时限最多900秒 |
| 站点存储预算 | 默认50 GiB；变更保留已用/已预约账，不能通过改预算抹除占用 |

客户端只读编辑/撤回/文件/图片四项视图，按账号、登录及恢复世代隔离，三十秒刷新；服务端写入以实际政策为准。0024 迁移给上传预约保存准入时的图片上限，之后政策收紧不改变已接受预约的处理约定。部署及回退前核对该迁移已存在；本地开发/测试库已前向迁移，不能把回退应用当作回退 schema。

## 3. 备份、保留与告警

运维容器用独立 owner/备份配置；应用容器没有这些权限，媒体没有业务网络/密钥。

| 命令 | 作用 |
|---|---|
| `tools backup:run` | 一致数据库导出、快照引用对象与密钥全集、restic 上传、完整下载/hash 回读，验证后才接受成功 |
| `tools backup:verify` | 核对远端所有快照，包括本地账本之外的旧快照；返回完整 snapshot ID、时间、源码与对象数 |
| `tools backup:maintain` | 先核验全部快照，再保留 7 daily/4 weekly 且年龄不超过 28 天，裁剪后核验，35 天 journal/checkpoint 维护 |
| `tools monitor` | 备份、journal、待完成删除、物理清理、死信与存储余量；20h 警告/24h RPO 超限，未来时钟也报警 |

`infra/systemd` 中已有 12 小时备份、每天保留维护、每分钟监控和 30 秒 watchdog 模板，当前未安装/启用。按实际系统时区核对 `OnCalendar`；首次运行、跨周期、异常失败、迟到/重启补跑、远端生命周期/私有权限和真实告警送达均在封闭云端验收。watchdog 只重启再次核验的本项目 API/worker/media，连续三次异常才行动，每服务 15 分钟最多三次；不重启数据库/缓存/对象库，不做全局 prune。

Sentry 在服务器配置 DSN。页面 relay 和运维事件仅发固定类别、页面类别、release；不发正文、邮箱、账号、设备、Cookie、原始 URL/错误堆栈/会话回放。运维问题变化、恢复或持续一小时发送，失败不写已送达回执；未配置时不发送。真实网络送达、通知渠道和 on-call 处理仍需云端确认。

恢复材料单独复制：`production.js materials /opt/chatapp/private <新的另存目录>`。它包含 12 个私有配置/密钥文件；工具只证明本地生成，不能证明异地保管。将材料加密后与双架构候选归档保存在源主机之外；TLS/DNS/SMTP/AI/云存储账户访问及经核验的固定模型文件归档也须独立可取。独立演练不能借用本机已有模型缓存，缺模型须计入可恢复能力/准备时间；联网重取时须固定版本/hash并计入RTO。keyring 历史版本不能因轮换丢失。材料更改后更新另存副本并记录版本。

## 4. 云端丢失后的本机恢复

这部分必须在云端封闭部署后实际演练。从宣布故障连续计时，整台源主机不可访问，仅用异地备份/journal/另存材料；本机新建项目、库、桶、卷，不借用开发数据或源缓存。

1. 装载同一源码的 x64 原生归档。`production.js recovery-prepare <全新配置目录> <原始材料目录> <恢复HTTPS origin>` 生成新的部署 owner、数据库/Valkey/Garage 身份、RESTORE_EPOCH、writer epoch；只带回原始解密密钥、VAPID 与异地位置，不带回旧数据库连接或站点 AI/SMTP 外发配置。随后 `bind-recovery` 绑定同一源码的本架构清单。
2. 子网、回环端口、TLS 和允许清单与现有开发环境分开。撤销源主机的 journal/backup 凭据，在恢复配置填写新的最小权限凭据；核对原 writer epoch 与独立 head。`recovery-prepare` 带回的是材料里的旧凭据，不能据此说轮换已完成。
3. 初始化新卷/依赖和新 Garage，安装新的本地对象凭据；**不要运行 migrate、db:bootstrap、journal:init 或启动 API/worker**。恢复导入要求 public/drizzle 空库和空桶；初始化生产 schema 会使它拒绝导入。
4. `tools backup:verify` 得到完整 snapshot ID；`tools restore:download <ID>` 在新的私有暂存目录下载并逐文件核验，回执给出 PAYLOAD。`tools restore:import <PAYLOAD> <新RESTORE_EPOCH>` 校验源码/schema/原解密材料，导入并持久隔离，重放可信 journal，只写回仍活的对象并 hash 验证。缺材料、对象、可信 head 或清理证据即失败。中断后用 `restore:replay` 同一 PAYLOAD/epoch 续跑，保留原失败结果。
5. `restore:permissions <EPOCH> <新私有文件>` 导出完整用户/成员/可见历史/角色/封禁/归档清单及全部默认不确认的模板。在本人的终端逐账号复核，另写 600 权限的 review 文件，再 `restore:confirm <FILE>`；普通管理员不能绕过恢复暂停标记，原惩罚封禁不被重新确认释放。
6. 对已确认、活动、验证且未封禁的账号，`restore:credential <EPOCH> <USER_ID>` 在交互终端隐藏输入新密码；旧密码、session、Passkey、邮件链接、委托及未确认外发无效。脚本不能代替真实本人核验。
7. `restore:unlock <EPOCH> <PREVIOUS_WRITER> <NEXT_WRITER>` 再验对象、隔离、权限、新凭证和最新独立 head，用 CAS 切换 writer 后才解除恢复隔离并授予应用角色。两个 writer UUID 必须与恢复配置一致；凭据撤销及源主机实际不可访问另有证据，CAS 不是整机停机证明。
8. 验证后启动受限服务、切换必要入口，记录全量对象/删除零复活/权限范围/外发封锁、实际备份年龄与连续 RTO；目标 RPO ≤24h、RTO ≤4h。本机只恢复数据或没有公网服务入口时，不能报告完整服务 RTO 通过。

## 5. 压测与仍待完成的 M7

`tools benchmark:seed smoke|full <新RUN_ID>` 需要显式 `BENCHMARK_ENABLED=true`，只新增合成记录，不清理现有数据。smoke 是 8 用户/3 会话/120 消息/3 对象、12KiB；full 是 1000 用户/200 会话/100 万消息/10 万真实随机对象、约 10.7GB，先测量存储余量。fixture 包含真实 SDK 登录 Cookie，只存 700 目录/600 文件，禁止上传为 CI artifact。失败保留原 run，重试用新 run ID。

`production-load.ts <PRIVATE_FIXTURE> smoke|full <新结果目录>` 用锁定 k6 运行 HTTPS 聊天。默认 full 为正常 80/15/5 分布、200 个活跃发送用户、450 个快速接收连接及 50 个真实暂停读取的慢连接，五分钟预热、三十分钟测量，并在预热后五秒内另发起 500 次重连；`CHATAPP_LOAD_DISTRIBUTION=hot` 单独测单频道热点。接收账号各自独立，重连仍受原每用户限制。full 需要经 OS 配置验证的 `CHATAPP_LOAD_LOCAL_IPS`，每个独立 IP 限流组配置一个地址，至少五组；同一 IPv6 /64 算一组，同一 NAT 出口不能冒充多组，不得降低每 IP/每用户连接限额。远端网络、反向代理及真实出口也须核对，OS 绑定成功不能证明远端看到多个来源。

summary 不包含用户/URL/Cookie 标签；原始诊断私有存储。门槛包括有效交付样本 >0、从发送开始到接收方拿到已授权完整 DTO 的 p95 <300ms（本地 smoke <200ms）、错误率 <1%、权限/重复效果/丢迭代为零，并校验精确的发送及重连次数。热点退化单列，不并入正常负载均值。full 数据计划的 500 人档是频道，每个账号均有 20/100/500 三档可达目标；smoke 的三个逻辑档均为八人，不能用于规模外推。私有测试域名的路由覆盖通过 k6 JSON 配置的 hosts 提供，并保留原 Host/TLS 身份，见 [k6 官方配置说明](https://grafana.com/docs/k6/latest/using-k6/k6-options/reference/)。

`bun --no-env-file scripts/test-m7-mixed.ts` 是独立 compose.test 的本地混合 smoke，不接受 full 参数。它使用真实媒体、离线原生 BGE query/回填、一致 pg_dump/对象读回与本地清单，并在约两分钟内观察四个运行中的模拟 Agent、媒体和备份重叠；其中聊天测量三十秒，三条快速连接、一条真实慢连接、四次重连。长模拟流只在 `APP_ENV=test` 允许调节，未调用真实模型服务。API/worker 心跳附带主进程累计事件循环指标，保留原健康新鲜度门槛。备份是本地合成恢复材料，不能当作异地 restic、定时备份或独立恢复证据。混合 smoke 与任何前端构建/浏览器网关套件必须串行，避免覆盖共享 dist；常规 coverage/E2E/edge 也须独占共享测试库。

完整生产混合编排、500 WS/全量 10GB 实跑、所有故障与背压矩阵、生产调度/告警、ARM 容量、独立整机恢复、完整安全清单及本人试用仍须在封闭部署阶段继续。管理页的十五项限制及站点存储预算已接入；政策变更的实际全量运行效果仍需目标环境验收。不得把本地 smoke 或归档交付当作完整 M7 关闭。
