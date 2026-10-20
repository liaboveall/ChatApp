# 部署与运维

线上入口为 [chatapp.software](https://chatapp.software)。本仓库负责源码与运维工具，生产状态以服务器实际版本、私有配置和部署回执为准；仓库分支切换不自动更新线上实例。

## 发布结构

- `infra/compose.prod.yml` 定义 API、worker、媒体、PostgreSQL、Valkey、Garage 及一次性运维服务。
- 宿主 Nginx 终结 TLS，提供版本化静态资源并代理 API、WebSocket 与附件；模板在 `infra/nginx/`。
- `scripts/production.ts` 生成带源码指纹、归档哈希和不可变镜像 ID 的原生架构发布包。
- 生产配置、keyring、备份凭据与恢复材料在 Git 之外保管；开发 `.env.local` 不能直接用于生产。

具体初始化、配置绑定、备份、恢复和压测命令见[运维命令](operations.md)。所有命令应匹配发布包中的工具版本，不用当前 checkout 的工具猜测旧包行为。

## 准备候选

在与目标一致的原生架构构建机上，使用尚不存在的输出目录：

```sh
bun --no-env-file scripts/production.ts package .test-runs/release-candidate
bun --no-env-file scripts/production-image-smoke.ts .test-runs/release-candidate/release.json
bun --no-env-file scripts/test-production.ts .test-runs/release-candidate/release.json
bun --no-env-file scripts/production-scan.ts .test-runs/release-candidate/release.json
```

`release.json` 绑定 Git SHA、源码 hash、归档大小与 SHA-256、镜像 ID。dirty 候选必须以源码指纹区分，不能只记基线 SHA；构建中源码变化时重新打包。ARM64 与 x64 分别准备完整归档，恢复不得依赖源主机或临时重新拉取镜像。

镜像 smoke、生产 Compose 彩排、扫描和目标服务器验证各有不同范围。彩排使用隔离服务与模拟异地存储，不能代表真实 R2、整机失效恢复或目标容量通过。

## 生产配置

私有目录由 root 管理（目录 700、文件 600），供容器读取的 runtime 文件使用实际容器 UID。应用、数据库 owner、备份及 Garage 管理权限分开；媒体无业务凭据、无网络、只读根文件系统。

删除 journal 与加密备份分别使用私有桶和只对单桶授权的不同凭据。关闭公开桶入口，生产与测试使用不同桶 / 前缀，不将凭据写进 README、源码、聊天或日志。SMTP、AI、Sentry、证书与 DNS 按实例配置核验。

准备工具默认生成拒绝访问的策略；实际公开或受限范围由经过确认的生产网关配置决定。本站不设 `default_server`，不更改同机其他站点。

首次部署使用 `db:bootstrap`，不运行开发 `db:seed`。已有生产实例不能重新运行初始卷创建或 `journal:init` 来代替更新。

## 日常更新

1. 核对线上 SHA / source hash、健康状态、剩余空间、私有配置、镜像 ID 和全部卷身份；准备上一版本及恢复材料。
2. 取一致备份并异地读回验证。新候选通过对应 SHA 的检查后，上传并逐项校验归档。
3. 使用发布包的绑定工具更新镜像引用，保留部署 owner、卷名、创建标识、密钥版本和现有数据。
4. 核对前向迁移与新旧应用兼容，执行运维迁移；迁移失败不继续切换。
5. 更新 API、worker 和媒体；发布哈希静态资源，再原子切换前端 `current`。旧资源至少保留 7 天且至少最近 3 版。
6. 验证 `/api/readyz`、登录、聊天同步、上传下载、Agent、通知、安全头和备份 / 监控调度，记录准确源码、镜像和现场结果。

既有实例若使用私有 `volume-identity.compose.json` 覆盖，所有相关 Compose 命令需继续包含它；改变模板前先渲染并核对卷定义。遇到重建卷提示或标签不一致应停止，不能接受删除重建。

本次分支归档和文档清理不包含生产更新。

## 回滚

只切换到与现有 schema 兼容且已验证的应用、镜像与静态资源，按上一份清单绑定并再次核验。数据库不做降级迁移；不兼容时走经验证的备份恢复流程。回滚应用不能掩盖 schema 不兼容或未知外发结果。

## 备份、恢复与监控

- 一致快照导出数据库及其实际引用的不可变对象，核验大小 / hash；独立异地 journal 防止删除在旧快照中复活。
- 目标每 12 小时备份，RPO ≤24 小时、RTO ≤4 小时；快照超过 20 小时预警。保留 7 个日点、4 个周点，强制清理超过 28 天的快照。
- `infra/systemd/` 包含备份、保留维护、监控及 watchdog 模板；是否安装、实际时区、跨周期成功与真实告警送达需在目标机验证。
- 恢复材料、历史 keyring、发布包、固定模型及账户恢复途径在源主机外加密保管，配置变化后同步更新。
- 恢复到全新隔离库 / 桶 / 卷，重放可信 journal，失效旧 session、凭据和委托，重新确认权限与必要外发后解锁。
- watchdog 只操作核验归属后的本项目服务，不做全局容器或数据清理。

详细命令及恢复顺序见[运维命令](operations.md)。整机失效演练另行安排维护窗口，不能用停止容器或本机读回冒充完整服务恢复。
