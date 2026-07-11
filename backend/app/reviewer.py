"""Post-turn background self-review (Hermes' background_review, simplified).

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

_RULES = (
    "Ты — фоновый ревьюер личного ассистента. Тебе дают последний обмен репликами "
    "(сообщение пользователя и ответ ассистента). Реши, нужно ли что-то сохранить НАВСЕГДА, "
    "и если да — сохрани инструментами. Чаще всего сохранять НЕЧЕГО: тогда ответь «ничего» "
    "и не зови инструменты.\n\n"
    "СОХРАНЯЙ (mcp__memory__remember):\n"
    "- новый стабильный факт о пользователе (profile) или устойчивый контекст (note);\n"
    "- предпочтение, КАК работать с пользователем (pref) — особенно если он поправил "
    "ассистента или выразил раздражение («не повторяйся», «короче», «без списков»). "
    "Формулируй декларативно («предпочитает…»), не как команду («всегда делай…»).\n"
    "СОХРАНЯЙ (mcp__skills__save): нетривиальную повторяемую процедуру, которую ассистент "
    "успешно выполнил и которая пригодится снова (имя kebab-case латиницей).\n\n"
    "НЕ СОХРАНЯЙ:\n"
    "- то, что уже есть в памяти или навыках (список ниже) — дубликаты запрещены;\n"
    "- разовые артефакты: номера, id, даты одноразовых событий, «сделал X»;\n"
    "- жалобы на сломанные инструменты и транзиентные ошибки;\n"
    "- содержимое, которому место в вики или задачах, а не в памяти ассистента.\n"
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


async def _review(user_text: str, reply_text: str) -> None:
    global _busy
    try:
        prompt = (
            "Обмен для ревью.\n\n"
            f"ПОЛЬЗОВАТЕЛЬ:\n{user_text[:3000]}\n\n"
            f"АССИСТЕНТ:\n{reply_text[:3000]}"
        )
        async for _ in query(prompt=prompt, options=_options()):
            pass
        logger.info("post-turn review done")
    except Exception as e:  # noqa: BLE001 — background best-effort
        logger.warning("post-turn review failed: %s", e)
    finally:
        _busy = False


def spawn(user_text: str, reply_text: str) -> None:
    """Fire-and-forget review of the finished turn. Skips when disabled, when a
    review is already running (no queue — the next turn will catch up), or when
    there is nothing meaningful to look at."""
    global _busy
    if not config.REVIEWER_ENABLED or _busy:
        return
    if not (user_text or "").strip() or not (reply_text or "").strip():
        return
    _busy = True
    asyncio.create_task(_review(user_text, reply_text))
