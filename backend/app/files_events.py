"""Живая синхронизация вики: рассылка изменений файлов открытым вкладкам.

Счётчик версий, как в задачах, тут не годится: агент правит страницы своими
Write/Edit (cwd=WIKI_DIR), туда же пишут Telegram, крон и внешние агенты по MCP —
всё это проходит мимо files.py. Поэтому сигнал берём с файловой системы: одна
фоновая задача обходит дерево, сравнивает mtime и раздаёт разницу подписчикам.
"""

import asyncio
import json
import logging
import os

from fastapi import APIRouter, HTTPException, Request
from sse_starlette.sse import EventSourceResponse

from . import config
from .auth import check_token

logger = logging.getLogger("wiki")

# EventSource не умеет слать заголовки — как и у задач, роутер без auth-зависимости,
# токен приходит в query.
router = APIRouter(prefix="/files", tags=["files"])

SCAN_INTERVAL = 2.0
# Тишина дольше этого — отдаём ping, заодно проверяя, жив ли клиент.
IDLE_TIMEOUT = 15.0

_subs: set[asyncio.Queue] = set()

Snapshot = dict[str, float]

# Последний снимок дерева. None — никто не слушает, обход не делаем.
_pages: "Snapshot | None" = None
_storage: "Snapshot | None" = None


def _scan(root: str, only_md: bool) -> Snapshot:
    out: Snapshot = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for name in filenames:
            if name.startswith(".") or (only_md and not name.endswith(".md")):
                continue
            abs_path = os.path.join(dirpath, name)
            try:
                st = os.stat(abs_path)
            except OSError:
                continue
            out[os.path.relpath(abs_path, root)] = st.st_mtime_ns + st.st_size
    return out


def _changed(old: Snapshot, new: Snapshot) -> list[str]:
    return sorted({p for p in old.keys() | new.keys() if old.get(p) != new.get(p)})


async def _baseline() -> None:
    """Снять точку отсчёта. Делается при подписке, а не в цикле: иначе правка в
    первые секунды после открытия вкладки утонула бы в первом же обходе."""
    global _pages, _storage
    _pages = await asyncio.to_thread(_scan, config.WIKI_DIR, True)
    _storage = await asyncio.to_thread(_scan, config.FILES_DIR, False)


async def watch_loop() -> None:
    """Одна задача на весь процесс: обход дерева и рассылка разницы подписчикам."""
    global _pages, _storage
    while True:
        await asyncio.sleep(SCAN_INTERVAL)
        try:
            if not _subs:
                # Никто не слушает — обход не нужен; следующий подписчик снимет
                # свежую базу сам, чтобы не получить разницу за час.
                _pages = _storage = None
                continue
            if _pages is None or _storage is None:
                await _baseline()
                continue
            next_pages = await asyncio.to_thread(_scan, config.WIKI_DIR, True)
            next_storage = await asyncio.to_thread(_scan, config.FILES_DIR, False)
            changed = _changed(_pages, next_pages)
            storage_changed = bool(_changed(_storage, next_storage))
            _pages, _storage = next_pages, next_storage
            if not changed and not storage_changed:
                continue
            payload = json.dumps({"pages": changed, "storage": storage_changed})
            for q in list(_subs):
                q.put_nowait(payload)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("files watch loop")


@router.get("/events")
async def files_events(request: Request, token: str = ""):
    if not check_token(token):
        raise HTTPException(401, "Unauthorized")

    q: asyncio.Queue = asyncio.Queue()
    if not _subs:
        await _baseline()
    _subs.add(q)

    async def gen():
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    payload = await asyncio.wait_for(q.get(), timeout=IDLE_TIMEOUT)
                except asyncio.TimeoutError:
                    yield {"event": "ping", "data": ""}
                    continue
                yield {"event": "files", "data": payload}
        finally:
            _subs.discard(q)

    return EventSourceResponse(gen())
