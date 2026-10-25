# 测试与验证

## 本地检查

```sh
bun run check
bun run build
```

`check` 包含 Biome、全部工作区类型检查、架构与密钥边界、后端及前端单元测试、设计令牌对比度、双语文案一致性。`build` 生成生产前端，检查生成的路由树未意外变化。

| 命令 | 范围 | 环境 |
| --- | --- | --- |
| `bun run test:unit` | scripts、contracts、db、server、media、Web 单元测试 | 无需基础服务 |
| `bun run test:integration` | 集成、安全、契约与实时回归 | PostgreSQL、Valkey、Garage |
| `bun run test:coverage` | 后端覆盖率与 domain 门槛 | 同上，独占测试库 |
| `bun run test:e2e` | 真实服务浏览器场景 | 基础服务、媒体、Playwright |
| `bun run test:review` | 组件和审查问题回归 | 合成 HTTP 数据、Chromium / WebKit |
| `bun run test:edge` | Nginx、TLS、安全头与代理边界 | Docker、基础服务、独占测试库 |
| `bun run test:visual` | Storybook 截图基线 | Docker 中固定 Playwright 镜像 |
| `bun run test:fault` | 进程、队列、总线等故障恢复 | 自动创建并核验的隔离实例 |
| `bun run test:media` | 无网络媒体运行时与故障 | 隔离 Docker 实例 |
| `bun run test:attachments` | 真实上传、媒体处理、对象账本与下载 | 隔离 Docker 实例 |
| `bun run test:m3:e2e` | 真实解码的浏览器链路 | 隔离媒体栈、Playwright |
| `bun run eval` | 冻结语料的真实模型评测 | 所选 provider 凭据，真实外部调用 |

`test:m3:*`、`test:m4:*`、`test:m5:*`、`test:m7:*` 保留历史命名，是仍在使用的回归入口；完整清单见根 `package.json`。生产包验证、扫描、备份恢复及压测入口见[运维命令](operations.md)。

## 准备真实服务测试

```sh
bun run infra:up
bun run infra:bootstrap
bun run db:migrate:test
bun run test:integration
```

集成测试使用真实 PostgreSQL、Valkey、Garage，只模拟外部模型、邮件和推送服务。单个文件从根目录用 `bun --env-file=.env.local test ./apps/server/test/<目录>/<文件>` 运行。

共享测试库的 integration、coverage、普通 E2E、edge 必须串行。媒体栈虽然独立，浏览器、混合负载、发布包和网关构建仍不能同时覆盖共享 `dist`。故障脚本只操作已核验归属的独立 Compose 项目，不能指向开发或生产实例。

## 回归重点

- 身份与权限：同浏览器换人、迟到响应、旧请求 401 / Cookie、成员撤销、加入前历史、私有资源统一 404。
- 实时与持久任务：断线补齐、固定上界分页、尾事件对账、队列重建、幂等、通知补偿。
- Agent：共享来源范围、BYOK 隔离、审批、未知调用预算、停止与重生成、注入防护。
- 媒体：格式与资源限制、无网络执行、不可变对象、Range、撤回后的拒读及物理清理。
- 恢复：一致快照、删除 journal 重放、删除不复活、权限再确认、旧凭据失效、外发封锁。
- 界面：中英双语、深浅主题、桌面与窄屏、键盘焦点、对话框、异步失败与账号切换。

测试夹具新建浏览器上下文应复用 `apps/web/e2e/support/fixtures.ts`，保持 CSP 违规与意外控制台错误检查。模拟断网用支持库中的网络控制工具，以同时覆盖 WebSocket。

Storybook 与 `apps/web/review/` 是回归设施；合成数据测试不能证明真实后端或生产环境正常。

视觉测试通过 `apps/web/visual/clock.ts` 固定浏览器日期，计时器继续运行。截图夹具使用固定日期时不能依赖真实日历；邀请码等到期状态另有过去 / 未来日期的明暗主题回归。不要通过顺延夹具、增加像素容差或覆盖基线消除日期漂移。

## CI

`.github/workflows/` 包含 check、integration、e2e、media、embeddings、images、security，以及仅手动触发的真实 provider eval。所有工作流均不设定时触发；其余工作流保留 push、pull_request 和原有的手动触发配置。开发主线统一为 `main`；原生 ARM、镜像、安全扫描、真实服务与浏览器结果分别取证。

推送后检查当前提交的所有最终作业，不以旧 SHA 的绿色结果替代。评测依赖凭据、人工审核或外部服务时，按实际完成范围记录，失败、跳过和重跑原因保留。

## 生产与人工验证

上线状态不代替容量、恢复、运维与真机证据。目标容量仍按实际负载验证，包括 1000 用户、百万消息、约 10GB 对象、500 WebSocket，以及 AI、媒体、备份与清理重叠；轻量 smoke 不能用于推断目标容量。备份恢复目标为 RPO ≤24 小时、RTO ≤4 小时，完整 RTO 包含环境与服务入口恢复。

安装、系统通知、浏览器快捷键、硬件 Passkey、读屏和中国大陆无代理网络需要真实设备与网络验证。整机不可访问的独立恢复需要维护窗口与操作授权。

历史 AT-01–AT-37、V-xx、人工验收、初次失败和重跑细节保存在[清理前测试规范](https://github.com/liaboveall/ChatApp/blob/v2-pre-cleanup-2026-10-20/docs/08-testing.md)及[历史进度](https://github.com/liaboveall/ChatApp/blob/v2-pre-cleanup-2026-10-20/docs/PROGRESS.md)，不能将历史结果写成当前版本已通过。

每次变更记录源码版本、命令、环境、实际结果与限制。本地运行输出可能包含测试账号、令牌与私有路径；`.test-runs/` 不提交，CI 仅上传经过筛选的无凭据结果。
