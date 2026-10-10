"""Карточки в Telegram: круг повторения кнопками и напоминание раз в день."""

import asyncio
import os
import sys
from datetime import datetime

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ME = 42


@pytest.fixture
def store(tmp_path, monkeypatch):
    from app import cards_store, config, pairing

    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(config, "TELEGRAM_BOT_TOKEN", "t0ken")
    monkeypatch.setattr(pairing, "allowed_ids", lambda: {ME})
    cards_store.init()
    return cards_store


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


def buttons(params: dict) -> list[dict]:
    return [b for row in params["reply_markup"]["inline_keyboard"] for b in row]


def press(data: str, user: int = ME, message_id: int = 7) -> dict:
    return {"callback_query": {"id": "q", "from": {"id": user}, "data": data,
                               "message": {"message_id": message_id, "chat": {"id": ME}}}}


def fast(update: dict) -> bool:
    from app import telegram
    return asyncio.run(telegram.tg_fast(None, update))


def test_review_round_in_one_message(store, calls):
    store.create_note("basic", {"front": "2 + 2", "back": "4"})
    store.create_note("basic", {"front": "Столица Франции", "back": "Париж"})

    assert fast({"message": {"text": "/review", "from": {"id": ME}, "chat": {"id": ME}}})
    method, shown = calls[-1]
    assert method == "sendMessage" and "2 + 2" in shown["text"] and "осталось 2" in shown["text"]
    (show,) = buttons(shown)

    assert fast(press(show["callback_data"]))
    method, opened = calls[-1]
    assert method == "editMessageText" and opened["message_id"] == 7
    assert "2 + 2" in opened["text"] and "4" in opened["text"]
    rates = buttons(opened)
    assert [b["text"].split(" · ")[0] for b in rates] == ["Снова", "Трудно", "Хорошо", "Легко"]
    assert calls[-2][0] == "answerCallbackQuery"     # «часики» сняты до правки сообщения

    assert fast(press(rates[2]["callback_data"]))
    method, nxt = calls[-1]
    assert method == "editMessageText" and "Столица Франции" in nxt["text"]
    log = store._q("SELECT rating, src FROM revlog")
    assert [(r["rating"], r["src"]) for r in log] == [(3, "tg")]


def test_stale_button_does_not_answer_twice(store, calls):
    """Двойное нажатие или старое сообщение: карточку уже оценили — второй раз не считаем."""
    store.create_note("basic", {"front": "a", "back": "b"})
    card = store.next_card()
    data = f"cd:r:{card['id']}:{card['reps']}:3:{store.now() // 1000}"
    fast(press(data))
    fast(press(data))
    assert len(store._q("SELECT 1 FROM revlog")) == 1
    assert calls[-1][0] == "editMessageText"


def test_done_clears_buttons(store, calls):
    fast(press("cd:go"))
    method, params = calls[-1]
    assert method == "editMessageText" and "всё повторено" in params["text"]
    assert params["reply_markup"] == {"inline_keyboard": []}


def test_strangers_and_other_updates(store, calls):
    assert fast(press("cd:go", user=666))                 # чужой: кнопка гаснет, и всё
    assert [m for m, _ in calls] == ["answerCallbackQuery"]
    assert not fast({"message": {"text": "привет", "from": {"id": ME}, "chat": {"id": ME}}})
    assert not fast({"message": {"text": "/review", "from": {"id": 666}, "chat": {"id": 666}}})
    assert not fast(press("другое:1"))


def test_markup_survives_html(store):
    from app import cards_tg

    note = store.create_note("word", {"word": "a<b", "meaning": "x & y", "example": "Say a<b now."})
    card = store.card(store.note_cards(note["id"])[0]["id"])
    text, _ = cards_tg.question(card, store.counts())
    assert "<b>a&lt;b</b>" in text and "<i>Say a&lt;b now.</i>" in text
    assert cards_tg.interval(600) == "10 мин" and cards_tg.interval(75 * 86400) == "2,5 мес"


def test_notify_once_a_day(store, calls):
    from app import cards_tg, cron_outbox

    store.create_note("basic", {"front": "a", "back": "b"})
    early, morning, later = (datetime(2026, 1, 5, h) for h in (8, 9, 15))
    assert asyncio.run(cards_tg.maybe_notify(early)) is False and calls == []

    assert asyncio.run(cards_tg.maybe_notify(morning)) is True
    method, params = calls[-1]
    assert method == "sendMessage" and params["chat_id"] == ME
    assert params["text"] == "К повторению сегодня 1 карточка: 1 новая."
    assert buttons(params)[0]["callback_data"] == "cd:go"
    assert "К повторению" in cron_outbox.pending()[0]

    assert asyncio.run(cards_tg.maybe_notify(later)) is False and len(calls) == 1
    assert asyncio.run(cards_tg.maybe_notify(datetime(2026, 1, 6, 9))) is True


def test_notify_respects_settings_and_empty_queue(store, calls):
    from app import cards_tg

    assert asyncio.run(cards_tg.maybe_notify(datetime(2026, 1, 5, 10))) is False   # повторять нечего
    store.create_note("basic", {"front": "a", "back": "b"})
    # Решение на сегодня принято: карточка, добавленная позже, напоминания не вызовет.
    assert asyncio.run(cards_tg.maybe_notify(datetime(2026, 1, 5, 12))) is False
    store.save_settings({"notify": False})
    assert asyncio.run(cards_tg.maybe_notify(datetime(2026, 1, 6, 10))) is False
    assert calls == []
