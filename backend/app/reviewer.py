"""Post-turn background self-review.

After each interactive turn a separate small agent re-reads the exchange and
decides whether anything deserves persisting: a stable fact/preference into
long-term memory, or a reusable procedure into a skill. The main turn never
waits for it; failures are logged and dropped. Tool access is whitelisted to
memory + skills only, so the reviewer can't touch the wiki or schedule jobs.
"""

import asyncio
import logging

from claude_agent_sdk import ClaudeAgentOptions, query

from . import config, memory_store, skill_store
from .memory_tools import TOOL_NAMES as MEMORY_TOOL_NAMES
from .memory_tools import server as memory_server
from .skill_tools import TOOL_NAMES as SKILL_TOOL_NAMES
from .skill_tools import server as skills_server

logger = logging.getLogger("wiki.reviewer")

_busy = False
_turns_since = 0
_seen_write_seq = 0

_RULES = (
    "Ты — фоновый ревьюер личного ассистента. Тебе дают последние обмены репликами "
    "(сообщения пользователя и ответы ассистента). Реши, нужно ли что-то сохранить НАВСЕГДА, "
    "и если да — сохрани инструментами. Чаще всего сохранять НЕЧЕГО: тогда ответь «ничего» "
    "и не зови инструменты.\n\n"
    "СОХРАНЯЙ (mcp__memory__remember):\n"
    "- новый стабильный факт о пользователе (profile) или устойчивый контекст (note);\n"
    "- предпочтение, КАК работать с пользователем (pref) — особенно если он поправил "
    "ассистента или выразил раздражение («не повторяйся», «короче», «без списков»). "
    "Формулируй декларативно («предпочитает…»), не как команду («всегда делай…»).\n"
    "Если новое — уточнение уже существующей записи, НЕ добавляй новую: обнови старую "
    "через mcp__memory__update_memory. Память ограничена по объёму; при переполнении "
    "сначала слей пересекающиеся записи и удали устаревшие (mcp__memory__forget).\n"
    "СОХРАНЯЙ (mcp__skills__save): нетривиальную повторяемую процедуру, которую ассистент "
    "успешно выполнил и которая пригодится снова (имя kebab-case латиницей).\n\n"
    "НЕ СОХРАНЯЙ:\n"
    "- то, что уже есть в памяти или навыках (список ниже) — дубликаты запрещены;\n"
    "- прогресс текущей задачи: промежуточные результаты, шорт-листы, варианты, «что "
    "обсудили и на чём остановились». Это состояние сессии — оно целиком остаётся в "
    "журнале сессий (session_search), в памяти ему не место. Из длинной итеративной "
    "сессии в память попадает максимум ОДНА строка о сути (что ищет/делает и по каким "
    "критериям), и та обновляется, а не наслаивается;\n"
    "- то, что ассистент записал в вики или задачи, — не дублируй содержимое в память; "
    "если важно не потерять, сохрани только указатель («данные X — в вики такой-то»);\n"
    "- разовые артефакты: номера документов, id, VIN, реквизиты, даты одноразовых "
    "событий, «сделал X»;\n"
    "- жалобы на сломанные инструменты и транзиентные ошибки.\n"
)


def _context() -> str:
    mem = memory_store.as_prompt() or "(память пуста)"
    skills = ", ".join(s["slug"] for s in skill_store.list_skills()) or "(нет)"
    return f"{mem}\n\nСуществующие навыки: {skills}"


def _options() -> ClaudeAgentOptions:
    return ClaudeAgentOptions(
        model=config.REVIEWER_MODEL,
        system_prompt=_RULES + "\n" + _context(),
        allowed_tools=MEMORY_TOOL_NAMES + SKILL_TOOL_NAMES,
        mcp_servers={"memory": memory_server, "skills": skills_server},
        cwd=config.DATA_DIR,
        resume=None,
        max_turns=6,
        setting_sources=None,
    )


_buffer: list[tuple[str, str]] = []


async def _review(exchanges: list[tuple[str, str]]) -> None:
    global _busy
    try:
        parts = ["Обмены для ревью (от старых к новым)."]
        for user_text, reply_text in exchanges:
            parts.append(f"ПОЛЬЗОВАТЕЛЬ:\n{user_text[:1500]}\n\nАССИСТЕНТ:\n{reply_text[:1500]}")
        async for _ in query(prompt="\n\n---\n\n".join(parts), options=_options()):
            pass
        logger.info("background review done (%d exchanges)", len(exchanges))
    except Exception as e:  # noqa: BLE001 — background best-effort
        logger.warning("background review failed: %s", e)
    finally:
        _busy = False


def spawn(user_text: str, reply_text: str) -> None:
    """Buffer the finished turn; fire a background review every N turns
    (Hermes-style nudge interval). The counter resets when the main agent
    saved memory itself this turn — then the reviewer has nothing to add."""
    global _busy, _turns_since, _seen_write_seq
    if not config.REVIEWER_ENABLED:
        return
    if not (user_text or "").strip() or not (reply_text or "").strip():
        return
    _buffer.append((user_text, reply_text))
    del _buffer[:-config.REVIEWER_EVERY_TURNS]
    if memory_store.write_seq != _seen_write_seq:
        _seen_write_seq = memory_store.write_seq
        _turns_since = 0
        _buffer.clear()
        return
    _turns_since += 1
    if _turns_since < config.REVIEWER_EVERY_TURNS or _busy:
        return
    _turns_since = 0
    exchanges = list(_buffer)
    _buffer.clear()
    _busy = True
    asyncio.create_task(_review(exchanges))
