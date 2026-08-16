"""Оркестратор разговора: нити, сессии, персона и память, журнал — всё, что вокруг хода.

Сам ход делает движок (engines/): Claude по подписке Max или Codex по подписке ChatGPT.
Одна общая сессия на веб и Telegram, сериализованная agent_lock и продолжаемая по id
из data/session.json.
"""

import asyncio
import json
import logging
import os
import time
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta

from . import clock, config, cron_outbox, engines, memory_store, session_log

logger = logging.getLogger("wiki.agent")

# Serializes the single session so web and Telegram turns never resume it concurrently.
agent_lock = asyncio.Lock()

Emit = Callable[[dict], Awaitable[None]]

# --- Session persistence ---
#
# Нитей несколько. Телеграм, вики и задачи — одна общая («main»): это один и тот же
# разговор с ассистентом, просто из разных окон, и общий контекст там полезен
# («положи это в задачи»). Читалка — своя нить на книгу: разговор про книгу состоит
# из микроходов («переведи слово», «а можешь пример»), их много, они объёмные и вне
# книги не нужны. В одной нити они выдавливали общий разговор — реплика из телеграма
# приходила в контекст, на девять десятых забитый чужой книгой, и агент достраивал
# ответ из неё. Знание при этом не теряется: журнал общий на все нити.

MAIN = "main"


def thread_key(surface: str, book_id: str = "") -> str:
    """Нить разговора. Книга — по id: между двумя книгами связь не нужна и мешает."""
    return f"books:{book_id}" if surface == "books" and book_id else MAIN


def _read_threads() -> dict:
    """Карта нитей. Файл старого формата (одна сессия в корне) читается как main."""
    try:
        with open(config.SESSION_FILE) as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    if not isinstance(data, dict):
        return {}
    if "session_id" in data:
        return {MAIN: data}
    threads = data.get("threads")
    return threads if isinstance(threads, dict) else {}


def _write_threads(threads: dict) -> None:
    os.makedirs(config.DATA_DIR, exist_ok=True)
    with open(config.SESSION_FILE, "w") as f:
        json.dump({"threads": threads}, f)


def load_session_state(thread: str = MAIN) -> tuple[str | None, bool]:
    """(session_id, expired). A session idle beyond SESSION_FRESH_HOURS is
    discarded (freshness window): expired=True so the caller can tell
    the fresh agent why the conversation restarted."""
    data = _read_threads().get(thread) or {}
    sid = data.get("session_id")
    last = data.get("last_used")
    if sid and last and config.SESSION_FRESH_HOURS > 0:
        try:
            if datetime.now() - datetime.fromisoformat(last) > timedelta(hours=config.SESSION_FRESH_HOURS):
                logger.info("session %s (%s) expired (idle > %sh) — starting fresh",
                            sid[:8], thread, config.SESSION_FRESH_HOURS)
                session_log.end(sid, "expired")
                clear_session(thread)
                return None, True
        except ValueError:
            pass
    return sid, False


def load_session(thread: str = MAIN) -> str | None:
    return load_session_state(thread)[0]


def _age(started: str | None) -> str | None:
    try:
        mins = int((datetime.now() - datetime.fromisoformat(started)).total_seconds() // 60)
    except (TypeError, ValueError):
        return None
    return f"{mins // 60}ч {mins % 60}м" if mins >= 60 else f"{mins}м"


def session_age(thread: str = MAIN) -> str | None:
    """Human-readable age of the thread's session (for /status)."""
    return _age((_read_threads().get(thread) or {}).get("started"))


def threads_overview() -> list[dict]:
    """Живые нити для /status: ключ, id сессии, возраст."""
    out = []
    for key, d in sorted(_read_threads().items()):
        if d.get("session_id"):
            out.append({"key": key, "session_id": d["session_id"], "age": _age(d.get("started"))})
    return out


def save_session(thread: str, session_id: str | None) -> None:
    if not session_id:
        return
    threads = _read_threads()
    prev = threads.get(thread) or {}
    now = datetime.now().isoformat(timespec="seconds")
    started = prev.get("started") if prev.get("session_id") == session_id else None
    threads[thread] = {"session_id": session_id, "last_used": now, "started": started or now}
    _write_threads(threads)


def clear_session(thread: str = MAIN) -> None:
    threads = _read_threads()
    data = threads.pop(thread, None)
    if data is None:
        return
    session_log.end(data.get("session_id"), "clear")  # journal keeps the transcript; only the pointer dies
    _write_threads(threads)


# --- Options ---

# Frozen per session: memory is re-read only when the session
# changes, so a mid-session remember() doesn't bust the prompt prefix cache.
# Writes still hit disk immediately; the snapshot refreshes on the next session.
# Снимок на каждую сессию, а не один общий: нити чередуются (книга ↔ телеграм),
# и с одним снимком каждое переключение перечитывало бы память заново.
_SNAP_MAX = 8  # нитей столько и не бывает; страховка от роста на долгом аптайме
_mem_snapshots: dict[str, str] = {}


def _snapshot(cache: dict[str, str], resume: str | None, read: Callable[[], str]) -> str:
    if resume is None:  # новая сессия — берём свежее
        return read()
    if resume not in cache:
        if len(cache) >= _SNAP_MAX:
            cache.clear()
        cache[resume] = read()
    return cache[resume]


def _memory_snapshot(resume: str | None) -> str:
    return _snapshot(_mem_snapshots, resume, memory_store.as_prompt)


# Persona (SOUL.md-style): a wiki page the user edits like any note; injected as the
# first prompt block. Frozen per session (same reason as the memory snapshot).
_persona_snapshots: dict[str, str] = {}

DEFAULT_PERSONA = (
    "# Персона ассистента\n\n"
    "Эту страницу можно редактировать — она попадает в системный промпт ассистента "
    "(перечитывается при старте новой сессии).\n\n"
    "Ты — Бендер, личный ассистент. Спокойный, краткий, честный. Говоришь по-русски, "
    "по делу, без канцелярита и восторгов. Не поддакиваешь: если пользователь неправ "
    "или есть вариант лучше — говоришь об этом прямо и предлагаешь альтернативу.\n"
)


def _read_persona() -> str:
    path = config.persona_path()
    try:
        with open(path, encoding="utf-8") as f:
            return f.read().strip()
    except FileNotFoundError:
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                f.write(DEFAULT_PERSONA)
        except OSError:
            logger.warning("cannot seed persona file at %s", path)
        return DEFAULT_PERSONA
    except OSError:
        return ""


def _persona(resume: str | None) -> str:
    return _snapshot(_persona_snapshots, resume, _read_persona)


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




# --- Один ход: движок отдаёт события, мы склеиваем их в то, что видит интерфейс ---

THROTTLE = 0.05   # чаще пятидесяти кадров в секунду обновлять текст незачем


class _Text:
    """Накопитель потокового ответа: движок шлёт куски, а показывать надо целое."""

    def __init__(self):
        self.id = ""
        self.buf = ""
        self.last_push = 0.0

    def add(self, msg_id: str, chunk: str) -> None:
        if msg_id != self.id:
            self.id, self.buf = msg_id, ""
        self.buf += chunk

    def due(self) -> bool:
        return time.monotonic() - self.last_push >= THROTTLE

    def taken(self) -> str:
        self.last_push = time.monotonic()
        return self.buf

    def reset(self) -> None:
        self.id, self.buf = "", ""


EXPIRED_NOTE = (
    "[Прошлая сессия закрыта по неактивности — это начало нового разговора. Долговременная "
    "память ниже актуальна; историю прошлых бесед не выдумывай.]\n"
)


def _preamble(message: str, thread: str) -> tuple[str, list[str]]:
    """Служебное, что клеится к реплике: часы и неотправленные крон-сообщения."""
    message = f"{clock.stamp()}\n{message}"  # live clock: the session's date goes stale
    # Крон пишет в телеграм, то есть в общую нить: в разговоре про книгу этот блок —
    # чужой шум. Клеится к реплике, а не к инструкциям: отправленное сообщение —
    # часть беседы, и в стенограмме оно останется.
    note, keys = cron_outbox.pending() if thread == MAIN else ("", [])
    return (f"{note}\n\n{message}" if note else message), keys


async def _finish(thread: str, out, raw: str, surface: str, keys: list[str]) -> None:
    save_session(thread, out.session_id)
    cron_outbox.drop(keys)  # доехало до стенограммы — вычёркиваем
    session_log.log_turn(out.session_id, surface, raw, out.reply)
    if out.reply:
        from . import reviewer
        reviewer.spawn(raw, out.reply)


# --- Web: stream events to a WebSocket-like emitter ---

async def run_ws(emit: Emit, message: str, surface: str = "wiki", thread: str = MAIN) -> None:
    async with agent_lock:
        raw = message
        message, keys = _preamble(message, thread)
        try:
            await _run_ws(emit, message, surface, raw, thread, keys)
        except engines.StaleSession:
            logger.warning("stale session in run_ws; cleared, retrying fresh")
            clear_session(thread)
            await _run_ws(emit, message, surface, raw, thread, keys)


async def _run_ws(emit: Emit, message: str, surface: str, raw: str,
                  thread: str = MAIN, outbox_keys: list[str] | None = None) -> None:
    sid, expired = load_session_state(thread)
    if expired:
        message = EXPIRED_NOTE + message
    text = _Text()
    produced = False

    async def on_event(ev: dict) -> None:
        nonlocal produced
        kind = ev.get("t")
        if kind == "delta":
            text.add(ev.get("id", ""), ev.get("text", ""))
            if text.due():
                produced = True
                await emit({"t": "text", "id": text.id, "text": text.taken()})
        elif kind == "flush":
            if text.buf:
                produced = True
                await emit({"t": "text", "id": text.id, "text": text.taken()})
        elif kind == "text":
            produced = True
            text.reset()
            await emit({"t": "text", "id": ev.get("id", ""), "text": ev.get("text", "")})
        elif kind == "tool":
            produced = True
            await emit(ev)
        elif kind == "error":
            await emit(ev)

    try:
        out = await engines.get().run(
            message, resume=sid, surface=surface, instructions=_compose_prompt(surface, sid),
            emit=on_event)
        if out.error:
            await emit({"t": "error", "text": out.error})
        await _finish(thread, out, raw, surface, outbox_keys or [])
        await emit({"t": "done", "sid": out.session_id})

    except engines.StaleSession:
        if produced:            # что-то уже показали — переигрывать ход поздно
            logger.exception("stale session after output")
            await emit({"t": "error", "text": "Сессия потерялась. Начните новую: «Очистить»."})
            await emit({"t": "done", "sid": load_session(thread)})
            return
        raise
    except Exception as e:  # noqa: BLE001 — surface any engine failure to the client
        logger.exception("run_ws failed")
        await emit({"t": "error", "text": str(e)})
        await emit({"t": "done", "sid": load_session(thread)})


# --- Telegram: run one turn, return the full reply text ---

def _collector(texts: list[str], on_delta, on_tool):
    """Обработчик событий хода для Telegram: копит ответ и по дороге показывает черновик.
    Отдельной фабрикой, а не замыканием внутри цикла повторов, — чтобы у каждой попытки
    был свой накопитель и это было видно."""
    text = _Text()

    async def on_event(ev: dict) -> None:
        kind = ev.get("t")
        if kind == "delta" and on_delta:
            text.add(ev.get("id", ""), ev.get("text", ""))
            try:
                await on_delta("\n\n".join([*texts, text.buf]))
            except Exception:  # noqa: BLE001 — черновик не повод ронять ход
                pass
        elif kind == "text":
            texts.append(ev.get("text", ""))
            text.reset()
        elif kind == "tool" and on_tool:
            try:
                await on_tool(ev.get("name", ""), ev.get("file") or ev.get("pattern", ""))
            except Exception:  # noqa: BLE001 — показ инструмента тоже не критичен
                pass

    return on_event


async def run_collect(message: str, on_tool: Callable[[str, str], Awaitable[None]] | None = None,
                      surface: str = "telegram",
                      on_delta: Callable[[str], Awaitable[None]] | None = None,
                      thread: str = MAIN) -> str:
    """Run one turn and return the full reply. `on_delta` (if given) receives the
    accumulated reply text as it streams — used for Telegram draft previews."""
    async with agent_lock:
        raw = message
        message, keys = _preamble(message, thread)
        for attempt in (1, 2):  # attempt 2 only runs after a stale-session reset
            sid, expired = load_session_state(thread)
            prompt = (EXPIRED_NOTE + message) if expired else message
            texts: list[str] = []
            on_event = _collector(texts, on_delta, on_tool)

            try:
                out = await engines.get().run(
                    prompt, resume=sid, surface=surface,
                    instructions=_compose_prompt(surface, sid), emit=on_event)
            except engines.StaleSession:
                if attempt == 1:
                    logger.warning("stale session in run_collect; cleared, retrying fresh")
                    clear_session(thread)
                    continue
                return "Что-то пошло не так при обработке запроса."
            except Exception:
                logger.exception("run_collect failed")
                return "Что-то пошло не так при обработке запроса."

            if out.error:
                save_session(thread, out.session_id)
                return out.error
            await _finish(thread, out, raw, surface, keys)
            return out.reply.strip() or "(пустой ответ)"


# --- Cron: isolated one-off run, no shared session, no cron tools (anti-recursion) ---

async def run_cron(prompt: str, surface: str = "telegram") -> str:
    async def sink(_ev: dict) -> None:
        pass

    try:
        out = await engines.get().run(
            prompt, resume=None, surface=surface,
            instructions=_compose_prompt(surface, None), emit=sink, interactive=False)
    except Exception:
        logger.exception("run_cron failed")
        return ""
    return out.reply.strip()
