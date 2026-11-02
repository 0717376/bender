"""Большие файлы в боте: долгое скачивание, реплай на файл, запись на диск."""

import asyncio
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture
def bot(monkeypatch, tmp_path):
    """Бот с подменёнными Bot API и агентом; локальный сервер отдаёт путь к файлу на диске."""
    from app import config, curator, pairing, telegram

    src = tmp_path / "server.pdf"
    src.write_bytes(b"%PDF-data")
    state = type("S", (), {"sent": [], "prompts": [], "timeouts": [], "file": str(src)})()

    async def fake_api(_client, method, _timeout=None, **params):
        if method == "getFile":
            state.timeouts.append(_timeout)
            return {"ok": True, "result": {"file_path": state.file}} if state.file else {"ok": False}
        if method == "sendMessage":
            state.sent.append(params["text"])
        return {"ok": True}

    async def fake_send(_client, _chat, text):
        state.sent.append(text)

    async def fake_run(text, *_a, **_k):
        state.prompts.append(text)
        return "ок"

    monkeypatch.setattr(telegram, "tg_api", fake_api)
    monkeypatch.setattr(telegram, "tg_send", fake_send)
    monkeypatch.setattr(telegram, "run_collect", fake_run)
    monkeypatch.setattr(curator, "mark_activity", lambda: None)
    monkeypatch.setattr(pairing, "allowed_ids", lambda: {1})
    monkeypatch.setattr(config, "FILES_DIR", str(tmp_path / "files"))
    state.inbox = tmp_path / "files" / config.FILES_INBOX
    return state


def handle(msg):
    from app import telegram

    base = {"chat": {"id": 1}, "from": {"id": 1}}
    asyncio.run(telegram.tg_handle(None, {"message": {**base, **msg}}))


PDF = {"file_id": "f", "file_name": "отчёт.pdf", "mime_type": "application/pdf", "file_size": 9}


def test_document_saved_with_long_wait(bot):
    """Локальный bot-api молчит, пока качает: общий тайм-аут опроса в 70 с тут обрывал запрос."""
    from app import telegram

    handle({"document": PDF, "caption": "в ворд"})
    assert bot.timeouts == [telegram.GET_FILE_TIMEOUT] and telegram.GET_FILE_TIMEOUT > 600
    assert (bot.inbox / "отчёт.pdf").read_bytes() == b"%PDF-data"
    assert "отчёт.pdf" in bot.prompts[0] and "в ворд" in bot.prompts[0]


def test_reply_to_file_brings_the_file(bot):
    """Сама просьба и файл — разные сообщения: реплай не должен терять вложение."""
    handle({"text": "ты видишь этот файл?", "reply_to_message": {"document": PDF, "from": {"id": 1}}})
    assert str(bot.inbox / "отчёт.pdf") in bot.prompts[0]


def test_reply_twice_makes_no_copies(bot):
    for _ in range(2):
        handle({"text": "ещё", "reply_to_message": {"document": PDF}})
    assert [p.name for p in bot.inbox.iterdir()] == ["отчёт.pdf"]


def test_same_name_other_content_keeps_both(bot):
    handle({"document": PDF})
    handle({"document": {**PDF, "file_size": 777}})
    assert len(list(bot.inbox.iterdir())) == 2


def test_big_file_is_announced(bot):
    handle({"document": {**PDF, "file_size": 100 * 1024 * 1024}})
    assert "100 МБ" in bot.sent[0]


def test_failure_names_the_file_and_skips_agent(bot):
    bot.file = None
    handle({"document": PDF})
    assert "отчёт.pdf" in bot.sent[-1] and not bot.prompts


def test_broken_copy_leaves_no_file(bot):
    bot.file = "/nonexistent/x.pdf"
    handle({"document": PDF})
    assert not bot.prompts and list(bot.inbox.iterdir()) == []


def test_command_in_reply_stays_a_command(bot, monkeypatch):
    from app import telegram

    seen = []
    monkeypatch.setattr(telegram, "clear_session", lambda: seen.append(1))
    handle({"text": "/new", "reply_to_message": {"document": PDF}})
    assert seen and not bot.prompts
