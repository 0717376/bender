"""Тренировки в Telegram: утренняя сводка, команда /fit, недельный разбор."""

import asyncio
import os
import sys
import time
from datetime import datetime

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ME = 42
PROGRAM = {"name": "База", "days": [
    {"name": "А", "items": [{"exercise": "Жим лёжа", "sets": 3, "reps_min": 6, "reps_max": 10},
                            {"exercise": "Тяга верхнего блока", "sets": 3, "reps_min": 8, "reps_max": 12}]},
    {"name": "Кардио", "kind": "cardio", "minutes": 30, "note": "спокойный темп"}]}


@pytest.fixture
def store(tmp_path, monkeypatch):
    from app import config, fit_store, pairing

    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(config, "TELEGRAM_BOT_TOKEN", "t0ken")
    monkeypatch.setattr(pairing, "allowed_ids", lambda: {ME})
    fit_store.init()
    return fit_store


@pytest.fixture
def calls(monkeypatch):
    """Перехват Bot API: список (метод, параметры)."""
    from app import telegram

    seen: list[tuple[str, dict]] = []

    async def fake_api(_client, method, **params):
        seen.append((method, params))
        return {"ok": True}

    monkeypatch.setattr(telegram, "tg_api", fake_api)
    return seen


def ring(store, day: str, **over):
    """Две ровные недели и сегодняшняя ночь поверх."""
    base = {"readiness": 82, "hrv": 50, "rhr": 52, "sleep_sec": 26400, "temp_dev": 0.0}
    d = datetime.fromisoformat(day)
    for back in range(1, 15):
        store.oura_put(d.fromordinal(d.toordinal() - back).date().isoformat(), **base)
    store.oura_put(day, **{**base, **over})


def notify(when):
    from app import fit_tg
    return asyncio.run(fit_tg.maybe_notify(when))


def test_brief_with_ring_and_program(store, calls):
    store.set_program(PROGRAM)
    ring(store, "2026-01-05")
    assert notify(datetime(2026, 1, 5, 7)) is False and calls == []
    assert notify(datetime(2026, 1, 5, 8, 30)) is True
    method, params = calls[-1]
    assert (method, params["chat_id"], params["parse_mode"]) == ("sendMessage", ME, "HTML")
    assert params["text"] == (
        "Готовность <b>82</b> · сон 7 ч 20 мин · ВСР 50 · пульс покоя 52\n"
        "Восстановился — занимайся по плану.\n"
        "На очереди: <b>А</b> — жим лёжа, тяга верхнего блока · около 20 мин")
    assert "reply_markup" not in params
    assert notify(datetime(2026, 1, 5, 15)) is False and len(calls) == 1
    assert notify(datetime(2026, 1, 6, 12)) is True


def test_brief_names_the_reason_and_links_the_app(store, calls):
    from app import cron_outbox

    store.set_program(PROGRAM)
    store.set_meta("app_url", "https://fit.example.com")
    ring(store, "2026-01-05", hrv=44, rhr=56, readiness=71)
    assert notify(datetime(2026, 1, 5, 9)) is True
    text = calls[-1][1]["text"]
    assert "сегодня полегче" in text
    assert "Причина: вариабельность пульса ниже обычного, пульс покоя выше обычного." in text
    assert calls[-1][1]["reply_markup"]["inline_keyboard"][0][0]["url"] == "https://fit.example.com"
    # В памяти агента — тот же текст без разметки.
    assert "Готовность 71" in cron_outbox.pending()[0] and "<b>" not in cron_outbox.pending()[0]


def test_brief_waits_for_the_ring_until_noon(store, calls):
    store.set_program(PROGRAM)
    store.set_meta("oura_token", {"access": "a", "refresh": "r", "expires": int(time.time()) + 999})
    assert notify(datetime(2026, 1, 5, 9)) is False and calls == []
    # Ночь приехала в десять — сводка уходит сразу, а не ждёт завтра.
    ring(store, "2026-01-05")
    assert notify(datetime(2026, 1, 5, 10)) is True and "Готовность" in calls[-1][1]["text"]
    # Назавтра кольцо молчит до полудня — шлём без него.
    assert notify(datetime(2026, 1, 6, 11)) is False
    assert notify(datetime(2026, 1, 6, 12)) is True
    assert calls[-1][1]["text"].startswith("На очереди: <b>А</b>")


def test_brief_keeps_quiet_when_there_is_nothing(store, calls):
    assert notify(datetime(2026, 1, 5, 9)) is False and calls == []
    store.set_program(PROGRAM)
    store.save_settings({"notify": False})
    assert notify(datetime(2026, 1, 6, 9)) is False and calls == []


def test_brief_after_a_morning_workout(store, calls):
    from app import fit_tg

    store.set_program(PROGRAM)
    t = int(datetime(2026, 1, 5, 9).timestamp() * 1000)
    store.log_session({"kind": "strength", "program_day": "А",
                       "sets": [{"exercise": "Жим лёжа", "weight": 80, "reps": 8}]}, t=t)
    assert fit_tg.brief(t) == "На очереди (сегодня уже занимался): <b>Кардио</b> — спокойный темп · около 30 мин"
    s = store.start_session(t=t)
    assert "Тренировка идёт" in fit_tg.brief(t)
    store.delete_session(s["id"])


def test_fit_command(store, calls):
    from app import telegram

    def fast(text, user=ME):
        return asyncio.run(telegram.tg_fast(None, {"message": {"text": text, "from": {"id": user}, "chat": {"id": user}}}))

    assert fast("/fit") and "Пока пусто" in calls[-1][1]["text"]
    store.set_program(PROGRAM)
    assert fast("/fit@bender_bot") and calls[-1][1]["text"].startswith("На очереди: <b>А</b>")
    assert not fast("/fit", user=666) and not fast("как дела")
    assert {"command": "fit", "description": "Готовность и тренировка на очереди"} in telegram.BOT_COMMANDS


def test_weekly_review_once_on_sunday_evening(store, monkeypatch):
    from app import agent, cron_outbox, fit_tg, telegram

    prompts, sent = [], []

    async def fake_run(prompt, surface="telegram"):
        prompts.append(prompt)
        return "Три тренировки, жим вырос."

    async def fake_notify(text):
        sent.append(text)

    monkeypatch.setattr(agent, "run_cron", fake_run)
    monkeypatch.setattr(telegram, "notify", fake_notify)
    review = lambda *a: asyncio.run(fit_tg.maybe_review(datetime(2026, 1, *a)))  # noqa: E731

    store.set_program(PROGRAM)
    assert review(10, 20) is False                    # суббота
    assert review(11, 18) is False                    # воскресенье, но рано
    assert review(11, 19) is True
    assert sent == ["Неделя тренировок\n\nТри тренировки, жим вырос."]
    assert "mcp__fit__progress" in prompts[0] and "[Сейчас" in prompts[0]
    assert "жим вырос" in cron_outbox.pending()[0]
    assert review(11, 21) is False and len(prompts) == 1
    assert review(18, 19) is True


def test_weekly_review_can_stay_silent(store, monkeypatch):
    from app import agent, fit_tg, telegram

    asked, sent = [], []

    async def fake_run(prompt, surface="telegram"):
        asked.append(1)
        return "[SILENT]"

    async def fake_notify(text):
        sent.append(text)

    monkeypatch.setattr(agent, "run_cron", fake_run)
    monkeypatch.setattr(telegram, "notify", fake_notify)
    sunday = datetime(2026, 1, 11, 19)
    # Ни программы, ни тренировок — модель не зовём вовсе.
    assert asyncio.run(fit_tg.maybe_review(sunday)) is False and asked == []
    store.set_program(PROGRAM)
    store.set_meta("reviewed", None)
    assert asyncio.run(fit_tg.maybe_review(sunday)) is False and asked == [1] and sent == []
    store.save_settings({"weekly": False})
    assert asyncio.run(fit_tg.maybe_review(datetime(2026, 1, 18, 19))) is False and asked == [1]


def test_app_url_is_remembered(store, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app import config, fit_api

    monkeypatch.setattr(config, "WIKI_PASSWORD", "пароль")
    monkeypatch.setattr(config, "AUTH_TOKEN", "tok3n")
    app = FastAPI()
    app.include_router(fit_api.router)
    c = TestClient(app, headers={"Authorization": "Bearer tok3n"})
    c.get("/fit/overview", headers={"host": "fit.example.com"})
    assert store.meta("app_url") == "https://fit.example.com"
    c.get("/fit/overview", headers={"host": "192.168.1.93:8877"})
    assert store.meta("app_url") == "http://192.168.1.93:8877"
