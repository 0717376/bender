import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from starlette.routing import Route

from . import books_store, config, cron_store, mcp_server, session_log, skill_store, tasks_store
from .asr import router as asr_router
from .auth import require_auth
from .books_api import init as books_init
from .books_api import router as books_router
from .chat import router as chat_router
from .files import normalize_pages
from .files import router as files_router
from .files_events import router as files_events_router
from .files_events import watch_loop as files_watch_loop
from .mcp_api import router as mcp_router
from .storage_api import init as storage_init
from .storage_api import router as storage_router
from .cron_api import router as cron_router
from .curator_api import router as curator_router
from .scheduler import scheduler_loop
from .tasks_api import events_router as tasks_events_router
from .tasks_api import router as tasks_router
from .telegram import telegram_poller

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("wiki")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    tasks_store.init()
    cron_store.init()
    session_log.init()
    skill_store.init()  # scaffold learned-skills plugin + migrate legacy flat skills once
    storage_init()
    books_store.init()
    books_init()
    # Папки заводит не только интерфейс (агент через Bash, бэкапы) — выдаём им
    # страницы, иначе в дереве всплывёт «папка», которой в модели вики нет.
    for path, how in normalize_pages():
        logger.info("Wiki: %s → %s", path, "страница продвинута" if how == "promoted"
                    else "заведена пустая страница раздела")
    tasks: list[asyncio.Task] = []
    if config.TELEGRAM_BOT_TOKEN:
        tasks.append(asyncio.create_task(telegram_poller()))
        logger.info("Telegram bot enabled")
    else:
        logger.info("Telegram bot disabled (no TELEGRAM_BOT_TOKEN)")
    tasks.append(asyncio.create_task(scheduler_loop()))
    tasks.append(asyncio.create_task(files_watch_loop()))
    try:
        # Примонтированный на /mcp sub-app не получает свой lifespan от FastAPI —
        # менеджер сессий MCP запускаем здесь.
        async with mcp_server.mcp.session_manager.run():
            yield
    finally:
        for t in tasks:
            t.cancel()
        for t in tasks:
            try:
                await t
            except asyncio.CancelledError:
                pass


app = FastAPI(title="Personal Wiki Assistant (Agent SDK)", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class LoginReq(BaseModel):
    password: str


@app.post("/auth/login")
async def login(req: LoginReq):
    if not config.WIKI_PASSWORD or req.password != config.WIKI_PASSWORD:
        raise HTTPException(401, "Неверный пароль")
    return {"token": config.AUTH_TOKEN}


@app.get("/auth/me")
async def me(_: bool = Depends(require_auth)):
    return {"ok": True}


@app.get("/health")
async def health():
    return {"status": "ok"}


app.include_router(chat_router)
app.include_router(files_events_router)  # /files/events: SSE без auth-зависимости (токен в query)
app.include_router(files_router)
app.include_router(storage_router)
app.include_router(books_router)
app.include_router(asr_router)
app.include_router(tasks_events_router)  # before tasks_router so /tasks/events isn't shadowed by /tasks/{id}
app.include_router(tasks_router)
app.include_router(cron_router)
app.include_router(curator_router)
app.include_router(mcp_router)
# Route, а не Mount: Mount("/mcp") отвечает 307-редиректом на /mcp/,
# который MCP-клиенты не обязаны следовать за POST.
app.router.routes.append(Route("/mcp", endpoint=mcp_server.asgi_app))
