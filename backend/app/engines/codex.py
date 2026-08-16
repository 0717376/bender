"""Движок на подписке ChatGPT (Codex SDK).

Отличий от Claude три, всё остальное — общее:
- инструменты Codex не умеет держать внутри процесса, поэтому забирает те же самые
  по HTTP у нас же (mcp_internal);
- запреты живут не в коде, а в хуке ($CODEX_HOME/hooks.json → codex_hook.py);
- нить разговора зовётся thread, и её id мы храним там же, где id сессии Claude.
"""

import asyncio
import json
import logging
import os
import sys

from openai_codex import ApprovalMode, AsyncCodex, CodexConfig, Sandbox
from openai_codex import models as codex_models

from .. import config, mcp_internal
from . import Emit, Outcome, StaleSession

logger = logging.getLogger("wiki.agent.codex")

HOOK_SCRIPT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                           "codex_hook.py")
MCP_TOKEN_ENV = "BENDER_MCP_TOKEN"

_client: AsyncCodex | None = None
_client_lock = asyncio.Lock()


def _hooks_config() -> dict:
    """Запрет на rm. Кладём в $CODEX_HOME — это конфиг пользователя, он доверенный;
    хук, переданный на лету вместе с ходом, Codex сначала попросит подтвердить руками,
    а подтверждать в контейнере некому."""
    return {
        "hooks": {
            "PreToolUse": [
                {
                    "matcher": "shell",
                    "hooks": [{
                        "type": "command",
                        "command": f"{sys.executable} {HOOK_SCRIPT}",
                        "timeout": 15,
                        "statusMessage": "проверяю команду",
                    }],
                }
            ]
        }
    }


def _sync_skills() -> None:
    """Навыки Codex читает из $CODEX_HOME/skills. Наши лежат в двух местах (доменные
    в образе, выученные на томе) — раскладываем ссылками, чтобы не копировать и не
    ловить рассинхрон после того, как агент навык поправил."""
    dest = os.path.join(config.CODEX_HOME, "skills")
    os.makedirs(dest, exist_ok=True)
    sources = {}
    for root in (os.path.join(config.SKILL_PLUGIN_DIR, "skills"), config.LEARNED_SKILLS_DIR):
        if not os.path.isdir(root):
            continue
        for slug in os.listdir(root):
            path = os.path.join(root, slug)
            if os.path.isfile(os.path.join(path, "SKILL.md")):
                sources[slug] = path
    for slug, path in sources.items():
        link = os.path.join(dest, slug)
        try:
            if os.path.islink(link):
                if os.readlink(link) == path:
                    continue
                os.remove(link)
            elif os.path.exists(link):
                continue        # не ссылка, а что-то своё — не наше дело сносить
            os.symlink(path, link)
        except OSError as e:
            logger.warning("Codex: навык %s не подключился (%s)", slug, e)
    for slug in os.listdir(dest):          # навык удалили — ссылка не должна пережить его
        link = os.path.join(dest, slug)
        if os.path.islink(link) and slug not in sources:
            os.remove(link)


def _ensure_home() -> None:
    os.makedirs(config.CODEX_HOME, exist_ok=True)
    path = os.path.join(config.CODEX_HOME, "hooks.json")
    body = json.dumps(_hooks_config(), ensure_ascii=False, indent=2)
    try:
        with open(path) as f:
            if f.read() == body:
                return
    except OSError:
        pass
    with open(path, "w") as f:
        f.write(body)


async def client() -> AsyncCodex:
    global _client
    async with _client_lock:
        if _client is None:
            _ensure_home()
            env = dict(os.environ)
            env["CODEX_HOME"] = config.CODEX_HOME
            env[MCP_TOKEN_ENV] = mcp_internal.get_token()
            _client = AsyncCodex(CodexConfig(env=env, cwd=config.WIKI_DIR))
        return _client


def _thread_config(variant: str) -> dict:
    """Конфиг нити: где брать инструменты, куда можно писать, чем ходить в веб."""
    return {
        "mcp_servers": {
            config.CODEX_MCP_NAME: {
                "url": mcp_internal.url(variant),
                "bearer_token_env_var": MCP_TOKEN_ENV,
            }
        },
        # Писать можно в вики (рабочая директория) и в файловое хранилище. Библиотека
        # книг остаётся только на чтение — там правит человек в читалке.
        "sandbox_workspace_write": {
            "writable_roots": [config.FILES_DIR],
            "network_access": True,
        },
        "tools": {"web_search": True},
    }


def _opts(variant: str, instructions: str) -> dict:
    return {
        "cwd": config.WIKI_DIR,
        "sandbox": Sandbox.workspace_write,
        # Спрашивать разрешение не у кого: подтверждать эскалации в контейнере некому,
        # поэтому всё, что не разрешено песочницей, просто не делается.
        "approval_mode": ApprovalMode.deny_all,
        "developer_instructions": instructions,
        "config": _thread_config(variant),
        **({"model": config.CODEX_MODEL} if config.CODEX_MODEL else {}),
    }


def is_stale(exc: Exception) -> bool:
    text = str(exc).lower()
    return "not found" in text and "thread" in text


def _error_text(message: str) -> str:
    blob = (message or "").lower()
    if "context" in blob or "too long" in blob or "token" in blob and "limit" in blob:
        return "Контекст сессии переполнен. Начните новую: /new в боте или «Очистить» в чате."
    if "rate limit" in blob or "quota" in blob or "usage limit" in blob:
        return "Лимит подписки ChatGPT исчерпан — попробуйте позже."
    return "Ошибка Codex. Попробуйте начать новую сессию (/new)."


async def run(prompt: str, *, resume: str | None, surface: str, instructions: str,
              emit: Emit, interactive: bool = True) -> Outcome:
    codex = await client()
    _sync_skills()
    nudge = config.SKILL_NUDGE.get(surface, "")
    opts = _opts("main" if interactive else "cron",
                 f"{instructions}\n\n{nudge}" if nudge else instructions)
    if resume:
        try:
            thread = await codex.thread_resume(resume, **opts)
        except Exception as e:
            if is_stale(e):
                raise StaleSession from e
            raise
    else:
        thread = await codex.thread_start(**opts)

    out = Outcome(session_id=thread.id)
    texts: list[str] = []
    handle = await thread.turn(prompt)
    async for event in handle.stream():
        p = event.payload
        if isinstance(p, codex_models.AgentMessageDeltaNotification):
            await emit({"t": "delta", "id": p.item_id, "text": p.delta})
        elif isinstance(p, codex_models.ItemStartedNotification):
            tool = _tool_event(p.item)
            if tool:
                await emit(tool)
        elif isinstance(p, codex_models.ItemCompletedNotification):
            item = p.item.root
            if getattr(item, "type", "") == "agentMessage" and item.text:
                texts.append(item.text)
                await emit({"t": "text", "id": item.id, "text": item.text})
        elif isinstance(p, codex_models.TurnCompletedNotification):
            if p.turn.error:
                out.error = _error_text(p.turn.error.message)
        elif isinstance(p, codex_models.ErrorNotification) and not p.will_retry:
            out.error = _error_text(p.error.message)
        elif isinstance(p, codex_models.ConfigWarningNotification):
            # Незнакомый ключ конфига Codex глотает молча — и агент остаётся без
            # инструментов или без веба, а по логам не видно. Пусть будет видно.
            logger.warning("Codex: конфиг — %s%s", p.summary,
                           f" ({p.details})" if p.details else "")

    out.session_id = thread.id
    out.reply = "\n\n".join(texts)
    return out


def _tool_event(thread_item) -> dict | None:
    """Что показать в интерфейсе, когда агент полез в инструмент. Имена подгоняем под
    те, что рисует фронтенд для Claude, — интерфейс не должен знать про движок."""
    item = thread_item.root
    kind = getattr(item, "type", "")
    if kind == "commandExecution":
        return {"t": "tool", "name": "Bash", "pattern": (item.command or "")[:80], "file": ""}
    if kind == "mcpToolCall":
        return {"t": "tool", "name": f"mcp__{item.server}__{item.tool}", "pattern": "", "file": ""}
    if kind == "webSearch":
        return {"t": "tool", "name": "WebSearch", "pattern": (item.query or "")[:80], "file": ""}
    if kind == "fileChange":
        paths = [str(getattr(c, "path", "")) for c in (item.changes or [])]
        return {"t": "tool", "name": "Edit", "pattern": "", "file": paths[0] if paths else ""}
    if kind == "imageView":
        return {"t": "tool", "name": "Read", "pattern": "", "file": str(item.path or "")}
    return None


async def review(prompt: str, instructions: str) -> None:
    codex = await client()
    thread = await codex.thread_start(
        cwd=config.DATA_DIR,
        sandbox=Sandbox.read_only,
        approval_mode=ApprovalMode.deny_all,
        developer_instructions=instructions,
        config={"mcp_servers": {config.CODEX_MCP_NAME: {
            "url": mcp_internal.url("review"), "bearer_token_env_var": MCP_TOKEN_ENV}}},
        **({"model": config.CODEX_MODEL} if config.CODEX_MODEL else {}),
    )
    await thread.run(prompt)


# --- Авторизация: подписка ChatGPT, вход по коду устройства (браузер не нужен) ---

async def account() -> dict:
    """Кто мы для Codex. Пустой словарь — не авторизованы."""
    codex = await client()
    try:
        resp = await codex.account()
    except Exception as e:
        logger.warning("Codex: не удалось спросить аккаунт (%s)", e)
        return {}
    acc = getattr(resp, "account", None)
    if acc is None:
        return {}
    return {k: v for k, v in {
        "email": getattr(acc, "email", ""),
        "plan": getattr(acc, "plan_type", "") or getattr(acc, "plan", ""),
    }.items() if v}


async def login(on_code) -> bool:
    """Вход по коду устройства: печатаем адрес и код, ждём подтверждения с телефона."""
    codex = await client()
    handle = await codex.login_chatgpt_device_code()
    await on_code(handle.verification_url, handle.user_code)
    await handle.wait()
    return True
