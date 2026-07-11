"""In-process SDK MCP tools that let the agent manage the Tasks domain.

Exposed to Claude as `mcp__tasks__*`. They call the same store the REST API uses,
so chat-created tasks show up live in the Tasks UI.
"""

import json

from claude_agent_sdk import create_sdk_mcp_server, tool

from . import tasks_store as store


def _text(obj) -> dict:
    return {"content": [{"type": "text", "text": json.dumps(obj, ensure_ascii=False, default=str)}]}


@tool(
    "list_tasks",
    "Список задач. view: inbox|today|upcoming|anytime|someday|logbook. "
    "Можно фильтровать по project_id или строке q.",
    {
        "type": "object",
        "properties": {
            "view": {"type": "string", "enum": list(store.VIEWS)},
            "project_id": {"type": "integer"},
            "q": {"type": "string"},
        },
    },
)
async def list_tasks(args):
    return _text(store.list_tasks(view=args.get("view"), project_id=args.get("project_id"), q=args.get("q")))


@tool(
    "create_task",
    "Создать задачу. when: ISO-дата 'YYYY-MM-DD' | 'today' | 'someday' | null. "
    "project — имя или id проекта (создаётся, если новое имя). "
    "repeat — повтор: {unit: day|week|month|year, interval: N, mode: schedule|done} "
    "(schedule — от даты задачи, done — от даты выполнения).",
    {
        "type": "object",
        "properties": {
            "title": {"type": "string"},
            "notes": {"type": "string"},
            "when": {"type": "string"},
            "deadline": {"type": "string", "description": "ISO YYYY-MM-DD"},
            "project": {"type": "string"},
            "tags": {"type": "array", "items": {"type": "string"}},
            "repeat": {"type": "object"},
        },
        "required": ["title"],
    },
)
async def create_task(args):
    return _text(store.create_task(
        title=args["title"], notes=args.get("notes", ""), when=args.get("when"),
        deadline=args.get("deadline"), project=args.get("project"), tags=args.get("tags"),
        repeat=args.get("repeat"),
    ))


@tool(
    "update_task",
    "Изменить задачу по id. Любые поля: title, notes, when, deadline, project, tags, status, "
    "repeat ({unit, interval, mode}; пустой объект {} убирает повтор).",
    {
        "type": "object",
        "properties": {
            "id": {"type": "integer"},
            "title": {"type": "string"},
            "notes": {"type": "string"},
            "when": {"type": "string"},
            "deadline": {"type": "string"},
            "project": {"type": "string"},
            "tags": {"type": "array", "items": {"type": "string"}},
            "status": {"type": "string", "enum": ["open", "completed", "canceled"]},
            "repeat": {"type": "object"},
        },
        "required": ["id"],
    },
)
async def update_task(args):
    tid = args.pop("id")
    res = store.update_task(tid, **args)
    return _text(res or {"error": "not found"})


@tool(
    "complete_task",
    "Отметить задачу выполненной (done=true) или снова открыть (done=false).",
    {
        "type": "object",
        "properties": {"id": {"type": "integer"}, "done": {"type": "boolean"}},
        "required": ["id"],
    },
)
async def complete_task(args):
    res = store.complete_task(args["id"], done=args.get("done", True))
    return _text(res or {"error": "not found"})


@tool("delete_task", "Удалить задачу по id.",
      {"type": "object", "properties": {"id": {"type": "integer"}}, "required": ["id"]})
async def delete_task(args):
    store.delete_task(args["id"])
    return _text({"ok": True})


@tool("list_projects", "Список проектов.", {"type": "object", "properties": {}})
async def list_projects(args):
    return _text(store.list_projects())


@tool("create_project", "Создать проект.",
      {"type": "object", "properties": {"title": {"type": "string"}, "notes": {"type": "string"}},
       "required": ["title"]})
async def create_project(args):
    pid = store.create_project(args["title"], notes=args.get("notes", ""))
    return _text({"id": pid})


TOOLS = [list_tasks, create_task, update_task, complete_task, delete_task, list_projects, create_project]

# Tool names as Claude sees them, for allowed_tools.
TOOL_NAMES = [f"mcp__tasks__{t.name}" for t in TOOLS]

server = create_sdk_mcp_server("tasks", version="1.0.0", tools=TOOLS)
