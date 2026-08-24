"""Два движка — один продукт.

Проверяем то, что ломается тихо: промпт, который зовёт несуществующий инструмент,
набор инструментов, разъехавшийся между Claude и Codex, и события хода, из которых
интерфейс собирает ответ.
"""

import asyncio
import os
import re
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import config, tool_registry  # noqa: E402


# ── Промпт зовёт то, что существует ──

def mentioned(text: str) -> set[str]:
    """Имена инструментов, названные в тексте. Групповое упоминание (`mcp__tasks__*`)
    оставляем как есть: его проверяем по префиксу."""
    return set(re.findall(r"mcp__[a-z]+__[a-z_]*\*?", text))


def unknown(names: set[str], known: set[str]) -> set[str]:
    missing = set()
    for name in names:
        prefix = name.rstrip("*")
        if name.endswith("*"):
            if not any(k.startswith(prefix) for k in known):
                missing.add(name)
        elif name not in known:
            missing.add(name)
    return missing


@pytest.mark.parametrize("engine", ["claude", "codex"])
def test_промпт_зовёт_существующие_инструменты(engine):
    known = set(tool_registry.tool_names(tool_registry.groups_for(True), engine))
    assert unknown(mentioned(config.base_prompt(engine)), known) == set()


@pytest.mark.parametrize("engine", ["claude", "codex"])
def test_ревьюер_зовёт_существующие_инструменты(engine, monkeypatch):
    from app import reviewer

    monkeypatch.setattr(config, "ENGINE", engine)
    known = set(tool_registry.tool_names(tool_registry.REVIEWER_GROUPS, engine))
    assert unknown(mentioned(reviewer.rules()), known) == set()


def test_у_движков_один_набор_инструментов():
    """Инструмент, который есть на одной подписке и отсутствует на другой, — это
    разная функциональность у одного продукта."""
    groups = tool_registry.groups_for(True)
    claude = tool_registry.tool_names(groups, "claude")
    codex = tool_registry.tool_names(groups, "codex")
    assert len(claude) == len(codex) == len(set(codex))


def test_плановый_запуск_без_крона_и_записи_в_память():
    """Иначе задача по расписанию заведёт себе новую задачу по расписанию."""
    groups = tool_registry.groups_for(interactive=False)
    assert "cron" not in groups and "memory" not in groups
    assert "tasks" in groups


# ── События Codex → то, что рисует интерфейс ──

class _Root:
    def __init__(self, **kw):
        self.__dict__.update(kw)


class _Item:
    """ThreadItem у SDK — обёртка над union'ом, конкретный элемент лежит в .root."""

    def __init__(self, **kw):
        self.root = _Root(**kw)


def test_события_инструментов_переводятся_в_язык_фронтенда():
    # SDK Codex ставится вместе с бэкендом; в голом окружении теста его может не быть
    codex = pytest.importorskip("app.engines.codex")

    shell = codex._tool_event(_Item(type="commandExecution", command="ls -la"))
    assert shell["name"] == "Bash" and shell["pattern"] == "ls -la"

    # Обёртку оболочкой показывать человеку незачем — в чипе нужна сама команда
    wrapped = codex._tool_event(_Item(type="commandExecution",
                                      command='/bin/bash -lc "rg --files -g \'*.md\'"'))
    assert wrapped["pattern"] == "rg --files -g '*.md'"

    tool = codex._tool_event(_Item(type="mcpToolCall", server="bender", tool="tasks_create_task"))
    assert tool["name"] == "mcp__bender__tasks_create_task"

    search = codex._tool_event(_Item(type="webSearch", query="погода в Москве"))
    assert search["name"] == "WebSearch"

    patch = codex._tool_event(_Item(type="fileChange", changes=[_Root(path="/app/content/a.md")]))
    assert patch["file"] == "/app/content/a.md"

    assert codex._tool_event(_Item(type="reasoning")) is None


# ── Склейка потока: то, что уезжает в веб-чат ──

def test_поток_собирается_в_накопленный_текст(tmp_path, monkeypatch):
    from app import agent, cron_outbox, engines, memory_store, reviewer, session_log

    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(config, "SESSION_FILE", str(tmp_path / "session.json"))
    monkeypatch.setattr(config, "WIKI_DIR", str(tmp_path / "wiki"))
    monkeypatch.setattr(memory_store, "as_prompt", lambda: "")
    monkeypatch.setattr(reviewer, "spawn", lambda *_a: None)
    monkeypatch.setattr(session_log, "log_turn", lambda *_a: None)
    monkeypatch.setattr(cron_outbox, "pending", lambda: ("", []))
    monkeypatch.setattr(agent, "THROTTLE", 0)   # без задержки: тест не должен спать

    class FakeEngine:
        @staticmethod
        async def run(prompt, *, resume, surface, instructions, emit, interactive=True):
            await emit({"t": "delta", "id": "m1", "text": "При"})
            await emit({"t": "delta", "id": "m1", "text": "вет"})
            await emit({"t": "flush", "id": "m1"})
            await emit({"t": "tool", "name": "Bash", "pattern": "ls", "file": ""})
            return engines.Outcome(session_id="s1", reply="Привет")

    monkeypatch.setattr(engines, "get", lambda name="": FakeEngine)

    events = []

    async def emit(ev):
        events.append(ev)

    asyncio.run(agent.run_ws(emit, "привет", "wiki"))

    texts = [e["text"] for e in events if e["t"] == "text"]
    assert texts[-1] == "Привет"                       # показываем накопленное, не куски
    assert any(e["t"] == "tool" and e["name"] == "Bash" for e in events)
    assert events[-1] == {"t": "done", "sid": "s1"}
    assert agent.load_session() == "s1"                # сессию запомнили для resume


def test_протухшая_сессия_переигрывается_с_чистого_листа(tmp_path, monkeypatch):
    """Движок мог потерять нить (переезд хоста, чистка кэша) — это не повод терять ход."""
    from app import agent, cron_outbox, engines, memory_store, reviewer, session_log

    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(config, "SESSION_FILE", str(tmp_path / "session.json"))
    monkeypatch.setattr(config, "WIKI_DIR", str(tmp_path / "wiki"))
    monkeypatch.setattr(memory_store, "as_prompt", lambda: "")
    monkeypatch.setattr(reviewer, "spawn", lambda *_a: None)
    monkeypatch.setattr(session_log, "log_turn", lambda *_a: None)
    monkeypatch.setattr(cron_outbox, "pending", lambda: ("", []))
    agent.save_session(agent.MAIN, "старая")

    seen = []

    class FakeEngine:
        @staticmethod
        async def run(prompt, *, resume, surface, instructions, emit, interactive=True):
            seen.append(resume)
            if resume:
                raise engines.StaleSession
            return engines.Outcome(session_id="новая", reply="ок")

    monkeypatch.setattr(engines, "get", lambda name="": FakeEngine)

    async def emit(_ev):
        return None

    asyncio.run(agent.run_ws(emit, "привет", "wiki"))

    assert seen == ["старая", None]
    assert agent.load_session() == "новая"


# ── Перегрузка на той стороне ──

def test_перегрузка_распознаётся_а_лимит_подписки_нет():
    """529/503 лечатся повтором, 429 — нет: это исчерпанная подписка, и повтор её не вернёт."""
    from app import engines

    assert engines.looks_overloaded("API Error: 529 Overloaded")
    assert engines.looks_overloaded("503 Service Temporarily Unavailable")
    assert not engines.looks_overloaded("API Error: 429 rate limit exceeded")
    assert not engines.looks_overloaded("")


def test_ход_переигрывается_после_перегрузки(tmp_path, monkeypatch):
    """529 приходит до первого куска ответа — значит, терять нечего и ход можно повторить."""
    from app import agent, cron_outbox, engines, memory_store, reviewer, session_log

    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(config, "SESSION_FILE", str(tmp_path / "session.json"))
    monkeypatch.setattr(config, "WIKI_DIR", str(tmp_path / "wiki"))
    monkeypatch.setattr(memory_store, "as_prompt", lambda: "")
    monkeypatch.setattr(reviewer, "spawn", lambda *_a: None)
    monkeypatch.setattr(session_log, "log_turn", lambda *_a: None)
    monkeypatch.setattr(cron_outbox, "pending", lambda: ("", []))
    monkeypatch.setattr(agent, "OVERLOAD_PAUSE", 0)      # тест не должен спать

    calls = []

    class FakeEngine:
        @staticmethod
        async def run(prompt, *, resume, surface, instructions, emit, interactive=True):
            calls.append(resume)
            if len(calls) == 1:
                raise engines.Overloaded("Claude сейчас перегружен и не ответил.")
            return engines.Outcome(session_id="s1", reply="ответ")

    monkeypatch.setattr(engines, "get", lambda name="": FakeEngine)

    events = []

    async def emit(ev):
        events.append(ev)

    asyncio.run(agent.run_ws(emit, "привет", "wiki"))

    assert len(calls) == 2                                    # повторили тот же ход
    assert not [e for e in events if e["t"] == "error"]        # и человек ошибки не увидел
    assert events[-1] == {"t": "done", "sid": "s1"}


def test_упорная_перегрузка_объясняется_человеку(tmp_path, monkeypatch):
    """Если и повтор не прошёл — говорим, что именно случилось, а не «что-то пошло не так»."""
    from app import agent, cron_outbox, engines, memory_store, reviewer, session_log

    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(config, "SESSION_FILE", str(tmp_path / "session.json"))
    monkeypatch.setattr(config, "WIKI_DIR", str(tmp_path / "wiki"))
    monkeypatch.setattr(memory_store, "as_prompt", lambda: "")
    monkeypatch.setattr(reviewer, "spawn", lambda *_a: None)
    monkeypatch.setattr(session_log, "log_turn", lambda *_a: None)
    monkeypatch.setattr(cron_outbox, "pending", lambda: ("", []))
    monkeypatch.setattr(agent, "OVERLOAD_PAUSE", 0)

    class FakeEngine:
        @staticmethod
        async def run(prompt, *, resume, surface, instructions, emit, interactive=True):
            raise engines.Overloaded("Claude сейчас перегружен и не ответил.")

    monkeypatch.setattr(engines, "get", lambda name="": FakeEngine)

    reply = asyncio.run(agent.run_collect("привет"))
    assert "перегружен" in reply

    events = []

    async def emit(ev):
        events.append(ev)

    asyncio.run(agent.run_ws(emit, "привет", "wiki"))
    assert [e for e in events if e["t"] == "error"][-1]["text"].startswith("Claude сейчас")
    assert events[-1]["t"] == "done"


def test_529_превращается_в_повторяемую_ошибку(monkeypatch):
    """Как это выглядит на самом деле: CLI отдаёт ход одним «API Error: 529» и выходит
    с ненулевым кодом, а SDK превращает выход в невнятное «error result: success»."""
    claude = pytest.importorskip("app.engines.claude")
    from claude_agent_sdk import AssistantMessage, TextBlock

    from app import engines

    async def fake_query(*, prompt, options):    # noqa: ARG001 — подпись SDK
        yield AssistantMessage(
            content=[TextBlock(text="API Error: 529 Overloaded. This is a server-side issue")],
            model="claude", message_id="m1")
        raise Exception("Claude Code returned an error result: success")

    monkeypatch.setattr(claude, "build_options", lambda *_a, **_kw: None)
    monkeypatch.setattr(claude, "query", fake_query)

    events = []

    async def emit(ev):
        events.append(ev)

    async def go():
        return await claude.run("привет", resume=None, surface="wiki",
                                instructions="", emit=emit)

    with pytest.raises(engines.Overloaded):
        asyncio.run(go())
    assert not events        # «API Error» — это не ответ, человеку его не показываем
