# 2026-10-15 上线新对话交接

> 后续本人已指示「开始上线」，实际服务器执行及当前待办见 [33](33-closed-launch-2026-10-15.md)。本文件保留开工前交接时点，不代表后续没有服务器变更。

本轮本人要求「将当前进度同步，我将新开对话开始上线」。本文件同步域名、邮件及已经执行的只读检查，供新对话继续 D-211 的封闭部署；本轮没有连接或修改服务器，也没有提交、推送、签发证书或部署。完整 M7、V-19/AT-33 和正式开放均未通过。

## 1. 开工顺序与当前代码

1. 先读 [PROGRESS](PROGRESS.md) 顶部本轮记录及本文件，再读 [31 运维手册](31-prelaunch-operations-2026-10-13.md)、[10 部署流程](10-deployment.md)和 [11 的 M7/M8](11-roadmap.md)。冲突按用户最新指示、[12 的 D-210/D-211/D-212](12-decisions.md)和实际证据处理。
2. 工作区仍为 `/home/mars/projects/ChatApp`，分支 `v2`，HEAD 为 `8f33c772b1eced9c0d2fbe1f84f6c2f32a9641ff`。同步前有 102 个已跟踪修改、122 个未跟踪路径；本轮只改交接文档，原有改动保留，最终状态以重新执行 `git status` 为准。
3. 原开发数据、配置、卷及历史失败证据保留。不得用清空开发环境、覆盖 `.env.local` 或回退历史来准备部署；用户未在本轮授权 Git 提交/推送。
4. 目标服务器地址、连接方式和私钥路径按私有全局 `~/.claude/CLAUDE.md` 及 [09](09-local-dev.md)核对。D-054：公开仓库不保存服务器地址、区域和机型，也不保存任何密钥。

## 2. 已完成及其证据范围

| 项目 | 已知事实 | 证据与限制 |
|---|---|---|
| 域名 | 本人通过 Name.com 的 GitHub 学生包注册 `chatapp.software` | 用户直接确认；无需重复购买 |
| 正式入口约定 | `https://chatapp.software` | 用于生产 `APP_ORIGIN`、Nginx 和证书；不是已部署成功的声明 |
| DNS | 本对话只读查询返回 A 记录、Name.com NS；AAAA 查询成功但没有返回记录 | 查询接口为 Google 公共 DNS JSON；尚未把 A 值与私有目标服务器配置核对，实际值仅保存在忽略的本地回执 |
| Resend | 本人明确确认「我已经收到了测试邮件」 | 证明本次测试邮件已实际送达；未独立读取账号后台、原始邮件头或复核实际测试发送入口 |
| 约定发件地址 | `ChatApp <noreply@chatapp.software>` | 教程及后续生产配置约定，不冒充已检查过真实邮件 From 头 |
| 本地发布候选 | 扫描 `.test-runs/**/release.json` 共 9 份，全部为 x64 | 本地扫描范围内未找到原生 ARM 清单；不能据此断言其他机器或远端没有产物 |
| 源码绑定 | 交接前重新计算 892 个发布绑定文件，指纹与 `candidate-attempt4` 一致 | `APPLICATION_SOURCE_HASH=b603a699d1763c06ce0167ea5d3d25ed28557638b954d18b74b82bd20c4047fa`；当前 Git SHA 只是 dirty 基线 |

本轮前段公网 443 TLS 探测返回 `SSLError / TLSV1_UNRECOGNIZED_NAME`，尚未验证域名 HTTPS 可用。此错误不证明某个证书、Nginx 配置或 DNS 的具体根因，需要在目标服务器只读检查后定位。

DNS/TLS 是本对话前段已经执行的网络读取；同步文档时未重复探测。完整回执及修改前文档快照在 `.test-runs/prelaunch-handoff-2026-10-15/cb2298737ea1/`，该目录受 Git 忽略保护。回执分别标注用户确认、工具观察及本轮文档同步，网络观察不会被写成后台独立验收。

## 3. Resend 与生产邮件配置

实际 Resend 截图使用下面这组 DNS 类型；完整 Content 未出现在截图中，必须以控制台复制的完整值为准，不根据缩略字符串构造值：

| 用途 | Type | Name.com Host | 值的来源 |
|---|---|---|---|
| DKIM | TXT | `resend._domainkey` | Resend 生成的完整 DKIM Content |
| SPF | CNAME | `rsend` | Resend 第一条 SPF CNAME 的完整 Content |
| SPF | CNAME | `send` | Resend 第二条 SPF CNAME 的完整 Content |
| DMARC，推荐 | TXT | `_dmarc` | 初始宽松策略 `v=DMARC1; p=none;` |

TTL 在 Name.com 可使用 300。本次记录不要硬套旧教程的 MX + SPF TXT 示例；同名 CNAME 不能和 TXT/MX 混用。已指导将域名 Configuration 中的 Open Tracking、Click Tracking 关闭，并保持 Enable Sending 开启；后台实际保存状态未由本轮工具独立读取。

生产配置字段约定如下，部署时只在 [31](31-prelaunch-operations-2026-10-13.md)的服务器私有 `app.env` 中填写，保留其余字段；下面的密码占位符不是可用凭据，也不是终端命令：

```dotenv
APP_ORIGIN=https://chatapp.software
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_USER=resend
SMTP_PASS=<由本人在私有配置中填写Resend发送权限APIKey>
MAIL_FROM=ChatApp <noreply@chatapp.software>
```

现有 `apps/server/src/jobs/smtp.ts` 对 465 使用隐式 TLS，其他端口采用 STARTTLS；不需要为这次教程改邮件代码。API Key 使用发送权限并限制到本域名的方案已指导，实际权限仍须在部署时核对。本轮没有读取或改写本地/服务器的 SMTP 密钥配置，不能认定生产 `app.env` 已填好。

现有 R2 账号、journal/backup 独立凭据与此前恢复材料准备沿用，不要求本人重新创建或在聊天发送任何密钥；在目标私有配置中填写，检查存在性、权限及实际连接结果。普通开发环境的 Mailpit 配置未改。

## 4. 旧候选与历史验证如何使用

- 最新本地候选清单为 `.test-runs/m7-prelaunch-2026-10-12/e9c8c3d1-8e0b-49b8-a64f-df3491e2fdc8/candidate-attempt4/release.json`，架构 x64、dirty=true、baselineShaOnly=true；源码指纹见上。本轮没有重建、扫描或重新执行其应用测试。
- [30](30-prelaunch-implementation-2026-10-13.md)和 PROGRESS 中的 check、coverage、浏览器、媒体、安全扫描、45 阶段本地生产彩排及轻量混合 smoke 都是历史实际结果；源码指纹一致不等于本轮重跑，不证明当前宿主软件安全或 ARM/云端容量。
- 本地 x64 包不能直接部署到 ARM。云端和本机恢复分别需要同一源码的原生 ARM/x64 包，上传前后核验归档和不可变 image ID；同源码远端 CI/原生 ARM 回执仍须取得。
- 前次 worker unhealthy 的根因未确认；额外十账号同会话 POST 延迟和锁等待仍待诊断。保留原失败，不把后续成功或轻量 smoke 当作完整修复/容量达标。

## 5. 新对话实际执行批次

1. **先做服务器只读检查**：核对私有连接信息、SSH 主机指纹、DNS A 与目标服务器是否一致；查看实际架构、系统/宿主 Nginx 支持状态、Docker/Compose、端口、服务和 CPU/内存/磁盘余量。2026-10-12 的服务器清空/更新记录属于历史，不证明本次现场状态。
2. **准备同源码原生 ARM 候选及对应 CI**：按 31 做架构构建、原生启动/生产彩排、安全检查及归档绑定，保留 x64 恢复材料。保留当前 dirty 工作；如需提交/推送，按用户在新对话中的实际授权处理，不能自行把旧 HEAD 当新发布版本。
3. **准备生产私有配置和封闭入口**：为 ChatApp 建独立项目/库/桶/卷，落实名单、最小权限、媒体隔离、生产 journal 和离源恢复材料。SMTP、AI、R2 由本人在自己的终端填写；按 10 的既定条款要求接续 certbot 签发及自动续期。除证书验证路径外，页面/API/WS/附件统一只允许本人和验收人员访问。
4. **执行封闭部署及完整业务冒烟**：按 31 初始化新卷、数据库权限/迁移、独立存储、journal/restic、bootstrap、管理员及 API/worker；部署前端和 Nginx。核验 readyz、HTTPS、注册验证/找回密码、QQ/163 送达、双方聊天/重连、附件及 AI，不以独立测试邮件代替这些路径。
5. **完成云端 M7 和最终独立恢复**：继续完整混合/故障矩阵、500 WS 与目标全量数据、ARM 资源、真实 R2 调度/保留/告警、安全、本人及真机验收。按 D-210 使整台云端源主机不可访问，仅凭异地备份/journal/另存材料在本机干净环境恢复；确认删除零复活、权限再确认、RPO ≤24 小时及连续 RTO ≤4 小时，再关闭 M7 和正式开放。

当前同步不替代新对话的部署指令，不包含真实用户开放、服务器变更、整机故障、提交推送或证书条款接受。新对话按用户实际指示接续；已有授权不重复询问，缺项不冒充通过。

## 6. 本轮文档核对

修改前已保存六份文档原件和 Git 状态；发布源码指纹已重新计算并与历史最新候选核对。文档差异、相对链接及改动后源码指纹的最终结果记录在上述本地 `receipt.json`。仅文档同步，没有重跑应用测试，没有访问/变更服务器或读取密钥值。
