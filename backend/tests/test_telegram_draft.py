"""Живой черновик в Telegram: он не исчезает сам и должен гаснуть после ответа."""

import asyncio
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture
def calls(monkeypatch):
    """Перехват вызовов Bot API: (метод, текст)."""
    from app import telegram

    seen: list[tuple[str, str]] = []

    async def fake_api(_client, method, **params):
        seen.append((method, params.get("text", "")))
        return {"ok": True}

    monkeypatch.setattr(telegram, "tg_api", fake_api)
    return seen


def draft():
    from app import telegram

    return telegram.Draft(None, 42)


def test_cleared_after_reply(calls):
    """Иначе преамбула «сейчас посмотрю» остаётся висеть в чате рядом с ответом."""
    d = draft()
    asyncio.run(d.update("Сейчас посмотрю"))
    asyncio.run(d.clear())

    assert calls == [("sendMessageDraft", "Сейчас посмотрю"), ("sendMessageDraft", "")]


def test_nothing_shown_nothing_to_clear(calls):
    asyncio.run(draft().clear())
    assert calls == []


def test_throttled_update_still_gets_cleared(calls):
    """Троттлинг глотает последнее обновление — черновик застывает на преамбуле."""
    d = draft()
    asyncio.run(d.update("Сейчас посмотрю"))
    asyncio.run(d.update("Сейчас посмотрю статью и отвечу"))  # не пройдёт по времени
    asyncio.run(d.clear())

    assert [text for _, text in calls] == ["Сейчас посмотрю", ""]


def test_long_answer_stops_updating_but_clears(calls):
    from app import telegram

    d = draft()
    asyncio.run(d.update("x" * (telegram.DRAFT_CAP + 10)))
    d.at = 0.0  # троттлинг тут ни при чём — дальше молчит именно из-за размера
    asyncio.run(d.update("x" * (telegram.DRAFT_CAP + 20)))
    asyncio.run(d.clear())

    assert len(calls) == 2
    assert len(calls[0][1]) == telegram.DRAFT_CAP
    assert calls[1][1] == ""


def test_gives_up_when_method_unavailable(monkeypatch):
    """Старый Bot API без sendMessageDraft: живём с одним «печатает…»."""
    from app import telegram

    seen: list[str] = []

    async def fake_api(_client, method, **params):
        seen.append(method)
        return {"ok": False, "description": "Method not found"}

    monkeypatch.setattr(telegram, "tg_api", fake_api)
    d = telegram.Draft(None, 42)
    asyncio.run(d.update("раз"))
    d.at = 0.0
    asyncio.run(d.update("два"))
    asyncio.run(d.clear())

    assert seen == ["sendMessageDraft"]
