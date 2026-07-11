"""Cron scheduler: ticks every 60s, runs due jobs as isolated agent turns,
delivers the result to Telegram (unless the job is marked silent)."""

import asyncio
import logging
from datetime import datetime

from . import agent, clock, cron_outbox, cron_store, curator
from .telegram import notify

logger = logging.getLogger("wiki.cron")

TICK_SECONDS = 60

# Prepended to every scheduled prompt. Keeps the run's final text clean: the
# scheduler delivers it verbatim, so the agent must not narrate its own actions
# or try to "send" anything.
CRON_HINT = (
    "[Ты запущен как запланированная задача (cron). Твой финальный ответ будет автоматически "
    "доставлен пользователю как есть.\n"
    "ЖЁСТКИЕ ПРАВИЛА вывода — они приоритетнее текста самого задания:\n"
    "— Выведи ТОЛЬКО сам результат (например, текст анекдота / сводку / напоминание). Ничего "
    "вокруг.\n"
    "— Без служебных вступлений и обращений («Готово», «Лови», «Сергей, …»), без постскриптумов "
    "и P.S., без отчётов о своих действиях и об инструментах, без emoji.\n"
    "— Расписанием НЕ управляй и не упоминай его: разовые задачи система удаляет сама. У тебя "
    "и нет инструментов крона — не пытайся их звать и не жалуйся на их отсутствие.\n"
    "— Если докладывать нечего ИЛИ по сравнению с уже отправленным (блок «Предыдущие запуски» "
    "ниже) ничего существенно не изменилось — ответь ровно \"[SILENT]\" и больше ничего. Никогда "
    "не пересылай переформулировки уже отправленного и филлеры вида «без изменений».\n"
    "— Если отслеживаемое событие полностью завершилось и это финальный итог — начни ответ "
    "строкой \"[FINAL]\", дальше сам итог. Система после этого остановит задание. Если итог уже "
    "был отправлен в предыдущем запуске — ответь [SILENT].]\n\n"
)

_SILENT_TOKENS = {"SILENT", "NO_REPLY", "NOREPLY"}
FINAL = "[FINAL]"


def _is_silent_line(line: str) -> bool:
    return line.strip().strip("[]().!").upper() in _SILENT_TOKENS


def _suppressed(output: str) -> bool:
    """Tolerant [SILENT] matcher: whole answer, first or last line,
    with or without brackets — but never the token buried mid-sentence."""
    lines = [ln for ln in (output or "").splitlines() if ln.strip()]
    if not lines:
        return True
    return _is_silent_line(lines[0]) or _is_silent_line(lines[-1])


def _split_final(output: str) -> tuple[bool, str]:
    """Detect the [FINAL] marker at the start and strip it from the delivered text."""
    s = (output or "").lstrip()
    if s.upper().startswith(FINAL):
        return True, s[len(FINAL):].lstrip(" :\n")
    return False, output


def _history_block(job: dict) -> str:
    """Previous-run context so a fresh cron agent knows what was already sent."""
    entries = cron_store.run_log(job)
    if not entries:
        return ""
    lines = [
        f"- {e['at']}: отправлено: «{e['text']}»" if e.get("sent")
        else f"- {e['at']}: [SILENT] — ничего не отправлялось"
        for e in entries
    ]
    return (
        "[Предыдущие запуски этого задания (это УЖЕ у пользователя — не повторяй):\n"
        + "\n".join(lines) + "]\n\n"
    )


async def run_job(job: dict) -> None:
    logger.info("cron run: #%s %s", job["id"], job["name"])
    prompt = clock.stamp() + "\n\n" + CRON_HINT + _history_block(job) + job["prompt"]
    try:
        output = await agent.run_cron(prompt, surface=job.get("surface", "telegram"))
    except Exception:
        logger.exception("cron job #%s failed", job["id"])
        output = ""

    final, text = _split_final(output)
    silent = _suppressed(text)

    cron_store.mark_ran(job["id"], text, datetime.now(), sent=not silent)
    if final:
        # Terminal contract: the tracked event is over — no more runs, ever.
        logger.info("cron job #%s reported [FINAL] — removing", job["id"])
        cron_store.delete(job["id"])

    deliver = job.get("deliver", "telegram")
    if text and deliver == "telegram" and not silent:
        header = f"{job['name']}\n\n"
        await notify(header + text)
        # Mirror into the shared session so the interactive agent knows it was sent.
        cron_outbox.record_delivery(job["name"], text)


async def tick() -> None:
    due = cron_store.due()
    for job in due:
        await run_job(job)  # sequential — avoids two agent runs racing on files/db
    await curator.maybe_run()  # idle-triggered skill-library consolidation


async def scheduler_loop() -> None:
    logger.info("Cron scheduler started (tick=%ss)", TICK_SECONDS)
    while True:
        try:
            await tick()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("cron tick error")
        await asyncio.sleep(TICK_SECONDS)
