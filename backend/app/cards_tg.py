"""Повторение карточек прямо в Telegram: одно сообщение и кнопки под ним.

Модели в этой цепочке нет: вопрос, ответ и оценка — обычные запросы к хранилищу, поэтому
кнопка отвечает сразу и не ждёт, пока агент закончит свой ход. Сообщение одно — оно
правится на месте: вопрос → ответ с четырьмя оценками → следующий вопрос → итог.

Состояния между нажатиями не храним: всё нужное лежит в самой кнопке (callback_data).
Перезапуск сервера посреди сессии ничего не ломает.

  cd:go                       начать или продолжить
  cd:s:<карточка>:<reps>      показать ответ
  cd:r:<карточка>:<reps>:<оценка>:<когда показали, сек>
"""

import html
import logging
import re
import time
from datetime import datetime

import httpx

from . import cards_store as store
from . import config, cron_outbox, pairing

logger = logging.getLogger(__name__)

PREFIX = "cd:"
RATINGS = ((1, "Снова"), (2, "Трудно"), (3, "Хорошо"), (4, "Легко"))
# Задумался, отошёл, вернулся через час — это не час раздумий над карточкой.
MAX_ANSWER_MS = 60_000


def _plural(n: int, one: str, few: str, many: str) -> str:
    a, b = abs(n) % 100, abs(n) % 10
    if 10 < a < 20:
        return many
    return one if b == 1 else few if 2 <= b <= 4 else many


def cards_word(n: int) -> str:
    return f"{n} {_plural(n, 'карточка', 'карточки', 'карточек')}"


def interval(secs: float) -> str:
    """Через сколько карточка вернётся — подпись на кнопке оценки."""
    m, h, d = secs / 60, secs / 3600, secs / 86400
    if secs < 60:
        return "<1 мин"
    if m < 60:
        return f"{round(m)} мин"
    if h < 24:
        return f"{round(h)} ч"
    if d < 30:
        return f"{round(d)} д"
    if d < 365:
        return f"{round(d / 30.4, 1):g} мес".replace(".", ",")
    return f"{round(d / 365, 1):g} г".replace(".", ",")


def to_html(text: str) -> str:
    """Лёгкая разметка лиц карточки (**жирный**, строка в _курсиве_) → HTML Telegram."""
    out = html.escape(text or "", quote=False)
    out = re.sub(r"\*\*([^*\n]+)\*\*", r"<b>\1</b>", out)
    return re.sub(r"(?m)^_(.+)_$", r"<i>\1</i>", out)


def _head(card: dict, counts: dict) -> str:
    return f"<i>{html.escape(card['deck'])} · осталось {counts['total']}</i>"


def question(card: dict, counts: dict) -> tuple[str, dict]:
    text = f"{_head(card, counts)}\n\n{to_html(card['front'])}"
    data = f"{PREFIX}s:{card['id']}:{card['reps']}"
    return text, {"inline_keyboard": [[{"text": "Показать ответ", "callback_data": data}]]}


def answer(card: dict, counts: dict, shown: int) -> tuple[str, dict]:
    text = f"{_head(card, counts)}\n\n{to_html(card['front'])}\n\n———\n\n{to_html(card['back'])}"
    btn = [{"text": f"{name} · {interval(card['intervals'][r])}",
            "callback_data": f"{PREFIX}r:{card['id']}:{card['reps']}:{r}:{shown}"} for r, name in RATINGS]
    return text, {"inline_keyboard": [btn[:2], btn[2:]]}


def done(t: int | None = None) -> tuple[str, dict | None]:
    """Показывать нечего: либо всё повторено, либо доучиваемые ещё не подошли."""
    t = t or store.now()
    today = store.overview(t)["today"]
    tally = f"\n\nСегодня: {cards_word(today['n'])}." if today["n"] else ""
    wait = store.waiting(None, t)
    if wait:
        text = f"<b>Почти всё.</b> Доучиваемые карточки вернутся через {interval((wait - t) / 1000)}.{tally}"
        return text, {"inline_keyboard": [[{"text": "Продолжить", "callback_data": PREFIX + "go"}]]}
    return f"<b>На сегодня всё повторено.</b>{tally}", None


def screen(t: int | None = None) -> tuple[str, dict | None]:
    """Что показать сейчас: следующий вопрос или итог."""
    t = t or store.now()
    card = store.next_card(None, t)
    return question(card, store.counts(None, t)) if card else done(t)


async def _api(client, method: str, **params) -> dict:
    from . import telegram
    return await telegram.tg_api(client, method, **params)


async def _show(client, chat_id: int, message_id: int | None, text: str, markup: dict | None) -> None:
    params = {"chat_id": chat_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True,
              # Пустая клавиатура, а не её отсутствие: иначе под итогом остались бы старые кнопки.
              "reply_markup": markup or {"inline_keyboard": []}}
    if message_id:
        await _api(client, "editMessageText", message_id=message_id, **params)
    else:
        await _api(client, "sendMessage", **params)


async def start(client, chat_id: int) -> None:
    """Команда /review: новое сообщение с первой карточкой."""
    await _show(client, chat_id, None, *screen())


async def on_callback(client, cq: dict) -> None:
    """Нажатие кнопки под карточкой."""
    msg = cq.get("message") or {}
    chat_id, message_id = (msg.get("chat") or {}).get("id"), msg.get("message_id")
    # Сразу снять «часики» с кнопки — до любой работы.
    await _api(client, "answerCallbackQuery", callback_query_id=cq.get("id"))
    if not chat_id or not message_id:
        return
    parts = (cq.get("data") or "")[len(PREFIX):].split(":")
    t = store.now()
    try:
        if parts[0] == "s":
            card = store.card(int(parts[1]), t)
            # reps изменился — карточку уже оценили в другом месте, кнопка устарела.
            if card and not card["suspended"] and card["reps"] == int(parts[2]):
                return await _show(client, chat_id, message_id, *answer(card, store.counts(None, t), t // 1000))
        elif parts[0] == "r":
            card = store.card(int(parts[1]), t)
            if card and not card["suspended"] and card["reps"] == int(parts[2]):
                spent = max(0, min(MAX_ANSWER_MS, t - int(parts[4]) * 1000))
                store.answer(card["id"], int(parts[3]), spent, src="tg", t=t)
    except (IndexError, ValueError):
        logger.warning("cards: непонятная кнопка %r", cq.get("data"))
    await _show(client, chat_id, message_id, *screen())


async def maybe_notify(when: datetime | None = None) -> bool:
    """Раз в день, в настроенный час: сколько карточек ждёт и кнопка «Начать».

    Не задание cron: там каждый запуск — ход модели, а здесь нужно одно число. Решение
    принимается один раз за день: нечего повторять — значит, сегодня молчим, и слово,
    добавленное после обеда, напоминания не вызовет."""
    when = when or datetime.now()
    s = store.settings()
    day = when.date().isoformat()
    if not s["notify"] or when.hour < s["notify_hour"] or store.meta("notified") == day:
        return False
    targets = pairing.allowed_ids()
    if not config.TELEGRAM_BOT_TOKEN or not targets:
        return False
    store.set_meta("notified", day)
    c = store.counts()
    if not c["total"]:
        return False
    bits = [f"{c['review']} {_plural(c['review'], 'повтор', 'повтора', 'повторов')}" if c["review"] else "",
            f"{c['learning']} {_plural(c['learning'], 'доучивается', 'доучиваются', 'доучиваются')}" if c["learning"] else "",
            f"{c['new']} {_plural(c['new'], 'новая', 'новые', 'новых')}" if c["new"] else ""]
    plain = f"К повторению сегодня {cards_word(c['total'])}: " + ", ".join(b for b in bits if b) + "."
    markup = {"inline_keyboard": [[{"text": "Начать", "callback_data": PREFIX + "go"}]]}
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
        for chat_id in targets:
            await _api(client, "sendMessage", chat_id=chat_id, text=plain, reply_markup=markup)
    # Агент должен знать, что это уже ушло: человек может ответить на напоминание текстом.
    cron_outbox.record_delivery("Карточки", plain)
    return True
