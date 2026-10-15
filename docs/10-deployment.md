# 10 部署与上线（M7 彩排、M8 封闭部署与上线）

> 2026-10-16 已进入实际封闭运行；当前版本、验证与未完成项见 [35](35-closed-deployment-2026-10-16.md)。下文历史准备状态保留。

> 正式开放上线是**最后一步**。按 [12 的 D-211](12-decisions.md)，先补齐最小可部署条件，提前封闭部署到现有云服务器，在云端完成 M7 的压测、ARM 容量、备份与运维验收并补齐其他功能；按 D-210 用现有本机完成独立恢复，全部发布门槛通过后才对真实用户开放。
> 服务器的地址、SSH 方式、多站点约定和操作注意事项，都写在用户私有的全局配置 `~/.claude/CLAUDE.md` 中，部署时以那里为准。本仓库是公开的，只写与 ChatApp 有关的部分（D-054）。
> 2026-10-13 上线前工程与本地证据见 [30](30-prelaunch-implementation-2026-10-13.md)，当前真实工具、私有配置/归档/恢复命令见 [31](31-prelaunch-operations-2026-10-13.md)。完整云端运维、容量和最终独立恢复仍待验收。
> 2026-10-15 实际部署执行见 [33](33-closed-launch-2026-10-15.md)，开工前交接为 [32](32-launch-handoff-2026-10-15.md)：DNS 已与目标核对，同源码原生 ARM 镜像/37 阶段隔离彩排/七镜像扫描通过，四个独立生产依赖健康；API/worker 尚未启动。本人已同意证书条款及 Git 提交/推送，HTTPS 证书/封闭路径/续期 dry-run 通过；独立生产 R2 准备与私有配置见 [34](34-r2-production-setup.md)，当前源码 CI、真实 journal/备份及独立恢复仍待完成。测试邮件和隔离彩排不代替生产应用流程或正式开放验收。

## 1. 目标环境（摘要）

- **服务器**：ARM64 云服务器，2 核、12 GB 内存。PROGRESS 中另一个会话已记录原站点清空与系统更新；部署前仍须只读核对实际服务、版本和余量。
- **已装软件**：Docker 和 Compose；宿主机上的 Nginx 是所有站点共用的入口；certbot 负责证书的申请和自动续期。
- **对外端口**：只开放 22、80、443。
- **站点约定**：
  - 本应用放在 `/opt/chatapp`，使用独立的 compose 项目、数据卷、密钥文件和备份；
  - 新建一个 Nginx 站点文件，**不改动**其他站点的任何文件，**不设** `default_server`；
  - 容器端口只绑定到 `127.0.0.1`。
- **内存**：只要不超过服务器总内存即可（D-033）。ChatApp 合计上限约 6 GB（见第 3 节），其余留给已有的站点和系统。

## 2. 上线前需要用户完成的事

1. **域名与 DNS，这是硬性前提**（D-049；2026-10-15 已购买）。
   - 本项目采用 `chatapp.software`，主站 origin 为 `https://chatapp.software`，DNS 由 Name.com 管理，无需重复购买域名。
   - 2026-10-15 只读查询已返回 A 记录，未返回 AAAA；部署前须将解析结果与私有配置中的目标服务器公网 IP 核对，再配置 Nginx 和证书。服务器地址仍不写入公开仓库（D-054）。
   - `*.sslip.io` 这类免费主机名只能用于上线前自测，不能开放注册，因为：
     - 它发不了邮件，而注册必须验证邮箱；
     - 它不在公共后缀列表（Public Suffix List）里，Cookie 隔离会变弱。
2. **Resend 发信配置**（2026-10-15 本人已确认收到测试邮件）。
   - 约定发件地址为 `ChatApp <noreply@chatapp.software>`。本次 Resend 截图的必需记录为 DKIM TXT `resend._domainkey`、SPF CNAME `rsend` 和 `send`；DMARC TXT `_dmarc` 另行推荐添加。类型、完整值与优先级始终按实际控制台生成结果，不固定套用 TXT/MX 示例或“三条记录”数量。
   - SMTP 为 `smtp.resend.com`、用户名 `resend`，密码为本人保管的发送权限 API Key；本次接入参数约定使用 465 隐式 TLS。生产字段仍需按 [31](31-prelaunch-operations-2026-10-13.md)填入私有配置并验证应用完整链路。
   - 本人收信确认不能替代账号后台/邮件头独立复核、ChatApp 注册/找回密码与 QQ/163 双邮箱送达验收（V-11），不在文档保存 API Key。
3. **准备所选站点 AI 服务的 key**（当前为 `SOCLAAS_API_KEY`，D-182；公开部署前确认校方服务的账户/使用范围与实际模型可用性）。由用户**自己**写进服务器上的密钥文件：我提供命令，用户在自己的终端里执行，key 不经过聊天。
4. **同意 Let's Encrypt 条款**：每个主机名申请证书前，都要用户明确同意。
5. **异地备份**：
   - 开通Cloudflare R2或Backblaze B2账号，用于自动备份；M7还需要独立删除journal的持续读写目标。自动同步用户设备可作备份替代，但不能以偶尔拷贝代替在线journal及24小时RPO；替代服务必须通过V-19。
   - restic 仓库的密码由用户保存在自己的密码管理器里，不能只放在服务器上，否则服务器被回收时，备份也就无法解密。
6. **准备测试邮箱**：M8 冒烟测试时，用 QQ 邮箱和 163 邮箱各收一次验证邮件（V-11）。

## 3. 生产拓扑（`infra/compose.prod.yml`，随机独立项目名）

| 服务 | 镜像 | 端口 | 内存上限 | 数据卷 |
|---|---|---|---|---|
| api | 候选 `SERVER_IMAGE` 不可变ID，Bun1.4.2/distroless | 可配置 `127.0.0.1` 回环端口 | 1 GiB | 只读 embedding IPC/keyring |
| worker | 同一个server镜像，`bun src/worker.ts` | 无 | 1536 MiB，向量子进程≤1 GiB；与media共计2 GiB | 模型缓存、仅Unix socket的IPC卷 |
| media | 候选 `MEDIA_IMAGE`，sharp/签名FFmpeg9.0.2/distroless | 无；network_mode=none | 512 MiB，swap总额同限；tmpfs合计256 MiB计入 | 仅Unix socket IPC卷；无业务文件卷 |
| postgres | 候选 `POSTGRES_IMAGE`，官方PG18.6-Alpine + pgvector0.8.6，UID70 | 仅内部网络 | 2 GiB（`shared_buffers=512MB`） | 独立项目PG18数据卷 |
| valkey | `valkey/valkey:9.1-alpine` | 仅内部网络 | 512 MiB（`maxmemory 384mb`，`noeviction`，开启 AOF） | `chatapp_valkey` |
| garage | `dxflrs/garage:v2.4.1` | 仅内部网络 | 512 MiB | `chatapp_garage` |

Valkey/Garage 同样由原生归档的不可变ID绑定；卷名以生成的独立项目为前缀。`tools` 是单独运维镜像/配置与1GiB临时预算，持有owner、备份和Garage管理权限；`initialize` 仅以受限root能力创建/设置本项目新卷的根目录。两个profile服务不常驻，需与6GiB应用预算另留运维余量。生产Alpine PG只用于全新库/卷，本地已有开发/测试Debian PG未切换；既有PG数据禁止直接换操作系统/版本镜像。

- **合计**：6 GiB容器内存上限；宿主机实际可用字节和其他站点余量以M7实测为准。
- media落实03的非root、只读rootfs、cap_drop、no-new-privileges、seccomp、pid限制；其配置不能继承app.env、数据库网络或S3密钥。worker通过有限IPC传文件字节，禁止挂Docker socket。部署前用docker inspect及AT-30确认实际cgroup/挂载/环境，不仅检查YAML。
- **前端**：静态文件放在宿主机的 `/opt/chatapp/web/<sha>/`，`/opt/chatapp/web/current` 是指向当前版本的软链接，由 Nginx 直接提供。切换版本就是原子地替换这个软链接。
- **重启策略**：所有容器都设为 `restart: unless-stopped`，都配置健康检查。
- **日志**：使用 json-file 驱动，限制 `max-size: 10m`、`max-file: 5`。
- **密钥文件**：
  - 六个配置分组与runtime文件在 `/opt/chatapp/private`，目录700、文件600；详见31。配置分组由root管理，供容器读取的runtime keyring/restic密码/Garage TOML须UID10001。
  - 用 `production.js prepare` 生成独立身份/密钥，不重复覆盖已有配置，不打印值。
  - M5a 起，`app.env` 里还有 `AI_KEY_ENCRYPTION_KEY`。
  - M1a的AUTH_TOKEN_ENCRYPTION_KEY、M7的DELETION_JOURNAL加密/访问凭据单独版本管理；media绝不读取。journal恢复密钥与备份密码保存在原主机之外。
- **数据库账号**：
  - `chatapp_owner`：独立实例拥有者，只给迁移/备份/恢复等运维入口；
  - `chatapp_app`：应用运行时使用，只有表的读写权限，不是超级用户。

## 4. 镜像与发布流程

- **现有工作流**：`.github/workflows/images.yml` 原生x64/ARM构建候选、验证三个应用镜像及完整生产启动/TLS聊天/原生恢复，独立扫描全部7个镜像；当前只编写，未推送运行。ONNX实推理和实际ARM混合容量另有门槛，不能由二进制启动代替。
- **现有打包入口**：`production.ts package` 产出source/web/images及独立Bun工具；双架构归档按31核验和绑定。本轮本机x64候选已生成，不能给ARM服务器直接使用。Git SHA、dirty源码hash、原生image ID和全部文件hash分别记录。
- GHCR推送、GitHub Release发布及镜像标签仍须在提交/发布授权和对应架构/安全核验之后执行，当前工作流没有自动公开镜像。公开分发前同时满足源代码/许可证交付要求。
- **迁移**：新部署用 `tools migrate` 的独立owner；不携带drizzle-kit/esbuild。恢复空库走31的导入流程，不能先运行迁移/初始化。

## 5. Nginx 站点（`infra/nginx/chatapp.conf`，部署到 `/etc/nginx/sites-available/chatapp`）

**同一份配置文件**也用于本地的网关测试（M2b，已实现，D-147）和彩排（M7）。本地的 Nginx 容器（`infra/compose.edge.yml`，`bun run edge:up`）只替换证书路径和上游地址（`infra/nginx/env/` 里的两个小文件，D-045）。M2b 起 `infra/nginx/` 里有：`chatapp.conf`（站点）、`security-headers.conf`、`transport-security.conf`、`proxy-api.conf`、`empty.conf`（换掉镜像自带的 `default.conf`）和 `env/local-*.conf`。

D-212 增加统一 `access.conf`：生产生成默认deny-all的允许清单；本地edge单独挂名为`local-access.conf`的本地策略。域名、证书、代理及允许网段由私有准备工具生成，不能将local允许全部策略拷贝到云端。容器补丁版Nginx用于恢复/核验；宿主Nginx的支持版本、系统依赖和配置必须在部署时另验（D-169）。

要点：
- **监听与证书**：`server_name chat.<域名>`；证书由 certbot 管理；`listen 443 ssl`，开启 http2。可选开启 HTTP/3，但需要在云厂商的安全列表和主机防火墙两处都放行 UDP 443。
- **静态文件**：`root /opt/chatapp/web/current`。SPA 回退规则是 `try_files $uri /index.html`：
  - `/assets/*` 从独立追加的共享哈希目录提供，缓存 1 年（immutable）；至少保留 7 天且至少最近 3 版，不仅切换 current 后把旧资源藏起来。资源缺失返回真实 404，不回退 index.html；
  - `index.html` 设置 `no-cache`；
  - M6：Service Worker `/sw.js` 走普通文件规则，`no-cache`（新版本在浏览器下次检查时就能拿到）；应用清单 `/manifest.webmanifest` 有独立的精确 location，类型是 `application/manifest+json`（Nginx 自带的类型表里没有它，否则会是 `application/octet-stream`），同样 `no-cache`；网关套件逐项核对（D-207）；
  - web root 里没有 Vite 自己的 `.vite/`（`scripts/edge.ts` 组装时排除；部署脚本同样）。
- **安全响应头**（SEC-06、SEC-22）：
  - 静态文件的 CSP 等头写在 `infra/nginx/security-headers.conf` 片段里，在每个需要的 location 中 `include`。这样可以避开 `add_header` 在子 location 中不继承的问题。取值以 `apps/web/tools/csp.ts` 为准（M1b 的 E2E 就在这份策略下运行，D-116）；`scripts/edge-config.test.ts`（M2b，`bun run check` 里已包含）核对 Nginx 片段与它逐字一致，E2E 夹具则核对每个文档响应的 `Content-Security-Policy` 头逐字等于它（D-148）。
  - HSTS 写独立 transport-security.conf 片段，add_header 加 always，在每个 HTTPS location（含 assets、API、attachments、WS、错误页）显式 include；不能仅靠 server 级继承。**server 块里也 include 一次**（M2b 的网关套件发现：请求行解析不了——例如 `GET /%zz`——时 Nginx 在选定 location 之前就回 400，没有 location 可取头，只剩 server 级）；自己写了 `add_header` 的 location 不继承 server 级的，所以不会出现两份（`edge-config.test.ts` 核对 server 块也带它，网关套件逐项核对每种响应恰好一份）。
  - 静态 CSP 等由 security-headers.conf 设置；API/附件的 CSP 等由应用负责，HSTS 仍只由 Nginx 设置，避免重复。
- **`location /api/`**：`proxy_pass http://127.0.0.1:3100`，并设置：
  - `proxy_set_header X-Real-IP $remote_addr` 和 `X-Forwarded-For`，应用只信任本机代理写入的这些头（SEC-28）；
  - 默认`client_max_body_size 128k`，只在精确匹配单文件`PUT /api/uploads/:uuid/content`的独立location放宽到`100m`；monitoring独立`256k`，其他相似路径不能继承大限额；
  - 上传location才设`proxy_request_buffering off`；普通JSON保持小额缓冲，应用仍在解析前限流计数；
  - `proxy_read_timeout 120s`。
- **`location /ws`**：设置 `proxy_http_version 1.1`、`Upgrade` 和 `Connection` 两个头，`proxy_read_timeout 3600s`。
- **`location /api/attachments/`**：关闭代理缓冲（`proxy_buffering off`）。这样大文件下载和视频拖动播放直接流式转发，不经过 Nginx 的临时文件。
- **健康检查**：`/api/healthz`、`/api/readyz` 走 `/api/` 转发，不会被 SPA 回退拦走，外部监控能真实反映后端状态。
- **限流**：给 `/api/auth/` 和 `/api/invites/check` 配置 `limit_req_zone`，作为应用层限流之外的第二道防线。
- **请求预算**：应用总读取/空闲超时按05执行，Nginx补client_body_timeout（JSON/envelope 5s、上传15s）及header限额；网关的空闲超时不能冒充总请求时限。拒绝请求压缩、异常Content-Length/Transfer-Encoding，返回413/415/408时仍使用安全日志/响应头。
- **访问日志（D-077）**：独立chatapp-access.log按天轮转。每类路由一个专用log_format（`chatapp_static`、`asset`、`api`、`auth`、`upload`、`attachment`、`monitoring`、`ws`、`redirect`；不用 `map`：服务器上的 1.28 的正则 `map` 有未修复的 CVE，升到 1.30 之前站点文件必须在 1.28 上也安全，D-169），字段只有`$request_id`、method、status、耗时、remote_addr、路由类别常量和`$upstream_http_x_request_id`（应用自己的请求 id，网关自己回的响应为空，用来把一行日志和应用日志对上），不输出任何原始路径、query、Referer、User-Agent、Cookie或Location。禁止默认combined、`$request`、`$request_uri`以及以`$uri`作为日志回退。`scripts/edge-config.test.ts` 检查格式里没有这些变量；edge 套件（`apps/web/edge/3-abuse.spec.ts`）发出带哨兵的请求，在网关日志和 API 日志里都找不到哨兵，请求 id 两边都能对上。
- **错误输出**：Nginx原文error_log可能附带request行，本站server及敏感location将原文写`/dev/null`，以状态/耗时、上游健康及脱敏应用requestId定位；启动配置检查单独记录不含用户请求的诊断。必须在edge复现400/413、body超时、502/504、未知及编码路由，确认没有逃到上级日志；不改其他站点配置。认证页面统一Referrer-Policy:no-referrer，无第三方分析资源。
- **不设** `default_server`，不改其他站点的文件。

## 6. 部署步骤

### 首次封闭部署（D-211）

准入要求：最小可部署条件齐备，包括目标架构可启动的服务端/媒体镜像、生产 Compose、候选源码/镜像绑定、启动/迁移/健康/回滚及基础安全检查。生产 journal、密钥与最小权限、媒体隔离、独立项目/库/桶/卷必须生效，不以开发模式绕过生产校验。网关或网络层只允许本人及验收人员访问页面、API、WebSocket 和附件入口；证书验证路径仅用于签发。使用受控验收账号和数据，不发放真实用户邀请。完整压测、备份运维、管理界面等可在部署后继续交付和验收；正式开放仍要求全部 M7 和发布门槛通过。

部署前先只读核对既有站点、端口、CPU/内存/磁盘余量和当前配置，设置本项目资源限额；不变更其他站点。共享主机的压测逐级加压并观察其他站点状态；故障脚本只操作有所有权核验的独立测试实例，整机失效另安排维护窗口。

1. 获取已核验的原生ARM候选及对应SHA/hash，按31建立 `/opt/chatapp` 的source/release/tools目录和私有配置，所选外部服务字段由本人在终端填写。
2. `docker load` 装载完整归档，用`production.js bind`绑定所有不可变镜像ID，完成私有文件600/runtime UID10001/独立端口子网与默认受限入口核验。
3. 以`initialize`创建本项目新卷目录，`up --wait postgres valkey garage media`；运维`storage:init`生成独立Garage layout/key/bucket，600回执经`storage-install`安装到普通应用配置。
4. Postgres初始化建立独立owner；`tools migrate`前向迁移并创建/授予最小应用角色，普通API/worker不读取owner配置。
5. 仅在空库/空远端前缀执行`tools journal:init`，初始化restic仓库；运维容器的应用CLI执行`db:bootstrap`（机器人、保留名、默认配置），不使用演示seed或恢复数据。
6. 同一运维容器CLI交互执行`admin:create`，本人在自己的终端隐藏输入密码。再次`configtest`，核对源外恢复材料全集。
7. `up --wait api worker`，部署版本化前端/共享哈希assets；缺journal或隔离/权限证明不进入可发布模式。精确参数与操作边界以31为准。
8. 部署 Nginx 站点，先只配 HTTP；用户同意条款后执行 certbot 申请证书，然后执行 `nginx -t` 并 reload。
9. 冒烟测试：
   - `/api/readyz` 返回 200；数据库不可用的503/监控验证另在已核验的独立compose.test中注入，不能直接停云端生产postgres作普通测试；
   - 用浏览器完成一遍：登录 → 生成邀请码 → 第二个账号注册 → 收到验证邮件（QQ 邮箱和 163 邮箱各测一次，确认没有进垃圾箱）→ 双方聊天（WebSocket 正常）→ 上传图片 → Agent 做一次总结。
10. 建立锁版本压测入口，先低负载冒烟再逐级升压；按 08 第 9 节在实际 ARM 服务器完成完整混合负载与容量验收，记录本项目及其他站点资源状态，不把轻量测试当作完整门槛通过。
11. 配置每12小时备份、删除journal连续追加/完整性检查及监控，核对主机之外另存的恢复材料全集和版本；验收数据集满足 08 第 9 节要求，与正式业务数据分开管理。
12. 按第 7 节执行独立恢复：完成异地备份后让整台云端源主机不可访问，在本机新建隔离恢复环境，仅凭异地备份/journal/另存恢复材料恢复，核验全量数据、删除不复活、权限与连续 RPO/RTO。提前核对同机其他站点影响并安排整机维护窗口，不能只停 ChatApp 容器代替源主机失效。
13. 在封闭阶段继续补齐管理/举报/隐私、监控、安全、视觉与本人试用，收齐对应候选版本的 E2E、远端 CI/ARM、压测及恢复证据。全部 M7 和其他发布门槛通过后关闭 M7；按第 10 节逐项检查，完成正式开放确认，才允许真实用户注册/邀请并开始 14 天内测观察。恢复失败或证据不足时继续封闭，恢复数据保持隔离。

### 日常更新
1. **先备份。**
2. 拉取新镜像。
3. 执行迁移。迁移必须同时兼容新旧两版代码。
4. `up -d api worker media`：重启期间客户端自动重连补齐；media IPC协议版本需与worker兼容，不兼容时先停止接新媒体任务再一起更新。
5. 发布新哈希静态资源后再切换 index.html 软链接；保留旧资源和上一版 API/WS 契约。应用 shell 带 buildId，超过支持窗口时提示刷新并保留草稿，不在编辑/审批中强制刷新。
6. 冒烟测试。

### 回滚
- 核验迁移兼容性，按上一份候选清单的不可变image ID/源码hash绑定配置及前端目录，重新启动并验证；dirty候选不能只用基线Git SHA区分。原生本地兼容候选回退/升回测试与失败记录见30。
- 数据库**不做**降级迁移：因为迁移本身兼容新旧两版代码，旧版可以直接在新库上运行。
- 迁移出现严重问题时，用最近的备份恢复。

## 7. 一致备份与恢复隔离（D-071）

- **目标**：RPO ≤24 小时、RTO ≤4 小时；每12小时备份一次。当前未安装模板是系统时区00/12点，部署时核对实际时区/高峰并固定UTC计划；不把尚未安装的模板当作03:40/15:40等已运行计划。最新成功异地备份的数据库快照年龄 >20 小时告警，>24 小时记录目标违约；“脚本跑过”不等于成功备份。
- **首次演练安排（D-210）**：云端封闭部署后、正式开放前，以云服务器为源主机、现有本机为恢复设备。整台源主机不可访问后，在本机新建独立项目/库/桶/卷；不使用开发库、已有开发卷、本机缓存或源服务器补足恢复输入，不覆盖开发数据。演练绑定发布候选、恢复材料版本及目标全量数据集。源主机承载其他站点，须提前安排整机维护窗口并核对影响。
- **RTO 的终点**：按约定服务入口验证可用及权限再确认完成计时，含环境准备、下载、验证和必要的服务入口切换；本机仅在隔离环境读回数据时，只记数据恢复耗时，完整服务 RTO 仍待验证。公网服务接管和真实 ARM 资源门槛各自取证，不能由本机恢复外推。
- **一致性流程**：
  1. 在 Postgres 创建带租约/epoch 的 backup_run，建立物理删除屏障；等待已在途的对象删除结束。所有对象删除器检查同一屏障，新的删除意图照常入库，只延迟物理删除。对象 key 不可覆盖。
  2. 开启 REPEATABLE READ 事务导出 snapshot；同一 snapshot 下导出所有活对象 key、size、sha256 和数据库版本/迁移头，再以 pg_dump --snapshot 导出数据库。导出事务在数据库 dump 完成前保持存活。
  3. 按清单复制主文件、衍生图及数据库实际引用的其他对象；全量校验大小/hash。不能用“同步当前 bucket”代替快照清单；DB 快照后的新对象不必属于这份备份。
  4. manifest含应用SHA、schema版本、快照时间、对象数/hash、密钥版本及快照内已应用的删除journal水位/hash；同一snapshot捕获，不能记录“已异地接受但尚未应用”的更高水位。密钥文件加密副本随restic上传，校验后才succeeded。
  5. 本地对象副本完整后可释放删除屏障；复制失败/屏障丢租约则这次备份作废，不标成功，释放屏障并重试。屏障最长 2 小时，超过中止备份并告警，不能无限拖延用户的 24 小时删除期限。
- **保留**：本机和异地均最多 7 个日点/4 个周点，额外强制删除超过 28 天的快照；清理失败告警。失败备份不覆盖最后有效备份。异地目标为 R2/B2 或自动同步的用户设备；手工“偶尔下载”不满足 24 小时目标。
- **不备份 Valkey**：durable work/state/预算在 Postgres；恢复重建队列。在线状态重新计算、限流历史保守收紧，不能假装完整恢复这些瞬态值。

**恢复顺序**：隔离临时库/桶验证 → RESTORE_MODE=isolated（模型、邮件、push、提醒/定时消息禁发，恢复重放删除为唯一允许的删除维护入口）→ 失效sessions、verifications、auth_challenges、push_subscriptions、全部旧delegations，生成备份外新restore_epoch → 从独立journal重放至可信head并清理过期副本 → 校验数据/对象/权限 → 对账unknown调用及歧义外发任务 → 重新授权必要任务 → 解锁。不能复用旧验证JWT或让旧来源设备委托复活。

恢复权限清单必须覆盖快照后可能发生的凭证、成员和管理角色撤销；无法证实仍有效的权限保持暂停并重新确认，不因为旧库里存在关系就自动放行。旧备份中的密码/Passkey和BYOK key不得未经复核重新启用；先开放受限账号恢复流程完成本人验证/重设，再恢复相应能力。此类证据和用户恢复等待计入可用性限制，不能把API启动时间冒充全部RTO；V-19须记录实际可恢复范围。

恢复到旧快照可能把已经发送的任务恢复成 pending，数据库无法证明外部是否已收到；默认取消有歧义的过期外发任务，必须由负责人核实再恢复。普通用户消息补同步可以重建，外发不能一概自动重放。

恢复可能带回快照后删除的内容；必须完成以下独立journal校验才能开放。缺少完整证据时保留隔离，负责人不能用无证据的“人工确认”豁免；记录实际RTO违约，继续修复证据或放弃该恢复数据集。

### 7.1 独立删除journal（D-084、V-19）

**目标与存放**：独立异地对象存储私有桶/前缀，不在本机Garage或同卷备份中；不经CDN缓存。备份可以RPO≤24h，但已经确认成功的删除必须全部重放。优先验证R2，其他目标必须同样证明条件写、读后一致、完整列举和故障恢复；[R2一致性说明](https://developers.cloudflare.com/r2/reference/consistency/)提供选型依据，不能代替实际SDK与凭据的V-19实验。

**M7 实现状态（2026-10-12）**：专属 R2 测试桶的真实准入、加密链、旧凭据撤销及小样本 restic 异地恢复已执行。本人分别确认公开入口关闭、加密恢复材料另存主机之外、旧 journal 测试凭据已撤销；S3 实测确认旧凭据读写被拒绝。消息/记忆/私有会话、附件、密码确认注销与固定规则到期清理，以及加密 checkpoint、远端全部快照锚点核验和恢复续跑已有实现与分项证据。最新小样本验证真实裁剪后恢复零复活，清单绑定实验源码指纹，数据仍隔离；保留年龄用模拟时间。开发 journal 仍禁用，测试仅写脚本拥有的随机前缀。完整覆盖审查、生产入口/密钥全集/持续调度与保留告警、权限再确认，以及整台源主机失效的目标数据集恢复仍未交付或验收。本人已按 D-210 选择云端源主机与现有本机恢复，最终演练安排在 M8 封闭部署后、正式开放前，尚未执行，**V-19/AT-33 未通过**。小样本隔离重放时间不是开放服务的 RTO。具体结果与失败尝试见 [28](28-m7-implementation-2026-10-12.md)、[29](29-m7-acceptance-2026-10-12.md)。密钥值不进入文档，S3 凭据、journal 加密密钥及 restic 密码分别管理。

**记录协议**：加密记录含journal格式/规则版本、writer_epoch、seq、previous_hash、operation_id、action、目标id/冻结版本或到期cutoff、接受时间；无正文、邮箱、认证凭据。外部head含epoch/seq/hash，使用条件更新（ETag/CAS）；单dispatcher串行追加，immutable记录先写并读回校验，再CAS推进head，成功后才允许本地应用删除。CAS失败重新读取，不覆盖其他writer；网络结果未知按operation_id/hash查明，不能生成新逻辑操作盲重试。只有head可达链为已接受意图，孤立候选对象不生效。

在线applied水位只覆盖连续无缺口的已应用记录；seq=12完成但11未完成时仍停在10。备份不得记录12跳过11；恢复对10之后所有可信记录幂等重放。字段/密钥轮换和规则升级须保留28天恢复窗口的解读能力。

**用户删除流程**：受锁授权→本地prepared，冻结目标且禁止并发编辑/重新绑定→事务外追加journal→本地journaled→锁内幂等清空/匿名化及工作意图/applied同事务。授权冻结只允许这一动作与目标，后续会话到期不撤回已接受删除；正常读在applied前仍可能返回原内容。5秒超时返回202/operationId，UI轮询状态；prepared没有异地确认不宣称成功。journal接受但本地崩溃时，即使旧备份没有该operation行，恢复仍按可信意图执行。对象物理删除截止从本地首次逻辑删除起算；journal延迟本身另设告警，不隐瞒待完成时间。

**覆盖范围**：撤回/管理删除、私有Agent会话/记忆删除、账号注销、附件解绑/删除；到期清理由带规则版本和截止时间的批意图或恢复时当前有效期限保证。只隐藏个人视图不等同于全局删除。原始备份内容保持加密且不开放管理员浏览，重放调用同一删除domain并覆盖04全部副本。

**writer与恢复**：暂停原writer、撤销旧写入凭据并确认生效，在外部head用CAS登记新writer_epoch后才启用新writer；旧writer后续head提交必须失败。恢复读取manifest的已应用水位到独立最新head，逐项验证链和格式/解密/hash，完整重放包括“异地确认、本地未提交”的意图。恢复过程不重新外发通知或模型调用。读取新head再次检查无缺口后方可开放；恢复后epoch变化还会拒绝旧认证/委托。

**保留和失败**：最少35天，并保留所有≤28天可恢复快照所需后缀；裁剪前验证每份有效备份的已应用水位，生成签名/加密checkpoint锚点，禁止仅凭对象年龄删链。超龄备份如仍存在，延长对应journal并告警；不默认允许恢复窗口外的离线旧副本。journal未提交积压>60秒、CAS持续失败、密钥缺失/断链立即告警；不可用只影响需要确认的删除，不能伪造完成。配置缺失阻断发布；恢复证据不足维持隔离。

**V-19验收**：在独立测试环境覆盖prepared/写对象/head更新/在线清空各点崩溃、重复写、两个writer、凭据轮换、备份中删除、注销/记忆/附件清理及保留截断；故意让源数据库和主机完全不可访问，只靠异地备份+journal+外部保存密钥恢复，确认成功的删除零复活、歧义外发为零。RTO从宣布故障到验证后开放计时，等待日志也算入4小时，不能暂停计时。

**演练**：首次独立全量恢复按 D-210 在 M8 封闭部署后、正式开放前用本机执行，完成后关闭 M7 恢复验收项；之后每月恢复到隔离库/桶。记录备份年龄、实际 RPO/RTO、全部对象校验、关键行数、含已删除数据的副本清理、账号失效与外发封锁。测量按 08 的目标数据集执行；缺密钥或缺一个引用对象即判失败。密码及 AI_KEY_ENCRYPTION_KEY 在服务器之外妥善保管。

## 8. 监控与运维

- **健康与重启**：restart: unless-stopped 只在容器退出后生效，unhealthy 本身不触发重启。独立宿主机 watchdog 每 30 秒看进程存活/事件循环心跳，连续 3 次确认本服务卡死才单独重启，15 分钟最多 3 次，然后告警人工处理；依赖共同故障仅告警，不重启全部服务。外部监控每分钟探测 readyz，并验证告警真的送达。
- **错误追踪**：
  - 前端和后端都接入 Sentry（免费额度即可）；
  - 前端的上报经自己的域名 `/api/monitoring` 转发（D-046）。
- **磁盘与准入**：80%告警、85%拒绝新上传、90%暂停媒体/向量批任务，低于75%恢复；保留登录、聊天读取和删除入口（删除仍需异地确认）。上线填写对象/数据库/备份/staging实际字节预算，不把个人5GiB上限当总容量。
- **Valkey 内存**：用到 `maxmemory` 的 80% 时告警。
- **工作积压**：work_items 最老待派发 >60 秒、dead/uncertain 新增、对象删除接近 24 小时、注册 reserved 无法对账、预算 unknown 均告警；连续队列故障时拒绝新的收费任务和上传，已有持久工作保留重试。
- **证书**：certbot 自动续期；每月检查一次续期日志。
- **AI 预算**：月度预算用到 80% 时通知站点管理员（应用内置）。
- **删除journal**：独立head可读性、待确认最老年龄、链完整性、checkpoint/备份水位覆盖每日检查；202待完成不计为删除成功。外部日志及备份故障要分别告警。

## 9. M7：本地生产彩排

1. **启动整套服务**：用 CI 产出的 amd64 镜像（或者在本地构建），通过 `compose.prod.yml` 在本地启动全部服务。用各服务的 `cpus` 设置，让整套服务合计不超过 2 核，近似服务器的配置。
2. **前置网关**：前面放一个 Nginx 容器（`infra/compose.edge.yml`），加载与生产相同的 `infra/nginx/chatapp.conf`，把 `https://chat.localhost:8443` 当作生产环境来访问。
   - 证书由本地脚本用 openssl 生成的本地 CA 签发；
   - 是否把这个 CA 导入系统信任，由用户决定；
   - 自动化测试里忽略证书错误。
3. **测试与演练**：对这个地址运行完整的 E2E 测试和压力测试，并完成一次备份和恢复演练。
4. **逐项验证**：
   - HTTPS 下，WebSocket 的地址会自动变成 `wss://`；
   - 安全响应头齐全，而且没有重复；
   - Cookie 带有 `Secure` 和 `__Host-` 前缀；
   - 生产配置缺少密钥时，服务拒绝启动；
   - 测试专用接口不存在；
   - `/api/readyz` 能反映数据库故障。
5. **arm64 冒烟**：由 CI 的 `image` 工作流完成（第 4 节）。

## 10. 上线检查清单（M8）

以下清单是正式开放及后续扩大邀请的门槛；封闭部署成功不能自动勾选恢复验收或完整 M7。

- [ ] D-210 封闭部署与独立恢复完成：云端源主机不可访问时在本机干净环境恢复；未借用开发数据或源服务器；全量数据、权限、服务可用性及连续 RPO/RTO 有实际证据，完整 M7 已关闭。
- [ ] 域名解析生效；证书有效；HTTP 自动跳转到 HTTPS；HSTS 已开启。
- [ ] `/api/readyz` 返回 200；首页、登录页、API、WebSocket 都正常。
- [ ] 邮件能送达：验证邮件、找回密码邮件都能收到；QQ 邮箱和 163 邮箱都没有进垃圾箱（V-11）。
- [ ] db:bootstrap 幂等通过、机器人不能登录、保留名有效；第一个站点管理员已创建；演示数据**没有**进入生产库。
- [ ] 07 的安全自查清单全部通过；依赖和镜像扫描没有高危问题；CI 的 arm64 冒烟通过。
- [ ] 隐私说明已发布，内容与实际行为一致（01 第 4.11 节）；文档中写明了 Chrome 推送在中国大陆的限制。
- [ ] 每12小时备份已成功异地落盘；V-19/AT-33从完全不可用的源主机恢复通过，独立journal持续可用；restic、认证投递、BYOK及journal解密材料在服务器之外妥善保存。
- [ ] media实际隔离与总内存限制通过AT-30；网关日志哨兵和分路由请求预算通过AT-26/27。
- [ ] 按06第8.1节填写首批AI人数、任务量、实验预算预留及低/基准/高成本场景；没有用20美元预算承诺1000人日常AI容量。
- [ ] 服务器上的轻量 k6 测试达标。
- [ ] 可用性监控、Sentry、磁盘告警、Valkey 内存告警都已接入。
- [ ] 运维手册（部署、回滚、恢复、更换密钥、应急处理）已写进本文件的附录。
- [ ] 按 11 的 14 天内测门槛记录真实任务成功率、可靠性、成本和用户反馈，通过后再扩大发放。
