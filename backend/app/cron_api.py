from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from . import cron_store, scheduler
from .auth import require_auth

router = APIRouter(prefix="/cron", tags=["cron"], dependencies=[Depends(require_auth)])


class JobIn(BaseModel):
    name: str
    prompt: str
    schedule: str
    deliver: str = "telegram"
    repeat: int | None = None


class JobPatch(BaseModel):
    name: str | None = None
    prompt: str | None = None
    schedule: str | None = None
    deliver: str | None = None
    enabled: bool | None = None
    repeat: int | None = None


@router.get("")
async def jobs_list():
    return {"jobs": cron_store.list_jobs()}


@router.post("")
async def job_create(req: JobIn):
    try:
        return cron_store.create(**req.model_dump())
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.patch("/{jid}")
async def job_patch(jid: int, req: JobPatch):
    fields = {k: v for k, v in req.model_dump().items() if v is not None}
    try:
        job = cron_store.update(jid, **fields)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not job:
        raise HTTPException(404, "Не найдено")
    return job


@router.delete("/{jid}")
async def job_delete(jid: int):
    cron_store.delete(jid)
    return {"ok": True}


@router.post("/{jid}/run")
async def job_run_now(jid: int):
    job = cron_store.get(jid)
    if not job:
        raise HTTPException(404, "Не найдено")
    await scheduler.run_job(job)
    return cron_store.get(jid) or {"ok": True, "deleted": True}
