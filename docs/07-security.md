# 07 安全规范

> 每个里程碑验收前都要对照本文件自查。每条 SEC 要求至少对应一个自动化测试（见 [08](08-testing.md)）。
> 旧版的 24 个缺陷见 [13-legacy-analysis.md](13-legacy-analysis.md)，它们的回归测试在第 3 节列出。

## 1. 威胁模型

**需要保护的资产**
- 私信、群组和 Agent 会话的内容，包括新成员加入前的历史；
- 附件；
- Agent 的长期记忆；
- 用户账号和会话；
- 用户自带的 API key；
- DeepSeek API 额度，也就是钱；
- 站点管理员权限。

**可能的攻击者**
| 攻击者 | 能力 | 主要风险 |
|---|---|---|
| 外部人员（没有邀请码） | 只能访问公开页面和接口 | 暴力破解登录；猜测或滥用邀请码；绕过邀请直接调用注册接口；借 SSRF 或上传漏洞入侵；刷接口 |
| 恶意成员（已注册） | 合法会话，能在群里发内容 | 越权读取，包括加入前的历史；冒充他人或冒充"助手"；XSS；恶意上传；在消息里埋注入指令操纵 Agent（外泄、记忆投毒）；刷屏；刷 AI 额度；被踢后重新加入 |
| 被盗的账号 | 拿到了某个用户的会话 | 冒用此人权限；提供设备注销和持续授权复核，撤销提交后拒绝新授权，连接在 5 秒复核周期内关闭；已授权在途内容无法收回 |
| 恶意内容 | 网页、文件、聊天记录中嵌入的指令 | 诱导 Agent 泄露数据或执行操作 |
| 站点管理员（受信但受限） | 管理后台 | 越权查看私有内容。约束：只能看举报上下文和站点 key 的 Agent 运行（D-034），每次查看都写审计日志；看不到自带 key 运行的内容，也看不到用户的 key |
| 网络窃听者 | 能监听网络流量 | 生产环境全程 HTTPS，使用 HSTS 和 Secure Cookie |

## 2. 安全要求

| 编号 | 要求 |
|---|---|
| **SEC-01** | HTTP/WS身份只来自服务端session，后台用户动作只来自受控delegation；请求体不能指定Principal/userId/发送来源，username、senderId等冒用字段忽略或拒绝 |
| **SEC-02** | 会话读写（HTTP、WS、附件、搜索、Agent）统一经authorize(principal,conversation,action)。消息需当前成员且seq>visible_from_seq；封禁不可重入；无权私有资源404；Principal规则见03 |
| **SEC-03** | WS 绑定 session，Origin 必须匹配；服务端决定 topic，但订阅不构成授权。内容每批查当前 session/成员/来源版本；注销走持久撤销，5 秒复核（测试容差 1 秒），依赖失败停止派发并断连；已授权在途字节不可召回（03 第 6 节）。 |
| **SEC-04** | 所有对外暴露的 id 都用 UUIDv7，不使用可以枚举的自增 id 或可以拼出来的名字（旧版的 `private_1_2` 就是反例） |
| **SEC-05** | 前端**禁止**用 `innerHTML` 或 `dangerouslySetInnerHTML` 渲染用户内容。<br>• Markdown 按 D-047 配置：禁止原始 HTML，关闭数学公式和 Mermaid<br>• 链接只允许 `http`、`https`、`mailto` 三种协议，外链加 `rel="noopener noreferrer"`<br>• `guard` 扫描 `innerHTML`、`outerHTML`、`insertAdjacentHTML`、`dangerouslySetInnerHTML`、`document.write`、`setHTMLUnsafe`、`createContextualFragment`、`srcdoc` |
| **SEC-06** | 页面文档（index.html）的 CSP 由 Nginx 站点配置输出：<br>`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'`<br>• **Trusted Types 已开启（D-146，V-08）**：策略末尾追加 `; require-trusted-types-for 'script'; trusted-types 'none'`（不允许创建任何策略）。`apps/web/tools/csp.ts` 是唯一来源，`infra/nginx/security-headers.conf` 与它逐字一致（`bun run check` 里的单元测试比对）；构建把 `decode-named-character-reference` 解析到查表版，因为它的浏览器版用 `innerHTML` 解码实体。以后需要写入点的功能（M6 的 Service Worker 注册、`new Worker(url)`、M7 的 Sentry）另立决定、建只做一件事的命名策略<br>• WebKit 的 E2E 要验证 WebSocket 在 `connect-src 'self'` 下能连接；不能的话，显式加上 `wss://<站点域名>`<br>• **M1b 已实现并验证**：策略与上面逐字相同（`apps/web/tools/csp.ts`），`vite preview` 在 E2E 里原样发送；每个 E2E 测试都断言零 `securitypolicyviolation` 和零意外控制台错误；WebSocket 在 Chromium、WebKit、Firefox 的 `connect-src 'self'` 下都能连接并保持，所以不需要显式 `wss://`；页面没有内联脚本和样式，Zod 以 `jitless` 运行（D-116）。生产站点配置的同样输出在 M2b 的 edge（本地 Nginx 容器，D-147）上验证 |
| **SEC-07** | 上传先持久预占与对象意图，再接收流；每阶段可幂等恢复。魔数/长度/像素/帧数/时长/解码内存/超时均有限制；媒体子进程无网络、非 root。随机不可覆盖对象 key；svg/html/xml 只能下载；EXIF 清理失败不能宣称已清理（03 第 5.4 节）。 |
| **SEC-08** | 附件按 purpose、当前有效绑定和消息可见性授权；deleting 一律不可读。应用设置安全 Content-Type、Content-Disposition、nosniff、CSP sandbox、Cache-Control: private, no-store；Range 每次重新鉴权，SW 不缓存敏感文件。 |
| **SEC-09** | 注册仅受控入口执行D-059；首次INSERT关联registration_id。D-076验证/重置凭证绑定user、registration、purpose、邮箱摘要、auth/restore世代，一次性事务消费；GET不消费，原生JWT回调默认关闭。同邮箱重建不可复用旧链接，验证/撤销/清理串行化。邀请码只存哈希，按IP限流。 |
| **SEC-10** | 密码至少 10 位，并用本地的常见弱密码表拦截弱密码；密码哈希使用 Better Auth 的默认算法 |
| **SEC-11** | 登录/注册/验证重发/重置按真实IP及规范化账号摘要限流，计数在Valkey；自定义认证端点显式接入同一限流器，不能假定SDK覆盖。匿名错误不枚举账号。改密注销其他会话、重置注销全部，委托按03撤销；不启用cookieCache |
| **SEC-12** | Cookie 设为 `HttpOnly`、`SameSite=Lax`；生产环境加 `Secure`，并使用 `__Host-` 前缀（如果 Better Auth 不支持，就用 `__Secure-`，并确保不设置 `Domain`） |
| **SEC-13** | 所有非 GET 请求都校验 `Origin`（Better Auth 的 `trustedOrigins` 加上我们自己的中间件）；API 默认只接受 JSON，上传内容仅 octet-stream，monitoring 仅受限 envelope；拒绝其他普通表单格式 |
| **SEC-14** | 用户名和显示名：<br>• 用户名有格式规则和保留名单；显示名也不能使用保留名，比较前先做 NFKC 规范化<br>• 所有数据都通过用户 id 关联<br>• 改名有 30 天冷却期，旧用户名保留 30 天，不能被别人立刻注册<br>• Better Auth 的 `update-user` 不能修改用户名、显示名和头像（D-039） |
| **SEC-15** | 撤回事务清空在线正文/提及/向量，附件立即拒读；对象物理删除目标 1 小时、最长 24 小时，失败告警重试。所有内容副本、摘要、审批参数、任务、浏览器缓存和备份按 04 第 10 节处理；注销取消活动和未来任务。 |
| **SEC-16** | 限流覆盖消息、上传、Agent 运行、@Agent 触发、正在输入事件，以及每个用户的 WebSocket 连接数（见 01 第 7 节） |
| **SEC-17** | Agent必须遵守[06第11节](06-agent.md)的A1–A15，包含持久委托和跨key来源隔离 |
| **SEC-18** | 启动时校验配置：生产环境缺少密钥、密钥太短或仍是示例值，都拒绝启动；错误响应里不包含堆栈和内部信息 |
| **SEC-19** | 应用/Nginx/Sentry只记录允许字段和规范化route，不存原始URL/query/path参数/Referer/请求体/Cookie/认证头/正文。网关未知路由只记unknown，不能用默认combined；错误日志也不可带原始请求行。Sentry事件/breadcrumb双层过滤且关闭回放，SDK遥测无输入输出。假哨兵覆盖正常和错误路径（AT-26）。 |
| **SEC-20** | 依赖和镜像：<br>• 依赖锁定精确版本，用 Renovate 自动提升级 PR<br>• CI 运行 `osv-scanner`（查依赖漏洞）、`trivy`（查镜像漏洞）、`gitleaks`（查泄露的密钥） |
| **SEC-21** | 以下操作都要写入审计日志：<br>• 站点管理员和会话管理员的操作<br>• 站点管理员查看敏感内容：举报上下文、Agent run 详情（包括站点 key 运行的内容）<br>• 审计日志只存 id 和元数据，不存正文 |
| **SEC-22** | HSTS 由 Nginx 的独立片段 add_header ... always 覆盖每个 HTTPS location 及错误页，不能只放 server 级后被子 location 覆盖。静态 CSP、Referrer/Permissions/COOP 由静态片段设置；API/附件除 HSTS 外的头由应用设置，不重复。 |
| **SEC-23** | M6 Web Push 即实施 SSRF 防护：HTTPS/443、经真实浏览器订阅验证的服务商域名清单、拒绝用户信息与 IP 字面量、每次解析全部 A/AAAA 并拒绝非公网地址、连接钉住已验证 IP 且保持正确 TLS SNI、不跟随重定向、5 秒超时及出口防火墙。DNS 重绑定、IPv4-mapped IPv6、元数据地址须测试。Sentry 固定服务端目的地/项目 id，envelope 不能指定任意转发地址。将来 fetch_url 也须独立实施防护。 |
| **SEC-24** | WebSocket 单帧最大 64 KB；每条消息都用 zod 校验；收到未知类型的消息，回一条 `error` 事件 |
| **SEC-25** | Passkey 的 RP ID 与站点域名一致；本地开发用 `localhost` |
| **SEC-26** | 用户自带的 API key（M5a）：<br>• 用 AES-256-GCM 加密存储，密钥来自 `AI_KEY_ENCRYPTION_KEY`，带版本号便于轮换<br>• 保存后只返回末 4 位；不写日志、不进提示词、管理员也看不到<br>• 只发往固定的 DeepSeek 地址，不接受用户提供的地址，避免 SSRF<br>• 注销账号时删除 |
| **SEC-27** | message.changed 一律不含正文/引用/附件；HTTP 投影逐接收者检查可见性。Agent 共享输入采用共同可见水位，成员变化使旧运行失效；每批流式发布检查当前授权与 epoch，不允许加入后一秒继续盲播。 |
| **SEC-28** | 限流和日志使用真实客户端 IP：只信任来自 `TRUSTED_PROXIES` 的转发头；其他来源的 `X-Forwarded-For`、`X-Real-IP` 一律忽略 |
| **SEC-29** | 测试专用接口（可控时钟、断开连接等）只在 `APP_ENV=test` 时注册；生产环境启动时自检，发现它们就拒绝启动 |
| **SEC-30** | 数据按 04 第 10 节的保留期清理；隐私说明（01 第 4.11 节）必须与实际行为一致，行为变化时同步修改说明 |


### 2.1 新增边界要求

| 编号 | 要求 |
|---|---|
| SEC-31 | 认证端点 method/path 默认拒绝，扩展字段 input=false/显式 schema 拒绝。站点管理员也不能代登、改他人密码邮箱、原生硬删除或绕邀请建用户；后台与 CLI 只能调用受审计 domain |
| SEC-32 | 所有业务写入在一致锁序下事务内复核授权；Agent 效果同时核对 lease_epoch、取消、审批状态和 args_hash，旧执行者不可写回 |
| SEC-33 | 所有站点模型调用先锁库预占；未知外部调用不自动退款或重试。价格/用量估算失准告警并停止新调用 |
| SEC-34 | 本地消息、草稿、队列、push 按账号/登录世代/成员世代隔离，退出跨标签页广播并清理；重新联网先验证身份，不把失联设备远程清除作为安全承诺；**请求的回答和失败带发起时的账号与成员关系，过期的丢弃**，成员关系结束时草稿、待发、回复/编辑状态一并清除，引用不能因迟到的旧响应恢复已撤回的摘要（D-171）；**迟到的回答带来的界面收尾（结束编辑、放回草稿）也只作用于发起时的那一次**，不清空下一账号或新成员关系的草稿（D-173）；**屏幕的写请求回答之后的跳转、提示、结束会话同样只属于发起请求的那个人**，换了人之后迟到的回答不会跳转、不会说出前一个人的会话名和用户名、不会结束新账号的会话（D-174） |
| SEC-35 | 恢复隔离模式禁止外发/模型任务，失效 sessions 和验证凭证、提升恢复世代后核对任务。备份有逻辑对象清单/校验值及删除屏障 |
| SEC-36 | domain区分Session/Delegated/System Principal；后台用户动作持有有效origin、auth/restore世代及参数绑定委托。普通退出与安全撤销分开；安全撤销和效果提交串行化，不凭裸userId授权 |
| SEC-37 | 私有byok_private内容及派生摘要/记忆/向量命中不进入site自动上下文，工具检索同样过滤；key来源切换新开空白段。共享发布仅按用户明确操作释放正文，不释放原私有run详情 |
| SEC-38 | JSON/envelope/上传分别在网关及应用解析前执行128KiB/256KiB/100MiB上限（上传另受reservation约束）、字节累计和超时；拒绝压缩请求、异常framing，超限不影响正常小请求 |
| SEC-39 | 媒体只在D-081无网络、无凭据、只读、受cgroup/pid/tmpfs约束的独立容器解码；worker不挂Docker socket，IPC拒绝任意命令/URL/路径；OOM/超时不拖垮API/worker |
| SEC-40 | 生产成功删除先有独立异地journal证据；恢复校验完整链并重放至可信head，缺证据保持隔离。凭证、删除journal密钥和restore epoch的恢复材料不能仅存在原主机 |
| SEC-41 | 进程/网络/实例级故障仅在独立测试Compose执行；核对project labels、实例标记及容器/卷ID，禁止开发/生产目标与模糊清理，开发哨兵须保持不变 |

管理员内容限制指应用角色；本系统无端到端加密，主机/数据库/服务端密钥的运维权限不在此隔离保证内。安全测试需同时以普通成员、管理员、机器人、未激活/注销账号执行原生路由矩阵。

## 3. 旧版缺陷 → 新要求 → 回归测试

编号 L-xx 对应 [13-legacy-analysis.md](13-legacy-analysis.md)。回归测试放在两处，每条测试的标题都以 `L-xx` 开头：
- `apps/server/test/security/legacy.test.ts`：接口层和 WebSocket 层；
- `apps/web/e2e/security.spec.ts`：界面层。

"里程碑"一列表示这条测试在哪个里程碑完成；分在两个里程碑的，各完成自己那部分。

| 旧缺陷 | 新版的保证 | 回归测试断言 | 里程碑 |
|---|---|---|---|
| L-01 纯中文房间名导致创建报 500 | 会话用 UUID 标识，名称只用于显示 | 创建"测试房间"频道成功，访问正常 | M2a |
| L-02 一个中文名房间让全站所有页面 500 | 同上，页面渲染不再依赖名称拼出的 slug | 创建之后，首页和登录页依然返回 200 | M2a |
| L-03 第二个中文名房间撞上唯一约束 | 频道名唯一性按规范化后的名称判断 | 两个不同的中文名都能创建；名称完全相同时返回 409 | M2a |
| L-04 私密房间的密码可以被绕过 | SEC-02：群组没有"密码"，只能被拉入或凭群邀请链接加入 | 非成员读取群组消息返回 404 | M2a |
| L-05、L-06 聊天记录被渲染成页面顶部的横幅 | 前端重写（React），没有模板变量重名的问题 | E2E：私信页（M2b ✅，`scenario-5-isolation.spec.ts`：「错误：…」这样的文字只在时间线里，页面上没有横幅和告警）和 Agent 页（M4）都不出现错误横幅 | M2b / M4 |
| L-07 超过时限的消息仍显示撤回按钮 | 服务端和客户端都按时间戳计算时限（客户端用 `hello.serverTime` 校正时钟） | 3 分钟前的消息返回 `WINDOW_EXPIRED`（M2a）；界面上也没有撤回按钮（M2b ✅，`scenario-4-recall.spec.ts`：撤回者的浏览器时钟拨慢 10 分钟，消息用测试接口变老，D-155；缓存里还是旧时间时界面仍会给出撤回，点了由服务端拒绝并说明） | M2a / M2b |
| L-08 页面样式没有生效 | 改用 Tailwind 和组件库；关键组件做截图对比测试 | Storybook 截图对比通过 | M1b ✅（2026-10-03：64 张基线，Playwright 官方镜像内逐像素比较，D-123；本地与远端 CI 的 `visual` 作业都是 64 通过） |
| L-09 可以冒充他人发言 | SEC-01 | 请求体里带 `senderId` 或 `username` 会被拒绝（422，请求体是 strict 的），消息的发送者永远是会话本人 | M2a |
| L-10 可以把消息写进别的房间 | SEC-01、SEC-02：会话 id 取自 URL，并检查成员关系 | 对非成员的会话发消息返回 404 | M2a |
| L-11 实时消息存在 XSS | SEC-05、SEC-06 | E2E：发送 `<img src=x onerror=…>` 后，页面显示为文本，脚本没有执行，也没有 CSP 违规报告（M2b ✅，`security.spec.ts`：七种恶意样本，两个人的页面上都只是文本；另有 Trusted Types 金丝雀，D-146、D-148） | M2b |
| L-12 上传 html 文件后被当作网页在同源打开 | SEC-07、SEC-08 | 上传 `pwn.html` 后，`kind` 为 `file`，下载时的响应头是 `attachment` 加 `nosniff` 加 `sandbox` | M3 |
| L-13 私聊 WebSocket 匿名也能连接 | SEC-03 | 不带 Cookie 连接，被以 4401 关闭 | M1a |
| L-14 AI 的 WebSocket 匿名也能连接 | SEC-03：只有一个 `/ws`，必须登录 | 同上（M1a）；匿名调用 `POST /api/agent/runs` 返回 401（M4） | M1a / M4 |
| L-15 AI 页面删除消息时报错 | 写操作统一走 HTTP 接口 | 在 Agent 会话里撤回和删除都成功 | M4 |
| L-16 中文名房间在推送层串消息 | 推送频道以 UUID 命名（`conv:{uuid}`） | 两个中文名会话互相收不到对方的事件 | M2a |
| L-17 "是不是当前用户"的标记算错人 | 在线状态事件里没有这个字段，由客户端自己判断 | 在线状态事件的结构里不含 `is_current` | M2a |
| L-18 多标签页关掉一个就显示离线 | 按连接统计在线状态（Valkey） | 开两个连接、关掉一个，状态仍为 online | M2a |
| L-19 改名后能读到别人的 AI 历史 | SEC-14：一切按用户 id 关联；Agent 会话属于某个用户 id | 30 天内不能改成 A 的旧名（M2a）；用户 B 改成 A 的旧用户名后，看不到 A 的 Agent 会话（M4） | M2a / M4 |
| L-20 改名后能删除别人的消息 | SEC-14 | 同上场景，删除 A 的消息返回 404 或 403 | M2a |
| L-21 任何人都能读取所有私信 | SEC-02、SEC-04 | 非成员读取私信的消息返回 404；会话 id 无法枚举 | M2a |
| L-22 任何人都能读取他人的 AI 对话 | SEC-02 | 非本人读取 Agent 会话返回 404 | M4 |
| L-23 可以向他人的私信里伪造消息 | SEC-01、SEC-02 | 非成员对私信发消息返回 404 | M2a |
| L-24 可以注册"AI助手"这样的保留名 | SEC-14 | 用保留用户名注册返回 422；把显示名设为"助手"同样被拒绝 | M1a / M2a |

基础设施类问题（迁移链断裂、生产方式启动失败、写死 `ws://` 等）没有进入上表，由 [08](08-testing.md) 中的 CI 检查覆盖：在空库上执行迁移、构建生产镜像、在 arm64 上冒烟、M7 做 HTTPS 彩排。

## 4. 每个里程碑验收前的自查清单

- [ ] 新增的接口在 contracts 中都有 zod schema，并且都经过 `authorize()` 和统一的可见性判断。
- [ ] 新增事件按接收者当前权限派发；普通提示无正文，流式来源与权限版本有效，不能仅检查 topic。
- [ ] 没有新增 `innerHTML` 等禁用写法（CI 用 `guard` 扫描）。
- [ ] 新增的配置项都有 zod 校验；生产环境缺失时会拒绝启动。
- [ ] 日志和 Sentry 里没有正文或密钥（抽查日志输出）。
- [ ] 认证链接/搜索假哨兵在应用、网关访问/错误日志、监控事件及breadcrumb中均不存在；直连API也实施解析前限额。
- [ ] 本阶段涉及的委托撤销、BYOK来源、实体版本、媒体隔离和删除journal已有对应AT证据，未实现不得标通过。
- [ ] 限流按真实客户端 IP 计数；Better Auth 的原生接口没有绕过应用规则的路径。
- [ ] 对应的 SEC 和 L 测试全部通过；M4 起，Agent 评测中安全类的结果断言 100% 通过。
- [ ] 依赖和镜像扫描没有高危问题；有高危就先修复，或在 12-decisions 里记录豁免理由。
- [ ] 如果改动影响了数据保留或管理员能看到的内容，隐私说明已同步修改。

## 5. 事件响应（简版，M8 前完善成运维手册）

- **站点 key 泄露**：
  - 立即在 DeepSeek 控制台作废，生成新 key；
  - 把新 key 写入服务器的密钥文件，并重启 worker；
  - 检查用量有没有异常。
- **`AI_KEY_ENCRYPTION_KEY` 泄露**：
  - 生成新密钥（版本号加 1），用新密钥重新加密所有自带 key；
  - 通知用户检查自己的 DeepSeek 用量，必要时在 DeepSeek 更换 key。
- **账号被盗**：
  - 站点管理员封禁该账号，注销它的所有会话，实时连接随之断开；
  - 让用户重置密码，并检查自己的 Passkey；
  - 在审计日志中排查这个账号做过什么。
- **数据泄露或越权漏洞**：
  - 先修复并部署；
  - 再评估影响范围（审计日志、访问日志）；
  - 然后通知受影响的用户，最后补上回归测试。
