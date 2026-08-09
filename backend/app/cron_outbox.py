"""Окно фоновых (крон) доставок — чтобы общий разговор знал, что уже ушло человеку.

Запланированные задания крутятся в ИЗОЛИРОВАННОЙ сессии и пишут прямо в Telegram,
так что общая сессия про отправку не знает вовсе. Без этого агент обещает «пришлю
в 08:33» уже после того, как прислал, а на ответ человека («давай попробуем»)
отвечает мимо: он не видит, на что тот отвечает.

Доставки держим окном в WINDOW_HOURS, а не «отдать первому ходу и стереть». Между
отправкой и ответом проходят часы и несколько чужих ходов — например, вопросы из
читалки, — и одноразовая выдача достаётся не тому разговору, а к нужному приходит
пустой. Заодно отдаём и промпт задания: в нём написано, что делать с ответом
(«ответит баллом — оформить запись в вики»), а по одному отправленному тексту это
не восстановить.
"""

import json
import os
import threading
from datetime import datetime, timedelta

from . import config

_lock = threading.Lock()
_MAX = 20          # cap stored deliveries so a quiet stretch can't bloat the file
WINDOW_HOURS = 12  # дольше человек на сообщение уже не отвечает — а контекст не бесплатный


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


def _fresh(items: list[dict], now: datetime) -> list[dict]:
    """Доставки внутри окна. Запись без разбираемого времени — из старого формата
    («20:00» без даты), её возраст неизвестен: считаем протухшей."""
    edge = now - timedelta(hours=WINDOW_HOURS)
    out = []
    for it in items:
        try:
            if datetime.fromisoformat(it.get("at", "")) >= edge:
                out.append(it)
        except (TypeError, ValueError):
            continue
    return out


def record_delivery(name: str, text: str, prompt: str = "", when: datetime | None = None) -> None:
    """Append a delivered cron message. Called after a successful Telegram send."""
    when = when or datetime.now()
    with _lock:
        items = _read()
        items.append({
            "at": when.isoformat(timespec="seconds"),
            "name": name,
            "text": (text or "").strip()[:400],
            "prompt": (prompt or "").strip()[:400],
        })
        _write(items)


def pending_block(now: datetime | None = None) -> str:
    """Контекстный блок доставок за последние WINDOW_HOURS. '' — если их нет.

    Зовётся в начале каждого интерактивного хода. Ничего не «выпивает»: блок живёт,
    пока живёт окно, — иначе он достаётся первому подвернувшемуся разговору. Заодно
    подчищает протухшее, чтобы файл не рос.
    """
    now = now or datetime.now()
    with _lock:
        items = _read()
        fresh = _fresh(items, now)
        if len(fresh) != len(items):
            _write(fresh)
        if not fresh:
            return ""

    lines = []
    for d in fresh:
        at = datetime.fromisoformat(d["at"]).strftime("%d.%m %H:%M")
        lines.append(f"- {at} «{d.get('name', '')}»\n  отправлено: «{d.get('text', '')}»")
        if d.get("prompt"):
            lines.append(f"  задание: {d['prompt']}")
    return (
        "[ФОНОВЫЕ ДОСТАВКИ: эти запланированные сообщения УЖЕ отправлены пользователю в "
        "Telegram с момента твоего прошлого ответа. Они доставлены — НЕ обещай прислать их "
        "снова и не дублируй их содержимое. Если его реплика похожа на ответ на одно из них "
        "(даже без явной ссылки) — отвечай по нему и по тексту задания, а не достраивай "
        "смысл из текущего разговора.\n" + "\n".join(lines) + "]"
    )
