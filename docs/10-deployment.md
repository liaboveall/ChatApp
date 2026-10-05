# 10 部署与上线（M7 彩排、M8 上线）

> 上线是**最后一步**。M7 先在本地用生产配置完整彩排一遍，M8 再部署到服务器。
> 服务器的地址、SSH 方式、多站点约定和操作注意事项，都写在用户私有的全局配置 `~/.claude/CLAUDE.md` 中，部署时以那里为准。本仓库是公开的，只写与 ChatApp 有关的部分（D-054）。

## 1. 目标环境（摘要）

- **服务器**：ARM64 云服务器，2 核、12 GB 内存，上面已经运行着其他站点。
- **已装软件**：Docker 和 Compose；宿主机上的 Nginx 是所有站点共用的入口；certbot 负责证书的申请和自动续期。
- **对外端口**：只开放 22、80、443。
- **站点约定**：
  - 本应用放在 `/opt/chatapp`，使用独立的 compose 项目、数据卷、密钥文件和备份；
  - 新建一个 Nginx 站点文件，**不改动**其他站点的任何文件，**不设** `default_server`；
  - 容器端口只绑定到 `127.0.0.1`。
- **内存**：只要不超过服务器总内存即可（D-033）。ChatApp 合计上限约 6 GB（见第 3 节），其余留给已有的站点和系统。

## 2. 上线前需要用户完成的事

1. **购买域名，这是硬性前提**（D-049）。
   - 在 DNS 中把 A 记录指向服务器，建议用一个子域名，比如 `chat.<你的域名>`。
   - `*.sslip.io` 这类免费主机名只能用于上线前自测，不能开放注册，因为：
     - 它发不了邮件，而注册必须验证邮箱；
     - 它不在公共后缀列表（Public Suffix List）里，Cookie 隔离会变弱。
2. **开通 Resend 账号**：完成域名验证（SPF、DKIM、DMARC 三条 DNS 记录），拿到 SMTP 凭据。
3. **准备站点用的 DeepSeek API key**（v2 专用的新 key）。由用户**自己**写进服务器上的密钥文件：我提供命令，用户在自己的终端里执行，key 不经过聊天。
4. **同意 Let's Encrypt 条款**：每个主机名申请证书前，都要用户明确同意。
5. **异地备份**：
   - 开通Cloudflare R2或Backblaze B2账号，用于自动备份；M7还需要独立删除journal的持续读写目标。自动同步用户设备可作备份替代，但不能以偶尔拷贝代替在线journal及24小时RPO；替代服务必须通过V-19。
   - restic 仓库的密码由用户保存在自己的密码管理器里，不能只放在服务器上，否则服务器被回收时，备份也就无法解密。
6. **准备测试邮箱**：M8 冒烟测试时，用 QQ 邮箱和 163 邮箱各收一次验证邮件（V-11）。

## 3. 生产拓扑（`infra/compose.prod.yml`，项目名 `chatapp`）

| 服务 | 镜像 | 端口 | 内存上限 | 数据卷 |
|---|---|---|---|---|
| api | `ghcr.io/liaboveall/chatapp-server:<sha>`（基于 `oven/bun:1.4-slim`） | `127.0.0.1:3100` | 1 GiB | 无 |
| worker | 同一个server镜像，`bun src/worker.ts` | 无 | 1536 MiB，向量子进程≤1 GiB；与media共计2 GiB | 模型缓存、仅Unix socket的IPC卷 |
| media | `ghcr.io/liaboveall/chatapp-media:<sha>`，含sharp/ffmpeg | 无；network_mode=none | 512 MiB，swap总额同限；tmpfs合计256 MiB计入 | 仅Unix socket IPC卷；无业务文件卷 |
| postgres | `pgvector/pgvector:0.8.6-pg18` | 仅内部网络 | 2 GiB（`shared_buffers=512MB`） | `chatapp_pg` |
| valkey | `valkey/valkey:9.1-alpine` | 仅内部网络 | 512 MiB（`maxmemory 384mb`，`noeviction`，开启 AOF） | `chatapp_valkey` |
| garage | `dxflrs/garage:v2.4.1` | 仅内部网络 | 512 MiB | `chatapp_garage` |

- **合计**：6 GiB容器内存上限；宿主机实际可用字节和其他站点余量以M7实测为准。
- media落实03的非root、只读rootfs、cap_drop、no-new-privileges、seccomp、pid限制；其配置不能继承app.env、数据库网络或S3密钥。worker通过有限IPC传文件字节，禁止挂Docker socket。部署前用docker inspect及AT-30确认实际cgroup/挂载/环境，不仅检查YAML。
- **前端**：静态文件放在宿主机的 `/opt/chatapp/web/<sha>/`，`/opt/chatapp/web/current` 是指向当前版本的软链接，由 Nginx 直接提供。切换版本就是原子地替换这个软链接。
- **重启策略**：所有容器都设为 `restart: unless-stopped`，都配置健康检查。
- **日志**：使用 json-file 驱动，限制 `max-size: 10m`、`max-file: 5`。
- **密钥文件**：
  - 文件：`/opt/chatapp/app.env`、`/opt/chatapp/db.env`、`/opt/chatapp/garage.toml`。
  - 属主 root，权限 600。
  - 用 `openssl rand` 在服务器上生成，不打印，也不出现在聊天里。
  - M5a 起，`app.env` 里还有 `AI_KEY_ENCRYPTION_KEY`。
  - M1a的AUTH_TOKEN_ENCRYPTION_KEY、M7的DELETION_JOURNAL加密/访问凭据单独版本管理；media绝不读取。journal恢复密钥与备份密码保存在原主机之外。
- **数据库账号**：
  - `chatapp_owner`：拥有者，只用于迁移；
  - `chatapp_app`：应用运行时使用，只有表的读写权限，不是超级用户。

## 4. 镜像与发布流程

- **推荐方式：用 CI 构建。**
  1. GitHub Actions 的 `image` 工作流在 `ubuntu-24.04-arm` 机器上原生构建 arm64 镜像；
  2. 用 trivy 扫描镜像；
  3. 在同一台 arm64 机器上用 `compose.prod.yml` 启动整套服务，执行迁移和冒烟测试，覆盖 sharp、ffmpeg、onnxruntime 这些原生依赖；
  4. 推送到 GHCR；
  5. 镜像标签同时打上 git sha 和版本号。

  镜像里不含任何密钥，可以公开，服务器拉取时就不需要仓库凭据。
- **备选方式：在服务器上构建。** 本地用 `git -c core.autocrlf=false archive <sha>` 打包源码，scp 上传后在服务器上 `docker build`。这就是服务器约定里原有的做法。
- **前端产物**：由 CI 打成 `web-<sha>.tar.gz`，作为 GitHub Release 附件或构建产物上传；部署时下载到服务器解压。
- **迁移**：使用镜像里的 `bun src/cli.ts migrate`（drizzle-orm 自带的 migrator），不需要 drizzle-kit。

## 5. Nginx 站点（`infra/nginx/chatapp.conf`，部署到 `/etc/nginx/sites-available/chatapp`）

**同一份配置文件**也用于本地的网关测试（M2b，已实现，D-147）和彩排（M7）。本地的 Nginx 容器（`infra/compose.edge.yml`，`bun run edge:up`）只替换证书路径和上游地址（`infra/nginx/env/` 里的两个小文件，D-045）。M2b 起 `infra/nginx/` 里有：`chatapp.conf`（站点）、`security-headers.conf`、`transport-security.conf`、`proxy-api.conf`、`empty.conf`（换掉镜像自带的 `default.conf`）和 `env/local-*.conf`。

要点：
- **监听与证书**：`server_name chat.<域名>`；证书由 certbot 管理；`listen 443 ssl`，开启 http2。可选开启 HTTP/3，但需要在云厂商的安全列表和主机防火墙两处都放行 UDP 443。
- **静态文件**：`root /opt/chatapp/web/current`。SPA 回退规则是 `try_files $uri /index.html`：
  - `/assets/*` 从独立追加的共享哈希目录提供，缓存 1 年（immutable）；至少保留 7 天且至少最近 3 版，不仅切换 current 后把旧资源藏起来。资源缺失返回真实 404，不回退 index.html；
  - `index.html` 设置 `no-cache`；
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

### 首次部署
1. 创建 `/opt/chatapp` 目录，生成各个密钥文件；DeepSeek key 由用户自己写入。
2. 把 `compose.prod.yml` 放到服务器上，执行 `docker compose pull`。
3. `up -d postgres valkey garage`，等健康检查通过后，初始化 Garage（layout、key、bucket）。
4. 创建数据库账号 `chatapp_owner` 和 `chatapp_app`。
5. 用一次性容器、以拥有者账号执行迁移，再用应用 CLI 执行 db:bootstrap（机器人、保留名、默认配置），重复执行无副作用。**不跑**演示 seed。
6. 执行 `bun run admin:create`，创建第一个站点管理员（用户在自己的终端里输入密码）。
7. 配置并验证独立删除journal及生产恢复世代；`up -d api worker media`，部署前端静态文件。缺journal配置不进入可发布模式。
8. 部署 Nginx 站点，先只配 HTTP；用户同意条款后执行 certbot 申请证书，然后执行 `nginx -t` 并 reload。
9. 冒烟测试：
   - `/api/readyz` 返回 200；停掉 postgres 时，它返回 503，外部监控能发现；
   - 用浏览器完成一遍：登录 → 生成邀请码 → 第二个账号注册 → 收到验证邮件（QQ 邮箱和 163 邮箱各测一次，确认没有进垃圾箱）→ 双方聊天（WebSocket 正常）→ 上传图片 → Agent 做一次总结。
10. 在低峰时段，对服务器跑一次短时间的轻量 k6 测试，确认真实硬件上的延迟达标。
11. 配置每12小时备份、删除journal连续追加/完整性检查及监控，完成原主机不可用的恢复演练。

### 日常更新
1. **先备份。**
2. 拉取新镜像。
3. 执行迁移。迁移必须同时兼容新旧两版代码。
4. `up -d api worker media`：重启期间客户端自动重连补齐；media IPC协议版本需与worker兼容，不兼容时先停止接新媒体任务再一起更新。
5. 发布新哈希静态资源后再切换 index.html 软链接；保留旧资源和上一版 API/WS 契约。应用 shell 带 buildId，超过支持窗口时提示刷新并保留草稿，不在编辑/审批中强制刷新。
6. 冒烟测试。

### 回滚
- 把镜像标签和前端软链接改回上一个 sha，重新 `up -d`。
- 数据库**不做**降级迁移：因为迁移本身兼容新旧两版代码，旧版可以直接在新库上运行。
- 迁移出现严重问题时，用最近的备份恢复。

## 7. 一致备份与恢复隔离（D-071）

- **目标**：RPO ≤24 小时、RTO ≤4 小时；每 12 小时（03:40、15:40 UTC）备份一次，避开其他站点高峰。最新成功异地备份的数据库快照年龄 >20 小时告警，>24 小时记录目标违约；“脚本跑过”不等于成功备份。
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

**记录协议**：加密记录含journal格式/规则版本、writer_epoch、seq、previous_hash、operation_id、action、目标id/冻结版本或到期cutoff、接受时间；无正文、邮箱、认证凭据。外部head含epoch/seq/hash，使用条件更新（ETag/CAS）；单dispatcher串行追加，immutable记录先写并读回校验，再CAS推进head，成功后才允许本地应用删除。CAS失败重新读取，不覆盖其他writer；网络结果未知按operation_id/hash查明，不能生成新逻辑操作盲重试。只有head可达链为已接受意图，孤立候选对象不生效。

在线applied水位只覆盖连续无缺口的已应用记录；seq=12完成但11未完成时仍停在10。备份不得记录12跳过11；恢复对10之后所有可信记录幂等重放。字段/密钥轮换和规则升级须保留28天恢复窗口的解读能力。

**用户删除流程**：受锁授权→本地prepared，冻结目标且禁止并发编辑/重新绑定→事务外追加journal→本地journaled→锁内幂等清空/匿名化及工作意图/applied同事务。授权冻结只允许这一动作与目标，后续会话到期不撤回已接受删除；正常读在applied前仍可能返回原内容。5秒超时返回202/operationId，UI轮询状态；prepared没有异地确认不宣称成功。journal接受但本地崩溃时，即使旧备份没有该operation行，恢复仍按可信意图执行。对象物理删除截止从本地首次逻辑删除起算；journal延迟本身另设告警，不隐瞒待完成时间。

**覆盖范围**：撤回/管理删除、私有Agent会话/记忆删除、账号注销、附件解绑/删除；到期清理由带规则版本和截止时间的批意图或恢复时当前有效期限保证。只隐藏个人视图不等同于全局删除。原始备份内容保持加密且不开放管理员浏览，重放调用同一删除domain并覆盖04全部副本。

**writer与恢复**：暂停原writer、撤销旧写入凭据并确认生效，在外部head用CAS登记新writer_epoch后才启用新writer；旧writer后续head提交必须失败。恢复读取manifest的已应用水位到独立最新head，逐项验证链和格式/解密/hash，完整重放包括“异地确认、本地未提交”的意图。恢复过程不重新外发通知或模型调用。读取新head再次检查无缺口后方可开放；恢复后epoch变化还会拒绝旧认证/委托。

**保留和失败**：最少35天，并保留所有≤28天可恢复快照所需后缀；裁剪前验证每份有效备份的已应用水位，生成签名/加密checkpoint锚点，禁止仅凭对象年龄删链。超龄备份如仍存在，延长对应journal并告警；不默认允许恢复窗口外的离线旧副本。journal未提交积压>60秒、CAS持续失败、密钥缺失/断链立即告警；不可用只影响需要确认的删除，不能伪造完成。配置缺失阻断发布；恢复证据不足维持隔离。

**V-19验收**：在独立测试环境覆盖prepared/写对象/head更新/在线清空各点崩溃、重复写、两个writer、凭据轮换、备份中删除、注销/记忆/附件清理及保留截断；故意让源数据库和主机完全不可访问，只靠异地备份+journal+外部保存密钥恢复，确认成功的删除零复活、歧义外发为零。RTO从宣布故障到验证后开放计时，等待日志也算入4小时，不能暂停计时。

**演练**：M7 及之后每月恢复到隔离库/桶，记录备份年龄、实际 RPO/RTO、全部对象校验、关键行数、含已删除数据的副本清理、账号失效与外发封锁。测量按 08 的目标数据集执行；缺密钥或缺一个引用对象即判失败。密码及 AI_KEY_ENCRYPTION_KEY 在服务器之外妥善保管。

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
