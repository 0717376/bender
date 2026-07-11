import httpx
from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile

from . import config
from .auth import require_auth

router = APIRouter(prefix="/api/asr", tags=["asr"])


@router.post("/transcribe")
async def transcribe(audio: UploadFile, model_id: str = Form(config.ASR_MODEL), _: bool = Depends(require_auth)):
    if not config.ASR_UPSTREAM:
        raise HTTPException(503, "Распознавание речи не настроено")
    content = await audio.read()
    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(
            config.ASR_UPSTREAM,
            files={"audio": (audio.filename or "recording.webm", content, audio.content_type or "audio/webm")},
            data={"model_id": model_id},
        )
    if resp.status_code != 200:
        raise HTTPException(resp.status_code, "Ошибка распознавания речи")
    return resp.json()
