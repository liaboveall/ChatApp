# 2026-10-15 封闭部署执行记录

> 2026-10-16 已进入实际封闭运行；当前版本、验证与未完成项见 [35](35-closed-deployment-2026-10-16.md)。下文历史准备状态保留。

本文为最近一次 CI 命令修复提交时的检查快照；后续版本和结果以[分支工作流](https://github.com/liaboveall/ChatApp/actions?query=branch%3Av2)、实际 Git 及下述私有执行回执为准。

本人指示「开始上线」，按 D-211 进入云端封闭部署。真实用户开放须等待完整 M7、V-19/AT-33 及发布门槛；本文只记录实际操作。开工交接见 [32](32-launch-handoff-2026-10-15.md)，运维入口见 [31](31-prelaunch-operations-2026-10-13.md)。

**当前接续**：同源码原生 ARM 候选第二次构建/镜像冒烟、37 阶段隔离生产彩排及七镜像 HIGH/CRITICAL 扫描通过。六份公开 ARM 归档已传回本机并逐项核验。生产 PostgreSQL、Valkey、Garage、media 已健康、静态前端就绪；API/worker 尚未启动、生产库未迁移、真实 journal/restic 未初始化。本人已明确接受证书条款及自动续期，并授权提交、推送 v2 和处理 CI。域名证书已签发至 2027-01-13；公网 TLS/主机名、HTTP→HTTPS、HSTS 和所有应用路径封闭检查通过，自动续期 dry-run 及 Nginx reload hook 通过。当前待本人按 [34](34-r2-production-setup.md)新建生产 R2 桶及独立凭据、运行修正版配置助手；旧本地目标实际都是测试桶。私有离源恢复材料、当前提交 CI、正式启动和完整 M7/恢复仍待完成。

## 当前版本与现场检查

- 分支 `v2`，开工 HEAD `8f33c772b1eced9c0d2fbe1f84f6c2f32a9641ff`，保留全部既有未提交工作。开工时没有提交或推送；该 SHA 是本次 dirty 基线，后续提交/CI 以实际 Git 和工作流回执为准。
- 892 个绑定文件的源码指纹为 `b603a699d1763c06ce0167ea5d3d25ed28557638b954d18b74b82bd20c4047fa`，与 `candidate-attempt4` 相同。六份历史归档逐份核验 hash/大小，源码 tar 的 888 个文件逐项匹配清单；另外四份绑定测试文件也上传核验，未将 `.env.local` 或私钥放入构建上下文。
- 使用 WSL 现有 SSH 私钥及 `StrictHostKeyChecking=yes` 连接，未读取或复制私钥内容。DNS A 与私有目标地址一致，AAAA 查询没有记录。地址及出口 IP 只留在私有配置/回执，不写入公开文档。
- 现场为原生 `aarch64`、Ubuntu 26.04.1 LTS，Docker 29.9.0、Compose 5.6.0，宿主 Nginx 包 `1.28.3-2ubuntu1.11`；可用内存约 11 GiB、磁盘约 136 GiB。没有应用容器、镜像或失败服务，Nginx 仅启用原兜底站点。
- 原先域名 TLS 返回 `TLSV1_UNRECOGNIZED_NAME`；现场没有域名证书及匹配站点，与兜底站点拒绝未知 SNI 的配置一致。此时尚未提供 HTTPS 应用服务。

## 已执行的准备

1. 建立独立 `/opt/chatapp` 目录及受限上传区；原开发环境未改。架构无关的源码、前端和独立 JS 工具来自已验证候选，没有上传 x64 运行镜像。
2. 以单独的 systemd 作业在原生 ARM 构建五个发布镜像并拉取两项锁定依赖，逐文件核对源码指纹并归档。第一次全部镜像构建成功，但镜像冒烟失败：构建准备脚本的 `umask 077` 使解包时自动建立的源码子目录成为 root 700。实查运维镜像的 `/app/apps/server/src/runtime` 为 root 700，入口文件存在且为 644；非 root 用户读取时 Bun 返回 `Module not found`。三个镜像的 UID、架构、版本绑定及 pg_dump/pg_restore/restic 启动均通过单独诊断，不能据此把完整冒烟写成通过。

   首次镜像、归档、作业日志和失败回执保留。第二次只规范公开构建源码的子目录为 755、文件为 644，源码内容/hash 不变；私有配置目录不参与此处理。`chatapp-native-candidate-attempt2.service` 已通过，产物另存 `arm64-attempt2`，证据另存 `build-evidence/attempt2`。三个应用镜像的原生架构、UID/绑定和运维入口通过；隔离生产彩排 37 阶段通过并按归属清理；七个实际原生镜像扫描 HIGH/CRITICAL 均为零。源文件和彩排 harness 前后未变。异地服务仍由 TLS/Garage 模拟，恢复为八用户小样本，不是生产 R2、目标全量容量或最终独立恢复验收。
3. 后端 ARM 镜像已完成；从此镜像提取并确认 Bun 1.4.2，放在 `/opt/chatapp/bin/bun`。历史记录中的宿主 Bun 路径现场不存在，没有因此安装宿主 Node 或替换系统软件。
4. 使用候选 `production.js prepare` 生成生产随机身份、数据库运行/owner 分离、VAPID、journal keyring、restic 密码及独立随机异地前缀。配置目录 root 700、文件 600，runtime 文件按既定容器 UID 设置。外部服务字段尚待本人填写，生产容器尚未启动。
5. 用 `production.js edge` 生成本人核验出口和回环地址的允许名单，结尾 `deny all`。SSH 来源与本机 HTTPS 出口查询一致；浏览器实际访问仍须在 HTTPS 启用后验证。
6. 新建临时 `chatapp-acme` Nginx 站点，保留原兜底站点。只开放 `/.well-known/acme-challenge/`，其他路径 403；`nginx -t`、reload 及公网验证路径的 200/精确正文检查通过。前段尚未申请证书；本人随后明确接受 v1.8 及自动续期，已签发并通过下述 HTTPS/续期检查。
7. 前段私有配置助手误把本地 R2 测试目标作为可复用生产目标，实际执行被生产 `-test` 校验拒绝，未写入生产外部字段。已修正为独立的本机生产私有配置：复用已有 AI 和同账户 endpoint；由本人隐藏输入生产两组桶/凭据和 Resend Key，保存 600 权限文件后经严格 SSH 写入服务器，重试不重复询问。普通 WSL 用户运行，服务器提权由脚本处理。没有放宽生产桶校验、改名复用测试桶或替换开发配置；步骤见 [34](34-r2-production-setup.md)。
8. 将已核验候选绑定到独立生产配置，准备 `/opt/chatapp/source`、`release`、`tools` 和静态前端原子 `current` 指针；静态目录/文件为 755/644，没有 `.vite` 元数据。新卷初始化、四个依赖容器健康、内部 Garage 初始化和应用凭据私有安装均通过；一次性 storage 容器按 owner 核验后移除。四个容器没有宿主端口；media 非 root、只读、无网络、ALL capabilities 丢弃、no-new-privileges、512 MiB 内存与同额 swap、仅 IPC/tmp 挂载经实际 inspect 核验。生产外部字段写入与内部凭据安装使用同一配置锁。
9. ARM 公开归档回传完成。首次较慢的未完成文件保留；四路分块传输已重组并核验 747751019 字节传输包 hash 和六份清单归档的 hash/大小，`download-receipt.json` 为 `downloaded-and-verified`。这是公开发布材料；私有离源恢复密钥/证书等尚待另存。
10. 本人同意条款后运行 Certbot webroot 签发，公开域名证书至 2027-01-13 有效。临时 HTTPS 站点对所有应用路径返回 403；公网 TLSv1.3/证书链/主机名、HTTP 301、各路径单份 HSTS 均通过。snap certbot 续期 timer enabled/active；新增仅匹配本域名的 Nginx 校验/重载 hook，`renew --dry-run --no-random-sleep-on-renew --run-deploy-hooks` 退出 0、模拟续期及 hook 成功。日志中的 `error output` 是 Nginx 成功信息写到 stderr，不能误报 hook 失败。最终业务 Nginx 站点仍待 API/worker 就绪后切换。

## 本轮本地验证

| 检查 | 实际结果 |
|---|---|
| `bun run check` | 退出 0；后端/脚本 702、前端 750；lint/typecheck/guard/对比度/文案一致性通过 |
| `bun run db:check` | 退出 0 |
| `bun audit --audit-level=high` | 退出 0；1045 个包，1 项低于 high 门槛 |
| 历史六归档 hash 与大小 | 全部匹配；包括本机 x64 镜像包，但未将该镜像包部署到 ARM |
| 源码 tar 及 892 文件绑定 | 全部匹配 `b603a699…` |
| SSH 主机指纹/DNS/ACME 入口 | 通过上述限定检查 |
| 发布源码密钥扫描 | Gitleaks 8.30.1，最终 1227 个可提交文件，零发现；首次 CLI 参数错误日志另存，修正调用后扫描退出 0 |
| 服务器到 Resend/SoCLaaS 的 TLS | SMTP 465 / API 443 的证书链及主机名有效；未认证调用或发送应用邮件 |
| 首次 ARM 镜像冒烟 | 失败；已定位解包源码目录的权限问题，原结果保留 |
| 第二次 ARM 镜像冒烟/隔离生产彩排 | 通过；37 阶段、原生小样本备份/恢复，已清理彩排项目 |
| ARM 镜像扫描 | 七镜像 HIGH/CRITICAL 均为零；自编译组件与宿主安全仍有独立审查边界 |
| 生产依赖准备 | 四项健康；内部存储、静态前端和媒体隔离已核验；API/worker 未启动 |

以前的 coverage、E2E、x64 生产彩排等仍是历史结果，本轮没有重复宣称重跑。首批 M7 改动已提交并推送为 `dabb9ea03303862eb8e07e58d8f0d011fbc6bdd3`，本地/远端 SHA 一致、工作区干净、892 文件指纹未变。该提交的 `check` 和 `security` 工作流通过，其余结果按实际回执接续；旧基线六项成功不覆盖本批 M7。实际目标 ARM 的镜像/隔离彩排通过不能代替远端 CI、生产 R2、全量容量或最终独立恢复。

首次远端 CI 的 media（x64/ARM）和 embeddings 失败在冷镜像构建：测试助手给媒体 Docker build 的上限仍为 180 秒，而新镜像从固定 hash 源码编译 FFmpeg，生产主机首次实际记录为 674.6 秒。将媒体镜像构建单独设为 20 分钟的有限准备预算；worker 构建、容器启动、解码、故障及负载时限不变，后续重新提交运行 CI。原失败日志另存，不能写成媒体/向量验收通过。原生候选第三次已绑定 `dabb9ea`，镜像冒烟、37 阶段彩排及扫描通过；后续修复提交仍须重新绑定对应 SHA。

同一次当前源码 CI 的 integration 和 Trivy 子任务通过。原生隔离彩排失败在 `storage-initialize`；GitHub 非 root runner 运行后，artifact 的递归匹配还进入 UID 10001/700 的私有 runtime 并被 EACCES 拒绝。CI 运维入口改为按生产手册使用 root 执行，仅将 release、image-smoke、receipt、load-summary 四类公开 JSON 复制给 runner，再上传独立 metadata 目录，私有权限保持原值。收集器在不可遍历私有目录的合成夹具上实际收集四个允许文件、未触及私有材料，YAML/Python 解析通过；远端修复效果仍以重跑为准。

视觉首跑 126/140 通过，十四张差异对应 M7 新增隐私入口及注册/设置页面排布。已在官方 Playwright 镜像重现并逐张查看全部浅深主题差异，保留首次截图/context；更新这十四张基线后完整比较 **140/140、零重试**。同步修正 visual artifact 路径为实际的 `.test-runs/visual/results`。本次十四张绑定 PNG 更新使 892 文件候选指纹变为 `54c82dea18544da8d76f7791d7335766578b3bad19dc2d0e3de5d2b35f47b282`，此前 `b603a699…` 候选保留，不把它重新命名成新源码。预算修复后 `check` 退出 0；另一次本机 x64 小样本彩排 37 阶段通过并清理，仍绑定前一指纹。

第二次提交 `b8c3f9143551de057bcb42fc4ffcffaa38797cf0` 已推送；同提交 `check`、`security`、`integration`、media 双架构及 embeddings 工作流通过。images 原生彩排未启动：`sudo --preserve-env=PATH bun` 仍被 sudo 的命令搜索路径限制，返回 `sudo: bun: command not found`。已修正为先解析 Bun 绝对路径，再以 `sudo env` 传入 PATH；原生主机确认 root UID、Bun 1.4.2 和 Docker ARM 可用。工作流的最终修复结果仍以新一轮回执为准，不能拿生产机成功替代 CI。该提交的 x64 发布包六归档 hash/大小、镜像冒烟/扫描及 37 阶段隔离彩排通过并清理；ARM 第四候选同项通过，六归档回传另验。后续 CI 命令/文档修复不改变 892 文件指纹，但发布镜像元数据仍须绑定实际发布提交。

## 证据和接续

本机私有记录在 `.test-runs/launch-2026-10-15/attempt1/`，包含修改前 Git 状态/补丁、源码清单、本轮检查日志、脱敏 `preflight.json`、`server-receipts.json` 及独立构建/配置助手。服务器私有记录分别在 `/opt/chatapp/build-evidence/attempt1/`、`attempt2/` 及对应 `build-output-attempt*.log`；生产依赖准备在 `/opt/chatapp/deploy-evidence/attempt1/preparation.json`。通过的 ARM 彩排回执在第二次构建目录的 `.test-runs/production/a40478d2-417d-46ef-a69f-903e17fe8b5c/receipt.json`。生产配置及其中历史副本保持私有，不作为公开 CI artifact。

本机 ARM 回传目录为 `.test-runs/launch-2026-10-15/arm64-attempt2/`，最终只接受 `download-receipt.json` 的 `downloaded-and-verified`。后台下载脚本与日志在本轮私有目录，另有 `next-state.json` 保存接续进程信息；未完成分块或首次部分 tar 不构成成功归档。

接续顺序：本人新建生产 R2 桶/独立凭据并运行修正版私有配置助手，同时按已有授权提交/推送并取得当前源码远端 CI→ 生产配置检查、迁移及真实 journal/备份初始化 → 离源私有材料另存及管理员隐藏密码输入 → API/worker 与 HTTPS 受限业务冒烟。提交后需按新的 SHA 重新绑定/生成对应原生发布元数据和镜像，并保留本次 dirty 基线候选；源码 hash 相同不代表旧 SHA 标签自动成为新提交。随后继续云端完整 M7 和 D-210 最终独立恢复；封闭部署成功不等于正式开放。
