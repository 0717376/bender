"""Curator: idle-triggered background consolidation of the procedural skill library.

Idle-triggered: when the system has been idle for >= CURATOR_MIN_IDLE_HOURS and the
last curator run was > CURATOR_INTERVAL_HOURS ago, a forked agent reviews the learned
skills + memory and consolidates them (merge near-duplicates, sharpen descriptions,
drop redundancy). A snapshot is taken first so the pass is fully reversible.
"""

import json
import logging
import os
from datetime import datetime, timedelta

from . import agent, config, skill_store
from .telegram import notify

logger = logging.getLogger("wiki.curator")

_last_activity = datetime.now()


def mark_activity() -> None:
    """Called on every user message so the curator only fires during quiet periods."""
    global _last_activity
    _last_activity = datetime.now()


def _state_path() -> str:
    return os.path.join(config.DATA_DIR, "curator_state.json")


def _load_state() -> dict:
    try:
        with open(_state_path()) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"last_run": None, "run_count": 0}


def _save_state(state: dict) -> None:
    os.makedirs(config.DATA_DIR, exist_ok=True)
    with open(_state_path(), "w") as f:
        json.dump(state, f)


def should_run(now: datetime | None = None) -> bool:
    if not config.CURATOR_ENABLED:
        return False
    now = now or datetime.now()
    if (now - _last_activity) < timedelta(hours=config.CURATOR_MIN_IDLE_HOURS):
        return False
    if len(skill_store.list_skills()) < 2:
        return False  # nothing to consolidate yet
    last = _load_state().get("last_run")
    if last:
        try:
            if (now - datetime.fromisoformat(last)) < timedelta(hours=config.CURATOR_INTERVAL_HOURS):
                return False
        except ValueError:
            pass
    return True


CURATOR_PROMPT = (
    "Ты — Куратор библиотеки навыков ассистента (процедурная память; это нативные Skill'ы). "
    "Цель — НЕ копить узкие навыки, а держать чистую библиотеку инструкций уровня класса задач.\n\n"
    "Сделай ревизию через инструменты mcp__skills__*:\n"
    "1. Посмотри список (list) и прочитай (read) навыки.\n"
    "2. Найди близкие/дублирующие навыки с общей темой — объедини: запиши один широкий через "
    "save (тем же или новым именем), лишние удали через remove. Не теряй полезные детали — "
    "переноси их в общий навык.\n"
    "3. Сделай описания (description) точными: 'когда применять'. Убери устаревшее.\n"
    "4. Имена (name) — латиницей в kebab-case. Ничего не выдумывай и не удаляй то, что несёт "
    "уникальную ценность.\n\n"
    "В конце верни КОРОТКУЮ сводку: что объединил/удалил/уточнил (3-6 пунктов)."
)


async def run_curator(manual: bool = False) -> str:
    snap = skill_store.snapshot(reason="manual" if manual else "curator")
    logger.info("Curator run (snapshot=%s)", os.path.basename(snap))
    summary = await agent.run_cron(CURATOR_PROMPT, surface="curator")
    state = _load_state()
    state["last_run"] = datetime.now().isoformat(timespec="seconds")
    state["run_count"] = state.get("run_count", 0) + 1
    state["last_summary"] = summary[:2000]
    _save_state(state)

    if summary and config.CURATOR_DELIVER == "telegram":
        await notify("Куратор навыков пересобрал библиотеку:\n\n" + summary)
    return summary


async def maybe_run() -> None:
    if should_run():
        try:
            await run_curator()
        except Exception:
            logger.exception("curator run failed")
