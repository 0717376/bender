"""Skill-authoring tools for the agent (`mcp__skills__*`).

Thin wrappers over skill_store that write/read native SKILL.md files. Discovery and use of
skills happens natively (the Skill tool + progressive disclosure); these tools exist so the
agent can reliably AUTHOR skills and so the Curator can enumerate/consolidate the library.
Available in interactive turns AND to the Curator.
"""

import json

from claude_agent_sdk import create_sdk_mcp_server, tool

from . import skill_store as store


def _text(obj) -> dict:
    return {"content": [{"type": "text", "text": json.dumps(obj, ensure_ascii=False, default=str)}]}


@tool(
    "save",
    "Сохранить навык (процедурную память) как переиспользуемый Skill из проверенного опыта. "
    "Создаёт новый или перезаписывает существующий с тем же именем. name — короткий "
    "идентификатор ЛАТИНИЦЕЙ в kebab-case (напр. 'deploy-backend'); description — КОГДА "
    "применять (по нему навык находится); body — markdown-инструкция: шаги, нюансы, примеры. "
    "Оформляй навык, когда решил нетривиальную повторяемую задачу.",
    {
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "description": {"type": "string"},
            "body": {"type": "string"},
        },
        "required": ["name", "description", "body"],
    },
)
async def save(args):
    return _text(store.save_skill(args["name"], args["description"], args["body"]))


@tool("list", "Список выученных навыков (slug + имя + когда применять).",
      {"type": "object", "properties": {}})
async def list_(args):
    return _text(store.list_skills())


@tool("read", "Прочитать полный навык по имени/slug.",
      {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]})
async def read(args):
    res = store.read_skill(args["name"])
    return _text(res or {"error": "не найдено"})


@tool("remove", "Удалить навык по имени/slug (используй при консолидации дублей).",
      {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]})
async def remove(args):
    return _text(store.delete_skill(args["name"]))


TOOLS = [save, list_, read, remove]
TOOL_NAMES = [f"mcp__skills__{t.name}" for t in TOOLS]

server = create_sdk_mcp_server("skills", version="1.0.0", tools=TOOLS)
