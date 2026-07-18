import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from . import tasks_store as store
from .auth import check_token, require_auth

router = APIRouter(prefix="/tasks", tags=["tasks"], dependencies=[Depends(require_auth)])

# SSE lives on its own router with NO auth dependency — EventSource can't send an
# Authorization header, so it authenticates via a ?token= query param instead.
events_router = APIRouter(prefix="/tasks", tags=["tasks"])


# --- Schemas ---

class TaskIn(BaseModel):
    title: str
    notes: str = ""
    when: str | None = None
    deadline: str | None = None
    project: str | int | None = None
    area_id: int | None = None
    tags: list[str] | None = None
    repeat: dict | None = None  # {unit, interval, mode}
    kind: str = "task"  # 'heading' = section divider inside a project


class TaskPatch(BaseModel):
    title: str | None = None
    notes: str | None = None
    when: str | None = None
    deadline: str | None = None
    project: str | int | None = None
    area_id: int | None = None
    tags: list[str] | None = None
    status: str | None = None
    sort: float | None = None
    repeat: dict | None = None  # {} clears the rule (None = field untouched)
    # area_id: -1 detaches the task from its area (None = field untouched)


class ProjectIn(BaseModel):
    title: str
    notes: str = ""
    area_id: int | None = None


class ProjectPatch(BaseModel):
    title: str | None = None
    notes: str | None = None
    area_id: int | None = None  # use -1 to detach from its area
    status: str | None = None


class AreaIn(BaseModel):
    title: str


class ChecklistIn(BaseModel):
    title: str


class ToggleIn(BaseModel):
    done: bool


class ReorderIn(BaseModel):
    ids: list[int]


# --- Overview ---

@router.get("/overview")
async def overview():
    return {
        "counts": store.counts(),
        "projects": store.list_projects(),
        "areas": store.list_areas(),
        "progress": store.project_progress(),
    }


@router.get("/search")
async def tasks_search(q: str):
    return {"tasks": store.search_tasks(q) if q.strip() else []}


@router.post("/reorder")
async def tasks_reorder(req: ReorderIn):
    store.reorder_tasks(req.ids)
    return {"ok": True}


# --- Live sync (SSE): emit a tick whenever the data version changes ---

@events_router.get("/events")
async def tasks_events(request: Request, token: str = ""):
    if not check_token(token):
        raise HTTPException(401, "Unauthorized")

    async def gen():
        last = -1
        while True:
            if await request.is_disconnected():
                break
            v = store.version()
            if v != last:
                last = v
                yield {"event": "tasks", "data": str(v)}
            await asyncio.sleep(1.5)

    return EventSourceResponse(gen())


# --- Tasks ---

@router.get("")
async def tasks_list(view: str | None = None, project_id: int | None = None,
                     area_id: int | None = None, q: str | None = None, tag: str | None = None):
    return {"tasks": store.list_tasks(view=view, project_id=project_id, area_id=area_id, q=q, tag=tag)}


@router.get("/{task_id}")
async def task_get(task_id: int):
    t = store.get_task(task_id)
    if not t:
        raise HTTPException(404, "Не найдено")
    return t


@router.post("")
async def task_create(req: TaskIn):
    return store.create_task(**req.model_dump())


@router.patch("/{task_id}")
async def task_patch(task_id: int, req: TaskPatch):
    fields = {k: v for k, v in req.model_dump().items() if v is not None}
    if fields.get("area_id") == -1:
        fields["area_id"] = None
    t = store.update_task(task_id, **fields)
    if not t:
        raise HTTPException(404, "Не найдено")
    return t


@router.post("/{task_id}/complete")
async def task_complete(task_id: int, req: ToggleIn):
    t = store.complete_task(task_id, done=req.done)
    if not t:
        raise HTTPException(404, "Не найдено")
    return t


@router.delete("/{task_id}")
async def task_delete(task_id: int):
    store.delete_task(task_id)
    return {"ok": True}


@router.post("/{task_id}/restore")
async def task_restore(task_id: int):
    t = store.restore_task(task_id)
    if not t:
        raise HTTPException(404, "Не найдено")
    return t


# --- Checklist ---

@router.post("/{task_id}/checklist")
async def checklist_add(task_id: int, req: ChecklistIn):
    return {"id": store.add_checklist(task_id, req.title)}


@router.post("/checklist/{item_id}/toggle")
async def checklist_toggle(item_id: int, req: ToggleIn):
    store.toggle_checklist(item_id, req.done)
    return {"ok": True}


@router.delete("/checklist/{item_id}")
async def checklist_delete(item_id: int):
    store.delete_checklist(item_id)
    return {"ok": True}


# --- Projects / Areas ---

@router.post("/projects")
async def project_create(req: ProjectIn):
    return {"id": store.create_project(req.title, area_id=req.area_id, notes=req.notes)}


@router.patch("/projects/{project_id}")
async def project_patch(project_id: int, req: ProjectPatch):
    fields = {k: v for k, v in req.model_dump().items() if v is not None}
    if fields.get("area_id") == -1:
        fields["area_id"] = None
    p = store.update_project(project_id, **fields)
    if not p:
        raise HTTPException(404, "Не найдено")
    return p


@router.post("/areas")
async def area_create(req: AreaIn):
    return {"id": store.create_area(req.title)}


@router.patch("/areas/{area_id}")
async def area_patch(area_id: int, req: AreaIn):
    a = store.update_area(area_id, req.title)
    if not a:
        raise HTTPException(404, "Не найдено")
    return a


@router.delete("/areas/{area_id}")
async def area_delete(area_id: int):
    store.delete_area(area_id)
    return {"ok": True}
