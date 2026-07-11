from fastapi import APIRouter, Depends
from pydantic import BaseModel

from . import curator, skill_store
from .auth import require_auth

router = APIRouter(tags=["curator"], dependencies=[Depends(require_auth)])


class RollbackIn(BaseModel):
    snapshot: str


@router.get("/skills")
async def skills_list():
    return {"skills": skill_store.list_skills()}


@router.get("/skills/{name}")
async def skill_read(name: str):
    return skill_store.read_skill(name) or {"error": "не найдено"}


@router.get("/curator/state")
async def curator_state():
    return {
        "state": curator._load_state(),
        "snapshots": skill_store.list_snapshots(),
        "skills": len(skill_store.list_skills()),
    }


@router.post("/curator/run")
async def curator_run():
    summary = await curator.run_curator(manual=True)
    return {"summary": summary, "skills": skill_store.list_skills()}


@router.post("/curator/rollback")
async def curator_rollback(req: RollbackIn):
    return skill_store.rollback(req.snapshot)
