"""Настройки MCP-доступа для фронтендов: показать/перевыпустить токен."""

from fastapi import APIRouter, Depends

from . import mcp_server
from .auth import require_auth

router = APIRouter(prefix="/api/mcp", tags=["mcp"])


@router.get("")
async def info(_: bool = Depends(require_auth)):
    return {"token": mcp_server.get_token()}


@router.post("/rotate")
async def rotate(_: bool = Depends(require_auth)):
    return {"token": mcp_server.rotate_token()}
