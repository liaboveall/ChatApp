# 07 安全规范

> 每个里程碑验收前都要对照本文件自查。每条 SEC 要求至少对应一个自动化测试（见 [08](08-testing.md)）。
> 旧版的 24 个缺陷见 [13-legacy-analysis.md](13-legacy-analysis.md)，它们的回归测试在第 3 节列出。

## 1. 威胁模型

**需要保护的资产**
- 私信、群组和 Agent 会话的内容；
- 附件；
- Agent 的长期记忆；
- 用户账号和会话；
- DeepSeek API 额度，也就是钱；
- 站点管理员权限。

**可能的攻击者**
| 攻击者 | 能力 | 主要风险 |
|---|---|---|
| 外部人员（没有邀请码） | 只能访问公开页面和接口 | 暴力破解登录、猜测或滥用邀请码、借 SSRF 或上传漏洞入侵、刷接口 |
| 恶意成员（已注册） | 合法会话，能在群里发内容 | 越权读取、冒充他人、XSS、恶意上传、在消息里埋注入指令操纵 Agent、刷屏、刷 AI 额度 |
| 被盗的账号 | 拿到了某个用户的会话 | 冒用此人的权限；需要让用户能看到设备并注销，并限制破坏范围 |
| 恶意内容 | 网页、文件、聊天记录中嵌入的指令 | 诱导 Agent 泄露数据或执行操作 |
| 网络窃听者 | 能监听网络流量 | 生产环境全程 HTTPS，使用 HSTS 和 Secure Cookie |

## 2. 安全要求

| 编号 | 要求 |
|---|---|
| **SEC-01** | 用户身份**只**从服务端会话获取。请求体和 WebSocket 消息里任何表示"我是谁"的字段（比如 username、senderId），一律忽略或直接拒绝 |
| **SEC-02** | 所有会话相关的读写（HTTP、WebSocket 订阅、附件下载、Agent 工具）都必须经过 `authorize(user, conversation, action)`。对无权访问的私有资源一律返回 404 |
| **SEC-03** | WebSocket 必须登录后才能连接，`Origin` 必须等于 `APP_ORIGIN`；订阅哪些频道只由服务端根据成员关系决定，客户端不能自选 |
| **SEC-04** | 所有对外暴露的 id 都用 UUIDv7，不使用可以枚举的自增 id 或可以拼出来的名字（旧版的 `private_1_2` 就是反例） |
| **SEC-05** | 前端**禁止**用 `innerHTML` 或 `dangerouslySetInnerHTML` 渲染用户内容。Markdown 渲染时禁止原始 HTML；链接只允许 `http`、`https`、`mailto` 三种协议，外链加 `rel="noopener noreferrer"` |
| **SEC-06** | 设置 CSP：`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'`。并尝试开启 Trusted Types（`require-trusted-types-for 'script'`），能不能开由 M7 评估 |
| **SEC-07** | 上传：边接收边检查大小上限，超出立即中止；根据文件开头的字节判断真实类型；按白名单决定是在页面里直接展示还是只能下载；图片重新编码以去除 EXIF；svg、html、xml 等文本类格式一律只能下载；存储路径用随机 key，原始文件名只用于显示 |
| **SEC-08** | 附件下载前必须鉴权（上传者本人，或附件所在会话的成员）。响应头要求：`Content-Type` 为经过判断的安全值；`Content-Disposition` 只有图片、音视频才用 `inline`，其余一律 `attachment`；`X-Content-Type-Options: nosniff`；`Content-Security-Policy: sandbox`；`Cache-Control: private` |
| **SEC-09** | 注册必须持有有效的邀请码；邀请码只存哈希，可以设置过期、限制次数、随时撤销；检查邀请码和注册的接口按 IP 限流 |
| **SEC-10** | 密码至少 10 位，并用本地的常见弱密码表拦截弱密码；密码哈希使用 Better Auth 的默认算法 |
| **SEC-11** | 登录、注册、重置密码都有限流（Better Auth 自带的限流，计数存在 Valkey）；错误提示不透露某个账号是否存在 |
| **SEC-12** | Cookie 设为 `HttpOnly`、`SameSite=Lax`；生产环境加 `Secure`，并使用 `__Host-` 前缀（如果 Better Auth 不支持，就用 `__Secure-`，并确保不设置 `Domain`） |
| **SEC-13** | 所有非 GET 请求都校验 `Origin`（Better Auth 的 `trustedOrigins` 加上我们自己的中间件）；API 只接受 JSON 或 multipart，拒绝普通表单格式 |
| **SEC-14** | 用户名有格式规则和保留名单；所有数据都通过用户 id 关联；改名有 30 天冷却期，旧用户名保留 30 天，不能被别人立刻注册 |
| **SEC-15** | 撤回和删除时真正清除正文、附件文件和向量；注销账号时按 INV-11 清除数据 |
| **SEC-16** | 限流覆盖消息、上传、Agent 运行、@Agent 触发、正在输入事件，以及每个用户的 WebSocket 连接数（见 01 第 7 节） |
| **SEC-17** | Agent 必须遵守 [06 第 11 节](06-agent.md) 的 A1–A10 |
| **SEC-18** | 启动时校验配置：生产环境缺少密钥、密钥太短或仍是示例值，都拒绝启动；错误响应里不包含堆栈和内部信息 |
| **SEC-19** | 日志不记录消息正文、AI 的提示词和输出、密码、令牌、Cookie 和 API key |
| **SEC-20** | 依赖锁定精确版本，用 Renovate 自动提升级 PR；CI 运行 `osv-scanner`（查依赖漏洞）、`trivy`（查镜像漏洞）、`gitleaks`（查泄露的密钥） |
| **SEC-21** | 站点管理员和会话管理员的操作，以及站点管理员查看敏感内容（举报上下文、Agent run 详情），都要写入审计日志 |
| **SEC-22** | 安全响应头：生产环境开启 HSTS（`max-age=31536000; includeSubDomains`）；`Referrer-Policy: strict-origin-when-cross-origin`；`Permissions-Policy: camera=(), geolocation=(), microphone=()`；`Cross-Origin-Opener-Policy: same-origin` |
| **SEC-23** | 服务端不去抓取用户提供的 URL（链接预览、Agent 读网页都是上线之后的功能），届时必须做 SSRF 防护：禁止内网、回环、链路本地和元数据服务地址，每次重定向后重新检查，并限定协议、大小和超时 |
| **SEC-24** | WebSocket 单帧最大 64 KB；每条消息都用 zod 校验；收到未知类型的消息，回一条 `error` 事件 |
| **SEC-25** | Passkey 的 RP ID 与站点域名一致；本地开发用 `localhost` |

## 3. 旧版缺陷 → 新要求 → 回归测试

编号 L-xx 对应 [13-legacy-analysis.md](13-legacy-analysis.md)。回归测试统一放在 `apps/server/test/security/legacy.test.ts`（接口层和 WebSocket 层），以及 `apps/web/e2e/security.spec.ts`（界面层）。每条测试的标题都以 `L-xx` 开头。

| 旧缺陷 | 新版的保证 | 回归测试断言 |
|---|---|---|
| L-01 纯中文房间名导致创建报 500 | 会话用 UUID 标识，名称只用于显示 | 创建"测试房间"频道成功，访问正常 |
| L-02 一个中文名房间让全站所有页面 500 | 同上，页面渲染不再依赖名称拼出的 slug | 创建之后，首页和登录页依然返回 200 |
| L-03 第二个中文名房间撞上唯一约束 | 频道名唯一性按不区分大小写的名称判断 | 两个不同的中文名都能创建；名称完全相同时返回 409 |
| L-04 私密房间的密码可以被绕过 | SEC-02：群组没有"密码"，只能被拉入或凭群邀请链接加入 | 非成员读取群组消息返回 404 |
| L-05、L-06 聊天记录被渲染成页面顶部的横幅 | 前端重写（React），没有模板变量重名的问题 | E2E：私信页和 Agent 页都不出现错误横幅 |
| L-07 超过时限的消息仍显示撤回按钮 | 服务端和客户端都按时间戳计算时限 | 3 分钟前的消息返回 `WINDOW_EXPIRED`，界面上也没有撤回按钮 |
| L-08 页面样式没有生效 | 改用 Tailwind 和组件库；关键组件做截图对比测试 | Storybook 截图对比通过 |
| L-09 可以冒充他人发言 | SEC-01 | 请求体里带 `senderId` 或 `username` 会被忽略，消息的发送者是会话本人 |
| L-10 可以把消息写进别的房间 | SEC-01、SEC-02：会话 id 取自 URL，并检查成员关系 | 对非成员的会话发消息返回 404 |
| L-11 实时消息存在 XSS | SEC-05、SEC-06 | E2E：发送 `<img src=x onerror=…>` 后，页面显示为文本，脚本没有执行 |
| L-12 上传 html 文件后被当作网页在同源打开 | SEC-07、SEC-08 | 上传 `pwn.html` 后，`kind` 为 `file`，下载时的响应头是 `attachment` 加 `nosniff` 加 `sandbox` |
| L-13 私聊 WebSocket 匿名也能连接 | SEC-03 | 不带 Cookie 连接，被以 4401 关闭 |
| L-14 AI 的 WebSocket 匿名也能连接 | SEC-03：只有一个 `/ws`，必须登录 | 同上；匿名调用 `POST /api/agent/runs` 返回 401 |
| L-15 AI 页面删除消息时报错 | 写操作统一走 HTTP 接口 | 在 Agent 会话里撤回和删除都成功 |
| L-16 中文名房间在推送层串消息 | 推送频道以 UUID 命名（`conv:{uuid}`） | 两个中文名会话互相收不到对方的事件 |
| L-17 "是不是当前用户"的标记算错人 | 在线状态事件里没有这个字段，由客户端自己判断 | 在线状态事件的结构里不含 `is_current` |
| L-18 多标签页关掉一个就显示离线 | 按连接数统计在线状态（Valkey 有序集合） | 开两个连接、关掉一个，状态仍为 online |
| L-19 改名后能读到别人的 AI 历史 | SEC-14：一切按用户 id 关联；Agent 会话属于某个用户 id | 用户 B 改成 A 的旧用户名后，看不到 A 的 Agent 会话；30 天内也不能改成 A 的旧名 |
| L-20 改名后能删除别人的消息 | SEC-14 | 同上场景，删除 A 的消息返回 404 或 403 |
| L-21 任何人都能读取所有私信 | SEC-02、SEC-04 | 非成员读取私信的消息返回 404；会话 id 无法枚举 |
| L-22 任何人都能读取他人的 AI 对话 | SEC-02 | 非本人读取 Agent 会话返回 404 |
| L-23 可以向他人的私信里伪造消息 | SEC-01、SEC-02 | 非成员对私信发消息返回 404 |
| L-24 可以注册"AI助手"这样的保留名 | SEC-14 | 用保留用户名注册返回 422 |

基础设施类问题（迁移链断裂、生产方式启动失败、写死 `ws://` 等）没有进入上表，由 [08](08-testing.md) 中的 CI 检查覆盖：在空库上执行迁移、构建生产镜像、M7 做 HTTPS 彩排。

## 4. 每个里程碑验收前的自查清单

- [ ] 新增的接口在 contracts 中都有 zod schema，并且都经过 `authorize()`。
- [ ] 新增的推送事件都只发给有权限的频道。
- [ ] 没有新增 `innerHTML` 或 `dangerouslySetInnerHTML`（CI 用规则扫描）。
- [ ] 新增的配置项都有 zod 校验；生产环境缺失时会拒绝启动。
- [ ] 日志里没有正文或密钥（抽查日志输出）。
- [ ] 对应的 SEC 和 L 测试全部通过；M4 起 Agent 评测中的安全类用例 100% 通过。
- [ ] 依赖和镜像扫描没有高危问题；有高危就先修复，或在 12-decisions 里记录豁免理由。

## 5. 事件响应（简版，M8 前完善成运维手册）

- **API key 泄露**：立即在 DeepSeek 控制台作废，生成新 key，写入服务器的密钥文件并重启 worker；检查用量有没有异常。
- **账号被盗**：站点管理员封禁该账号，注销它的所有会话；让用户重置密码并检查自己的 Passkey；在审计日志中排查这个账号做过什么。
- **数据泄露或越权漏洞**：先修复并部署，再评估影响范围（审计日志、访问日志），然后通知受影响的用户，最后补上回归测试。
