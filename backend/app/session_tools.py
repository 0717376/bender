"""In-process MCP tool exposing the session journal to the agent.

One tool, four shapes (mode inferred from arguments, Hermes-style):
  query=...                       → discovery: FTS search, best hit per session,
                                    each with session start/end bookends + a window
                                    around the match
  session_id=...                  → read a whole session (head + tail)
  session_id + around_message_id  → scroll a window around a message
  (no arguments)                  → browse recent sessions
"""

import json

from claude_agent_sdk import create_sdk_mcp_server, tool

from . import session_log


def _text(obj) -> dict:
    return {"content": [{"type": "text", "text": json.dumps(obj, ensure_ascii=False, default=str)}]}


@tool(
    "session_search",
    "Журнал прошлых разговоров (все сессии: веб и Telegram). Формы: "
    "query='слова' — полнотекстовый поиск (AND по умолчанию, OR, \"фраза\"; стемминга нет, "
    "поэтому русские слова ищи префиксом со звёздочкой: бейдж* найдёт «бейджем»), "
    "вернёт сессии с началом/концом и окном вокруг совпадения; "
    "session_id — прочитать сессию целиком; "
    "session_id + around_message_id — окно вокруг сообщения (листание); "
    "без аргументов — последние сессии. "
    "Ищи здесь, прежде чем переспрашивать пользователя о том, что уже обсуждалось.",
    {
        "type": "object",
        "properties": {
            "query": {"type": "string"},
            "session_id": {"type": "string"},
            "around_message_id": {"type": "integer"},
            "limit": {"type": "integer"},
        },
    },
)
async def session_search(args):
    limit = max(1, min(int(args.get("limit") or 5), 20))
    sid = args.get("session_id")
    if sid and args.get("around_message_id"):
        return _text(session_log.around(sid, int(args["around_message_id"])))
    if sid:
        return _text(session_log.read(sid))
    if args.get("query"):
        return _text(session_log.search(args["query"], limit=limit))
    return _text(session_log.browse(limit=limit))


TOOLS = [session_search]
TOOL_NAMES = [f"mcp__sessions__{t.name}" for t in TOOLS]

server = create_sdk_mcp_server("sessions", version="1.0.0", tools=TOOLS)
