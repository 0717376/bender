"""Установка: привязка Telegram кодом и первое наполнение стенда."""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture
def pair(tmp_path, monkeypatch):
    from app import config, pairing

    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setattr(config, "DATA_DIR", str(data))
    monkeypatch.setattr(config, "TELEGRAM_ALLOWED_IDS", set())
    monkeypatch.setattr(pairing, "STATE", str(data / "telegram.json"))
    return pairing


def test_код_не_меняется_между_вызовами(pair):
    # Установщик печатает код, доктор показывает его снова — это должен быть один код.
    assert pair.code() == pair.code()
    assert pair.code().isdigit() and len(pair.code()) == 6


def test_верный_код_привязывает_чат(pair):
    assert pair.try_pair(4242, pair.code()) is True
    assert pair.allowed_ids() == {4242}


def test_чужой_код_не_привязывает(pair):
    code = pair.code()
    assert pair.try_pair(1, "000000" if code != "000000" else "111111") is False
    assert pair.allowed_ids() == set()


def test_после_привязки_код_гаснет(pair):
    # Иначе дверь остаётся открытой: тот же код привязал бы ещё кого угодно.
    pair.try_pair(7, pair.code())
    assert pair.code() == ""
    assert pair.try_pair(8, "123456") is False
    assert pair.allowed_ids() == {7}


def test_список_из_конфига_старше_привязки(pair, monkeypatch):
    from app import config

    monkeypatch.setattr(config, "TELEGRAM_ALLOWED_IDS", {99})
    assert pair.code() == ""          # настроено вручную — привязка не нужна
    assert pair.allowed_ids() == {99}


def test_привязка_переживает_перезапуск(pair):
    pair.try_pair(5, pair.code())
    assert pair.paired_ids() == {5}   # состояние на диске, а не в памяти процесса


@pytest.fixture
def bot(pair, monkeypatch):
    """Бот с перехваченным Bot API: (метод, текст) — что улетело в чат."""
    from app import telegram

    seen: list[tuple[str, str]] = []

    async def fake_api(_client, method, **params):
        seen.append((method, params.get("text", "")))
        return {"ok": True}

    async def fake_send(_client, _chat, text):
        seen.append(("sendMessage", text))

    monkeypatch.setattr(telegram, "tg_api", fake_api)
    monkeypatch.setattr(telegram, "tg_send", fake_send)
    return telegram, seen


def _msg(text, uid=77):
    return {"message": {"chat": {"id": uid}, "from": {"id": uid}, "text": text}}


def test_непривязанному_чату_говорят_про_код(bot, pair):
    import asyncio

    telegram, seen = bot
    asyncio.run(telegram.tg_handle(None, _msg("привет")))

    assert "код привязки" in seen[0][1]
    assert pair.allowed_ids() == set()


def test_код_в_чате_привязывает_и_здоровается(bot, pair):
    import asyncio

    telegram, seen = bot
    asyncio.run(telegram.tg_handle(None, _msg(pair.code())))

    assert seen[0][1].startswith("Чат привязан")
    assert pair.allowed_ids() == {77}


def test_чужому_чату_после_привязки_отказ(bot, pair):
    import asyncio

    telegram, seen = bot
    pair.try_pair(77, pair.code())
    asyncio.run(telegram.tg_handle(None, _msg("пусти", uid=1234)))

    assert seen == [("sendMessage", "Это приватный бот.")]


@pytest.fixture
def stand(tmp_path, monkeypatch):
    from app import config, seed, tasks_store

    data, wiki = tmp_path / "data", tmp_path / "content"
    data.mkdir()
    wiki.mkdir()
    monkeypatch.setattr(config, "DATA_DIR", str(data))
    monkeypatch.setattr(config, "WIKI_DIR", str(wiki))
    monkeypatch.setattr(seed, "MARKER", str(data / ".seeded"))
    tasks_store.init()
    return seed, tasks_store, wiki


def test_пустой_стенд_наполняется(stand):
    seed, tasks, wiki = stand
    seed.init()

    assert (wiki / seed.PAGE).exists()
    assert len(tasks.list_tasks(view="today") + tasks.list_tasks(view="inbox")) == 2


def test_наполнение_бывает_только_раз(stand):
    seed, tasks, wiki = stand
    seed.init()
    (wiki / seed.PAGE).unlink()
    for t in tasks.list_tasks(view="today") + tasks.list_tasks(view="inbox"):
        tasks.delete_task(t["id"])

    seed.init()  # примеры удалили осознанно — возвращать их обратно нельзя

    assert not (wiki / seed.PAGE).exists()
    assert tasks.list_tasks(view="inbox") == []


def test_живую_вики_наполнение_не_трогает(stand):
    seed, _tasks, wiki = stand
    (wiki / "Мои заметки.md").write_text("# Мои заметки\n", encoding="utf-8")

    seed.init()

    assert not (wiki / seed.PAGE).exists()


def test_персона_не_считается_наполнением(stand):
    from app import config

    seed, _tasks, wiki = stand
    (wiki / config.PERSONA_NAME).write_text("# Персона\n", encoding="utf-8")

    seed.init()  # персону заводит сам агент — вики от этого не перестаёт быть пустой

    assert (wiki / seed.PAGE).exists()
