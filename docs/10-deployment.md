# 10 部署与上线（M7 彩排、M8 上线）

> 上线是**最后一步**。M7 先在本地用生产配置完整彩排一遍，M8 再部署到服务器。
> 服务器的主机信息、SSH 方式、多站点约定、操作注意事项都写在用户的全局配置 `~/.claude/CLAUDE.md` 中，部署时以那里为准，本文件只写 ChatApp 相关的部分。

## 1. 目标环境（摘要）

- **服务器**：Oracle Cloud 新加坡区，VM.Standard.A1.Flex，**ARM64**，2 OCPU，12 GB 内存，Ubuntu 26.04。上面已经运行着其他站点。
- **已装软件**：Docker 29、Compose v5；宿主机上的 Nginx 1.28 是所有站点共用的入口；certbot 用 snap 安装，证书自动续期。
- **对外端口**：只开放 22、80、443。
- **站点约定**：
  - 本应用放在 `/opt/chatapp`，使用独立的 compose 项目、数据卷、密钥文件和备份；
  - 新建一个 Nginx 站点文件，**不改动**其他站点的任何文件，**不设** `default_server`；
  - 容器端口只绑定到 `127.0.0.1`。
- **资源预算**：内存合计 ≤ 1.5 GB（见第 3 节），其余留给已有的站点和系统。

## 2. 上线前需要用户完成的事

1. **购买域名**，并在 DNS 中把 A 记录指向 `149.118.55.232`。建议用一个子域名，比如 `chat.<你的域名>`。
   - 如果暂时不买，可以先用 `chat.149-118-55-232.sslip.io`，但有两个限制：
     - sslip.io **不在**公共后缀列表（Public Suffix List）里，浏览器会把所有 `*.sslip.io` 网站当成同一个"站点"，Cookie 隔离会变弱，必须严格落实 SEC-12 和 SEC-13；
     - 没法配置发信需要的 DNS 记录，所以注册验证邮件和找回密码邮件都发不出去。
2. **开通 Resend 账号**，完成域名验证（SPF、DKIM、DMARC 三条 DNS 记录），拿到 SMTP 凭据。
3. **准备 DeepSeek API key**（v2 专用的新 key）。由用户**自己**写进服务器上的密钥文件：我提供命令，用户在自己的终端里执行，key 不经过聊天。
4. **同意 Let's Encrypt 条款**：每个主机名申请证书前，都要用户明确同意。
5. **（可选）异地备份存储**：Cloudflare R2 或 Backblaze B2 的账号。也可以改成定期把备份拷回自己的电脑。

## 3. 生产拓扑（`infra/compose.prod.yml`，项目名 `chatapp`）

| 服务 | 镜像 | 端口 | 内存上限 | 数据卷 |
|---|---|---|---|---|
| api | `ghcr.io/liaboveall/chatapp-server:<sha>`（基于 `oven/bun:1.4-alpine`） | `127.0.0.1:3100` | 512 MB | 无 |
| worker | 同一个镜像，启动命令为 `bun src/worker.ts` | 无 | 512 MB | 向量模型缓存（M5 起） |
| postgres | `pgvector/pgvector:0.8.6-pg18` | 仅内部网络 | 1 GB（`shared_buffers=256MB`） | `chatapp_pg` |
| valkey | `valkey/valkey:9.1-alpine` | 仅内部网络 | 256 MB（`maxmemory 192mb`，`noeviction`，开启 AOF） | `chatapp_valkey` |
| garage | `dxflrs/garage:v2.4.1` | 仅内部网络 | 256 MB | `chatapp_garage` |

- **前端**：静态文件放在宿主机的 `/opt/chatapp/web/<sha>/`，`/opt/chatapp/web/current` 是指向当前版本的软链接，由 Nginx 直接提供。切换版本就是原子地替换这个软链接。
- **重启策略**：所有容器都设为 `restart: unless-stopped`，都配置健康检查。
- **日志**：使用 json-file 驱动，限制 `max-size: 10m`、`max-file: 5`。
- **密钥文件**：`/opt/chatapp/app.env`、`/opt/chatapp/db.env`、`/opt/chatapp/garage.toml`，属主 root，权限 600。用 `openssl rand` 在服务器上生成，不打印，也不出现在聊天里。

## 4. 镜像与发布流程

- **推荐方式：用 CI 构建。**
  1. GitHub Actions 的 `image` 工作流在 `ubuntu-24.04-arm` 机器上原生构建 arm64 镜像；
  2. 扫描镜像（trivy），推送到 GHCR；
  3. 镜像标签同时打上 git sha 和版本号。
  
  镜像里不含任何密钥，可以公开，服务器拉取时就不需要仓库凭据。
- **备选方式：在服务器上构建。** 本地用 `git -c core.autocrlf=false archive <sha>` 打包源码，scp 上传后在服务器上 `docker build`。这就是服务器约定里原有的做法。
- **前端产物**：由 CI 打成 `web-<sha>.tar.gz`，作为 GitHub Release 附件或构建产物上传；部署时下载到服务器解压。

## 5. Nginx 站点（`infra/nginx/chatapp.conf`，部署到 `/etc/nginx/sites-available/chatapp`）

要点：
- `server_name chat.<域名>`；证书由 certbot 管理；`listen 443 ssl`，开启 http2。可选开启 HTTP/3，但需要在 Oracle 安全列表和 `/etc/iptables/rules.v4` 两处都放行 UDP 443。
- `root /opt/chatapp/web/current`。SPA 回退规则：`try_files $uri /index.html`。
  - `/assets/*` 带内容哈希，缓存 1 年（`immutable`）；
  - `index.html` 设置 `no-cache`。
- `location /api/`：`proxy_pass http://127.0.0.1:3100`，并设置：
  - `client_max_body_size 110m`（因为单个文件上限是 100 MB）；
  - `proxy_request_buffering off`，上传时边收边转发；
  - `proxy_read_timeout 120s`。
- `location /ws`：设置 `proxy_http_version 1.1`、`Upgrade` 和 `Connection` 两个头，`proxy_read_timeout 3600s`。
- 安全响应头（SEC-06、SEC-22）统一在 Nginx 上加，由 api 返回的头不能与之重复或冲突。
- 限流：给 `/api/auth/` 和 `/api/invites/check` 配置 `limit_req_zone`，作为应用层限流之外的第二道防线。
- 访问日志单独写到 `/var/log/nginx/chatapp-access.log`，按天轮转。
- **不设** `default_server`，不改其他站点的文件。

## 6. 部署步骤

### 首次部署
1. 创建 `/opt/chatapp` 目录，生成各个密钥文件；DeepSeek key 由用户自己写入。
2. 把 `compose.prod.yml` 放到服务器上，执行 `docker compose pull`。
3. `up -d postgres valkey garage`，等健康检查通过后，初始化 Garage（layout、key、bucket）。
4. 用一次性容器执行 `bun run db:migrate`。**不跑**种子数据。
5. 执行 `bun run admin:create`，创建第一个站点管理员（用户在自己的终端里输入密码）。
6. `up -d api worker`，部署前端静态文件。
7. 部署 Nginx 站点，先只配 HTTP；用户同意条款后执行 certbot 申请证书，然后执行 `nginx -t` 并 reload。
8. 冒烟测试：
   - `/readyz` 返回 200；
   - 用浏览器完成一遍：登录 → 生成邀请码 → 第二个账号注册 → 收到验证邮件 → 双方聊天（WebSocket 正常）→ 上传图片 → Agent 做一次总结。
9. 配置每天的备份定时任务和监控。

### 日常更新
1. **先备份。**
2. 拉取新镜像。
3. 执行迁移。迁移必须同时兼容新旧两版代码。
4. `up -d api worker`：重启期间客户端会自动重连并补齐漏掉的消息。
5. 切换前端的软链接。
6. 冒烟测试。

### 回滚
- 把镜像标签和前端软链接改回上一个 sha，重新 `up -d`。
- 数据库**不做**降级迁移：因为迁移本身兼容新旧两版代码，旧版可以直接在新库上运行。
- 迁移出现严重问题时，用最近的备份恢复。

## 7. 备份与恢复

- **频率和时间**：每天 03:40 UTC，与服务器上其他站点的备份时间（03:10）错开。
- **备份内容**：
  - `pg_dump -Fc` 导出数据库；
  - Garage 中 bucket 的完整同步；
  - 当天的 `app.env` 的**加密副本**。
- **保留策略**：本机保留最近 7 份每日备份和 4 份每周备份。
- **异地备份**：用 restic 加密后推送到 R2 或 B2；如果没有这类账号，就定期下载到本地电脑。服务器是 Always Free 实例，存在被回收的风险，所以异地备份是必需的。
- **恢复演练**：每月一次，也包括 M7 那次。把备份恢复到临时数据库和临时 bucket，然后逐项核对：
  - 表的行数；
  - 附件字节数和 sha256（与 `attachments.size_bytes` 和 `sha256` 对照）；
  - 抽样几条消息，确认可读。

## 8. 监控与运维

- **自动重启**：容器健康检查失败时自动重启；另外在外部部署一个可用性监控（Uptime Kuma 或其他服务），每分钟探测一次 `/readyz`。
- **错误追踪**：前端和后端都接入 Sentry（免费额度即可）。
- **磁盘**：可用空间低于 20% 时告警，附件和备份是主要的占用来源。
- **证书**：certbot 自动续期；每月检查一次续期日志。
- **AI 预算**：月度预算用到 80% 时通知站点管理员（应用内置）。

## 9. M7：本地生产彩排

1. 用 CI 产出的 amd64 镜像（或在本地构建），在本地通过 `compose.prod.yml` 启动全部服务。
2. 在前面放一个 `caddy:2`（配置在 `infra/caddy/`），用它的本地证书颁发机构，把 `https://chat.localhost` 当作生产环境来访问。
3. 对这个地址运行完整的 E2E 测试和压力测试，并完成一次备份和恢复演练。
4. 验证：HTTPS 下 WebSocket 的地址会自动变成 `wss://`；安全响应头齐全；Cookie 带有 `Secure` 和 `__Host-` 前缀；生产配置缺少密钥时会拒绝启动。

## 10. 上线检查清单（M8）

- [ ] 域名解析生效；证书有效；HTTP 自动跳转到 HTTPS；HSTS 已开启。
- [ ] `/readyz` 返回 200；首页、登录页、API、WebSocket 都正常。
- [ ] 邮件能送达（验证邮件、找回密码邮件都能收到，且没有进垃圾箱）。
- [ ] 第一个站点管理员已创建；演示数据**没有**进入生产库。
- [ ] 07 的安全自查清单全部通过；依赖和镜像扫描没有高危问题。
- [ ] 备份定时任务已经跑过一次，恢复验证通过。
- [ ] 可用性监控、Sentry、磁盘告警都已接入。
- [ ] 运维手册（部署、回滚、恢复、更换密钥、应急处理）已写进本文件的附录。
- [ ] 先邀请少量用户内测 1 到 2 周，再正式发放更多邀请码。
