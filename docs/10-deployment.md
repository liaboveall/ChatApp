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
   - 开通 Cloudflare R2 或 Backblaze B2 账号；也可以改成定期把备份拷回自己的电脑。
   - restic 仓库的密码由用户保存在自己的密码管理器里，不能只放在服务器上，否则服务器被回收时，备份也就无法解密。
6. **准备测试邮箱**：M8 冒烟测试时，用 QQ 邮箱和 163 邮箱各收一次验证邮件（V-11）。

## 3. 生产拓扑（`infra/compose.prod.yml`，项目名 `chatapp`）

| 服务 | 镜像 | 端口 | 内存上限 | 数据卷 |
|---|---|---|---|---|
| api | `ghcr.io/liaboveall/chatapp-server:<sha>`（基于 `oven/bun:1.4-slim`，含 ffmpeg） | `127.0.0.1:3100` | 1 GB | 无 |
| worker | 同一个镜像，启动命令为 `bun src/worker.ts` | 无 | 2 GB 总量；向量子进程 ≤1 GB、媒体 ≤512 MiB，统一资源闸门 | 向量模型缓存（M5b 起） |
| postgres | `pgvector/pgvector:0.8.6-pg18` | 仅内部网络 | 2 GB（`shared_buffers=512MB`） | `chatapp_pg` |
| valkey | `valkey/valkey:9.1-alpine` | 仅内部网络 | 512 MB（`maxmemory 384mb`，`noeviction`，开启 AOF） | `chatapp_valkey` |
| garage | `dxflrs/garage:v2.4.1` | 仅内部网络 | 512 MB | `chatapp_garage` |

- **合计**：约 6 GB。
- **前端**：静态文件放在宿主机的 `/opt/chatapp/web/<sha>/`，`/opt/chatapp/web/current` 是指向当前版本的软链接，由 Nginx 直接提供。切换版本就是原子地替换这个软链接。
- **重启策略**：所有容器都设为 `restart: unless-stopped`，都配置健康检查。
- **日志**：使用 json-file 驱动，限制 `max-size: 10m`、`max-file: 5`。
- **密钥文件**：
  - 文件：`/opt/chatapp/app.env`、`/opt/chatapp/db.env`、`/opt/chatapp/garage.toml`。
  - 属主 root，权限 600。
  - 用 `openssl rand` 在服务器上生成，不打印，也不出现在聊天里。
  - M5a 起，`app.env` 里还有 `AI_KEY_ENCRYPTION_KEY`。
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

**同一份配置文件**也用于本地的 CSP 测试（M2b）和彩排（M7）。本地的 Nginx 容器只替换证书路径和上游地址（D-045）。

要点：
- **监听与证书**：`server_name chat.<域名>`；证书由 certbot 管理；`listen 443 ssl`，开启 http2。可选开启 HTTP/3，但需要在云厂商的安全列表和主机防火墙两处都放行 UDP 443。
- **静态文件**：`root /opt/chatapp/web/current`。SPA 回退规则是 `try_files $uri /index.html`：
  - `/assets/*` 从独立追加的共享哈希目录提供，缓存 1 年（immutable）；至少保留 7 天且至少最近 3 版，不仅切换 current 后把旧资源藏起来。资源缺失返回真实 404，不回退 index.html；
  - `index.html` 设置 `no-cache`。
- **安全响应头**（SEC-06、SEC-22）：
  - 静态文件的 CSP 等头写在 `infra/nginx/security-headers.conf` 片段里，在每个需要的 location 中 `include`。这样可以避开 `add_header` 在子 location 中不继承的问题。
  - HSTS 写独立 transport-security.conf 片段，add_header 加 always，在每个 HTTPS location（含 assets、API、attachments、WS、错误页）显式 include；不能仅靠 server 级继承。
  - 静态 CSP 等由 security-headers.conf 设置；API/附件的 CSP 等由应用负责，HSTS 仍只由 Nginx 设置，避免重复。
- **`location /api/`**：`proxy_pass http://127.0.0.1:3100`，并设置：
  - `proxy_set_header X-Real-IP $remote_addr` 和 `X-Forwarded-For`，应用只信任本机代理写入的这些头（SEC-28）；
  - `client_max_body_size 110m`（因为单个文件上限是 100 MB）；
  - `proxy_request_buffering off`，上传时边收边转发；
  - `proxy_read_timeout 120s`。
- **`location /ws`**：设置 `proxy_http_version 1.1`、`Upgrade` 和 `Connection` 两个头，`proxy_read_timeout 3600s`。
- **`location /api/attachments/`**：关闭代理缓冲（`proxy_buffering off`）。这样大文件下载和视频拖动播放直接流式转发，不经过 Nginx 的临时文件。
- **健康检查**：`/api/healthz`、`/api/readyz` 走 `/api/` 转发，不会被 SPA 回退拦走，外部监控能真实反映后端状态。
- **限流**：给 `/api/auth/` 和 `/api/invites/check` 配置 `limit_req_zone`，作为应用层限流之外的第二道防线。
- **访问日志**：单独写到 `/var/log/nginx/chatapp-access.log`，按天轮转。邀请码不出现在 URL 里（D-045），所以不会被记录。
- **不设** `default_server`，不改其他站点的文件。

## 6. 部署步骤

### 首次部署
1. 创建 `/opt/chatapp` 目录，生成各个密钥文件；DeepSeek key 由用户自己写入。
2. 把 `compose.prod.yml` 放到服务器上，执行 `docker compose pull`。
3. `up -d postgres valkey garage`，等健康检查通过后，初始化 Garage（layout、key、bucket）。
4. 创建数据库账号 `chatapp_owner` 和 `chatapp_app`。
5. 用一次性容器、以拥有者账号执行迁移，再用应用 CLI 执行 db:bootstrap（机器人、保留名、默认配置），重复执行无副作用。**不跑**演示 seed。
6. 执行 `bun run admin:create`，创建第一个站点管理员（用户在自己的终端里输入密码）。
7. `up -d api worker`，部署前端静态文件。
8. 部署 Nginx 站点，先只配 HTTP；用户同意条款后执行 certbot 申请证书，然后执行 `nginx -t` 并 reload。
9. 冒烟测试：
   - `/api/readyz` 返回 200；停掉 postgres 时，它返回 503，外部监控能发现；
   - 用浏览器完成一遍：登录 → 生成邀请码 → 第二个账号注册 → 收到验证邮件（QQ 邮箱和 163 邮箱各测一次，确认没有进垃圾箱）→ 双方聊天（WebSocket 正常）→ 上传图片 → Agent 做一次总结。
10. 在低峰时段，对服务器跑一次短时间的轻量 k6 测试，确认真实硬件上的延迟达标。
11. 配置每天的备份定时任务和监控。

### 日常更新
1. **先备份。**
2. 拉取新镜像。
3. 执行迁移。迁移必须同时兼容新旧两版代码。
4. `up -d api worker`：重启期间客户端会自动重连并补齐漏掉的消息。
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
  4. 包含应用 SHA、schema 版本、快照时间、对象数/hash 清单、密钥版本的 manifest，以及密钥文件的加密副本。用 restic 加密并上传异地，校验后才写 succeeded。
  5. 本地对象副本完整后可释放删除屏障；复制失败/屏障丢租约则这次备份作废，不标成功，释放屏障并重试。屏障最长 2 小时，超过中止备份并告警，不能无限拖延用户的 24 小时删除期限。
- **保留**：本机和异地均最多 7 个日点/4 个周点，额外强制删除超过 28 天的快照；清理失败告警。失败备份不覆盖最后有效备份。异地目标为 R2/B2 或自动同步的用户设备；手工“偶尔下载”不满足 24 小时目标。
- **不备份 Valkey**：durable work/state/预算在 Postgres；恢复重建队列。在线状态重新计算、限流历史保守收紧，不能假装完整恢复这些瞬态值。

**恢复顺序**：隔离临时库/桶验证 → 启动 RESTORE_MODE=isolated（模型、邮件、push、提醒/定时消息全部禁发）→ 失效所有 sessions、verifications 与 push_subscriptions，提升外部保存的新 restore_epoch → 校验数据、对象和权限 → 对账 unknown 调用及快照后可能已执行的工作 → 人工处置 scheduled/pending 外发清单 → 解锁服务。

恢复到旧快照可能把已经发送的任务恢复成 pending，数据库无法证明外部是否已收到；默认取消有歧义的过期外发任务，必须由负责人核实再恢复。普通用户消息补同步可以重建，外发不能一概自动重放。

恢复也可能重新带回快照之后已删除的内容；开放读取前应用可取得的后续删除墓碑与用户注销记录，并执行当前日期的到期清理。缺少灾难后的删除证据时，记录可能恢复的时间范围，保持相关数据不可公开读取，负责人核对后再解锁；不能声称恢复旧备份天然保留之后的删除结果。

**演练**：M7 及之后每月恢复到隔离库/桶，记录备份年龄、实际 RPO/RTO、全部对象校验、关键行数、含已删除数据的副本清理、账号失效与外发封锁。测量按 08 的目标数据集执行；缺密钥或缺一个引用对象即判失败。密码及 AI_KEY_ENCRYPTION_KEY 在服务器之外妥善保管。

## 8. 监控与运维

- **健康与重启**：restart: unless-stopped 只在容器退出后生效，unhealthy 本身不触发重启。独立宿主机 watchdog 每 30 秒看进程存活/事件循环心跳，连续 3 次确认本服务卡死才单独重启，15 分钟最多 3 次，然后告警人工处理；依赖共同故障仅告警，不重启全部服务。外部监控每分钟探测 readyz，并验证告警真的送达。
- **错误追踪**：
  - 前端和后端都接入 Sentry（免费额度即可）；
  - 前端的上报经自己的域名 `/api/monitoring` 转发（D-046）。
- **磁盘与准入**：80% 告警、85% 拒绝新上传、90% 暂停媒体/向量批任务，低于 75% 才恢复；保留登录、聊天读取和删除能力。上传前同时检查逻辑预算、实际磁盘和 staging/衍生图预占。上线必须填写对象预算、数据库/备份/staging 预留，不把每人 5 GB 当作总容量。
- **Valkey 内存**：用到 `maxmemory` 的 80% 时告警。
- **工作积压**：work_items 最老待派发 >60 秒、dead/uncertain 新增、对象删除接近 24 小时、注册 reserved 无法对账、预算 unknown 均告警；连续队列故障时拒绝新的收费任务和上传，已有持久工作保留重试。
- **证书**：certbot 自动续期；每月检查一次续期日志。
- **AI 预算**：月度预算用到 80% 时通知站点管理员（应用内置）。

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
- [ ] 备份定时任务已经跑过一次，恢复验证通过；restic 密码和 `AI_KEY_ENCRYPTION_KEY` 已在服务器之外妥善保存。
- [ ] 服务器上的轻量 k6 测试达标。
- [ ] 可用性监控、Sentry、磁盘告警、Valkey 内存告警都已接入。
- [ ] 运维手册（部署、回滚、恢复、更换密钥、应急处理）已写进本文件的附录。
- [ ] 按 11 的 14 天内测门槛记录真实任务成功率、可靠性、成本和用户反馈，通过后再扩大发放。
