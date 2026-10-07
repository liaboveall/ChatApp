# M3 审查修复与验证（2026-10-07，Codex）

基于 [19 的独立审查](19-m3-acceptance-review-2026-10-06.md)，在 v2 / fb4abcb 及已有全部未提交 M3 改动上修复，保留原有工作。不代表独立复验或用户验收。决定见 D-181。

## 修复对照

| 项目 | 实现与回归 |
|---|---|
| R1 | contracts 的 plainMessageText 共用于服务端预览/引用和客户端侧栏、引用、待发引用、输入栏回复条；解析名字后截断，未知名字不显示 id，纯附件有类型说明。服务端预览在原有查询里取提及名字，引用批量读取且受可见性约束。客户端派生摘要保留完整提及来源，到纯文本出口再解析/截断，避免源消息编辑及待发引用切断 UUID。真实测试库验证改名与纯文件引用；浏览器验证侧栏、回复条与已发送引用。 |
| R2 | 0006 新增 metadata_cleared；媒体结果持久化并返回，文件下载卡片显示未清理警示。封装超额在原件不超预占时退回下载，保留原始 hash；预占不足仍拒绝。真实增长的视频样本、FFV1 业务链和浏览器卡片/下载验证。 |
| R3 | 注册/租约、通用清理、附件清理、存储对账独立运行并容错；进程内 guard + Postgres advisory lock 防同任务并发。完整存储对账 6 小时一轮，失败 15 分钟再试；LIST 账本批读、live HEAD 100 一批、只修用户差额且不锁全站计数。真实数据库验证 Garage 不可用仍释放过期注册、两个 worker 跳过同一在途任务及异常释放锁。未做 1000 用户真实 ARM 负载实测。 |
| R4 | 场景 6 保留真实请求与响应，并持有上传预占来稳定观察进度；断言实际 thumb 请求与 naturalWidth，preview 变体，图片 original 的 Content-Type、inline、nosniff、sandbox、private/no-store 和真实下载文件名。 |

## P3 优化

- 状态读取退避并由 attachment.updated 提示提前唤醒；只有鉴权 HTTP 回答能改变结果。429 按 Retry-After 等待，不标成永久上传失败；单元测试验证退避、提示、限流等待与取消。
- 上传错误给出配额、容量、限流等本地化原因；HEIC/SVG 不受浏览器 image/* 的 20 MiB 误拦截。
- 灯箱读取已生成 preview，下载仍用 original。
- 共享文件仅附件相关的时间线变化触发刷新；刷新保留已加载页数，撤回/隐藏立即过滤；单元与浏览器回归。
- 会话头像绑定前重新读当前 metadataVersion；个人头像也遵守请求发起时身份。
- 中断 multipart 写入先等待 writer 结束，再删除可能提交的部分对象；真实 Garage 11 MiB 断流用例确认对象不存在，删除失败继续由原有 intent 账本兜底。
- 超限业务测试改用新预占的真实 uploadId；下载权限补群聊、频道、私信，匿名、成员、陌生人、站点管理员，以及 Range/条件请求拒绝一致性（仅 requestId 是每个响应的随机标识）。
- 提及候选改为关联输入框的 listbox/options，宣布活动选项并支持 Escape；表情集扩充且面板限高滚动；media upload-artifact 与仓库既有工作流统一 v7。

## 运行证据（验收与推送前的本机记录）

本机 WSL Linux x64 / Docker Desktop。共享测试库的套件顺序执行；媒体与真实业务链从当前 checkout 构建独立实例，未借用开发镜像作本轮证据。仅按各自所有权凭据清理测试实例，未替换原有开发 worker/media，也未启动开发 API/网页。0006 已应用开发与测试库，保留开发数据。

| 命令 / 证据 | 最终结果 |
|---|---|
| 针对性 attachments / maintenance / registration 集成 | 59 通过 / 0 失败，495 断言 |
| `bun run check` | 退出 0：353 后端/脚本/媒体单元 + 590 前端单元；lint、类型、guard、3018 组对比度、651 键 × 2 语言 |
| `bun run test:coverage` | 737 通过 / 0 失败，14708 断言，126 秒；domain/ 行覆盖率 97.70%（7567 行、35 文件，门槛 90%） |
| `bun run test:media` | 846845bd：56 通过 / 0 失败 / 0 未执行，实例已核验清理；增长视频单项先在 37268285 通过 |
| `bun run test:attachments` | 1086e8d3：真实 API/worker/Garage 完整业务链通过，实例核验后已清理 |
| `bun run test:m3:edge` | e8c666c0：同一业务链经真实 TLS/Nginx 通过；实例及本轮网关已移除 |
| `bun run test:m3:e2e` | 8 通过 / 0 失败 / 0 重试，Chromium 4 + WebKit 4，50 秒；保持加强后的断言 |
| `bun run test:e2e` | 244 通过 / 4 既有跳过 / 0 失败 / 0 重试，17.6 分钟；Chromium、WebKit 全量 + Firefox 冒烟 + 性能 |
| `bun run test:visual` | 106 通过 / 0 失败，24.2 秒，没有更新截图基线 |
| `bun run test:fault` | 16 通过 / 0 失败，163 断言；4d5c1eb5，独立实例核验后已移除 |
| `bun run test:edge` | 25 通过 / 0 失败，30.7 秒；本轮网关已移除 |
| `bun run db:migrate:test`、`bun run db:migrate` | 0006 两库应用成功，没有重置开发数据 |
| `bun run db:check`、`bun run media:configtest`、`git diff --check` | 退出 0 |
| `bun audit --audit-level=high` | 退出 0，无 high；1 个低于该级别，仍为既有 esbuild moderate（D-105） |

两条真实附件业务链都包含 9 次上传、3 种头像、6 个消息附件，以及真实 100 MiB、预占超限、元数据落库、不可覆盖重放、Range、用途可见性、撤回与账本。完整 E2E 的收发到渲染 p95 为 54 ms，T1 帧 p95 为 16.7 ms；T2 的 100 次历史加载无重试、锚点最大偏移 0，T1–T4 全部通过。

本机日志：`/tmp/m3-check-final.log`、`/tmp/m3-targeted.log`、`/tmp/m3-coverage-final.log`、`/tmp/m3-media-final.log`、`/tmp/m3-attachments.log`、`/tmp/m3-edge.log`、`/tmp/m3-browser-final.log`、`/tmp/m3-e2e.log`、`/tmp/m3-visual.log`、`/tmp/m3-fault.log`、`/tmp/m3-core-edge.log`、`/tmp/m3-audit.log`。无凭据媒体结果：`.test-runs/m3/846845bd/result.json`；直连与 TLS 业务结果分别为 `.test-runs/m3/1086e8d3/business-result.json`、`.test-runs/m3/e8c666c0/business-result.json`。

**本轮本地修复与完整回归完成。** 原生 ARM、远端 CI、用户试用尚无本轮结果，真实读屏/硬件与 1000 用户 ARM 负载也未实测；修复方结果不替代独立复验。未提交、推送、部署或开始 M4，M3 仍待里程碑验收。

## 首次验证发现与修正

- 新 SQL 预览关联在 Drizzle 单表选择中会去掉列的表名，子查询 id 被错误绑定到内层 users/attachments。真实数据库回归识别后改成显式 messages.id；修复后提及名字及附件说明断言通过。
- 完整集成首轮 732 通过 / 5 失败：附加空 attachmentKind 改变了旧响应形状，system 预览 null 变成空字符串。恢复无附件/撤回/系统消息的原契约，仅活附件输出类型字段；保留原有严格断言后复跑。
- 新增长视频样本最初未加入隔离测试工具的白名单；首轮 2352a28f 执行 15 通过 / 1 白名单失败 / 40 未执行后主动停止，实例已核验清理。补入固定样本白名单后重新验证；首轮不是通过证据。
- M3 浏览器首轮 5 通过 / 3 失败：Escape 关闭提及候选后，编辑草稿未清除关闭标记，同一查询不会再次打开（两个引擎均复现），已修复；WebKit 的二进制 PUT 被测试代理转发后返回 422，头像版本竞争改为持有真实 JSON 预占请求、期间改群名再交付原请求。同时头像裁剪保存等图片真正解码完成后才启用。加强断言保持，复跑两个引擎全部通过。
- 开发环境 Docker Desktop 当时未运行；已启动既有应用并核验基础设施 6 个端口可连接，没有安装软件或删除开发卷。
- 故障实例启动第一次遇到 Docker Desktop 既有内部 bind-mount 路径错误；测试工具按原有规则核验回收本轮实例后重建，第二次启动完成并跑完 16 项测试，没有放宽断言或容器所有权检查。

## 用户验收与提交推送（2026-10-07）

上述修复与完整本地回归交付后，你明确回复「已验收，提交推送吧」。该确认记录为用户验收，授权完整 M3 实现及本轮修复提交推送到 `v2`；未授权生产部署或开始 M4。本次提交与远端工作流（含原生 ARM）的实际结果以 PROGRESS 最新交接为准，不以本机或用户确认替代远端证据。

## 推送后的原生 ARM 证据

完整实现与修复已提交并推送到 `origin/v2` 的 `f0c294bbe034fb2ea105e21cdd5c3f666d4323c6`。其 [media 运行 37553991861](https://github.com/liaboveall/ChatApp/actions/runs/37553991861) 成功；下载并核验 metadata artifact，原生 Linux arm64（45233ca2）和 x64（8f82afa2）均为 56 通过 / 0 失败 / 0 未执行，清理为 verified-run-only-removed。ARM 的完整真实附件业务链 4b84d909、x64 的 3c6f4c73 均为 pass，包含真实 100 MiB、预占限额、元数据落库、Range、用途可见性、撤回与账本。资源和隔离要求保持原值，不以 QEMU 替代原生 ARM。各工作流、完整 SHA、artifact 编号与浏览器最终结果见 PROGRESS 最新交接；本节不改变前述本机/独立审查的历史基线，也不代表生产混合负载或真实设备已验证。

功能提交的五个远端工作流已全部 success，完整 E2E 为 244 通过 / 4 既有跳过 / 0 失败 / 0 重试，M3 浏览器为 8 通过 / 0 失败 / 0 重试，视觉 106 通过；详见 [e2e 运行 37553991835](https://github.com/liaboveall/ChatApp/actions/runs/37553991835) 和 PROGRESS 的完整运行对照。后续补充记录的提交只改文档，其 CI 状态须按它自己的 SHA 核对，不以本功能提交的成功代替。
