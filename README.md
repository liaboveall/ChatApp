# ChatApp

[![English](https://img.shields.io/badge/lang-English-blue.svg)](README.md)
[![中文](https://img.shields.io/badge/语言-中文-red.svg)](README_ZN.md)

A chat application built with Django + Channels. It supports public chat rooms, private chats, online user presence, file/image/video messages, and an optional AI assistant.

## How to Run (two options)

Choose either of the following ways to start the project:

### Option 1: Run locally 
Prerequisites: Python 3.10+ installed.

1) Clone the repository

```powershell
git clone https://github.com/liaboveall/ChatApp.git
cd ChatApp
```

2) Install dependencies

```powershell
python -m pip install -r requirements.txt
```

3) Migrate the database and start the server

```powershell
python manage.py migrate
python manage.py runserver
```

4) Open in browser

```
http://127.0.0.1:8000
```

Optional (use Redis as Channels layer, or Postgres):

- Redis: set environment variables and use in production/multi-process scenarios
  - `CHANNEL_BACKEND=redis`
  - `CHANNEL_REDIS_URL=redis://localhost:6379/0`
- Postgres:
  - `USE_POSTGRES=1`
  - `POSTGRES_DB/POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_HOST/POSTGRES_PORT`

### Option 2: Use Docker (with docker-compose)

1) Clone the repository

```powershell
git clone https://github.com/liaboveall/ChatApp.git
cd ChatApp
```

2) Start directly (uses SQLite by default)

```powershell
docker compose up --build -d
```

3) Open in browser

```
http://127.0.0.1:8000
```

Optional: Postgres + Redis (recommended for production/scaled replicas)

- In `docker-compose.yml`, add `USE_POSTGRES=1` to the `web` service and configure the `POSTGRES_*` values.
- Add/enable the Redis service and set `CHANNEL_BACKEND=redis` and `CHANNEL_REDIS_URL=redis://redis:6379/0`.
- After the first start, run migrations in the container: `docker compose exec web python manage.py migrate`.

## Acknowledgements & Origin

This project adapts and extends an upstream open-source project originally released under the MIT License. Significant changes were made in features (private chat, online users, AI chat, file messages, etc.), structure, and deployment.

- Upstream project: Django-ChatApp (rustyxlol) https://github.com/rustyxlol/Django-ChatApp
- License: MIT (original copyright and license notice retained).

If you are the author of the upstream project, feel free to open an issue/PR for more accurate attribution details.

## License

Released under the MIT License. See the `LICENSE` file at the project root for details.
