"""In-process SDK MCP tools to manage scheduled jobs from chat (`mcp__cron__*`).

These are available in interactive turns only — NOT inside cron runs themselves
(anti-recursion: a scheduled job must not schedule more jobs).
"""

import json

from claude_agent_sdk import create_sdk_mcp_server, tool

from . import cron_store as store


def _text(obj) -> dict:
    return {"content": [{"type": "text", "text": json.dumps(obj, ensure_ascii=False, default=str)}]}


_SCHEDULE_DESC = (
    "Когда сработать. Форматы:\n"
    "• '5m' / '2h' / '1d' — ОДИН РАЗ через N минут/часов/дней (для «напомни через…»);\n"
    "• '2026-06-28T07:50' — один раз в конкретный момент (ISO; относительные даты переводи сам);\n"
    "• 'every 30m' / 'every 2h' — повторяющийся интервал;\n"
    "• '0 9 * * *' — cron (минута час день месяц день_недели), напр. каждый день в 9:00.\n"
    "Разовые задачи срабатывают один раз и сами удаляются — НЕ нужно их потом чистить."
)


@tool(
    "create_job",
    "Запланировать задачу: что агент должен сделать при срабатывании (prompt) и когда (schedule). "
    "Результат по умолчанию уходит в Telegram. Для «напомни/сделай через N / в момент времени» — "
    "это разовая задача (schedule вида '5m' или ISO), она исполнится один раз и удалится сама. "
    "В prompt описывай ТОЛЬКО что искать/делать и формат ответа. Правила «не повторяться», "
    "«молчать, если нет нового» и «остановиться после финала события» система добавляет сама "
    "(каждый запуск видит выводы предыдущих) — НЕ вписывай в prompt требования всегда "
    "что-нибудь присылать: это ломает подавление повторов.",
    {
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "prompt": {"type": "string"},
            "schedule": {"type": "string", "description": _SCHEDULE_DESC},
            "repeat": {"type": "integer", "description": "Сколько раз выполнить (необяз.). "
                       "По умолчанию: разовые — 1, повторяющиеся — бесконечно."},
            "deliver": {"type": "string", "enum": ["telegram", "silent"]},
        },
        "required": ["name", "prompt", "schedule"],
    },
)
async def create_job(args):
    try:
        job = store.create(
            name=args["name"], prompt=args["prompt"], schedule=args["schedule"],
            deliver=args.get("deliver", "telegram"), repeat=args.get("repeat"),
        )
        return _text(job)
    except ValueError as e:
        return _text({"error": str(e)})


@tool("list_jobs", "Список регулярных задач (с расписанием и временем следующего запуска).",
      {"type": "object", "properties": {}})
async def list_jobs(args):
    return _text(store.list_jobs())


@tool(
    "update_job",
    "Изменить задачу по id: name, prompt, schedule, repeat, deliver, enabled (вкл/выкл).",
    {
        "type": "object",
        "properties": {
            "id": {"type": "integer"},
            "name": {"type": "string"},
            "prompt": {"type": "string"},
            "schedule": {"type": "string", "description": _SCHEDULE_DESC},
            "repeat": {"type": "integer"},
            "deliver": {"type": "string", "enum": ["telegram", "silent"]},
            "enabled": {"type": "boolean"},
        },
        "required": ["id"],
    },
)
async def update_job(args):
    jid = args.pop("id")
    try:
        res = store.update(jid, **args)
        return _text(res or {"error": "not found"})
    except ValueError as e:
        return _text({"error": str(e)})


@tool("delete_job", "Удалить регулярную задачу по id.",
      {"type": "object", "properties": {"id": {"type": "integer"}}, "required": ["id"]})
async def delete_job(args):
    store.delete(args["id"])
    return _text({"ok": True})


TOOLS = [create_job, list_jobs, update_job, delete_job]
TOOL_NAMES = [f"mcp__cron__{t.name}" for t in TOOLS]

server = create_sdk_mcp_server("cron", version="1.0.0", tools=TOOLS)
