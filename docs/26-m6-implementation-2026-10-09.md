# M6 实现记录（2026-10-09）

> 只记录实际执行过的命令和结果；没跑过的检查不写成通过。决策见 [12](12-decisions.md) 的 D-201 至 D-207。M6 的验收标准见 [11](11-roadmap.md) 的 M6 一节，手工项见 [08](08-testing.md) 第 10 节第 8 项。

## 1. 基线与范围

- 起点：`v2` / `7c6561e`，远端六个工作流（security、media、e2e、check、embeddings、integration）全部成功；开工前 `bun run check` 通过（后端/脚本 449、前端 609）。
- 范围按 11 的 M6：PWA（清单、图标、Service Worker、离线外壳、Window Controls Overlay、应用窗口的快捷键）；站内通知中心；浏览器推送（VAPID、订阅、`push` 队列、通知真值表、发送前复核、SSRF 防护、设置界面、标题与应用角标、V-10）；离线（隔离、7 天 / 50 MiB、24 小时待发、注销墓碑）；E2E 场景 9。
- 两个会话完成：第一个会话（上午）做完服务端、通知中心，并写了 Service Worker、推送设置、离线持久化与对应测试，但浏览器测试大多没有运行；第二个会话（下午，用户「继续完成M6」）补齐、运行并修复，见第 5 节。

## 2. 服务端（D-201 至 D-204）

- 0016 迁移：`notifications`（`dedupe_key` 唯一、翻页/未读/清理索引）、`push_subscriptions`（绑定登录会话与安装 id、`binding_version`）、`push` 工作类型、`notification` 个人变更实体。
- 自写 RFC 8291（`aes128gcm`）与 RFC 8292（VAPID，ES256），对照 RFC 8291 附录 A 官方测试向量逐字节一致，另有独立接收端往返。不引入 `web-push`（D-201）。
- 端点策略（四家推送服务名单、解析出的每个地址都必须公网）与钉 IP 的 HTTPS 传输（自写 HTTP/1.1，Bun 的 `node:https` 会忽略钉住的地址），D-203。
- 通知真值表是纯函数 `domain/notify-rules.ts`（D-202）；派生与发送分两阶段，发送前复核会话、成员与历史水位、消息状态、偏好、是否正在看、绑定版本；404/410 删除订阅。审批、提醒、预算提醒（只给管理员、不推送）的生产者。
- `POST /api/conversations/:id/messages/replay`（D-204），通知与推送订阅路由，`notification` WebSocket 事件与个人日志条目，测试环境的模拟推送服务（捕获传输，只在 `APP_ENV=test`），`setup` 生成 VAPID。

## 3. 前端

- **通知中心**：侧栏用户卡里的铃铛与面板（`features/notifications/`），状态按版本合并（`lib/notifications/`），引擎接入个人日志与 `notification` 提示，标题与应用角标的未读数（`lib/unread.ts`、`lib/page-title.ts`）。面板打开时焦点在面板本身，不落在「全部标为已读」上（第二个会话修改）。
- **Service Worker 与 PWA**（D-206、D-207）：`src/sw/`（预缓存公共外壳、导航回落、推送显示与点击、注销时忘记身份），经 Trusted Types 命名策略 `chatapp-sw` 注册；清单与图标（`tools/pwa-icons.ts` 由设计图标导出）；`theme-color` 随应用主题；Window Controls Overlay 的标题栏；⌘N 只在安装后的窗口里绑定；设置里的安装入口。
- **推送设置**（设置 → 通知）：这台设备的开关与测试通知、账号的三个开关、其他设备、安装应用；不支持或被拒绝时的说明。
- **离线**（D-205）：`lib/offline/`（记录格式、期限策略、IndexedDB 存取、读回与写入、注销清空），`lib/sync/outbox.ts` 的等网络队列与补发，消息行的「等待网络」与失败原因，离线冷启动的外壳页。
- **开发模式**：`bun run dev -- api worker pwa` 在 http://localhost:25173 提供生产构建，用于手工测安装与真实推送（09）。

## 4. 测试与结果（第二个会话，同一工作区）

| 命令 | 结果 |
|---|---|
| `bun run check`（开工复核） | 通过：Biome、7 个 tsc（新增 `tsconfig.sw.json`）、guard、后端/脚本 653、前端 705、对比度 3018 组、文案 873 键 |
| `bun run test:integration`（迁移 0016 已应用到开发库与测试库，`db:check` 通过） | **729/729**，14,987 个断言，51 个文件，186 秒 |
| M6 浏览器用例（`notifications`、`pwa`、`push-settings`、`scenario-9-push`），Chromium | **13/13**，首轮通过 |
| 同上，WebKit + Firefox 冒烟 | WebKit 5 通过、8 跳过（推送只能经 Chrome DevTools 交给 Worker；离线冷启动见下）；Firefox 2/2 |
| `offline.spec.ts` 三个引擎（修复后） | Chromium **6/6**，WebKit **5/5**（离线冷启动 1 条按设计跳过），Firefox 冒烟 **1/1** |
| `bun run test:visual`（更新并逐张查看后） | **140/140**（新增 8 张：通知中心 3 个故事、设置「通知」，各浅深两张；侧栏多了铃铛、设置多了「通知」标签的 14 张更新） |
| `bun run check`（全部修改之后） | 通过：后端/脚本 653、前端 **714**、对比度 3018、文案 874 键 |
| `bun run test:coverage` | **1174/1174**，16,422 个断言，76 个文件，317 秒；domain **94.23%**（14,723 行），agent **97.78%**，门槛 90% |
| `bun run media:configtest` | 通过（合成环境，未启动服务） |
| `bun run test:edge`（本地 Nginx 网关，生产站点配置） | 第一次失败：自签证书下浏览器拒绝注册 Service Worker 并报错（网关套件改为关闭 Worker，Worker 文件另做文件级检查）；第二次失败：Nginx 把 `/manifest.webmanifest` 当 `application/octet-stream`（加精确 location 与类型，`edge.ts configtest` 通过）；第三次 **26/26** |
| `bun run test:fault`（独立 compose.test 实例） | **18/18**，179 个断言，实例按所有权拆除 |
| 密钥检查 | 1081 个可提交文件里 `.env.local` 的密钥类值字面匹配 0（命中的只有时区、无凭据的本地地址、桶名、模型名等普通配置）；离线 gitleaks v8.30.1（`--network none`，可提交文件的副本）首次报 1 处，是 RFC 8291 附录 A 公开测试向量的 `authSecret`，按 D-106 的做法精确登记到 `.gitleaks.toml` 后 0 |
| `git diff --check` | 通过 |
| 完整浏览器回归 `bun run test:e2e` | 见第 6 节 |

## 5. 第二个会话发现并修复的问题

1. **退出时渲染进程崩溃**（只在 Chromium 无界面测试版本）：Service Worker 在注销时调用清除应用角标，浏览器以「坏消息」终止整个渲染进程，页面一起崩溃（`No binder found for interface blink.mojom.BadgeService for the service worker scope`）。两条离线用例因此失败。修复：Worker 注销时不碰角标，由页面在外壳卸载时清除（D-206）；推送到达时设置角标保留（真实 Chrome/Edge 有这项服务）。
2. **离线期间被移出又重新加入，打开着的页面会直接丢掉待发消息**，与 03 第 11 节「重新入群……保留为需人工处理的草稿」不符（重新加载的路径是对的，在线路径不对）。修复：会话级重置带原因（`forgotten` / `membership`），成员关系换成另一个时，队列里本人写的纯文本改为失败 `MEMBERSHIP_CHANGED`、去掉回复与引用，草稿和回复/编辑状态照旧清除；在途请求仍作废（D-205，补充 D-171）。新增引擎单元测试五条（每条重置路径各一），浏览器用例覆盖。
3. **通知面板的初始焦点**落在「全部标为已读」上（无未读时它是禁用态，回车易误触）：改为面板本身获得焦点（`components/ui/popover.tsx`）。
4. **安装后的窗口**：清单已声明 Window Controls Overlay，但页面没有标题栏样式，窗口按钮会盖住侧栏和工具栏、也没有可拖动的地方。新增标题栏（图标与带未读数的标题，可拖动，面板从它下面开始，浮层不作拖动区），`theme-color` 随应用主题，iOS 触控图标，⌘N（D-207）。
5. **故事数据的既有缺陷**：设置「账号」故事的设备列表缺 M5a 加的 `pendingTasks` 字段，基线里一直是错误横幅；补上后基线显示设备列表。
6. **测试侧**：两个标签页都能读到同一账号的待发记录，另一个标签页把它正常发出（同一 `clientId`，只有一条）——这是正确行为，测试改为在整个浏览器上下文拦截发送；WebKit/Firefox 里 Service Worker 控制的页面不受 Playwright `route` 拦截（消息一直停在「发送中」），用请求拦截的两条用例关闭 Worker（它们不依赖 Worker）；读本机存储前先等登录页就位。
7. **全量回归里暴露的既有用例问题**（第一次全量在 190/329 时停下来修）：① Chromium `late-session` 一条超时：外壳就绪约 300 毫秒后读一次通知列表（M6 新增），正好落在测试注销会话之后，这个请求先拿到 401、页面先回了登录页（行为正确，是测试的时序假设被打破）。登录助手 `signIn` / `signInInPlace` 改为等这次读取完成再返回。② Chromium `shell` 一条：命令面板新增「打开通知设置」，输入 settings 后从 3 项变成 4 项，按新顺序更新。③ WebKit `isolation` 一条「找不到网页框架」和 `late-answers` 全部超时：Service Worker 接管页面后，Playwright 在 WebKit 里既拦不住请求、导航还会丢框架。WebKit 与 Firefox 项目改为默认关闭 Worker，`pwa.spec.ts` 重新打开，`newContext()` 沿用项目设置；Chromium 仍带着 Worker 跑全部用例。④ 定向复跑时 WebKit 的 `late-answers`「保存编辑期间输入的内容保留」失败一次（失败时消息的「更多操作」菜单开着，回车被菜单接走），单独重复 5 次全部通过，记为偶发。

## 6. 完整回归与收尾

- **第一次全量**（`.test-runs/m6/e2e-full-1.log`）：在 190/329 时停下，失败与处理见第 5 节第 7 项。
- **第二次全量**（`e2e-full-2.log`）：329 条，**315 通过 / 1 失败 / 13 跳过**，25.2 分钟。唯一失败是新写的 `offline.spec.ts` 在 WebKit 里：第二个标签页先 `goto('/')` 紧接着 `goto('/?settings=account')`，前一次的页面内跳转打断了后一次导航；去掉多余的第一次跳转后，`offline.spec.ts` 三引擎复跑 12 通过 / 1 跳过（`e2e-offline-all-2.log`）。
- **最终全量**（修复之后、文档之外再无代码改动，`e2e-full-3.log`）：329 条，**316 通过 / 13 跳过 / 0 失败**（本地不重试），25.8 分钟。Chromium 146 通过；WebKit 134 通过、12 跳过（3 条既有：Passkey 两条、输入法一条；9 条 M6 按设计：推送设置 4 条与场景 9 的 3 条只能经 Chrome DevTools 交给 Worker，两条离线冷启动受 Playwright 在 WebKit 的离线导航限制）；Firefox 冒烟 31 通过、1 条既有跳过（Passkey）；性能 5 条通过，收发到渲染 p95 **59 ms**（40 个样本），T1 滚动 p95 16.8 ms、无长帧，T2 读到最早一条无位移，T3 跳转 86 ms 出现、无漂移，T4 未读数在读到底之前保持 100。
- 之后只改了文档；收尾的 `bun run check`（653 + 714）、`git diff --check` 在最终全量之前、所有代码修改之后运行并通过。

**不能用自动化代替的**（第 7 节）：安装为应用与 Window Controls Overlay 的外观、应用窗口里的快捷键（V-16）、经真实推送服务的系统通知（关闭页面后）、V-10。远端 CI 要在提交推送之后才有结果。

## 7. 仍需本人或真机完成

- **安装与 Window Controls Overlay**、**V-16 的应用窗口**（含 ⌘N）、**关闭页面后的真实推送**、**V-10 中国大陆网络**：步骤见 08 第 10 节第 8 项（`bun run dev -- api worker pwa`，http://localhost:25173）。
- 本人试用与验收确认；提交、推送与远端 CI（需要用户同意）。

## 后续独立验收（2026-10-11）

本人已指示「验收M6，然后提交推送」，并确认安装/WCO、应用窗口快捷键及关闭页面后的真实推送前三项通过；V-10 未测，仍保留到 M8 前补测。本报告的 10 月 9 日实现与验证记录原样保留，本轮新复现、修复、回归与提交证据见 [27](27-m6-acceptance-2026-10-11.md)。
