"""Книги для агента: он видит книгу целиком, а не присланный кусок.

Читалка присылает цитату и абзац вокруг — этого хватает «перевести» и «объяснить», но
не хватает «где ещё об этом». Текст глав уже лежит на диске (books/<id>/text), поэтому
инструменты только читают: писать в книгу агенту нечего.

Встроенному агенту достаются как `mcp__books__*`, внешним клиентам — теми же функциями
через MCP-сервер (books_* в mcp_server).
"""

import json
import time

from claude_agent_sdk import create_sdk_mcp_server, tool
from fastapi import HTTPException

from . import books_api, books_store

# Цвет выписки — это её смысл (см. фронтенд читалки): агенту нужны названия, а не 'imp'.
COLORS = {"imp": "Важное", "no": "Не согласен", "q": "Вопрос",
          "wiki": "В вики", "nice": "Красиво сказано"}

CHUNK = 12000       # столько текста главы отдаём за раз, дальше — по offset


# ── Общая начинка (её же зовёт внешний MCP-сервер) ──


def catalog() -> list[dict]:
    """Полка глазами агента: без обложек и размеров, зато с прогрессом."""
    out = []
    for m in books_api.catalog():
        pos = m.get("position") or {}
        out.append({
            "id": m.get("id"), "title": m.get("title"), "author": m.get("author"),
            "chapters": m.get("chapters"), "highlights": m.get("highlights", 0),
            "read_pct": round((pos.get("pct") or 0) * 100),
            "reading_chapter": pos.get("chapter") or "",
        })
    return out


def read(book_id: str, chapter: int, offset: int = 0, limit: int = CHUNK) -> dict:
    text = books_api.chapter_text(book_id, chapter)
    titles = {c["n"]: c["title"] for c in books_api.chapters(book_id)}
    start = max(0, int(offset or 0))
    end = start + max(1, min(int(limit or CHUNK), CHUNK))
    return {
        "chapter": chapter, "title": titles.get(chapter, ""), "chars": len(text),
        "offset": start, "text": text[start:end],
        "more": end < len(text), "next_offset": end if end < len(text) else None,
    }


def highlights(book_id: str, color: str | None = None) -> list[dict]:
    out = []
    for h in books_store.highlights(book_id):
        if color and h["color"] != color:
            continue
        item = {"text": h["text"], "meaning": COLORS.get(h["color"], h["color"]),
                "chapter": h["chapter"], "date": _day(h["created"])}
        if h.get("note"):
            item["note"] = h["note"]       # своими словами — ценнее всей ветки разговора
        if h["thread"]:
            item["talk"] = [{"role": t.get("role"), "text": t.get("text")} for t in h["thread"]]
        out.append(item)
    return out


def _day(ms: int | None) -> str:
    return time.strftime("%Y-%m-%d", time.localtime((ms or 0) / 1000)) if ms else ""


# ── Инструменты встроенного агента ──


def _text(obj) -> dict:
    return {"content": [{"type": "text", "text": json.dumps(obj, ensure_ascii=False, default=str)}]}


def _fail(e: HTTPException) -> dict:
    return _text({"error": e.detail})


@tool(
    "list_books",
    "Книги в библиотеке: id, название, автор, число глав, прогресс чтения и число выписок. "
    "id нужен всем остальным инструментам книг.",
    {"type": "object", "properties": {}},
)
async def list_books(args):
    return _text(catalog())


@tool(
    "book_chapters",
    "Оглавление книги: номер главы, название и длина в знаках. По номеру читают главу "
    "(read_chapter); названия те же, что видит пользователь в читалке.",
    {"type": "object", "properties": {"book_id": {"type": "string"}}, "required": ["book_id"]},
)
async def book_chapters(args):
    try:
        return _text(books_api.chapters(args["book_id"]))
    except HTTPException as e:
        return _fail(e)


@tool(
    "read_chapter",
    f"Текст главы книги (номер — из book_chapters). Отдаётся кусками до {CHUNK} знаков: "
    "если в ответе more=true, следующий кусок — тем же вызовом с offset=next_offset.",
    {
        "type": "object",
        "properties": {
            "book_id": {"type": "string"},
            "chapter": {"type": "integer", "description": "номер главы из book_chapters"},
            "offset": {"type": "integer", "description": "с какого знака читать, по умолчанию 0"},
            "limit": {"type": "integer", "description": f"сколько знаков вернуть, максимум {CHUNK}"},
        },
        "required": ["book_id", "chapter"],
    },
)
async def read_chapter(args):
    try:
        return _text(read(args["book_id"], args["chapter"],
                          args.get("offset") or 0, args.get("limit") or CHUNK))
    except HTTPException as e:
        return _fail(e)


@tool(
    "search_book",
    "Поиск по тексту книги: номер главы, название и фрагмент вокруг совпадения. "
    "Этим и отвечают на «где ещё об этом» — не по памяти.",
    {
        "type": "object",
        "properties": {
            "book_id": {"type": "string"},
            "query": {"type": "string", "description": "слово или фраза, регистр не важен"},
            "regex": {"type": "boolean", "description": "искать регулярным выражением"},
            "limit": {"type": "integer", "description": "сколько совпадений вернуть, по умолчанию 20"},
        },
        "required": ["book_id", "query"],
    },
)
async def search_book(args):
    try:
        return _text(books_api.search(args["book_id"], args["query"],
                                      regex=bool(args.get("regex")),
                                      limit=max(1, min(int(args.get("limit") or 20), 100))))
    except HTTPException as e:
        return _fail(e)


@tool(
    "list_highlights",
    "Выписки пользователя из книги: цитата, цвет-смысл (Важное, Не согласен, Вопрос, "
    "В вики, Красиво сказано), глава, дата, своя заметка и разговор о ней, если он был.",
    {
        "type": "object",
        "properties": {
            "book_id": {"type": "string"},
            "color": {"type": "string", "enum": sorted(COLORS), "description": "фильтр по цвету"},
        },
        "required": ["book_id"],
    },
)
async def list_highlights(args):
    return _text(highlights(args["book_id"], args.get("color")))


@tool(
    "reading_stats",
    "Статистика чтения: по дням (сколько минут и выписок), по книгам, серия дней подряд "
    "и рекорд. tz — сдвиг часового пояса читателя в минутах, window — за сколько дней.",
    {
        "type": "object",
        "properties": {
            "tz": {"type": "integer", "description": "минуты от UTC, например 180 для Москвы"},
            "window": {"type": "integer", "description": "за сколько последних дней, по умолчанию 182"},
        },
    },
)
async def reading_stats(args):
    st = books_api.reading_stats(int(args.get("tz") or 0), "", int(args.get("window") or 182))
    # Дни отдаём в минутах: агенту незачем считать секунды, а строк меньше.
    return _text({
        "today": st["today"], "totals": {**st["totals"], "minutes": round(st["totals"]["secs"] / 60)},
        "books": [{**b, "minutes": round(b["secs"] / 60)} for b in st["books"]],
        "days": [{"day": d["day"], "minutes": round(d["secs"] / 60), "highlights": d["highlights"]}
                 for d in st["days"]],
    })


TOOLS = [list_books, book_chapters, read_chapter, search_book, list_highlights, reading_stats]

TOOL_NAMES = [f"mcp__books__{t.name}" for t in TOOLS]

server = create_sdk_mcp_server("books", version="1.0.0", tools=TOOLS)
