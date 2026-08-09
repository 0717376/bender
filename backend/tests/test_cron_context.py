"""Крон отправил, человек ответил — а разговор об этом не знал.

Три места, где терялся контекст фоновой доставки: окно outbox, якорь ответа
в Telegram и журнал.
"""

import asyncio
import os
import sys
from datetime import datetime, timedelta

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture
def outbox(tmp_path, monkeypatch):
    from app import config, cron_outbox

    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path))
    return cron_outbox


NOW = datetime(2026, 8, 9, 20, 0)


# ── Окно доставок ──

def test_блок_не_выпивается_первым_ходом(outbox):
    """Так и сломалось: доставку съел вопрос из читалки, а ответ в телеграм пришёл в пустоту."""
    outbox.record_delivery("Шкала Бёрнса", "Пора пройти шкалу за неделю", when=NOW)

    first = outbox.pending_block(NOW + timedelta(minutes=19))
    later = outbox.pending_block(NOW + timedelta(minutes=47))

    assert "Пора пройти шкалу" in first
    assert later == first


def test_в_блоке_есть_задание(outbox):
    """В промпте написано, что делать с ответом; по отправленной фразе это не восстановить."""
    outbox.record_delivery("Шкала Бёрнса", "Пора пройти шкалу",
                           "Напомнить и записать балл; ответит баллом — оформить в вики", when=NOW)

    assert "оформить в вики" in outbox.pending_block(NOW)


def test_протухшее_уходит_и_из_файла(outbox):
    old = NOW - timedelta(hours=outbox.WINDOW_HOURS, minutes=1)
    outbox.record_delivery("Вчерашнее", "старьё", when=old)
    outbox.record_delivery("Сегодняшнее", "свежак", when=NOW)

    block = outbox.pending_block(NOW)

    assert "свежак" in block and "старьё" not in block
    assert [d["name"] for d in outbox._read()] == ["Сегодняшнее"]


def test_запись_старого_формата_отбрасывается(outbox, tmp_path):
    """До этой версии время писалось как «20:00», без даты: возраст неизвестен."""
    (tmp_path / "cron_outbox.json").write_text(
        '[{"at": "20:00", "name": "Старое", "text": "было"}]', encoding="utf-8")

    assert outbox.pending_block(NOW) == ""


def test_пусто_когда_нечего_отдавать(outbox):
    assert outbox.pending_block(NOW) == ""


# ── Якорь ответа в Telegram ──

def note(msg):
    from app import telegram

    return telegram.quoted_note(msg)


def test_ответ_на_сообщение_бота():
    assert "твоё сообщение" in note({"reply_to_message": {"text": "Пора пройти шкалу",
                                                          "from": {"is_bot": True}}})


def test_цитата_точнее_целого_сообщения():
    """Bot API 7.0: человек выделил кусок — отвечает именно на него."""
    msg = {"quote": {"text": "записать балл"},
           "reply_to_message": {"text": "Пора пройти шкалу и записать балл",
                                "from": {"is_bot": True}}}

    assert "«записать балл»" in note(msg)


def test_ответ_на_своё_сообщение():
    assert "своё сообщение" in note({"reply_to_message": {"text": "напомни",
                                                          "from": {"is_bot": False}}})


def test_обычное_сообщение_без_якоря():
    assert note({"text": "привет"}) == ""


def test_ответ_на_картинку_без_подписи():
    """Отвечать на медиа без текста можно, но якорю взяться неоткуда."""
    assert note({"reply_to_message": {"from": {"is_bot": True}}}) == ""


# ── Журнал ──

@pytest.fixture
def journal(tmp_path, monkeypatch):
    """Планировщик с подменённым агентом: отдаёт то, что положили в out."""
    from app import agent, config, cron_store, scheduler, session_log

    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path))
    session_log.init()
    cron_store.init()

    out = {"text": ""}

    async def fake_cron(_prompt, surface="telegram"):
        return out["text"]

    async def noop(*_a, **_k):
        return None

    monkeypatch.setattr(agent, "run_cron", fake_cron)
    monkeypatch.setattr(scheduler, "notify", noop)
    return scheduler, session_log, cron_store, out


def run(journal, text):
    scheduler, session_log, cron_store, out = journal
    out["text"] = text
    job = cron_store.create("Шкала Бёрнса", "Напомнить пройти шкалу", "0 20 * * 0")
    asyncio.run(scheduler.run_job(cron_store.get(job["id"])))
    return session_log.search("шкалу")


def test_доставка_попадает_в_журнал(journal):
    """«Ты мне про это уже писал?» спрашивают днями позже — окно outbox столько не живёт."""
    found = run(journal, "Пора пройти шкалу за неделю")

    assert found, "крон-прогон не найден в журнале"


def test_молчаливый_прогон_в_журнал_не_идёт(journal):
    """Журнал — про то, что человек видел; [SILENT] он не видел."""
    assert not run(journal, "[SILENT]")
