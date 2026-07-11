"""Memory tools for the agent (`mcp__memory__*`). Interactive turns only."""

import json

from claude_agent_sdk import create_sdk_mcp_server, tool

from . import memory_store as store


def _text(obj) -> dict:
    return {"content": [{"type": "text", "text": json.dumps(obj, ensure_ascii=False, default=str)}]}


@tool(
    "remember",
    "Сохранить факт в долговременную память (переживёт /clear). Используй, когда узнаёшь "
    "стабильное о пользователе. category: 'profile' (кто он), 'note' (факт/контекст), "
    "'pref' (как с ним работать — выученное предпочтение).",
    {
        "type": "object",
        "properties": {
            "text": {"type": "string"},
            "category": {"type": "string", "enum": list(store.CATEGORIES)},
        },
        "required": ["text"],
    },
)
async def remember(args):
    return _text(store.add(args["text"], args.get("category", "note")))


@tool("list_memory", "Показать всё, что сохранено в долговременной памяти.",
      {"type": "object", "properties": {}})
async def list_memory(args):
    return _text(store.all_entries())


@tool("forget", "Удалить запись памяти по id.",
      {"type": "object", "properties": {"id": {"type": "integer"}}, "required": ["id"]})
async def forget(args):
    return _text({"ok": store.remove(args["id"])})


TOOLS = [remember, list_memory, forget]
TOOL_NAMES = [f"mcp__memory__{t.name}" for t in TOOLS]

server = create_sdk_mcp_server("memory", version="1.0.0", tools=TOOLS)
