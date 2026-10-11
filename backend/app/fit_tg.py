"""Тренировки в Telegram: утренняя сводка, недельный разбор и команда /fit.

Сводка — без модели: готовность, сон и день программы — это три числа и строка, они уже
посчитаны. Ждёт она не часа, а кольца: Oura отдаёт ночь только после того, как человек
открыл её приложение, и сводка без ночи была бы половиной сводки.

Недельный разбор — один ход агента в воскресенье вечером: тут нужен вывод, а не числа.
"""

import html
import logging
from datetime import datetime, timedelta

import httpx

from . import config, cron_outbox, pairing
from . import fit_store as store

logger = logging.getLogger("fit.tg")

# Если кольцо так и не отчиталось — после этого часа шлём сводку без него.
GIVE_UP_HOUR = 12
REVIEW_WEEKDAY, REVIEW_HOUR = 6, 19      # воскресенье, вечер

ADVICE = {
    "go": "Восстановился — занимайся по плану.",
    "easy": "Восстановление так себе — сегодня полегче: на подход меньше и без прибавки веса.",
    "rest": "Организм просит отдыха — лучше перенести тренировку или прогуляться.",
}
SIGNALS = {"hrv": "вариабельность пульса ниже обычного", "rhr": "пульс покоя выше обычного",
           "sleep": "мало сна", "temp": "температура выше обычной", "readiness": "низкая готовность"}
KINDS = {"strength": "силовая", "cardio": "кардио", "swim": "бассейн", "other": "тренировка"}

REVIEW_PROMPT = (
    "Воскресенье, пора подвести итог недели тренировок. Используй навык `fit`: посмотри "
    "{today}, {progress} (недели и два-три главных упражнения), {history} за 14 дней и "
    "{recovery}. Напиши короткий разбор для Telegram, пять-восемь строк: сколько было "
    "тренировок и минут, что выросло, что стоит, как восстановление. Если по данным нужна "
    "одна правка программы — предложи её одной фразой и спроси согласия; саму программу не "
    "меняй. Если всё идёт хорошо — так и скажи, ничего не предлагая. Без приветствий, без "
    "похвалы за объём, без эмодзи. Если за неделю не было ни одной тренировки и программы "
    "нет — ответь одним словом [SILENT]."
)


def _hours(sec: int) -> str:
    m = round(sec / 60)
    return f"{m // 60} ч {m % 60:02d} мин"


def _minutes(plan: dict) -> int:
    """Сколько займёт день программы: подходы с отдыхом и полминуты на сам подход."""
    if plan["minutes"]:
        return plan["minutes"]
    return round(sum(i["sets"] * (i["rest"] + 40) + 60 for i in plan["items"]) / 60 / 5) * 5


def brief(t: int | None = None) -> str:
    """Сводка на сейчас в разметке HTML; пустая строка — сказать нечего."""
    o = store.overview(t)
    rec, lines = o["recovery"], []
    if rec["level"]:
        d = rec["data"]
        bits = [f"Готовность <b>{d['readiness']}</b>" if d["readiness"] is not None else "",
                f"сон {_hours(d['sleep_sec'])}" if d["sleep_sec"] else "",
                f"ВСР {round(d['hrv'])}" if d["hrv"] else "",
                f"пульс покоя {round(d['rhr'])}" if d["rhr"] else ""]
        lines.append(" · ".join(b for b in bits if b))
        why = [SIGNALS[s["key"]] for s in rec["signals"] if s["state"] != "ok"]
        lines.append(ADVICE[rec["level"]] + (f" Причина: {', '.join(why)}." if why and rec["level"] != "go" else ""))
    if o["active"]:
        lines.append("Тренировка идёт — не забудь завершить её в приложении.")
    elif o["next"]:
        p = o["next"]
        names = ", ".join(html.escape(i["name"].lower()) for i in p["items"][:5])
        tail = names or html.escape(p["note"]) or KINDS[p["kind"]]
        done = " (сегодня уже занимался)" if o["today"] else ""
        lines.append(f"На очереди{done}: <b>{html.escape(p['name'])}</b> — {tail} · около {_minutes(p)} мин")
    elif not rec["level"]:
        return ""
    else:
        lines.append("Программы пока нет — напиши «составь программу», соберём.")
    return "\n".join(lines)


def _markup() -> dict | None:
    url = store.meta("app_url")
    return {"inline_keyboard": [[{"text": "Открыть тренировки", "url": url}]]} if url else None


async def _api(client, method: str, **params) -> dict:
    from . import telegram
    return await telegram.tg_api(client, method, **params)


async def _send(client, chat_id: int, text: str) -> None:
    params = {"chat_id": chat_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}
    markup = _markup()
    if markup:
        params["reply_markup"] = markup
    await _api(client, "sendMessage", **params)


async def start(client, chat_id: int) -> None:
    """Команда /fit: та же сводка по просьбе."""
    await _send(client, chat_id, brief() or "Пока пусто: нет ни программы, ни данных кольца. "
                                           "Напиши «составь программу» — начнём с неё.")


async def maybe_notify(when: datetime | None = None) -> bool:
    """Раз в день, не раньше настроенного часа: готовность и что на очереди. Если кольцо
    подключено, ждём от него сегодняшнюю ночь — но не дольше полудня."""
    when = when or datetime.now()
    s = store.settings()
    t = int(when.timestamp() * 1000)
    day = store.today(t).isoformat()
    if not s["notify"] or when.hour < s["notify_hour"] or store.meta("notified") == day:
        return False
    targets = pairing.allowed_ids()
    if not config.TELEGRAM_BOT_TOKEN or not targets:
        return False
    waiting = store.meta("oura_token") and not store.recovery(t)["level"]
    if waiting and when.hour < GIVE_UP_HOUR:
        return False
    store.set_meta("notified", day)
    text = brief(t)
    # Без кольца и без программы каждое утро писать «на очереди ничего» незачем.
    if not text or (not store.program() and not store.recovery(t)["level"]):
        return False
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
        for chat_id in targets:
            await _send(client, chat_id, text)
    # Агент должен знать, что это уже ушло: человек может ответить на сводку текстом.
    cron_outbox.record_delivery("Тренировки", html.unescape(text.replace("<b>", "").replace("</b>", "")))
    return True


async def maybe_review(when: datetime | None = None) -> bool:
    """Раз в неделю, в воскресенье вечером: разбор недели одним ходом агента."""
    when = when or datetime.now()
    week = (when.date() - timedelta(days=when.weekday())).isoformat()
    if (when.weekday() != REVIEW_WEEKDAY or when.hour < REVIEW_HOUR
            or not store.settings()["weekly"] or store.meta("reviewed") == week):
        return False
    if not config.TELEGRAM_BOT_TOKEN or not pairing.allowed_ids():
        return False
    store.set_meta("reviewed", week)
    t = int(when.timestamp() * 1000)
    # Пустая неделя без программы — модель звать незачем: сказать ей нечего.
    if not store.program() and not store.week(t)["sessions"]:
        return False
    from . import agent, clock, telegram

    names = {k: config.tool_name("fit", k) for k in ("today", "progress", "history", "recovery")}
    try:
        text = (await agent.run_cron(clock.stamp() + "\n\n" + REVIEW_PROMPT.format(**names))).strip()
    except Exception:
        logger.exception("fit: недельный разбор не удался")
        return False
    if not text or "[SILENT]" in text:
        return False
    await telegram.notify("Неделя тренировок\n\n" + text)
    cron_outbox.record_delivery("Неделя тренировок", text, "недельный разбор тренировок")
    return True
