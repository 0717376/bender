"""Внешний MCP-сервер (Streamable HTTP) для сторонних агентов — Claude Code,
claude.ai и любых других MCP-клиентов.

Инструменты зовут те же store/файловые функции, что REST API и встроенный агент,
поэтому изменения сразу видны в веб-интерфейсах (у задач — через SSE live-sync).
Auth — отдельный bearer-токен (data/mcp_token), независимый от пароля веба;
управляется из настроек фронтендов через /api/mcp.
"""

import os
import secrets
from urllib.parse import parse_qs

from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.server import StreamableHTTPASGIApp
from mcp.server.transport_security import TransportSecuritySettings
from starlette.responses import JSONResponse

from . import config, files, tasks_store

TOKEN_FILE = os.path.join(config.DATA_DIR, "mcp_token")


def get_token() -> str:
    try:
        with open(TOKEN_FILE) as f:
            tok = f.read().strip()
        if tok:
            return tok
    except OSError:
        pass
    return rotate_token()


def rotate_token() -> str:
    os.makedirs(config.DATA_DIR, exist_ok=True)
    tok = secrets.token_urlsafe(32)
    with open(TOKEN_FILE, "w") as f:
        f.write(tok)
    os.chmod(TOKEN_FILE, 0o600)
    return tok


class TokenGate:
    """ASGI-обёртка: токен в заголовке Authorization: Bearer или в ?token=."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        token = ""
        for k, v in scope.get("headers", []):
            if k == b"authorization":
                val = v.decode()
                if val.startswith("Bearer "):
                    token = val[7:].strip()
                break
        if not token:
            qs = parse_qs(scope.get("query_string", b"").decode())
            token = (qs.get("token") or [""])[0]
        if not token or not secrets.compare_digest(token, get_token()):
            resp = JSONResponse({"error": "unauthorized"}, status_code=401)
            return await resp(scope, receive, send)
        return await self.app(scope, receive, send)


# Stateless + JSON: каждый запрос самодостаточен, без SSE-стрима — просто
# проксируется nginx'ом и не требует session id между вызовами.
mcp = FastMCP(
    "bender",
    instructions=(
        "Личный агент пользователя: вики (база знаний из markdown-страниц) и "
        "задачи (менеджер дел в стиле Things). Пути вики — относительные, "
        "например 'vault/machines/backups.md'. Даты — ISO YYYY-MM-DD."
    ),
    stateless_http=True,
    json_response=True,
    streamable_http_path="/",
    # Дефолтная защита от DNS rebinding пускает только localhost и в проде
    # отвечает 421 на Host: wiki.muravskiy.com. Она нужна неаутентифицированным
    # локальным серверам; здесь каждый запрос требует bearer-токен, который
    # злоумышленный сайт подставить не может.
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
)


# ── Вики ──

def _wiki_abs(path: str) -> str:
    rel = (path or "").strip().lstrip("/")
    abs_path = os.path.realpath(os.path.join(config.WIKI_DIR, rel))
    root = os.path.realpath(config.WIKI_DIR)
    if abs_path != root and not abs_path.startswith(root + os.sep):
        raise ValueError("Путь выходит за пределы вики")
    return abs_path


@mcp.tool()
def wiki_tree() -> list[dict]:
    """Дерево страниц вики: path, title (первый заголовок), mtime; папки — с children."""
    return files.build_tree(config.WIKI_DIR, "")


@mcp.tool()
def wiki_read(path: str) -> str:
    """Прочитать страницу вики целиком (markdown). path — относительный, из wiki_tree."""
    abs_path = _wiki_abs(path)
    if not os.path.isfile(abs_path):
        raise ValueError(f"Страница не найдена: {path}")
    with open(abs_path, encoding="utf-8") as f:
        return f.read()


@mcp.tool()
def wiki_write(path: str, text: str) -> dict:
    """Создать или полностью перезаписать страницу вики. Чтобы дополнить существующую —
    сначала wiki_read, затем wiki_write с полным новым текстом. Расширение .md
    добавляется автоматически. Страница должна начинаться с заголовка '# …'."""
    rel = (path or "").strip().lstrip("/")
    if not rel:
        raise ValueError("Пустой путь")
    if not rel.endswith(".md"):
        rel += ".md"
    abs_path = _wiki_abs(rel)
    os.makedirs(os.path.dirname(abs_path), exist_ok=True)
    with open(abs_path, "w", encoding="utf-8") as f:
        f.write(text)
    return {"ok": True, "path": rel}


@mcp.tool()
def wiki_search(query: str, limit: int = 20) -> list[dict]:
    """Поиск по вики (регистронезависимо, по заголовкам и тексту страниц).
    Возвращает страницы с фрагментами совпавших строк."""
    q = query.strip().lower()
    if not q:
        return []
    hits: list[dict] = []
    for dirpath, dirnames, filenames in os.walk(config.WIKI_DIR):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for name in sorted(filenames):
            if not name.endswith(".md") or name.startswith("."):
                continue
            abs_path = os.path.join(dirpath, name)
            rel = os.path.relpath(abs_path, config.WIKI_DIR)
            try:
                with open(abs_path, encoding="utf-8", errors="ignore") as f:
                    text = f.read()
            except OSError:
                continue
            title = files.page_title(abs_path)
            snippets = [
                line.strip()[:200]
                for line in text.splitlines()
                if q in line.lower()
            ][:3]
            if snippets or q in rel.lower() or (title and q in title.lower()):
                hits.append({"path": rel, "title": title, "snippets": snippets})
            if len(hits) >= limit:
                return hits
    return hits


# ── Задачи ──

@mcp.tool()
def tasks_list(view: str | None = None, project_id: int | None = None,
               q: str | None = None) -> list[dict]:
    """Список задач. view: inbox | today | upcoming | anytime | someday | logbook.
    Можно фильтровать по project_id или искать строкой q."""
    return tasks_store.list_tasks(view=view, project_id=project_id, q=q)


@mcp.tool()
def tasks_create(title: str, notes: str = "", when: str | None = None,
                 deadline: str | None = None, project: str | None = None,
                 tags: list[str] | None = None, repeat: dict | None = None) -> dict:
    """Создать задачу. when: 'YYYY-MM-DD' | 'today' | 'someday' | 'anytime' | null
    (null → Входящие). project — имя или id (новое имя создаёт проект).
    repeat: {unit: day|week|month|year, interval: N, mode: schedule|done}."""
    return tasks_store.create_task(title=title, notes=notes, when=when, deadline=deadline,
                                   project=project, tags=tags, repeat=repeat)


@mcp.tool()
def tasks_update(id: int, title: str | None = None, notes: str | None = None,
                 when: str | None = None, deadline: str | None = None,
                 project: str | None = None, tags: list[str] | None = None,
                 status: str | None = None, repeat: dict | None = None) -> dict:
    """Изменить задачу по id. when: 'YYYY-MM-DD' | 'today' | 'someday' | 'anytime'
    (убрать дату) | 'inbox' (вернуть во Входящие). status: open|completed|canceled.
    repeat={} убирает повтор. Передавай только меняемые поля."""
    fields = {k: v for k, v in {"title": title, "notes": notes, "when": when,
                                "deadline": deadline, "project": project, "tags": tags,
                                "status": status, "repeat": repeat}.items() if v is not None}
    res = tasks_store.update_task(id, **fields)
    if res is None:
        raise ValueError(f"Задача {id} не найдена")
    return res


@mcp.tool()
def tasks_complete(id: int, done: bool = True) -> dict:
    """Отметить задачу выполненной (done=true) или снова открыть (done=false)."""
    res = tasks_store.complete_task(id, done=done)
    if res is None:
        raise ValueError(f"Задача {id} не найдена")
    return res


@mcp.tool()
def tasks_delete(id: int) -> dict:
    """Удалить задачу по id (мягкое удаление, хранится 30 дней)."""
    tasks_store.delete_task(id)
    return {"ok": True}


@mcp.tool()
def projects_list() -> list[dict]:
    """Список проектов."""
    return tasks_store.list_projects()


@mcp.tool()
def projects_create(title: str, notes: str = "") -> dict:
    """Создать проект."""
    return {"id": tasks_store.create_project(title, notes=notes)}


# ASGI-хендлер напрямую, минуя внутренний Starlette-роутер FastMCP — он
# path-независимый, поэтому вешается Route'ом на /mcp без редиректов.
# streamable_http_app() всё равно вызываем: он лениво создаёт session_manager.
mcp.streamable_http_app()
asgi_app = TokenGate(StreamableHTTPASGIApp(mcp.session_manager))
