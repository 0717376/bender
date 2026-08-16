"""Внутренний MCP-сервер: те же доменные инструменты, но по HTTP — для Codex.

Codex не умеет внутрипроцессные серверы Claude SDK, зато умеет MCP по HTTP. Поднимаем
их прямо в бэкенде: обработчики те же самые объекты из *_tools.py, так что второго
описания инструментов не появляется. Наружу этот сервер не торчит — он живёт на том же
порту, что и API (в docker-сети), и закрыт отдельным токеном.

Вариантов несколько, потому что набор инструментов зависит от того, кто ходит: живой
разговор, плановый запуск (без крона и записи в память) или фоновый ревьюер.
"""

import json
import logging
import os
import secrets

from mcp import types
from mcp.server.fastmcp.server import StreamableHTTPASGIApp
from mcp.server.lowlevel import Server
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp.server.transport_security import TransportSecuritySettings

from . import config, tool_registry
from .mcp_server import TokenGate

logger = logging.getLogger("wiki.mcp_internal")

TOKEN_FILE = os.path.join(config.DATA_DIR, "mcp_internal_token")

# Путь монтирования и набор групп. Ключ уезжает в конфиг нити Codex.
VARIANTS = {
    "main": tool_registry.groups_for(interactive=True),
    "cron": tool_registry.groups_for(interactive=False),
    "review": tool_registry.REVIEWER_GROUPS,
}


def get_token() -> str:
    """Токен внутреннего сервера. От пользовательского (data/mcp_token) отдельный:
    тот человек раздаёт сторонним клиентам и меняет из настроек, а этот — наш."""
    try:
        with open(TOKEN_FILE) as f:
            tok = f.read().strip()
        if tok:
            return tok
    except OSError:
        pass
    os.makedirs(config.DATA_DIR, exist_ok=True)
    tok = secrets.token_urlsafe(32)
    with open(TOKEN_FILE, "w") as f:
        f.write(tok)
    os.chmod(TOKEN_FILE, 0o600)
    return tok


def _content(result) -> list[types.ContentBlock]:
    """Ответ инструмента SDK ({'content': [{'type': 'text', ...}]}) — в блоки MCP."""
    blocks: list[types.ContentBlock] = []
    for item in (result or {}).get("content", []):
        if item.get("type") == "text":
            blocks.append(types.TextContent(type="text", text=item.get("text", "")))
        elif item.get("type") == "image":
            blocks.append(types.ImageContent(type="image", data=item.get("data", ""),
                                             mimeType=item.get("mimeType", "image/png")))
    if not blocks:
        blocks.append(types.TextContent(type="text", text=json.dumps(result, ensure_ascii=False,
                                                                     default=str)))
    return blocks


def _build(groups) -> Server:
    server = Server(config.CODEX_MCP_NAME)
    # Имя инструмента здесь — то же, что агент видит в промпте: config.tool_name()
    # отрезает от него префикс mcp__bender__, а группа остаётся частью имени.
    handlers = {f"{g}_{t.name}": t for g, t in tool_registry.tools_in(groups)}

    @server.list_tools()
    async def list_tools() -> list[types.Tool]:
        return [types.Tool(name=n, description=t.description, inputSchema=t.input_schema)
                for n, t in handlers.items()]

    @server.call_tool()
    async def call_tool(name: str, arguments: dict) -> list[types.ContentBlock]:
        tool = handlers.get(name)
        if tool is None:
            raise ValueError(f"нет такого инструмента: {name}")
        return _content(await tool.handler(arguments or {}))

    return server


def build() -> tuple[dict, dict]:
    """Свежий комплект серверов. Функцией, а не модульным кодом: менеджер сессий
    запускается ровно один раз за свою жизнь, и тесту нужен собственный."""
    managers: dict[str, StreamableHTTPSessionManager] = {}
    apps: dict[str, object] = {}
    for variant, groups in VARIANTS.items():
        manager = StreamableHTTPSessionManager(
            app=_build(groups),
            json_response=True,
            stateless=True,
            # Защита от DNS rebinding нужна открытым локальным серверам; здесь каждый
            # запрос требует bearer-токен, а ходит в него сосед по контейнеру.
            security_settings=TransportSecuritySettings(enable_dns_rebinding_protection=False),
        )
        managers[variant] = manager
        apps[variant] = TokenGate(StreamableHTTPASGIApp(manager), token_getter=get_token)
    return managers, apps


_managers, apps = build()


def url(variant: str) -> str:
    """Адрес для конфига Codex. Ходим сами в себя: агент живёт в этом же контейнере."""
    return f"http://127.0.0.1:8000/mcp-internal/{variant}"


async def run(stack, managers: dict | None = None):
    """Сессион-менеджеры живут столько же, сколько приложение (вызывается из lifespan)."""
    for manager in (managers if managers is not None else _managers).values():
        await stack.enter_async_context(manager.run())
