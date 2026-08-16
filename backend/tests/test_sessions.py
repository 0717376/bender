"""Нити разговора: общая (телеграм/вики/задачи) и своя на каждую книгу.

До разделения всё лежало в одной сессии, и вопросы из читалки — их много и они
объёмные — выдавливали общий разговор: ответ из телеграма приходил в контекст,
забитый чужой книгой.
"""

import asyncio
import json
import os
import sys
from datetime import datetime, timedelta

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture
def sessions(tmp_path, monkeypatch):
    from app import agent, config

    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(config, "SESSION_FILE", str(tmp_path / "session.json"))
    return agent


# ── Ключ нити ──

def test_книга_ведёт_свою_нить(sessions):
    assert sessions.thread_key("books", "aposd") == "books:aposd"


def test_разные_книги_разные_нити(sessions):
    assert sessions.thread_key("books", "aposd") != sessions.thread_key("books", "feeling-good")


@pytest.mark.parametrize("surface", ["telegram", "wiki", "tasks"])
def test_ассистент_один_разговор_из_разных_окон(sessions, surface):
    """«Положи это в задачи» из телеграма должно работать — это одна беседа."""
    assert sessions.thread_key(surface) == sessions.MAIN


def test_читалка_без_книги_идёт_в_общую(sessions):
    assert sessions.thread_key("books", "") == sessions.MAIN


# ── Раздельное хранение ──

def test_нити_не_перетирают_друг_друга(sessions):
    sessions.save_session(sessions.MAIN, "sid-main")
    sessions.save_session("books:aposd", "sid-book")

    assert sessions.load_session(sessions.MAIN) == "sid-main"
    assert sessions.load_session("books:aposd") == "sid-book"


def test_очистка_книги_не_трогает_общую(sessions):
    sessions.save_session(sessions.MAIN, "sid-main")
    sessions.save_session("books:aposd", "sid-book")

    sessions.clear_session("books:aposd")

    assert sessions.load_session(sessions.MAIN) == "sid-main"
    assert sessions.load_session("books:aposd") is None


def test_старый_файл_читается_как_общая_нить(sessions, tmp_path):
    """До разделения сессия лежала в корне файла — после обновления она не должна пропасть."""
    (tmp_path / "session.json").write_text(json.dumps(
        {"session_id": "sid-old", "last_used": datetime.now().isoformat(timespec="seconds"),
         "started": datetime.now().isoformat(timespec="seconds")}), encoding="utf-8")

    assert sessions.load_session(sessions.MAIN) == "sid-old"


def test_протухание_считается_по_нити(sessions, tmp_path, monkeypatch):
    """Книгу читают неделями, в телеграм пишут раз в день — таймеры не общие."""
    from app import config, session_log

    monkeypatch.setattr(session_log, "end", lambda *_a: None)
    stale = (datetime.now() - timedelta(hours=config.SESSION_FRESH_HOURS + 1)).isoformat(timespec="seconds")
    fresh = datetime.now().isoformat(timespec="seconds")
    (tmp_path / "session.json").write_text(json.dumps({"threads": {
        "main": {"session_id": "sid-main", "last_used": stale, "started": stale},
        "books:aposd": {"session_id": "sid-book", "last_used": fresh, "started": fresh},
    }}), encoding="utf-8")

    assert sessions.load_session_state(sessions.MAIN) == (None, True)
    assert sessions.load_session_state("books:aposd") == ("sid-book", False)


def test_обзор_нитей_для_статуса(sessions):
    sessions.save_session(sessions.MAIN, "sid-main")
    sessions.save_session("books:aposd", "sid-book")

    assert [t["key"] for t in sessions.threads_overview()] == ["books:aposd", "main"]


# ── Что попадает в промпт нити ──

@pytest.fixture
def engine(tmp_path, monkeypatch):
    """Ход агента с подменённым движком: наружу отдаём собранный системный промпт."""
    from app import agent, config, cron_outbox, engines, memory_store, reviewer, session_log, skill_store

    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(config, "SESSION_FILE", str(tmp_path / "session.json"))
    monkeypatch.setattr(config, "WIKI_DIR", str(tmp_path / "wiki"))
    monkeypatch.setattr(memory_store, "as_prompt", lambda: "")
    monkeypatch.setattr(skill_store, "list_skills", lambda: [])
    monkeypatch.setattr(reviewer, "spawn", lambda *_a: None)
    monkeypatch.setattr(session_log, "log_turn", lambda *_a: None)

    seen: dict = {}

    class FakeEngine:
        """Движок-пустышка: запоминает, что ему передали, и молча заканчивает ход."""

        @staticmethod
        async def run(prompt, *, resume, surface, instructions, emit, interactive=True):
            seen["prompt"] = prompt
            seen["append"] = instructions
            return engines.Outcome(session_id="sess-1", reply="ok")

    monkeypatch.setattr(engines, "get", lambda name="": FakeEngine)
    return agent, cron_outbox, seen


def turn(engine, thread):
    agent, _, seen = engine

    async def emit(_ev):
        return None

    asyncio.run(agent.run_ws(emit, "привет", "books", thread))
    return seen


def test_фоновые_доставки_идут_в_общую_нить(engine):
    _, cron_outbox, _ = engine
    cron_outbox.record_delivery("Шкала Бёрнса", "Пора пройти шкалу")

    assert "ФОНОВЫЕ ДОСТАВКИ" in turn(engine, "main")["prompt"]


def test_доставка_едет_в_реплике_а_не_в_инструкциях(engine):
    """Системный промпт пересобирается каждый ход и в переписку не попадает; отправленное
    сообщение — часть беседы, ему место в стенограмме."""
    _, cron_outbox, _ = engine
    cron_outbox.record_delivery("Шкала Бёрнса", "Пора пройти шкалу")

    assert "ФОНОВЫЕ ДОСТАВКИ" not in turn(engine, "main")["append"]


def test_доставка_вычёркивается_после_хода(engine):
    """Она уже в стенограмме — клеить её к каждой следующей реплике незачем."""
    _, cron_outbox, _ = engine
    cron_outbox.record_delivery("Шкала Бёрнса", "Пора пройти шкалу")
    turn(engine, "main")

    assert "ФОНОВЫЕ ДОСТАВКИ" not in turn(engine, "main")["prompt"]


def test_в_разговор_про_книгу_доставки_не_лезут(engine):
    """Крон пишет в телеграм; посреди разбора главы это чужой шум."""
    _, cron_outbox, _ = engine
    cron_outbox.record_delivery("Шкала Бёрнса", "Пора пройти шкалу")

    assert "ФОНОВЫЕ ДОСТАВКИ" not in turn(engine, "books:aposd")["prompt"]
