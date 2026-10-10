"""Заполнение карточки агентом: человек выделил слово в книге и нажал одну кнопку.

Ручка быстрого добавления отвечает сразу — заметка заводится черновиком, — а перевод,
транскрипцию и пример дописывает отдельный ход агента в фоне. Ход изолированный, как у
крона: общий разговор про эту карточку знать не должен. Пока черновик не заполнен,
спрашивать по нему нечего, поэтому карточек у него нет; не вышло заполнить — заметка
остаётся во «Входящих» с причиной, и её можно дописать руками или отправить ещё раз.
"""

import asyncio
import json
import logging

from . import cards_store as store

logger = logging.getLogger("cards")

# По одной: фоновые ходы не должны выстраиваться в очередь к модели пачкой
# из-за того, что человек надобавлял слов со страницы.
_gate = asyncio.Lock()
_tasks: set[asyncio.Task] = set()

LANGS = {"ru": "русский", "en": "английский"}

PROMPT = """Заполни карточку для интервальных повторений. Инструменты не вызывай и ничего \
не сохраняй: ответь одним JSON-объектом и больше ничем — без пояснений и без ограды ```.

{where}Выделено:
<<<
{text}
>>>
{around}
Язык объяснений — {lang}.

Если выделено слово или устойчивое выражение — это словарная карточка:
{{"kind": "word", "fields": {{
  "word": "выделенное, как в тексте (строчными, если это не имя)",
  "lemma": "начальная форма",
  "ipa": "транскрипция МФА в косых чертах",
  "pos": "часть речи одним словом",
  "meaning": "значение ИМЕННО в этом контексте, коротко — одно-три слова",
  "other": "другие частые значения через точку с запятой, если есть",
  "example": "предложение из текста вокруг, где стоит это слово, — целиком и без правок",
  "example_tr": "перевод этого предложения",
  "lang": "код языка слова, например en"
}}}}

Если выделена мысль, факт или определение — одна карточка на одну мысль. Либо вопрос и ответ:
{{"kind": "basic", "fields": {{"front": "вопрос", "back": "короткий ответ"}}}}
либо фраза с пропуском на месте главного:
{{"kind": "cloze", "fields": {{"text": "Фраза, где {{{{c1::главное}}}} скрыто."}}}}
Вопрос должен быть понятен без книги под рукой, ответ — проверяем одним взглядом."""


def build_prompt(n: dict, lang: str = "ru") -> str:
    src = n.get("source") or {}
    book = src.get("title") or ""
    where = ""
    if book:
        where = f"Книга «{book}»" + (f" ({src['author']})" if src.get("author") else "") \
            + (f", глава «{src['chapter']}»" if src.get("chapter") else "") + ".\n"
    around = f"Текст вокруг:\n<<<\n{src['context']}\n>>>\n" if src.get("context") else ""
    return PROMPT.format(where=where, text=src.get("quote") or n["fields"].get("word", ""),
                         around=around, lang=LANGS.get(lang, LANGS["ru"]))


def parse(reply: str) -> tuple[str, dict]:
    """Вынуть JSON из ответа. Модель нет-нет да и обернёт его парой слов или оградой."""
    a, b = reply.find("{"), reply.rfind("}")
    if a < 0 or b <= a:
        raise ValueError("в ответе нет JSON")
    data = json.loads(reply[a:b + 1])
    kind, fields = data.get("kind"), data.get("fields")
    if kind not in store.KINDS or not isinstance(fields, dict):
        raise ValueError("в ответе нет вида карточки или её полей")
    return kind, fields


async def fill(note_id: int) -> bool:
    n = store.note(note_id)
    if not n or n["status"] != "draft":
        return False
    from . import agent      # здесь, а не сверху: agent сам тянет инструменты карточек
    try:
        reply = await agent.run_cron(build_prompt(n, (n["source"] or {}).get("ui", "ru")),
                                     surface="cards")
        if not reply:
            raise ValueError("агент не ответил")
        kind, fields = parse(reply)
        # Вид мог оказаться не тем, что угадали по длине выделения: фраза — не слово.
        deck = None if kind == n["kind"] else store.resolve_deck(None, kind)["id"]
        store.update_note(note_id, fields=fields, kind=kind, deck=deck)
        return True
    except Exception as e:
        logger.warning("карточка #%s не заполнилась: %s", note_id, e)
        store.fail_note(note_id, str(e) or e.__class__.__name__)
        return False


async def _run(note_id: int) -> None:
    async with _gate:
        await fill(note_id)


def enqueue(note_id: int) -> None:
    """Поставить заметку на заполнение. Зовётся из обработчика запроса — цикл уже есть."""
    task = asyncio.get_running_loop().create_task(_run(note_id))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


def resume() -> int:
    """После перезапуска — дозаполнить то, что осталось в черновиках."""
    pending = store.drafts()
    for n in pending:
        enqueue(n["id"])
    return len(pending)


def quick(text: str, context: str = "", book: dict | None = None, cfi: str = "",
          ui: str = "ru") -> dict:
    """Быстрое добавление: завести черновик по выделенному и поставить его на заполнение.
    До трёх слов — скорее всего слово или выражение, длиннее — мысль; агент поправит."""
    text = " ".join((text or "").split())
    if not text:
        raise ValueError("нечего добавлять: пустое выделение")
    book = book or {}
    kind = "word" if len(text.split()) <= 3 and len(text) <= 60 else "basic"
    source = {"quote": text[:2000], "context": (context or "")[:4000], "ui": ui,
              "book_id": book.get("id", ""), "title": book.get("title", ""),
              "author": book.get("author", ""), "chapter": book.get("chapter", ""), "cfi": cfi}
    n = store.create_note(kind, {"word": text} if kind == "word" else {}, source=source, draft=True)
    enqueue(n["id"])
    return n
