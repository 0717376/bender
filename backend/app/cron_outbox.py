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


def pending(now: datetime | None = None) -> tuple[str, list[str]]:
    """(блок, ключи) — доставки за последние WINDOW_HOURS. ('', []) — если их нет.

    Блок подклеивается к реплике человека, а не к системному промпту: отправленное
    сообщение — часть беседы, ему место в стенограмме. Тогда оно попадает туда один
    раз и остаётся навсегда, а не пересобирается каждый ход и не исчезает бесследно.

    Ключи возвращаем, чтобы вычеркнуть доставку `drop`, когда ход дошёл до конца:
    сгорела бы она сразу — упавший ход уносил бы её с собой. Заодно чистим протухшее.
    """
    now = now or datetime.now()
    with _lock:
        items = _read()
        fresh = _fresh(items, now)
        if len(fresh) != len(items):
            _write(fresh)
    if not fresh:
        return "", []

    lines = []
    for d in fresh:
        at = datetime.fromisoformat(d["at"]).strftime("%d.%m %H:%M")
        lines.append(f"- {at} «{d.get('name', '')}»\n  отправлено: «{d.get('text', '')}»")
        if d.get("prompt"):
            lines.append(f"  задание: {d['prompt']}")
    block = (
        "[ФОНОВЫЕ ДОСТАВКИ: пока разговора не было, запланированные задания уже отправили "
        "пользователю в Telegram вот это. Он это получил — НЕ дублируй и не обещай прислать "
        "снова. Если его реплика похожа на ответ на одну из доставок (даже без явной ссылки) "
        "— отвечай по ней и по тексту задания, а не достраивай смысл из текущего разговора.\n"
        + "\n".join(lines) + "]"
    )
    return block, [d["at"] for d in fresh]


def drop(keys: list[str]) -> None:
    """Вычеркнуть доставки: они уже в стенограмме хода, второй раз подклеивать незачем."""
    if not keys:
        return
    with _lock:
        _write([d for d in _read() if d.get("at") not in set(keys)])
