"""Ручки карточек: очередь повторения, заметки, колоды, статистика.

Приложение, бот и агент ходят в одно хранилище (cards_store), поэтому оценка, поставленная
в Telegram, видна в открытом приложении — оно узнаёт об изменении по /cards/events.
"""

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from . import cards_enrich as enrich
from . import cards_store as store
from .auth import check_token, require_auth

router = APIRouter(prefix="/cards", tags=["cards"], dependencies=[Depends(require_auth)])

# Поток событий — отдельным роутером без зависимости: EventSource не умеет слать
# заголовок Authorization, токен приезжает в query.
events_router = APIRouter(prefix="/cards", tags=["cards"])


class AnswerIn(BaseModel):
    rating: int
    duration: int = 0
    deck: int | None = None      # в какой колоде идёт сессия — чтобы следующая была из неё же


class SuspendIn(BaseModel):
    suspended: bool = True


class DeckIn(BaseModel):
    name: str | None = None
    descr: str | None = None
    new_per_day: int | None = None
    retention: float | None = None


class NoteIn(BaseModel):
    kind: str | None = None
    fields: dict | None = None
    deck: int | str | None = None
    tags: list[str] | None = None
    source: dict | None = None


class QuickIn(BaseModel):
    text: str
    context: str = ""
    book: dict | None = None
    cfi: str = ""
    ui: str = "ru"


def _bad(e: ValueError) -> HTTPException:
    return HTTPException(400, str(e))


def _session(deck: int | None = None) -> dict:
    """Состояние сессии повторения: что показать сейчас и сколько осталось."""
    return {"card": store.next_card(deck), "counts": store.counts(deck),
            "waiting": store.waiting(deck)}


@events_router.get("/events")
async def cards_events(request: Request, token: str = ""):
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
                yield {"event": "cards", "data": str(v)}
            await asyncio.sleep(1.5)

    return EventSourceResponse(gen())


@router.get("/overview")
async def overview():
    return store.overview()


@router.get("/stats")
async def stats(window: int = 182):
    return store.stats(max(7, min(730, window)))


@router.get("/settings")
async def get_settings():
    return store.settings()


@router.put("/settings")
async def put_settings(patch: dict):
    return store.save_settings(patch)


# ── Повторение ──

@router.get("/next")
async def next_card(deck: int | None = None):
    return _session(deck)


@router.post("/undo")
async def undo(deck: int | None = None):
    done = store.undo()
    if not done:
        raise HTTPException(404, "Отменять нечего")
    # Показываем ровно ту карточку, оценку которой отменили, а не «следующую по очереди».
    return {**_session(deck), "card": store.card(done["card_id"])}


@router.post("/{card_id}/answer")
async def answer(card_id: int, req: AnswerIn):
    try:
        res = store.answer(card_id, req.rating, req.duration, src="web")
    except ValueError as e:
        raise _bad(e)
    if not res:
        raise HTTPException(404, "Карточка не найдена")
    return {"result": res, **_session(req.deck)}


@router.post("/{card_id}/suspend")
async def suspend(card_id: int, req: SuspendIn):
    if not store.set_suspended(card_id, req.suspended):
        raise HTTPException(404, "Карточка не найдена")
    return {"ok": True}


# ── Колоды ──

@router.get("/decks")
async def decks():
    return [{**d, "counts": store.counts(d["id"])} for d in store.decks()]


@router.post("/decks")
async def create_deck(req: DeckIn):
    try:
        return store.create_deck(req.name or "", req.descr or "", req.new_per_day, req.retention)
    except ValueError as e:
        raise _bad(e)


@router.patch("/decks/{deck_id}")
async def update_deck(deck_id: int, req: DeckIn):
    d = store.update_deck(deck_id, **req.model_dump())
    if not d:
        raise HTTPException(404, "Колода не найдена")
    return d


@router.delete("/decks/{deck_id}")
async def delete_deck(deck_id: int):
    if not store.delete_deck(deck_id):
        raise HTTPException(404, "Колода не найдена")
    return {"ok": True}


# ── Заметки ──

@router.get("/notes")
async def notes(q: str = "", deck: int | None = None, status: str = "", leech: bool = False,
                limit: int = 100, offset: int = 0):
    return store.list_notes(q=q, deck_id=deck, status=status, leech=leech, limit=limit, offset=offset)


@router.post("/notes")
async def create_note(req: NoteIn):
    try:
        return store.create_note(req.kind or "basic", req.fields or {}, deck=req.deck,
                                 source=req.source, tags=req.tags)
    except ValueError as e:
        raise _bad(e)


@router.get("/notes/{note_id}")
async def get_note(note_id: int):
    n = store.note(note_id)
    if not n:
        raise HTTPException(404, "Карточка не найдена")
    return {**n, "cards": store.note_cards(note_id)}


@router.patch("/notes/{note_id}")
async def update_note(note_id: int, req: NoteIn):
    try:
        n = store.update_note(note_id, fields=req.fields, kind=req.kind, deck=req.deck, tags=req.tags)
    except ValueError as e:
        raise _bad(e)
    if not n:
        raise HTTPException(404, "Карточка не найдена")
    return {**n, "cards": store.note_cards(note_id)}


@router.delete("/notes/{note_id}")
async def delete_note(note_id: int):
    if not store.delete_note(note_id):
        raise HTTPException(404, "Карточка не найдена")
    return {"ok": True}


@router.post("/notes/{note_id}/retry")
async def retry_note(note_id: int):
    """Заполнение не удалось — попросить агента ещё раз."""
    n = store.redraft_note(note_id)
    if not n:
        raise HTTPException(404, "Карточка не найдена")
    if n["status"] == "draft":
        enrich.enqueue(note_id)
    return n


@router.post("/quick")
async def quick(req: QuickIn):
    """Одна кнопка из читалки: черновик заводится сразу, поля дописывает агент в фоне."""
    try:
        return enrich.quick(req.text, req.context, req.book, req.cfi, req.ui)
    except ValueError as e:
        raise _bad(e)
