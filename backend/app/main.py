import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import config, cron_store, session_log, skill_store, tasks_store
from .asr import router as asr_router
from .auth import require_auth
from .chat import router as chat_router
from .files import router as files_router
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
    tasks: list[asyncio.Task] = []
    if config.TELEGRAM_BOT_TOKEN:
        tasks.append(asyncio.create_task(telegram_poller()))
        logger.info("Telegram bot enabled")
    else:
        logger.info("Telegram bot disabled (no TELEGRAM_BOT_TOKEN)")
    tasks.append(asyncio.create_task(scheduler_loop()))
    try:
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
app.include_router(files_router)
app.include_router(asr_router)
app.include_router(tasks_events_router)  # before tasks_router so /tasks/events isn't shadowed by /tasks/{id}
app.include_router(tasks_router)
app.include_router(cron_router)
app.include_router(curator_router)
