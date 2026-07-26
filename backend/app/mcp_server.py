"""Внешний MCP-сервер (Streamable HTTP) для сторонних агентов — Claude Code,
claude.ai и любых других MCP-клиентов.

Инструменты зовут те же store/файловые функции, что REST API и встроенный агент,
поэтому изменения сразу видны в веб-интерфейсах (у задач — через SSE live-sync).
Auth — отдельный bearer-токен (data/mcp_token), независимый от пароля веба;
управляется из настроек фронтендов через /api/mcp.
"""

import fnmatch
import os
import re
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
def wiki_edit(path: str, old_string: str, new_string: str, replace_all: bool = False) -> dict:
    """Точечная правка страницы: замена точного фрагмента текста (семантика Edit
    из Claude Code). old_string должен совпадать дословно — включая отступы и
    переносы строк — и встречаться в файле ровно один раз; если вхождений больше,
    дай больше окружающего контекста или поставь replace_all=true, чтобы заменить
    все. Перед правкой прочитай страницу через wiki_read и копируй фрагмент оттуда
    без изменений."""
    abs_path = _wiki_abs(path)
    if not os.path.isfile(abs_path):
        raise ValueError(f"Страница не найдена: {path}")
    if old_string == new_string:
        raise ValueError("old_string и new_string совпадают — менять нечего")
    with open(abs_path, encoding="utf-8") as f:
        text = f.read()
    n = text.count(old_string)
    if n == 0:
        raise ValueError("Фрагмент old_string не найден в файле. Он должен совпадать "
                         "дословно, включая пробелы, отступы и переносы строк — "
                         "перечитай страницу через wiki_read и скопируй фрагмент точно.")
    if n > 1 and not replace_all:
        raise ValueError(f"Фрагмент встречается в файле {n} раз(а). Добавь окружающий "
                         "контекст, чтобы он стал уникальным, или поставь "
                         "replace_all=true для замены всех вхождений.")
    with open(abs_path, "w", encoding="utf-8") as f:
        f.write(text.replace(old_string, new_string) if replace_all
                else text.replace(old_string, new_string, 1))
    return {"ok": True, "path": path, "replacements": n if replace_all else 1}


@mcp.tool()
def wiki_grep(pattern: str, path: str = "", glob: str | None = None,
              output_mode: str = "files_with_matches", case_insensitive: bool = False,
              context: int = 0, head_limit: int | None = None,
              multiline: bool = False) -> dict:
    """Поиск по вики регулярным выражением (семантика Grep из Claude Code).
    output_mode: "files_with_matches" (по умолчанию) — только пути страниц;
    "content" — совпавшие строки как "путь:номер: строка" (context добавляет
    строки вокруг); "count" — число совпадений на страницу. path — подпапка вики
    или конкретная страница, glob — фильтр по имени файла (напр. "vault/**").
    По умолчанию паттерн ищется
    в пределах одной строки; multiline=true — сквозь переносы (напр. "## Газ[\\s\\S]*?логин").
    head_limit обрезает выдачу."""
    if output_mode not in ("files_with_matches", "content", "count"):
        raise ValueError('output_mode: "files_with_matches" | "content" | "count"')
    flags = re.IGNORECASE if case_insensitive else 0
    try:
        rx = re.compile(pattern, flags)
    except re.error as e:
        raise ValueError(f"Некорректное регулярное выражение: {e}") from None

    root = _wiki_abs(path) if path else config.WIKI_DIR
    if path and not os.path.exists(root) and not path.endswith(".md"):
        root = _wiki_abs(path + ".md")
    if os.path.isfile(root):
        # path указывает на одну страницу: os.walk по файлу молча даёт пустоту
        walker = [(os.path.dirname(root), [], [os.path.basename(root)])]
    elif os.path.isdir(root):
        walker = os.walk(root)
    else:
        raise ValueError(f"Путь не найден в вики: {path}")

    files_out: list[str] = []
    content_out: list[str] = []
    counts: dict[str, int] = {}
    done = False
    for dirpath, dirnames, filenames in walker:
        if done:
            break
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for name in sorted(filenames):
            if not name.endswith(".md") or name.startswith("."):
                continue
            abs_path = os.path.join(dirpath, name)
            rel = os.path.relpath(abs_path, config.WIKI_DIR)
            if glob and not (fnmatch.fnmatch(rel, glob) or fnmatch.fnmatch(name, glob)):
                continue
            try:
                with open(abs_path, encoding="utf-8", errors="ignore") as f:
                    text = f.read()
            except OSError:
                continue
            lines = text.splitlines()
            if multiline:
                matches = list(rx.finditer(text))
                hit_lines = sorted({text.count("\n", 0, m.start()) for m in matches})
            else:
                hit_lines = [i for i, line in enumerate(lines) if rx.search(line)]
                matches = hit_lines
            if not matches:
                continue
            if output_mode == "files_with_matches":
                files_out.append(rel)
                if head_limit and len(files_out) >= head_limit:
                    done = True
                    break
            elif output_mode == "count":
                counts[rel] = len(matches)
            else:
                shown: set[int] = set()
                for i in hit_lines:
                    for j in range(max(0, i - context), min(len(lines), i + context + 1)):
                        if j not in shown:
                            shown.add(j)
                            mark = ":" if j in hit_lines else "-"
                            content_out.append(f"{rel}:{j + 1}{mark} {lines[j]}")
                    if head_limit and len(content_out) >= head_limit:
                        done = True
                        break
                if done:
                    break
    if output_mode == "files_with_matches":
        return {"files": files_out}
    if output_mode == "count":
        return {"counts": counts, "total": sum(counts.values())}
    return {"lines": content_out[:head_limit] if head_limit else content_out}


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
