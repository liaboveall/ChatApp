# ChatApp

一个基于 Django + Channels 的聊天应用，支持公共聊天室、私聊、在线用户、文件/图片/视频消息，以及可选的 AI 助手。

## 运行方式（两种）

你可以选择以下任意一种方式启动项目：

### 方式一：本地直接运行（推荐用于开发）

前置要求：已安装 Python 3.10+。

1) 克隆仓库

```powershell
git clone https://github.com/liaboveall/ChatApp.git
cd ChatApp
```

2) 创建并激活虚拟环境

Windows PowerShell：

```powershell
py -m venv .venv
./.venv/Scripts/Activate.ps1
```

macOS/Linux：

```bash
python3 -m venv .venv
source .venv/bin/activate
```

3) 安装依赖

```powershell
python -m pip install -r requirements.txt
```

4) 迁移数据库并启动

```powershell
python manage.py migrate
python manage.py runserver
```

5) 打开浏览器

```
http://127.0.0.1:8000
```

可选（使用 Redis 作为 Channels 层、或使用 Postgres）：

- Redis：设置环境变量并在生产/多进程下使用
	- `CHANNEL_BACKEND=redis`
	- `CHANNEL_REDIS_URL=redis://localhost:6379/0`
- Postgres：
	- `USE_POSTGRES=1`
	- `POSTGRES_DB/POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_HOST/POSTGRES_PORT`

### 方式二：使用 Docker（含 docker-compose）

1) 克隆仓库

```powershell
git clone https://github.com/liaboveall/ChatApp.git
cd ChatApp
```

2) 直接启动（默认使用 SQLite）

```powershell
docker compose up --build -d
```

3) 打开浏览器

```
http://127.0.0.1:8000
```

可选：使用 Postgres + Redis（生产/多副本推荐）

- 在 `docker-compose.yml` 中为 `web` 服务添加环境变量 `USE_POSTGRES=1`，并配置 `POSTGRES_*`；
- 添加/启用 Redis 服务，并设置 `CHANNEL_BACKEND=redis` 与 `CHANNEL_REDIS_URL=redis://redis:6379/0`；
- 首次启动后在容器中执行迁移：`docker compose exec web python manage.py migrate`。

## 致谢与来源

本项目基于上游开源项目进行改造与扩展，原项目使用 MIT 许可证发布。在功能（私聊、在线用户、AI 聊天、文件消息等）、结构与部署方面进行了较大调整与重构。

- 上游项目：Django-ChatApp（rustyxlol）https://github.com/rustyxlol/Django-ChatApp
- 许可证：MIT（保留原版权与许可声明）。

如果你是该上游项目的作者，欢迎提出建议或请求在此补充更准确的署名信息。

## License

本项目遵循 MIT License 发布，详见根目录 `LICENSE` 文件。
