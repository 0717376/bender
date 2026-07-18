"""Claude Agent SDK engine — replaces the old `claude` CLI subprocess.

Single shared session (web + Telegram), serialized by `claude_lock`, persisted
as a session id in data/session.json and resumed each turn. Runs on the Max
subscription via the CLI's OAuth (no ANTHROPIC_API_KEY).
"""

import asyncio
import json
import logging
import os
import time
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta

from claude_agent_sdk import (
    AgentDefinition,
    AssistantMessage,
    ClaudeAgentOptions,
    HookMatcher,
    ResultMessage,
    StreamEvent,
    TextBlock,
    ToolUseBlock,
    query,
)

from . import clock, config, cron_outbox, memory_store, session_log, skill_store
from .cron_tools import TOOL_NAMES as CRON_TOOL_NAMES
from .cron_tools import server as cron_server
from .memory_tools import TOOL_NAMES as MEMORY_TOOL_NAMES
from .memory_tools import server as memory_server
from .session_tools import TOOL_NAMES as SESSION_TOOL_NAMES
from .session_tools import server as sessions_server
from .skill_tools import TOOL_NAMES as SKILL_TOOL_NAMES
from .skill_tools import server as skills_server
from .tasks_tools import TOOL_NAMES as TASK_TOOL_NAMES
from .tasks_tools import server as tasks_server

logger = logging.getLogger("wiki.agent")

# Subagents the main agent can delegate to via the Task tool.
SUBAGENTS = {
    "researcher": AgentDefinition(
        description="Глубокий веб-ресёрч. Делегируй, когда нужно собрать и сверить информацию из "
        "интернета по теме. Возвращает краткую сводку фактов со ссылками.",
        prompt="Ты — исследователь. Тебе дают тему или вопрос. Сделай несколько веб-поисков "
        "(WebSearch), при необходимости открой страницы (WebFetch), сверь источники и верни "
        "сжатую фактическую сводку со ссылками. Не выдумывай; помечай неуверенность.",
        tools=["WebSearch", "WebFetch", "Read", "Grep", "Glob"],
        model="sonnet",
    ),
    "librarian": AgentDefinition(
        description="Реорганизация вики. Делегируй для крупных операций над базой знаний: "
        "навести порядок, разбить/объединить страницы, проставить ссылки.",
        prompt="Ты — библиотекарь персональной вики (markdown в рабочей директории). Аккуратно "
        "реорганизуй заметки по запросу: осмысленные имена, заголовки, относительные ссылки "
        "[текст](путь.md). Не теряй контент. По итогу кратко перечисли, что изменил.",
        tools=["Read", "Write", "Edit", "MultiEdit", "Grep", "Glob"],
        model="sonnet",
    ),
}

# Serializes the single session so web and Telegram turns never resume it concurrently.
claude_lock = asyncio.Lock()

Emit = Callable[[dict], Awaitable[None]]


# --- Session persistence ---

def load_session_state() -> tuple[str | None, bool]:
    """(session_id, expired). A session idle beyond SESSION_FRESH_HOURS is
    discarded (freshness window): expired=True so the caller can tell
    the fresh agent why the conversation restarted."""
    try:
        with open(config.SESSION_FILE) as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None, False
    sid = data.get("session_id")
    last = data.get("last_used")
    if sid and last and config.SESSION_FRESH_HOURS > 0:
        try:
            if datetime.now() - datetime.fromisoformat(last) > timedelta(hours=config.SESSION_FRESH_HOURS):
                logger.info("session %s expired (idle > %sh) — starting fresh", sid[:8], config.SESSION_FRESH_HOURS)
                session_log.end(sid, "expired")
                clear_session()
                return None, True
        except ValueError:
            pass
    return sid, False


def load_session() -> str | None:
    return load_session_state()[0]


def session_age() -> str | None:
    """Human-readable age of the current session (for /status)."""
    try:
        with open(config.SESSION_FILE) as f:
            data = json.load(f)
        started = datetime.fromisoformat(data["started"])
    except (FileNotFoundError, json.JSONDecodeError, KeyError, ValueError):
        return None
    mins = int((datetime.now() - started).total_seconds() // 60)
    return f"{mins // 60}ч {mins % 60}м" if mins >= 60 else f"{mins}м"


def save_session(session_id: str | None) -> None:
    if not session_id:
        return
    os.makedirs(config.DATA_DIR, exist_ok=True)
    started = None
    try:
        with open(config.SESSION_FILE) as f:
            prev = json.load(f)
        if prev.get("session_id") == session_id:
            started = prev.get("started")
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    now = datetime.now().isoformat(timespec="seconds")
    with open(config.SESSION_FILE, "w") as f:
        json.dump({"session_id": session_id, "last_used": now, "started": started or now}, f)


def clear_session() -> None:
    try:
        with open(config.SESSION_FILE) as f:
            sid = json.load(f).get("session_id")
        session_log.end(sid, "clear")  # journal keeps the transcript; only the pointer dies
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    try:
        os.remove(config.SESSION_FILE)
    except FileNotFoundError:
        pass


# --- Options ---

# Frozen per session: memory is re-read only when the session
# changes, so a mid-session remember() doesn't bust the prompt prefix cache.
# Writes still hit disk immediately; the snapshot refreshes on the next session.
_mem_snapshot = {"key": "", "text": ""}


def _memory_snapshot(resume: str | None) -> str:
    if resume is None or resume != _mem_snapshot["key"]:
        _mem_snapshot["key"] = resume
        _mem_snapshot["text"] = memory_store.as_prompt()
    return _mem_snapshot["text"]


# Persona (SOUL.md-style): a wiki page the user edits like any note; injected as the
# first prompt block. Frozen per session (same reason as the memory snapshot).
_persona_snapshot: dict = {"key": "", "text": ""}  # key "" = never read (resume is None or a sid)

DEFAULT_PERSONA = (
    "# Персона ассистента\n\n"
    "Эту страницу можно редактировать — она попадает в системный промпт ассистента "
    "(перечитывается при старте новой сессии).\n\n"
    "Ты — Бендер, личный ассистент. Спокойный, краткий, честный. Говоришь по-русски, "
    "по делу, без канцелярита и восторгов. Не поддакиваешь: если пользователь неправ "
    "или есть вариант лучше — говоришь об этом прямо и предлагаешь альтернативу.\n"
)


def _read_persona() -> str:
    try:
        with open(config.PERSONA_PATH, encoding="utf-8") as f:
            return f.read().strip()
    except FileNotFoundError:
        try:
            os.makedirs(os.path.dirname(config.PERSONA_PATH), exist_ok=True)
            with open(config.PERSONA_PATH, "w", encoding="utf-8") as f:
                f.write(DEFAULT_PERSONA)
        except OSError:
            logger.warning("cannot seed persona file at %s", config.PERSONA_PATH)
        return DEFAULT_PERSONA
    except OSError:
        return ""


def _persona(resume: str | None) -> str:
    if resume != _persona_snapshot["key"]:
        _persona_snapshot["key"] = resume
        _persona_snapshot["text"] = _read_persona()
    return _persona_snapshot["text"]


def _compose_prompt(surface: str, resume: str | None) -> str:
    # Learned skills are no longer injected as an index — they're native Skills (loaded via
    # the learned plugin) and surface through progressive disclosure / the Skill tool.
    parts = []
    persona = _persona(resume)
    if persona:
        parts.append(persona)
    parts.append(config.system_prompt_for(surface))
    mem = _memory_snapshot(resume)
    if mem:
        parts.append(mem)
    return "\n\n".join(parts)


def _surface_nudge_hook(surface: str):
    """UserPromptSubmit hook that biases a domain frontend toward its native Skill.
    Returns None for surfaces with no nudge (Telegram/universal → model self-selects)."""
    nudge = config.SKILL_NUDGE.get(surface)
    if not nudge:
        return None

    async def hook(input_data, tool_use_id, context):  # noqa: ARG001 — SDK callback signature
        return {
            "hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit",
                "additionalContext": nudge,
            }
        }

    return hook


def build_options(resume: str | None, surface: str = "wiki", interactive: bool = True,
                  extra_context: str | None = None) -> ClaudeAgentOptions:
    # Tasks, skills (read+author), memory-read injection and subagents (Task) are always
    # available. Cron/memory WRITE tools are interactive-only (not inside scheduled runs).
    tools = config.ALLOWED_TOOLS + TASK_TOOL_NAMES + SKILL_TOOL_NAMES + SESSION_TOOL_NAMES
    if interactive:
        tools = tools + CRON_TOOL_NAMES + MEMORY_TOOL_NAMES
    append = _compose_prompt(surface, resume)
    if extra_context:
        append = f"{append}\n\n{extra_context}"
    # Domain skills (wiki/tasks) are native SDK Skills loaded from our plugin dir. The Skill
    # tool is auto-added by the SDK when skills are enabled. A per-surface hook nudges the
    # domain frontends toward the right skill; Telegram gets none (model self-selects).
    hook = _surface_nudge_hook(surface)
    hooks = {"UserPromptSubmit": [HookMatcher(hooks=[hook])]} if hook else None
    # Enable ONLY our own skills by name — NOT "all". The mounted host ~/.claude carries the
    # official Claude plugin marketplace (code-review, deep-research, run, loop, …); skills="all"
    # would expose all of those. An explicit allow-list keeps the assistant self-contained:
    # domain wiki/tasks + whatever the agent has learned.
    allowed_skills = ["wiki", "tasks"] + [s["slug"] for s in skill_store.list_skills()]
    return ClaudeAgentOptions(
        model=config.CLAUDE_MODEL,
        system_prompt={"type": "preset", "preset": "claude_code", "append": append},
        allowed_tools=tools,
        mcp_servers={"tasks": tasks_server, "cron": cron_server, "memory": memory_server,
                     "skills": skills_server, "sessions": sessions_server},
        agents=SUBAGENTS,
        plugins=[
            {"type": "local", "path": config.SKILL_PLUGIN_DIR},      # domain skills (wiki/tasks)
            {"type": "local", "path": config.LEARNED_PLUGIN_DIR},    # agent-authored skills
        ],
        skills=allowed_skills,
        hooks=hooks,
        cwd=config.WIKI_DIR,
        include_partial_messages=True,
        resume=resume,
        # Don't inherit host ~/.claude project/user settings — keep the agent self-contained.
        # Skills come from `plugins` above, which is independent of setting_sources.
        setting_sources=None,
    )


def _error_text(m: ResultMessage) -> str:
    blob = " ".join(str(x) for x in (m.result, m.errors, m.api_error_status) if x).lower()
    if "context" in blob or "too long" in blob or "max tokens" in blob:
        return "Контекст сессии переполнен. Начните новую: /new в боте или «Очистить» в чате."
    return "Ошибка Claude. Попробуйте начать новую сессию (/new)."


class _StaleSession(Exception):
    """Resume referenced a session id the CLI no longer has (e.g. after a host
    migration or CLI cache prune). Recoverable: clear the session and retry fresh."""


def _is_stale_session(exc: Exception) -> bool:
    return "No conversation found with session" in str(exc)


# --- Web: stream events to a WebSocket-like emitter ---

async def run_ws(emit: Emit, message: str, surface: str = "wiki") -> None:
    async with claude_lock:
        raw = message
        message = f"{clock.stamp()}\n{message}"  # live clock: the session's system-prompt date goes stale
        pending = cron_outbox.drain_as_prompt()
        try:
            await _run_ws(emit, message, surface, pending, raw)
        except _StaleSession:
            logger.warning("stale session in run_ws; cleared, retrying fresh")
            clear_session()
            await _run_ws(emit, message, surface, pending, raw)


EXPIRED_NOTE = (
    "[Прошлая сессия закрыта по неактивности — это начало нового разговора. Долговременная "
    "память ниже актуальна; историю прошлых бесед не выдумывай.]\n"
)


async def _run_ws(emit: Emit, message: str, surface: str, pending: str, raw: str) -> None:
    sid, expired = load_session_state()
    if expired:
        message = EXPIRED_NOTE + message
    streaming_text = ""
    current_msg_id = ""
    last_push = 0.0
    THROTTLE = 0.05
    final_sid = sid
    produced = False
    reply_parts: list[str] = []

    async def _emit(ev: dict) -> None:
        nonlocal produced
        if ev.get("t") in ("text", "tool"):
            produced = True
        await emit(ev)

    try:
        async for m in query(prompt=message, options=build_options(sid, surface, extra_context=pending)):
            if isinstance(m, StreamEvent):
                ev = m.event
                itype = ev.get("type", "")
                if itype == "message_start":
                    streaming_text = ""
                    current_msg_id = ev.get("message", {}).get("id", current_msg_id)
                elif itype == "content_block_delta":
                    delta = ev.get("delta", {})
                    if delta.get("type") == "text_delta" and delta.get("text"):
                        streaming_text += delta["text"]
                        now = time.monotonic()
                        if now - last_push >= THROTTLE:
                            await _emit({"t": "text", "id": current_msg_id, "text": streaming_text})
                            last_push = now
                elif itype == "content_block_stop":
                    if streaming_text:
                        await _emit({"t": "text", "id": current_msg_id, "text": streaming_text})
                        last_push = time.monotonic()

            elif isinstance(m, AssistantMessage):
                current_msg_id = m.message_id or current_msg_id
                for block in m.content:
                    if isinstance(block, TextBlock) and block.text:
                        reply_parts.append(block.text)
                        await _emit({"t": "text", "id": current_msg_id, "text": block.text})
                    elif isinstance(block, ToolUseBlock):
                        inp = block.input or {}
                        await _emit({
                            "t": "tool",
                            "name": block.name or "",
                            "pattern": (inp.get("pattern") or inp.get("command", ""))[:80],
                            "file": inp.get("file_path", ""),
                        })
                streaming_text = ""

            elif isinstance(m, ResultMessage):
                final_sid = m.session_id or sid
                if m.is_error:
                    await emit({"t": "error", "text": _error_text(m)})

        save_session(final_sid)
        session_log.log_turn(final_sid, surface, raw, "\n\n".join(reply_parts))
        await emit({"t": "done", "sid": final_sid})
        from . import reviewer
        reviewer.spawn(message, "\n\n".join(reply_parts))

    except Exception as e:  # noqa: BLE001 — surface any engine failure to the client
        if _is_stale_session(e) and not produced:
            raise _StaleSession from e  # nothing emitted yet → safe to retry fresh
        logger.exception("run_ws failed")
        await emit({"t": "error", "text": str(e)})
        await emit({"t": "done", "sid": load_session()})


# --- Telegram: run one turn, return the full reply text ---

async def run_collect(message: str, on_tool: Callable[[str, str], Awaitable[None]] | None = None,
                      surface: str = "telegram",
                      on_delta: Callable[[str], Awaitable[None]] | None = None) -> str:
    """Run one turn and return the full reply. `on_delta` (if given) receives the
    accumulated reply text as it streams — used for Telegram draft previews."""
    async with claude_lock:
        raw = message
        message = f"{clock.stamp()}\n{message}"  # live clock: the session's system-prompt date goes stale
        pending = cron_outbox.drain_as_prompt()
        for attempt in (1, 2):  # attempt 2 only runs after a stale-session reset
            sid, expired = load_session_state()
            prompt = (EXPIRED_NOTE + message) if expired else message
            texts: list[str] = []
            partial = ""
            result_text = ""
            final_sid = sid
            had_error = False

            try:
                async for m in query(prompt=prompt, options=build_options(sid, surface, extra_context=pending)):
                    if isinstance(m, StreamEvent) and on_delta:
                        ev = m.event
                        delta = ev.get("delta", {}) if ev.get("type") == "content_block_delta" else {}
                        if delta.get("type") == "text_delta" and delta.get("text"):
                            partial += delta["text"]
                            try:
                                await on_delta("\n\n".join([*texts, partial]))
                            except Exception:
                                pass
                    elif isinstance(m, AssistantMessage):
                        partial = ""
                        for block in m.content:
                            if isinstance(block, TextBlock) and block.text:
                                texts.append(block.text)
                            elif isinstance(block, ToolUseBlock) and on_tool:
                                inp = block.input or {}
                                detail = inp.get("file_path") or inp.get("pattern") or (inp.get("command", "")[:80])
                                try:
                                    await on_tool(block.name or "", detail)
                                except Exception:
                                    pass
                    elif isinstance(m, ResultMessage):
                        final_sid = m.session_id or sid
                        had_error = m.is_error
                        if not m.is_error and m.result:
                            result_text = m.result
            except Exception as e:
                if attempt == 1 and _is_stale_session(e):
                    logger.warning("stale session in run_collect; cleared, retrying fresh")
                    clear_session()
                    continue
                logger.exception("run_collect failed")
                return "Что-то пошло не так при обработке запроса."

            save_session(final_sid)
            if had_error:
                return "Ошибка Claude. Попробуйте начать новую сессию (/new)."
            reply = (result_text or "\n\n".join(texts)).strip()
            session_log.log_turn(final_sid, surface, raw, reply)
            if reply:
                from . import reviewer
                reviewer.spawn(message, reply)
            return reply or "(пустой ответ)"


# --- Cron: isolated one-off run, no shared session, no cron tools (anti-recursion) ---

async def run_cron(prompt: str, surface: str = "telegram") -> str:
    texts: list[str] = []
    result_text = ""
    options = build_options(resume=None, surface=surface, interactive=False)
    try:
        async for m in query(prompt=prompt, options=options):
            if isinstance(m, AssistantMessage):
                for block in m.content:
                    if isinstance(block, TextBlock) and block.text:
                        texts.append(block.text)
            elif isinstance(m, ResultMessage):
                if not m.is_error and m.result:
                    result_text = m.result
    except Exception:
        logger.exception("run_cron failed")
        return ""
    return (result_text or "\n\n".join(texts)).strip()
