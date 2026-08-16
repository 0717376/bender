"""Внутренний MCP: то, через что Codex видит инструменты.

Ходим по нему так же, как ходил бы Codex, — это единственная проверка, которая
ловит, что инструменты до движка вообще доезжают.
"""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture
def mcp(tmp_path, monkeypatch):
    """Только маршруты внутреннего MCP: поднимать ради этого весь бэкенд незачем,
    а он ещё и полезет заводить каталоги данных."""
    from contextlib import AsyncExitStack, asynccontextmanager

    from fastapi.testclient import TestClient
    from starlette.applications import Starlette
    from starlette.routing import Route

    from app import config, mcp_internal, tasks_store
    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(config, "WIKI_DIR", str(tmp_path / "wiki"))
    monkeypatch.setattr(mcp_internal, "TOKEN_FILE", str(tmp_path / "token"))
    tasks_store.init()

    managers, apps = mcp_internal.build()

    @asynccontextmanager
    async def lifespan(_app):
        async with AsyncExitStack() as stack:
            await mcp_internal.run(stack, managers)
            yield

    app = Starlette(routes=[Route(f"/mcp-internal/{v}", endpoint=a) for v, a in apps.items()],
                    lifespan=lifespan)
    with TestClient(app) as client:
        yield client, mcp_internal


def rpc(client, body, token, path="/mcp-internal/main"):
    return client.post(path, json={"jsonrpc": "2.0", "id": 1, **body}, headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
    })


def handshake(client, token, path="/mcp-internal/main"):
    rpc(client, {"method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {},
        "clientInfo": {"name": "test", "version": "1"}}}, token, path)


def test_без_токена_не_пускает(mcp):
    client, _ = mcp
    assert client.post("/mcp-internal/main", json={}).status_code == 401


def test_инструменты_видны_и_названы_как_в_промпте(mcp):
    client, mcp_internal = mcp
    token = mcp_internal.get_token()
    handshake(client, token)
    resp = rpc(client, {"method": "tools/list", "params": {}}, token)

    names = {t["name"] for t in resp.json()["result"]["tools"]}
    assert "tasks_create_task" in names and "memory_remember" in names
    # Имя в промпте — mcp__bender__<это самое имя>: разъедутся, и агент будет звать пустоту
    from app import config
    assert config.tool_name("tasks", "create_task", "codex").endswith("__tasks_create_task")


def test_вызов_инструмента_меняет_данные(mcp):
    client, mcp_internal = mcp
    from app import tasks_store

    token = mcp_internal.get_token()
    handshake(client, token)
    resp = rpc(client, {"method": "tools/call", "params": {
        "name": "tasks_create_task", "arguments": {"title": "проверка", "when": "today"}}}, token)

    assert resp.json()["result"]["content"][0]["type"] == "text"
    assert [t["title"] for t in tasks_store.list_tasks(view="today")] == ["проверка"]


def test_плановому_запуску_крон_не_виден(mcp):
    """Иначе задача по расписанию заведёт себе новую задачу по расписанию."""
    client, mcp_internal = mcp
    token = mcp_internal.get_token()
    handshake(client, token, "/mcp-internal/cron")
    resp = rpc(client, {"method": "tools/list", "params": {}}, token, "/mcp-internal/cron")

    names = {t["name"] for t in resp.json()["result"]["tools"]}
    assert "tasks_create_task" in names
    assert not [n for n in names if n.startswith(("cron_", "memory_"))]


def test_ревьюеру_видны_только_память_и_навыки(mcp):
    client, mcp_internal = mcp
    token = mcp_internal.get_token()
    handshake(client, token, "/mcp-internal/review")
    resp = rpc(client, {"method": "tools/list", "params": {}}, token, "/mcp-internal/review")

    names = {t["name"] for t in resp.json()["result"]["tools"]}
    assert names and all(n.startswith(("memory_", "skills_")) for n in names)


def test_схема_инструмента_доезжает_целиком(mcp):
    """Описание и схему пишем один раз — в *_tools.py; сюда они должны доехать как есть."""
    client, mcp_internal = mcp
    from app import tool_registry

    token = mcp_internal.get_token()
    handshake(client, token)
    tools = {t["name"]: t for t in rpc(client, {"method": "tools/list", "params": {}},
                                       token).json()["result"]["tools"]}

    source = tool_registry.find("tasks", "create_task")
    assert tools["tasks_create_task"]["description"] == source.description
    assert tools["tasks_create_task"]["inputSchema"] == json.loads(json.dumps(source.input_schema))
