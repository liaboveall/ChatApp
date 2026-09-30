# 13 旧版（v1）分析记录

> 分析日期：2026-09-30。复现方法：把代码导出到临时目录，在 Python 3.10 虚拟环境中，用绕过坏掉迁移的临时配置运行，并编写了 24 个复现脚本，**24 个全部复现**。旧代码就是 main 分支的提交 `99056e7`（计划打上标签 `v1-legacy`），下文的文件路径都相对于那个版本。
> 本文件的用途：作为 v2 回归测试的来源（对应关系见 [07 第 3 节](07-security.md)），并记录值得保留的产品经验。

## 1. 旧版概况

- **技术栈**：Django 4.1.13、Channels 3.0.5（内存通道层，只能单进程）、SQLite 或 Postgres、Bootstrap 4.0 + jQuery 3.2.1、OpenAI SDK 调用 DeepSeek。
- **规模**：约 3,900 行，其中 `chat/consumers.py` 839 行；三个聊天页面各自内嵌约 200 行 JS。
- **功能**：公共聊天室、4 位密码的私密聊天室、私聊（邀请与接受）、在线用户、文字、图片、视频、文件消息、2 分钟撤回与删除、AI 助手。
- **来源**：2022 年从 rustyxlol/Django-ChatApp（MIT 协议）改来。2025-01 通过 Docker Hub 镜像分发，源码直到 2025-08 才整体提交进 git。

## 2. 基础设施问题（已实测）

| 问题 | 证据 |
|---|---|
| 迁移链断裂 | 在全新数据库上 `migrate` 报 `duplicate column name: file`。原因：重新生成过 `0001_initial`，但旧的 `0002_message` 和 `0003` 没有删除，同一批表被建了两次。`makemigrations --check` 也检测出模型和迁移不一致 |
| 测试跑不起来 | 创建测试库时同样卡在迁移上。绕过迁移后，3 个测试里有 2 个失败，因为模板已经汉化，测试还在断言英文文字 |
| 无法按生产方式启动 | `daphne chat_app_django.asgi:application` 报 `AppRegistryNotReady`：`asgi.py` 在 Django 初始化之前就导入了 consumers。只有开发服务器 `runserver` 能跑 |
| README 里的可选方案不可用 | `USE_POSTGRES=1` 报缺少 psycopg2；`CHANNEL_BACKEND=redis` 报缺少 channels_redis |
| 写死了 `ws://` | 4 个页面都这样写，放到 HTTPS 后面时 WebSocket 会被浏览器拦截 |
| 部署方式不安全 | Dockerfile 用 `runserver` 运行，以 root 身份运行，没有 `.dockerignore`；compose 启动了 Postgres，但应用实际用的是 SQLite |
| 默认配置不安全 | `DEBUG` 默认开启；`SECRET_KEY` 有硬编码的默认值；`ALLOWED_HOSTS=['*']`；WebSocket 不校验来源 |
| 依赖没有锁版本 | crispy-forms 等依赖没有锁版本，今天安装时被迫回退到很旧的版本；requirements 里还有 pipreqs 工具留下的无用依赖 |

## 3. 实测复现的 24 个缺陷

| 编号 | 缺陷 | 复现方式与结果 | 根因（v1 代码） |
|---|---|---|---|
| L-01 | 纯中文房间名导致创建报 500 | 创建"测试房间"时报 `NoReverseMatch`，房间却已经存进库里，slug 为空字符串 | `Room.save` 调用 `slugify(name)`，中文字符被全部去掉 |
| L-02 | 一个中文名公共房间让全站所有页面 500 | 之后未登录用户访问登录页也报 `NoReverseMatch` | 侧边栏在每个页面上都会为所有公共房间生成链接 |
| L-03 | 第二个中文名房间撞上唯一约束 | 报 `IntegrityError: UNIQUE constraint failed: chat_room.slug` | 两个房间的 slug 都是空字符串 |
| L-04 | 私密房间的密码形同虚设 | 不知道密码的用户直接访问 `/chat/secret/`，返回 200，能看到全部历史消息 | `chat_room` 视图不检查房间类型；WebSocket 也不检查 |
| L-05 | 私聊页面顶部出现一排横幅 | 历史消息被渲染成提示横幅，内容类似 "alice: PRIV-HIST-1" | 视图把聊天记录命名为 `messages`，覆盖了 Django 消息框架的同名变量 |
| L-06 | AI 页面同样出现横幅 | 同上 | 同上 |
| L-07 | 超过时限的消息仍显示撤回按钮 | 1 小时前、10 分钟前的消息都显示撤回按钮 | 模板里用 `timesince < "2分钟"` 做字符串比较 |
| L-08 | 聊天室页面的样式没有生效 | 渲染出的页面里不包含 `<style>` 中的规则 | 样式写在 `{% block %}` 之外，被 Django 丢弃 |
| L-09 | 可以冒充他人发言 | carol 发出 `username: "alice"`，广播出去显示的是 alice，数据库外键也指向 alice | consumer 直接信任客户端发来的 `username` 和 `profile_pic` |
| L-10 | 可以把消息写进别的房间 | 连接的是 lobby，却把消息写进了私密房间 secret | 文字消息使用客户端传来的 `data['room']` |
| L-11 | 实时消息存在 XSS | 服务端原样转发 `<img src=x onerror=…>`，前端用 `innerHTML` 插入页面（共 10 处） | 前端用模板字符串拼 HTML |
| L-12 | 上传的 html 会被当作网页在同源打开 | 把 `pwn.html` 当作"图片"上传，访问时返回 `Content-Type: text/html` | 不校验文件类型，扩展名取自客户端 |
| L-13 | 私聊 WebSocket 匿名也能连 | 不带 Cookie 握手返回 101，并能实时窃听别人的私聊 | `PrivateChatConsumer` 不做任何认证 |
| L-14 | AI WebSocket 匿名也能连 | 匿名连接被接受，理论上可以无限消耗 API 额度 | `AIBotConsumer` 不做认证 |
| L-15 | AI 页面删除、撤回会报错 | 前端弹出 `KeyError: 'username'` | AI 的 consumer 没有处理这两种操作 |
| L-16 | 中文名房间互相串消息 | "测试"房间的成员收到了"你好"房间的消息 | 群组名 `encode('ascii','ignore')`，中文全被去掉，都变成了 `chat_` |
| L-17 | "当前用户"标记算错人 | bob 收到的列表里，被标为 `is_current` 的是 alice | 标记是按"触发广播的那个人"计算的，然后广播给所有人 |
| L-18 | 多标签页关掉一个就显示离线 | alice 还有一个连接在线，却已被标为离线 | 在线状态没有按连接数统计 |
| L-19 | 改名后能读到别人的 AI 历史 | bob 改名后，alice 改成 "bob"，就能看到 bob 的 AI 历史 | AI 房间名是 `ai_chat_{username}` |
| L-20 | 改名后能删除别人的消息 | 同上场景，alice 删掉了 bob 以前发的消息 | 删除和撤回时按 `username` 判断归属 |
| L-21 | **任何人都能读取所有私聊** | 访问 `/chat/private_1_2/` 返回 200，能看到全部私聊记录；id 是自增的，可以逐个遍历 | 所有消息共用一个 `room` 字符串命名空间，`chat_room` 又不做鉴权 |
| L-22 | 任何人都能读取他人的 AI 对话 | 访问 `/chat/ai_chat_erin/` 返回 200 | 同上 |
| L-23 | 可以在他人的私聊里伪造消息 | 通过 `ws/chat/private_1_2/`，能以 erin 的名义写入消息 | 同上，再加上 L-09 |
| L-24 | 可以注册 "AI助手" 这个用户名 | 注册成功。之后所有 AI 回复都按用户名归到这个账号名下 | 没有保留名机制 |

## 4. 代码审查发现的其他问题（未单独复现）

- 服务重启后，在线状态会残留"幽灵在线"用户；只有打开"在线用户"页面才算在线，也只有在那个页面才能收到私聊邀请。
- AI 的上下文只存在单个连接的内存里：刷新页面就忘了之前的对话，上下文无限增长；调用失败时，"抱歉"这句话会被当成正常回复存进数据库；错误的原文会直接回给前端。
- 用户每次登录都会触发 `Profile.save()`，读取并可能重写头像文件。
- 时间显示不一致：历史消息按 UTC 显示，实时消息按浏览器本地时间显示；Django 自带的提示是英文的。
- 图标字体从 Google Fonts 加载，国内打不开，图标会显示成英文单词。
- 删除只是软删除，文件仍然可以通过 URL 访问；房间的默认图标文件并不存在。
- 文件用 base64 塞进 WebSocket 消息传输，没有大小限制，还在异步代码里同步写盘；`innerHTML +=` 每来一条消息就重新渲染全部，复杂度 O(n²)；历史消息全量加载，没有分页。
- 三个 consumer 中大量复制粘贴，各份之间的行为已经不一致；有 62 处 `print`、38 处 `console.log`；还有不少死代码，比如 `ALLOWED_FILE_TYPES` 从没被用到、`routing.py` 没有被任何地方导入、首页的 POST 分支永远执行不到。

## 5. 仓库与分发方面的问题

- **Docker Hub 上的公开镜像** `abovealll/chatapp:latest`：构建于 2025-01-19，被拉取过 202 次，只有 amd64 版本。构建时用 `COPY . /app/`，又没有 `.dockerignore`，所以镜像里**可能**打包了当时的 `db.sqlite3`、上传的文件、`.env`，以及当时可能硬编码在代码里的 DeepSeek key。这一点尚未拉取镜像验证。**建议用户**：作废那个时期的 key；如果这个镜像已经不用了，就删除这个 Docker Hub 仓库。
- **公开仓库里提交了 57 MB 用户上传的文件**（`media/`）；`.env` 虽然写在 `.gitignore` 里，但文件本身已经被提交了。
- **LICENSE 里没有保留上游的版权行**（`Copyright (c) 2022 rustyxlol`），这不符合 MIT 协议的要求，而 README 却写着"已保留"。M1 会补上。
- DeepSeek 已经不再列出旧代码里使用的 `deepseek-chat`（当前型号是 V4 系列）。

## 6. 值得保留的产品经验

- **功能流程**：从在线列表发起私聊邀请、2 分钟撤回、从在线列表直接进入 AI 助手。
- **文案**：中文界面的整体用语可以沿用。
- **几个本来就做对的地方**：
  - 用 `json_script` 把服务端数据安全地传给前端；
  - 历史消息靠 Django 模板自动转义，没有 XSS；
  - 页面视图都有 `login_required`；表单都有 CSRF 防护；
  - 有一条上传路径用 UUID 作为文件名。
