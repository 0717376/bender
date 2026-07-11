"""Outbox of background (cron) deliveries, to keep the shared chat session aware.

Scheduled jobs run in an ISOLATED agent session and deliver straight to Telegram,
so the main shared session never sees that a message went out. Without this, the
interactive agent keeps promising "I'll send it at 08:33" even after it already
fired. We mirror Hermes' delivery-mirroring: record each delivered message here,
then inject the pending ones as context on the next interactive turn (and clear).
"""

import json
import os
import threading
from datetime import datetime

from . import config

_lock = threading.Lock()
_MAX = 20  # cap stored deliveries so a quiet stretch can't bloat the file


def _path() -> str:
    return os.path.join(config.DATA_DIR, "cron_outbox.json")


def _read() -> list[dict]:
    try:
        with open(_path(), encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def _write(items: list[dict]) -> None:
    os.makedirs(config.DATA_DIR, exist_ok=True)
    with open(_path(), "w", encoding="utf-8") as f:
        json.dump(items[-_MAX:], f, ensure_ascii=False)


def record_delivery(name: str, text: str, when: datetime | None = None) -> None:
    """Append a delivered cron message. Called after a successful Telegram send."""
    when = when or datetime.now()
    with _lock:
        items = _read()
        items.append({
            "at": when.strftime("%H:%M"),
            "name": name,
            "text": (text or "").strip()[:400],
        })
        _write(items)


def drain_as_prompt() -> str:
    """Return a context block for pending deliveries and clear them. '' if none.

    Called at the start of an interactive turn so the agent learns what was
    already delivered in the background since its last reply.
    """
    with _lock:
        items = _read()
        if not items:
            return ""
        _write([])  # consumed — inject exactly once

    lines = [f"- {d['at']} «{d['name']}»: {d['text']}" for d in items]
    return (
        "[ФОНОВЫЕ ДОСТАВКИ: эти запланированные сообщения УЖЕ отправлены пользователю в "
        "Telegram с момента твоего прошлого ответа. Они доставлены — НЕ обещай прислать их "
        "снова и не дублируй их содержимое. Если пользователь благодарит или реагирует — "
        "отвечай с учётом того, что он их уже получил.\n" + "\n".join(lines) + "]"
    )
