# 设计原型（D 阶段）

ChatApp v2 的可点击设计原型，对应 [docs/02-design-system.md](../docs/02-design-system.md) 第 9 节的 D1 到 D4。它是评审用的**参考实现，不是产品代码**：M1b 会按它用 React、Tailwind 和 Base UI 重新实现。D 阶段的成果、候选令牌和待确认的事见 02 的[第 10 节](../docs/02-design-system.md#10-d-阶段成果2026-10-02候选值待-d4-确认)。

## 看原型

- **Artifact**：链接记在 [docs/PROGRESS.md](../docs/PROGRESS.md)（私有，只有发布者能打开，除非他分享）。
- **本地**：

  ```bash
  bun run design:build                       # 加 -- --minify 是发布版
  cd design/prototype/dist && python3 -m http.server 8790 --bind 127.0.0.1
  # 然后用浏览器打开 http://127.0.0.1:8790/index.html
  ```

- 页面不依赖网络：样式、脚本、图标和 Inter 的拉丁子集都内嵌。
- 顶部是**审阅控制条**（不是产品的一部分）：场景、主题、强调色、透明度、窗口宽度、字体、字号，以及模拟事件（新消息、对方正在输入、断网）。链接后面可以带场景名，例如 `index.html#agent`（单个词）；本地检查还支持 `#scene=agent&theme=dark&accent=purple&glass=clear&width=1024`（`fresh=1&nostore=1` 忽略并且不写本地存储）。

## 目录

```
design/prototype/
  src/styles/        00 令牌由 tools 生成；10 基础、15 玻璃、20 组件、30 外壳、40 聊天、50 Agent、60 浮层、70 页面、90 审阅控制条
  src/scripts/       界面模块（用 createElement 构建，不用 innerHTML）；main.js 是入口
  src/fonts/         Inter 拉丁子集（OFL）和说明
  tools/
    tokens.mjs       令牌的单一数据源（颜色、玻璃、圆角、字号、弹簧）
    tokens-css.mjs   把令牌生成 CSS
    contrast.mjs     令牌对比度自查（WCAG 2.2），退出码非零即失败
    color.mjs        颜色计算
    build.mjs        构建：artifact.html（Artifact 要求的片段形式）、index.html（本地）
    gen-icons.mjs    从 lucide-static 生成图标模块（icons.list 列出用到的图标）
    browser-checks/  用真实浏览器做的检查，见下
  dist/              构建产物（git 忽略）
```

## 检查

```bash
bun run design:contrast                       # 令牌静态对比度：3000 多组，不需要浏览器

design/prototype/tools/browser-checks/run.sh keyboard   # 键盘主流程、焦点、输入法组字、鼠标点模态内容
design/prototype/tools/browser-checks/run.sh layout     # 各档宽度无溢出、320 宽度主流程、点击目标 ≥ 28px
design/prototype/tools/browser-checks/run.sh media      # 减少透明度/动态效果、系统深色、宿主主题、字号档位
design/prototype/tools/browser-checks/run.sh flows      # 审批、重新生成、自带 key、邀请码、设备注销、登录注册校验……
design/prototype/tools/browser-checks/run.sh audit full # 像素级对比度：每种主题 × 强调色 × 透明度渲染后实测
design/prototype/tools/browser-checks/run.sh shots v1 "agent:theme=dark" "w320::320x700"   # 批量截图
design/prototype/tools/browser-checks/run.sh fonts      # 字体比较
```

浏览器检查用 **Windows 的 Edge 和 `node.exe`**（CDP）。原因是 WSL 是 NAT 网络，连不到 Windows 上浏览器的调试端口；调试端口由 Edge 自选，只绑 127.0.0.1。`run.sh` 会把脚本复制到 Windows 临时目录、起静态服务、跑完停止。截图在 `%TEMP%\chatapp-d\shots`。环境变量：`EDGE_PATH`、`NODE_EXE`、`CHECK_ROOT`、`PROTO_PORT`。

## 约定

- 颜色只用令牌；改令牌先改 `tools/tokens.mjs`，再跑 `bun run design:contrast`，通过才算改完。
- 玻璃只有三种（见 02 第 10.2 节）；同屏至多 4 个 `backdrop-filter` 层。
- 新增图标：把名字加到 `tools/icons.list`，用 `gen-icons.mjs` 重新生成（需要解开的 lucide-static 包路径）。
- 不引入 `innerHTML` 和同类写法（项目规则 SEC-05）；原型的 Markdown 渲染器自己解析，只支持规格里的子集。
- Biome 对 `design/**` 关闭了四条风格规则（逗号表达式、表达式内赋值、`!important`、选择器特异性顺序），其余规则照常。

## 已知限制

没有验证的东西列在 02 的第 10.7 节：macOS Safari 和 Firefox 的渲染、读屏、快捷键在各浏览器里的冲突、系统高对比度模式、真实照片垫在玻璃后面。

## 第三方

- 图标：[Lucide](https://lucide.dev)（ISC），`lucide-static` 1.49.0，生成的模块文件头注明了版本。
- 字体：Inter（SIL OFL 1.1），`@fontsource-variable/inter` 5.3.0 的拉丁子集，许可证在 `src/fonts/Inter-OFL.txt`。
