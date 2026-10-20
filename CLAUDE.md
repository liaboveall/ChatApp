# ChatApp 维护约定

用中文与用户交流。项目已上线，当前维护主线为 `main`（原 `v2`）。Django 旧版保存在 `archive/v1` 和 `v1-legacy`；清理前的完整源码、规划、评审及原型保存在 `v2-pre-cleanup-2026-10-20`。

## 开工顺序

1. 检查 Git HEAD、分支、工作区改动和用户最新要求。
2. 从 `docs/00-overview.md` 找到本次涉及的规格；日常开发看 `docs/09-local-dev.md`，部署看 `docs/10-deployment.md` 和 `docs/operations.md`。
3. 历史 D-xxx、AT-xxx 和阶段证据需要时再查归档标签；它们不是当前待办或新的提交、部署授权。现行维护原则见 `docs/12-decisions.md`。

## 实现约定

- TypeScript 严格模式；不新增 `any`、`@ts-ignore` 或跳过测试。
- 外部输入使用 `packages/contracts` 中的 Zod schema；业务逻辑集中在 `apps/server/src/domain/`，其他层调用领域服务。
- HTTP / WS 身份来自服务端 session；后台任务使用受限持久 delegation。所有会话资源读写统一授权，无权私有资源返回与不存在一致的 404。
- 消息可见性要求当前成员且 `seq > visible_from_seq`，引用、预览、搜索和附件逐项投影。共享 Agent 不得读取当前共享范围之外的内容；流式输出逐批复核权限。
- 业务变更、同步日志与 `work_items` 同事务；Valkey 队列可恢复。HTTP 写操作带幂等键，普通 WS 只传提示与瞬时信号。
- 前端请求以发起时的登录与成员关系为准。屏幕写请求经 `forScreen`，同步响应携带 `engine.ticket()`；会话状态向 `registerConversationReset` 登记。退出取消在途请求，迟到响应不得更改状态或 Cookie。
- 前端不使用原始 HTML 写入点渲染用户内容；Markdown 禁止原始 HTML。令牌来源为 `apps/web/src/design/tokens.ts`，修改后运行 `bun run design:contrast`。
- 影响他人的 Agent 操作先审批；同库效果与 `agent_effects` 同事务去重。模型、邮件、推送不宣称恰好一次，未知结果不得盲目重试。
- 私有 BYOK 内容不自动进入站点密钥上下文。隐私、管理员可见范围及保留期变化须同步规格和界面说明。
- 媒体解码只在无网络、无业务凭据的独立容器运行。删除依赖异地 journal；恢复缺可信证据时保持隔离。
- 保留完整数据库迁移链。测试、Storybook、开发启动工具及备份恢复工具都是维护设施，不能当作一次性脚手架删除。

## 验证与操作

- `bun run check`、`bun run build` 是常规本地检查；按改动补跑相关套件。集成测试用真实 PostgreSQL、Valkey、Garage，只模拟外部服务。
- 没跑过的检查不能说通过；区分本地、模拟浏览器、真实服务、CI、生产和人工证据。记录命令、结果、失败与限制，历史结果只对原版本有效。
- 使用共享测试库的集成、coverage、E2E、edge 串行运行；构建、视觉与媒体浏览器套件避免同时覆盖 `dist`。
- 故障测试仅操作经过归属验证的独立测试实例。生产停机、数据卷删除、部署和外部付费调用需要对应授权。
- 提交、推送、打标签及分支操作须有用户授权；当前任务已经明确授权的无需重复询问。生产变更不由仓库清理授权推导。
- 不输出 `.env.local`、私有部署配置或 `.test-runs/` 的密钥与凭据；它们不提交。清理源码不删除恢复材料、数据库或数据卷。
- 本地环境按仓库配置与实际检测结果处理，不依赖历史机器路径或端口占用记录。
