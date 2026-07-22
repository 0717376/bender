"""MCP tool letting the agent send a file to the user in Telegram.

Standalone httpx call (not telegram.py helpers) to avoid a circular import:
telegram imports agent, agent imports this module. Private bot: the allowlist
doubles as the chat list, same as telegram.notify().
"""

import json
import os

import httpx
from claude_agent_sdk import create_sdk_mcp_server, tool

from . import config

TG_FILE_CAP = 50 * 1024 * 1024  # Bot API sendDocument limit


def _resolve(path: str) -> str | None:
    p = path if os.path.isabs(path) else os.path.join(config.FILES_DIR, path)
    p = os.path.realpath(p)
    roots = [os.path.realpath(d) for d in (config.FILES_DIR, config.WIKI_DIR, config.TG_MEDIA_DIR)]
    if any(p == r or p.startswith(r + os.sep) for r in roots):
        return p
    return None


def _text(obj) -> dict:
    return {"content": [{"type": "text", "text": json.dumps(obj, ensure_ascii=False)}]}


@tool(
    "send_file",
    "Отправить файл пользователю в Telegram документом. path — путь относительно "
    "файлового хранилища (Документы/скан.pdf) или абсолютный. caption — подпись "
    "(необязательно). Используй, когда пользователь просит прислать/скинуть файл.",
    {
        "type": "object",
        "properties": {"path": {"type": "string"}, "caption": {"type": "string"}},
        "required": ["path"],
    },
)
async def send_file(args):
    if not config.TELEGRAM_BOT_TOKEN or not config.TELEGRAM_ALLOWED_IDS:
        return _text({"error": "Telegram-бот не настроен"})
    abs_path = _resolve(args["path"])
    if not abs_path or not os.path.isfile(abs_path):
        return _text({"error": f"файл не найден: {args['path']}"})
    size = os.path.getsize(abs_path)
    if size > TG_FILE_CAP:
        return _text({"error": f"файл больше лимита Telegram (50 МБ): {size} байт"})
    sent = 0
    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as client:
        for chat_id in config.TELEGRAM_ALLOWED_IDS:
            with open(abs_path, "rb") as f:
                data = {"chat_id": str(chat_id)}
                if args.get("caption"):
                    data["caption"] = str(args["caption"])[:1000]
                r = await client.post(
                    f"{config.TG_API}/sendDocument",
                    data=data,
                    files={"document": (os.path.basename(abs_path), f)},
                )
            if r.status_code == 200 and r.json().get("ok"):
                sent += 1
    if not sent:
        return _text({"error": "не удалось отправить"})
    return _text({"ok": True, "file": os.path.basename(abs_path), "size": size})


TOOLS = [send_file]
TOOL_NAMES = [f"mcp__tg__{t.name}" for t in TOOLS]

server = create_sdk_mcp_server("tg", version="1.0.0", tools=TOOLS)
