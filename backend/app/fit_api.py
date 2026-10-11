"""Ручки тренировок: дневник, программа, упражнения, прогресс.

Приложение и агент ходят в одно хранилище (fit_store): тренировка, которую агент записал
со слов в Telegram, появляется в открытом приложении — оно узнаёт о ней по /fit/events.
"""

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from . import fit_oura as oura
from . import fit_store as store
from .auth import check_token, require_auth

router = APIRouter(prefix="/fit", tags=["fit"], dependencies=[Depends(require_auth)])

# Поток событий — отдельным роутером без зависимости: EventSource не умеет слать
# заголовок Authorization, токен приезжает в query.
events_router = APIRouter(prefix="/fit", tags=["fit"])

_background: set[asyncio.Task] = set()


class StartIn(BaseModel):
    kind: str = "strength"
    program_day_id: int | None = None
    title: str = ""
    uid: str = ""
    at: int | None = None        # когда начали на самом деле: запрос мог ждать связи


class SetIn(BaseModel):
    exercise_id: int | None = None
    weight: float | None = None
    reps: int | None = None
    rir: int | None = None
    warm: bool | None = None
    uid: str = ""
    at: int | None = None


class SessionIn(BaseModel):
    title: str | None = None
    note: str | None = None
    feel: int | None = None
    kind: str | None = None
    day: str | None = None
    duration: int | None = None
    distance: float | None = None
    calories: float | None = None


class FinishIn(BaseModel):
    feel: int | None = None
    note: str | None = None
    at: int | None = None


class ExerciseIn(BaseModel):
    name: str | None = None
    name_en: str | None = None
    muscle: str | None = None
    also: list[str] | None = None
    equipment: str | None = None
    kind: str | None = None
    step: float | None = None
    note: str | None = None
    archived: bool | None = None


class ConnectIn(BaseModel):
    origin: str      # адрес, с которого открыто приложение: на него Oura вернёт человека


class BodyIn(BaseModel):
    weight: float
    day: str | None = None
    note: str = ""


def _bad(e: ValueError) -> HTTPException:
    return HTTPException(400, str(e))


def _found(v, what: str = "Тренировка"):
    if v is None or v is False:
        raise HTTPException(404, f"{what} не найдена")
    return v


@events_router.get("/events")
async def fit_events(request: Request, token: str = ""):
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
                yield {"event": "fit", "data": str(v)}
            await asyncio.sleep(1.5)

    return EventSourceResponse(gen())


@router.get("/overview")
async def overview():
    return store.overview()


@router.get("/settings")
async def get_settings():
    return store.settings()


@router.put("/settings")
async def put_settings(patch: dict):
    try:
        return store.save_settings(patch)
    except (ValueError, TypeError) as e:
        raise HTTPException(400, str(e))


# ── Тренировки ──

@router.get("/sessions")
async def sessions(limit: int = 30, offset: int = 0, since: str = "", until: str = "",
                   kind: str = ""):
    return store.sessions(limit, offset, since, until, kind)


@router.post("/sessions")
async def start(req: StartIn):
    try:
        return store.start_session(req.kind, req.program_day_id, req.title, req.uid, req.at)
    except ValueError as e:
        raise _bad(e)


@router.post("/sessions/log")
async def log(data: dict):
    """Записать тренировку целиком задним числом: кардио, бассейн, силовую по памяти."""
    try:
        return store.log_session(data)
    except (ValueError, TypeError) as e:
        raise HTTPException(400, str(e))


@router.get("/sessions/{session_id}")
async def get_session(session_id: int):
    s = _found(store.session(session_id))
    return {**s, "records": store.records(session_id)}


@router.patch("/sessions/{session_id}")
async def update_session(session_id: int, req: SessionIn):
    try:
        return _found(store.update_session(session_id, **req.model_dump()))
    except ValueError as e:
        raise _bad(e)


@router.post("/sessions/{session_id}/finish")
async def finish(session_id: int, req: FinishIn):
    s = _found(store.finish_session(session_id, req.feel, req.note, req.at))
    return {**s, "records": store.records(session_id)}


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: int):
    _found(store.delete_session(session_id))
    return {"ok": True}


@router.post("/sessions/{session_id}/sets")
async def add_set(session_id: int, req: SetIn):
    try:
        return _found(store.add_set(session_id, req.exercise_id, req.weight, req.reps, req.rir,
                                    bool(req.warm), req.uid, req.at))
    except ValueError as e:
        raise _bad(e)


@router.patch("/sets/{set_id}")
async def update_set(set_id: int, req: SetIn):
    try:
        return _found(store.update_set(set_id, req.weight, req.reps, req.rir, req.warm), "Запись")
    except ValueError as e:
        raise _bad(e)


@router.delete("/sets/{set_id}")
async def delete_set(set_id: int):
    return _found(store.delete_set(set_id), "Запись")


# ── Программа ──

@router.get("/program")
async def program():
    return store.program()


@router.put("/program")
async def set_program(data: dict):
    try:
        return store.set_program(data)
    except (ValueError, TypeError) as e:
        raise HTTPException(400, str(e))


@router.get("/program/days/{day_id}")
async def plan(day_id: int, exclude: int | None = None, easy: bool = False):
    return _found(store.plan_for(day_id, exclude, easy), "Запись")


# ── Упражнения ──

@router.get("/exercises")
async def exercises(q: str = "", muscle: str = "", archived: bool = False):
    return store.exercises(q, muscle, archived)


@router.post("/exercises")
async def create_exercise(req: ExerciseIn):
    try:
        return store.create_exercise(req.name or "", req.muscle or "", req.also,
                                     req.equipment or "other", req.kind or "strength",
                                     req.step, req.name_en or "", req.note or "")
    except ValueError as e:
        raise _bad(e)


@router.patch("/exercises/{ex_id}")
async def update_exercise(ex_id: int, req: ExerciseIn):
    try:
        return _found(store.update_exercise(ex_id, **req.model_dump()), "Запись")
    except ValueError as e:
        raise _bad(e)


@router.get("/exercises/{ex_id}/progress")
async def progress(ex_id: int, limit: int = 60):
    try:
        return store.progress(ex_id, max(1, min(500, limit)))
    except ValueError:
        raise HTTPException(404, "Запись не найдена")


# ── Прогресс и вес ──

@router.get("/weeks")
async def weeks(n: int = 12):
    return store.weeks(n)


@router.get("/body")
async def body(limit: int = 365):
    return store.body(max(1, min(3650, limit)))


@router.post("/body")
async def log_body(req: BodyIn):
    try:
        return store.log_body(req.weight, req.day, req.note)
    except ValueError as e:
        raise _bad(e)


@router.delete("/body/{day}")
async def delete_body(day: str):
    _found(store.delete_body(day), "Запись")
    return {"ok": True}


# ── Кольцо ──

@router.get("/oura")
async def oura_status():
    return oura.status()


@router.post("/oura/connect")
async def oura_connect(req: ConnectIn):
    try:
        return {"url": oura.connect_url(req.origin)}
    except ValueError as e:
        raise _bad(e)


@events_router.get("/oura/callback")
async def oura_callback(code: str = "", state: str = "", error: str = ""):
    """Сюда Oura возвращает человека после согласия. Заголовка с токеном у браузера в этот
    момент нет, поэтому ручка без авторизации: пропуском служит одноразовый state,
    который мы сами выдали минуту назад."""
    try:
        if error or not code:
            raise ValueError(error or "Oura не прислала код")
        origin = await oura.finish_connect(code, state)
    except (ValueError, oura.NeedLogin) as e:
        raise HTTPException(400, str(e))
    # История за три месяца — в фоне: человек уже вернулся в приложение и видит, как она едет.
    _background.add(t := asyncio.create_task(oura.sync(oura.BACKFILL_DAYS)))
    t.add_done_callback(_background.discard)
    return RedirectResponse(origin + "/#/settings")


@router.post("/oura/sync")
async def oura_sync():
    return await oura.sync()


@router.delete("/oura")
async def oura_disconnect():
    oura.disconnect()
    return oura.status()


@router.get("/recovery")
async def recovery(days: int = 30):
    return {**store.recovery(), "days": store.oura_days(max(1, min(400, days)))}
