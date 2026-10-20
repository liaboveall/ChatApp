# 维护记录

## 2026-10-20：上线后归档与整理

维护者确认项目已上线，仓库从 v2 重写阶段转为 `main` 日常维护。本次操作只涉及 Git 与仓库文件，不触发生产更新或数据迁移。

| 引用 | 内容 |
| --- | --- |
| `main` | 原 v2 源码及本次维护整理，后续开发主线 |
| `archive/v1` | 原 main：`98413524714a16a904f1ddef16c5bd59ea83fc8e` |
| `v1-legacy` | 已有的 v1 归档标签，指向同一旧 main 提交 |
| `v2-pre-cleanup-2026-10-20` | 清理前完整 v2：`ccc908c6fe382777cc0574b0cfcc4d81ee6c10f7` |

v2 是旧 main 的后代，主线提升通过快进完成，不重写提交历史。`v2` 的清理前状态由标签保留，后续只使用 `main` 维护。

## 清理内容

- 移除已完成的重写路线图、规划评审、阶段实施 / 验收报告、上线交接及过期状态 / 进度文件。
- 移除已由 React 应用取代的 `design/prototype/` HTML 原型、生成器和仅服务原型的浏览器脚本。
- 移除 `design:build` 命令和原型专用 Biome 例外；CI 分支入口统一为 `main`。
- 重写 README、文档索引、本地开发、测试、部署及维护约定；把有效运维命令整理为独立手册。
- 保留产品 / 设计 / 架构 / 数据 / 协议 / Agent / 安全规格，历史引用指向不可变归档。
- 保留运行代码、所有数据库迁移、开发环境与种子、测试夹具、评测、Storybook、CI、发布及备份恢复工具。

`.env.local`、私有配置、`.test-runs/`、未跟踪恢复材料和数据库 / Docker 数据卷不属于此次清理。归档标签只保存已提交文件，不能替代私有材料备份。

## 查阅归档

- [v1](https://github.com/liaboveall/ChatApp/tree/v1-legacy)
- [清理前完整 v2](https://github.com/liaboveall/ChatApp/tree/v2-pre-cleanup-2026-10-20)
- [历史进度与失败记录](https://github.com/liaboveall/ChatApp/blob/v2-pre-cleanup-2026-10-20/docs/PROGRESS.md)
- [历史决策](https://github.com/liaboveall/ChatApp/blob/v2-pre-cleanup-2026-10-20/docs/12-decisions.md)

```sh
git show v1-legacy:README.md
git show v2-pre-cleanup-2026-10-20:docs/PROGRESS.md
git show v2-pre-cleanup-2026-10-20:docs/31-prelaunch-operations-2026-10-13.md
```

上线确认不新增容量、整机独立恢复或设备验收证据；历史检查只对记录中的版本有效。新的检查与 CI 应绑定本次维护提交，失败与限制如实记录。

## 本次本地验证

- `bun run check`：通过；后端 / 脚本 702 项、前端 750 项，类型、架构边界、对比度与 1015 条双语文案检查通过。
- `bun run build`：通过，包含 Service Worker / PWA 产物生成。
- Markdown 相对链接与指向归档的文件目标：17 份文档、8 个归档文件目标核验通过。
- `git diff --check`：通过；应用、数据库、完整迁移与锁文件没有改动。

本次未运行数据库集成、全量浏览器、目标服务器或生产恢复演练。推送后 CI 由新提交触发，结果单独以 GitHub Actions 回执为准。

## 2026-10-20：视觉测试的日期漂移

原提交 `b36c607` 的 [e2e 工作流](https://github.com/liaboveall/ChatApp/actions/runs/39374966432) 中，真实服务 E2E、组件回归、媒体浏览器链与 edge-config 通过；visual 为 138 通过、2 失败，其他工作流通过。

失败发生在邀请码页面的明暗主题：夹具的第二张邀请码于 2026-10-20 到期，组件读取真实 `Date.now()`，文字从“已用完”变为“已过期”，与基线相差 112 / 101 像素。本地官方 Playwright 镜像复现了同样的 2 项失败；原 CI 差异图、日志和本地复现保存在 Git 忽略的 `.test-runs/ci-postlaunch-39374966432/attempt-1/`。

修复在视觉截图前将浏览器时间固定为 `2026-10-17T00:00:00.000Z`，保留基线所表达的状态，计时器正常运行。新增 4 项回归，从夹具到期前和 2040 年分别加载明暗主题，确认状态会随日期变化，再恢复截图日期并与原基线比较。

- 定向验证：原失败 2 项及新增 4 项全部通过。
- `CI=true bun run test:visual`：144 项全部通过，未更新任何 PNG 基线，像素容差保持原值。
- `bun run check`：通过，后端 / 脚本 702 项、前端 750 项；类型、架构、对比度与双语文案检查通过。
- `git diff --check`：通过。生产业务逻辑、邀请码状态优先级与线上实例未修改。

本地修复结果与新提交的远端 CI 分别取证，原失败运行保留。
