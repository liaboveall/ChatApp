# 文档索引

ChatApp 已上线，`main` 为维护主线。首次了解项目从[README](../README.md)开始。

## 开发与维护

| 文档 | 内容 |
| --- | --- |
| [本地开发](09-local-dev.md) | 环境、初始化、开发服务、AI 配置与常见问题 |
| [测试指南](08-testing.md) | 检查入口、环境隔离、回归与证据范围 |
| [部署指南](10-deployment.md) | 发布包、更新、回滚、生产配置与备份原则 |
| [运维命令](operations.md) | 归档绑定、首次初始化、备份、恢复和压测工具 |
| [维护原则](12-decisions.md) | 当前产品、安全、工程约束及历史决策查阅方法 |
| [维护记录](maintenance.md) | 分支归档、清理范围和历史资料入口 |

## 产品与技术参考

| 文档 | 内容 |
| --- | --- |
| [产品规格](01-product-spec.md) | 聊天、Agent、管理、隐私与默认行为 |
| [设计规范](02-design-system.md) | 视觉令牌、布局、交互与组件 |
| [架构](03-architecture.md) | 服务分层、数据流、实时同步与任务 |
| [数据模型](04-data-model.md) | 表结构、不变量、迁移与保留期 |
| [接口与实时协议](05-api-and-realtime.md) | REST、DTO、WebSocket 与同步契约 |
| [Agent 设计](06-agent.md) | 工具、权限、审批、上下文与评测 |
| [安全规范](07-security.md) | 威胁模型、SEC 编号与安全回归 |

规格中的 M1–M8、D-xxx、AT-xxx 是历史实施与追踪编号。版本和行为以当前代码、契约、迁移及实测为准；历史验收结论只适用于记录中的源码与环境。

## 历史资料

- [v1 源码](https://github.com/liaboveall/ChatApp/tree/v1-legacy)：Django + Channels 版本。
- [清理前 v2](https://github.com/liaboveall/ChatApp/tree/v2-pre-cleanup-2026-10-20)：完整规划、路线图、决策、阶段报告、失败记录及 HTML 原型。
- [历史进度](https://github.com/liaboveall/ChatApp/blob/v2-pre-cleanup-2026-10-20/docs/PROGRESS.md)、[历史决策](https://github.com/liaboveall/ChatApp/blob/v2-pre-cleanup-2026-10-20/docs/12-decisions.md)。

被忽略的本地运行回执和私有恢复材料仍由维护者另行保管，Git 标签不包含未提交文件。
