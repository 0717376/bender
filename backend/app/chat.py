import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from . import agent, config, curator
from .auth import check_token

logger = logging.getLogger("wiki.chat")
router = APIRouter()


def with_context(message: str, context: dict) -> str:
    path = (context or {}).get("path")
    selection = ((context or {}).get("selection") or "")[:4000]
    if not path and not selection:
        return message
    lines = ["[Контекст: где сейчас находится пользователь]"]
    if path:
        lines.append(f"Открытая страница: {path}")
    if selection:
        lines.append("Выделенный фрагмент страницы:\n<<<\n" + selection + "\n>>>")
    lines.append("")
    lines.append(message)
    return "\n".join(lines)


@router.websocket("/chat/ws")
async def chat_ws(ws: WebSocket, token: str = "", surface: str = "wiki"):
    if not check_token(token):
        await ws.close(code=4001, reason="Unauthorized")
        return
    if surface not in config.SURFACES:
        surface = "wiki"
    await ws.accept()
    logger.info("WS connected (surface=%s)", surface)

    async def emit(payload: dict) -> None:
        await ws.send_json(payload)

    try:
        while True:
            raw = await ws.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if data.get("type") != "message":
                continue
            message = data.get("text", "").strip()
            if not message:
                continue
            curator.mark_activity()

            # Session control handled by the backend.
            if message in ("/clear", "/new"):
                agent.clear_session()
                await emit({"t": "text", "id": "sys", "text": "Начал новую сессию. Прошлый разговор сохранён в журнале."})
                await emit({"t": "done", "sid": None})
                continue

            try:
                await agent.run_ws(emit, with_context(message, data.get("context") or {}), surface)
            except WebSocketDisconnect:
                raise
            except Exception as e:  # noqa: BLE001
                logger.error("run_ws error: %s", e)
                await emit({"t": "error", "text": str(e)})
                await emit({"t": "done", "sid": agent.load_session()})

    except WebSocketDisconnect:
        logger.info("WS disconnected")
    except Exception as e:  # noqa: BLE001
        logger.error("WS error: %s", e)
