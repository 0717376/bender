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
import re

from . import cards_store as store

logger = logging.getLogger("cards")

# По одной: фоновые ходы не должны выстраиваться в очередь к модели пачкой
# из-за того, что человек надобавлял слов со страницы.
_gate = asyncio.Lock()
_tasks: set[asyncio.Task] = set()

LANGS = {"ru": "русский", "en": "английский"}

HEAD = """Заполни карточку для интервальных повторений. Инструменты не вызывай и ничего \
не сохраняй: ответь одним JSON-объектом и больше ничем — без пояснений и без ограды ```.

{where}Выделено:
<<<
{text}
>>>
{around}{talk}Язык объяснений — {lang}.
"""

WORD = """{{"kind": "word", "fields": {{
  "word": "начальная (словарная) форма: глагол — инфинитив без to, существительное — \
единственное число, прилагательное — положительная степень; строчными, если это не имя",
  "form": "выделенное ровно как в тексте — если отличается от начальной формы",
  "ipa": "транскрипция МФА начальной формы в косых чертах",
  "pos": "часть речи начальной формы одним словом",
  "meaning": "перевод начальной формы в том значении, в каком слово стоит в тексте, тоже \
в начальной форме (глагол — инфинитивом), коротко — одно-три слова",
  "other": "другие частые значения через точку с запятой, если есть",
  "example": "предложение из текста вокруг, где стоит это слово, — целиком и без правок",
  "example_tr": "перевод этого предложения",
  "lang": "код языка слова, например en"
}}}}"""

FACT = """Одна карточка — одна мысль. Либо вопрос и ответ:
{{"kind": "basic", "fields": {{"front": "вопрос", "back": "короткий ответ"}}}}
либо фраза с пропуском на месте главного:
{{"kind": "cloze", "fields": {{"text": "Фраза, где {{{{c1::главное}}}} скрыто."}}}}
Вопрос должен быть понятен без книги под рукой, ответ — проверяем одним взглядом."""

# Вид карточки задаёт то, о чём читатель просил: перевод — словарная, объяснение — на понимание.
# Язык книги тут не подсказка: понятие из английского учебника — не словарное слово.
TASKS = {
    "translate": "Читатель просил перевод. Если выделено слово или устойчивое выражение — "
                 "это словарная карточка:\n" + WORD + "\nЕсли выделено целое предложение — "
                 "карточка на перевод фразы:\n"
                 '{{"kind": "basic", "fields": {{"front": "фраза в оригинале", "back": "её перевод"}}}}',
    "explain": "Читатель просил объяснение — нужна карточка на понимание, а не словарная, "
               "даже если текст на чужом языке.\n" + FACT,
    "": "Если выделено слово или устойчивое выражение — это словарная карточка:\n" + WORD
        + "\n\nЕсли выделена мысль, факт или определение — карточка на понимание.\n" + FACT,
}
TASKS["ask"] = TASKS["explain"]


def build_prompt(n: dict, lang: str = "ru") -> str:
    src = n.get("source") or {}
    book = src.get("title") or ""
    where = ""
    if book:
        where = f"Книга «{book}»" + (f" ({src['author']})" if src.get("author") else "") \
            + (f", глава «{src['chapter']}»" if src.get("chapter") else "") + ".\n"
    around = f"Текст вокруг:\n<<<\n{src['context']}\n>>>\n" if src.get("context") else ""
    # Читатель уже получил ответ и по нему решил запомнить: карточка обязана с ним сходиться.
    talk = ("Читатель уже разобрал это место с агентом. Карточка должна опираться на этот "
            f"разговор и не противоречить ему:\n<<<\n{src['answer']}\n>>>\n") if src.get("answer") else ""
    head = HEAD.format(where=where, text=src.get("quote") or n["fields"].get("word", ""),
                       around=around, talk=talk, lang=LANGS.get(lang, LANGS["ru"]))
    return head + "\n" + TASKS.get(src.get("mode") or "", TASKS[""]).format()


def check(kind: str, fields: dict, src: dict) -> list[str]:
    """Что в карточке не так. Проверяем то, что видно без модели: вид, длину, пример.
    Замечания уходят агенту на одну правку — молча исправлять за него нельзя."""
    f = {k: str(v).strip() for k, v in (fields or {}).items() if v is not None}
    mode, quote = src.get("mode") or "", (src.get("quote") or "").strip()
    out = []
    if mode in ("explain", "ask") and kind == "word":
        out.append("читатель просил объяснение — нужна карточка basic или cloze, а не словарная")
    if mode == "translate" and kind == "cloze":
        out.append("читатель просил перевод — нужна карточка word или basic, а не cloze")
    if kind == "word":
        f = store.headword(f)
        word, form, example = f.get("word", ""), f.get("form", ""), f.get("example", "")
        if not word or not f.get("meaning"):
            out.append("нужны поля word и meaning")
        if len(f.get("meaning", "")) > 60:
            out.append("meaning слишком длинное: одно-три слова, остальное — в other")
        if form and quote and form.lower() != quote.lower() and len(quote.split()) <= 3:
            out.append(f"form должно быть ровно выделенным: «{quote}»")
        if example and (form or word).lower() not in example.lower():
            out.append(f"в example нет слова «{form or word}» — возьми предложение из текста вокруг")
        if example and src.get("context") and _flat(example) not in _flat(src["context"]):
            out.append("example должно быть предложением из текста вокруг, целиком и без правок")
        if f.get("ipa") and not (f["ipa"].startswith("/") and f["ipa"].endswith("/")):
            out.append("ipa — в косых чертах")
    elif kind == "basic":
        if not f.get("front") or not f.get("back"):
            out.append("нужны поля front и back")
        if len(f.get("back", "")) > 320:
            out.append("back слишком длинный: ответ должен проверяться одним взглядом")
        if f.get("front", "").lower() == f.get("back", "").lower():
            out.append("front и back совпадают")
    elif kind == "cloze":
        hidden = [m.group(2) for m in store.CLOZE.finditer(f.get("text", ""))]
        if not hidden:
            out.append("во фразе нет пропуска вида {{c1::скрытое}}")
        if any(len(h) > 70 for h in hidden):
            out.append("под пропуском слишком много: скрывай одно понятие, а не полфразы")
    return out


def _flat(s: str) -> str:
    """Для сравнения цитат: пробелы и кавычки-тире в книге и в ответе пишут по-разному."""
    return re.sub(r"[\s\u00a0«»“”\"'’‘—–-]+", "", s).lower()


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
        src = n["source"] or {}
        prompt = build_prompt(n, src.get("ui", "ru"))
        reply = await agent.run_cron(prompt, surface="cards")
        if not reply:
            raise ValueError("агент не ответил")
        kind, fields = parse(reply)
        # Вторая пара глаз: что видно без модели — проверяем, замечания отдаём на одну правку.
        # Вторая попытка не удалась или тоже с огрехами — берём первую: её хотя бы видно во «Входящих».
        issues = check(kind, fields, src)
        if issues:
            logger.info("карточка #%s: правка — %s", note_id, "; ".join(issues))
            try:
                again = await agent.run_cron(
                    prompt + "\n\nТвой прошлый ответ:\n" + reply.strip() + "\n\nЗамечания:\n"
                    + "\n".join("- " + x for x in issues) + "\nИсправь и верни JSON заново, целиком.",
                    surface="cards")
                k2, f2 = parse(again or "")
                if len(check(k2, f2, src)) < len(issues):
                    kind, fields = k2, f2
            except Exception as e:
                logger.warning("карточка #%s: правка не удалась: %s", note_id, e)
        # Вид мог оказаться не тем, что угадали заранее. Колоду книги при этом не меняем.
        deck = None if kind == n["kind"] or src.get("title") else store.resolve_deck(None, kind)["id"]
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
          ui: str = "ru", mode: str = "", answer: str = "") -> dict:
    """Быстрое добавление: завести черновик по выделенному и поставить его на заполнение.
    mode — о чём читатель просил агента (translate / explain / ask): он и задаёт вид
    карточки. Без него гадаем по длине: до трёх слов — слово, длиннее — мысль.
    Карточки из книги идут в колоду этой книги."""
    text = " ".join((text or "").split())
    if not text:
        raise ValueError("нечего добавлять: пустое выделение")
    book = book or {}
    mode = mode if mode in ("translate", "explain", "ask") else ""
    short = len(text.split()) <= 3 and len(text) <= 60
    kind = "word" if (mode == "translate" or (not mode and short)) else "basic"
    source = {"quote": text[:2000], "context": (context or "")[:4000], "ui": ui,
              "mode": mode, "answer": (answer or "").strip()[:6000],
              "book_id": book.get("id", ""), "title": book.get("title", ""),
              "author": book.get("author", ""), "chapter": book.get("chapter", ""), "cfi": cfi}
    title = (book.get("title") or "").strip()
    n = store.create_note(kind, {"word": text} if kind == "word" and short else {}, source=source,
                          deck=store.create_deck(title[:120])["id"] if title else None, draft=True)
    enqueue(n["id"])
    return n
