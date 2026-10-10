"""Карточки для агента: завести колоду, добавить карточки, найти и поправить.

Повторяет человек сам — в приложении или кнопками в боте, — поэтому оценок агент не ставит:
его дело — хорошие карточки и ответ на «сколько у меня сегодня».
"""

import json

from claude_agent_sdk import create_sdk_mcp_server, tool

from . import cards_store as store


def _text(obj) -> dict:
    return {"content": [{"type": "text", "text": json.dumps(obj, ensure_ascii=False, default=str)}]}


def brief(n: dict) -> dict:
    """Заметка для агента: поля и состояние без служебных подробностей планировщика."""
    cards = store.note_cards(n["id"])
    return {"id": n["id"], "deck_id": n["deck_id"], "kind": n["kind"], "fields": n["fields"],
            "tags": n["tags"], "status": n["status"],
            "suspended": bool(cards) and all(c["suspended"] for c in cards),
            "leech": any(c["leech"] for c in cards),
            **({"error": n["error"]} if n["error"] else {}),
            **({"book": n["source"]["title"]} if n["source"].get("title") else {})}


def add(notes: list[dict], deck=None) -> dict:
    """Добавить пачку заметок. Ошибка в одной не роняет остальные — о ней будет сказано."""
    added, errors = [], []
    for i, n in enumerate(notes or []):
        try:
            made = store.create_note(n.get("kind") or "basic", n.get("fields") or {},
                                     deck=n.get("deck", deck), tags=n.get("tags"),
                                     source=n.get("source"))
            added.append({"id": made["id"], "kind": made["kind"]})
        except ValueError as e:
            errors.append({"index": i, "error": str(e)})
    return {"added": added, **({"errors": errors} if errors else {})}


def due() -> dict:
    o = store.overview()
    return {"due": o["due"], "streak": o["streak"], "reviewed_today": o["today"]["n"],
            "inbox": o["inbox"], "leeches": o["leeches"],
            "decks": [{"id": d["id"], "name": d["name"], "cards": d["cards"], **d["counts"]}
                      for d in o["decks"]]}


@tool("list_decks", "Колоды карточек: сколько в каждой карточек и сколько сегодня к повторению.", {})
async def list_decks(args):
    return _text(due()["decks"])


@tool(
    "create_deck",
    "Завести колоду. new_per_day — сколько новых карточек вводить в день (по умолчанию 15), "
    "retention — целевая доля вспоминаемого, 0.7…0.97 (по умолчанию 0.9).",
    {"type": "object",
     "properties": {"name": {"type": "string"}, "descr": {"type": "string"},
                    "new_per_day": {"type": "integer"}, "retention": {"type": "number"}},
     "required": ["name"]},
)
async def create_deck(args):
    try:
        return _text(store.create_deck(args["name"], args.get("descr", ""),
                                       args.get("new_per_day"), args.get("retention")))
    except ValueError as e:
        return _text({"error": str(e)})


@tool(
    "add_notes",
    "Добавить карточки пачкой. deck — название или id колоды (новое название заводит колоду; "
    "без него слова идут в «Слова», остальное в «Разное»). notes — список, у каждой kind и fields:\n"
    "• word — иностранное слово: word (в начальной форме), meaning (значение коротко), и по возможности form (как в тексте), ipa, "
    "pos, other (другие значения), example (предложение со словом), example_tr, lang. "
    "Даёт две карточки: узнать слово и вспомнить его по значению.\n"
    "• basic — вопрос и ответ: front, back, по желанию extra; reverse=true добавит обратную.\n"
    "• cloze — фраза с пропусками: text вида «Столица {{c1::Франции}} — {{c2::Париж}}», "
    "на каждый номер своя карточка; подсказка — {{c1::ответ::подсказка}}.\n"
    "У заметки могут быть tags.",
    {"type": "object",
     "properties": {
         "deck": {"type": "string"},
         "notes": {"type": "array", "items": {
             "type": "object",
             "properties": {"kind": {"type": "string", "enum": list(store.KINDS)},
                            "fields": {"type": "object"},
                            "tags": {"type": "array", "items": {"type": "string"}}},
             "required": ["kind", "fields"]}}},
     "required": ["notes"]},
)
async def add_notes(args):
    return _text(add(args.get("notes") or [], args.get("deck")))


@tool(
    "search_notes",
    "Найти карточки. q — строка по полям и тегам, deck_id — колода, status: ready | inbox "
    "(черновики и незаполнившиеся), leech=true — те, что не даются и требуют переделки.",
    {"type": "object",
     "properties": {"q": {"type": "string"}, "deck_id": {"type": "integer"},
                    "status": {"type": "string", "enum": ["ready", "inbox", "draft", "failed"]},
                    "leech": {"type": "boolean"}, "limit": {"type": "integer"}}},
)
async def search_notes(args):
    rows = store.list_notes(q=args.get("q", ""), deck_id=args.get("deck_id"),
                            status=args.get("status", ""), leech=bool(args.get("leech")),
                            limit=args.get("limit") or 30)
    return _text([brief(n) for n in rows])


@tool(
    "update_note",
    "Поправить карточку по id заметки: fields — только меняемые поля (пустая строка убирает "
    "поле), deck — перенести в колоду, tags — заменить теги, suspended — приостановить или "
    "вернуть в работу. Выученное при правке не теряется.",
    {"type": "object",
     "properties": {"id": {"type": "integer"}, "fields": {"type": "object"},
                    "deck": {"type": "string"},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "suspended": {"type": "boolean"}},
     "required": ["id"]},
)
async def update_note(args):
    nid = args["id"]
    try:
        n = store.note(nid)
        if n and (args.get("fields") or args.get("deck") is not None or args.get("tags") is not None):
            n = store.update_note(nid, fields=args.get("fields"), deck=args.get("deck"),
                                  tags=args.get("tags"))
    except ValueError as e:
        return _text({"error": str(e)})
    if not n:
        return _text({"error": "карточка не найдена"})
    if args.get("suspended") is not None:
        for c in store.note_cards(nid):
            store.set_suspended(c["id"], bool(args["suspended"]))
    return _text(brief(store.note(nid)))


@tool("delete_note", "Удалить карточку по id заметки.",
      {"type": "object", "properties": {"id": {"type": "integer"}}, "required": ["id"]})
async def delete_note(args):
    return _text({"ok": True} if store.delete_note(args["id"]) else {"error": "карточка не найдена"})


@tool("due_summary", "Что сегодня к повторению: по видам (доучить, повторить, новые) и по "
      "колодам, серия дней, сколько уже повторено и сколько лежит во «Входящих».", {})
async def due_summary(args):
    return _text(due())


@tool("stats", "Статистика повторений: удержание за 30 дней, зрелость карточек, серия, "
      "прогноз нагрузки на ближайшие дни.", {})
async def stats(args):
    s = store.stats(30)
    return _text({k: s[k] for k in ("streak", "totals", "retention", "maturity")}
                 | {"forecast": s["forecast"][:14]})


TOOLS = [list_decks, create_deck, add_notes, search_notes, update_note, delete_note,
         due_summary, stats]

TOOL_NAMES = [f"mcp__cards__{t.name}" for t in TOOLS]

server = create_sdk_mcp_server("cards", version="1.0.0", tools=TOOLS)
