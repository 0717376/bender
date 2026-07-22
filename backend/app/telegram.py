"""Telegram bot (long polling) sharing the single Claude session with the web UI."""

import asyncio
import html as html_lib
from datetime import datetime
import logging
import os
import re
import time

import httpx

from . import config
from .agent import clear_session, run_collect

logger = logging.getLogger("wiki.tg")

TG_WELCOME = (
    "Привет! Я Bender — личный ассистент.\n\n"
    "**Что умею**\n"
    "• Вики: отвечаю по твоим заметкам, создаю и правлю страницы\n"
    "• Задачи: создаю, переношу, подсказываю план на день\n"
    "• Веб: ищу актуальную информацию в интернете\n"
    "• Файлы: храню документы — пришли файл, я его положу куда скажешь и найду по просьбе\n"
    "• Расписание: напоминания и регулярные сводки («каждый день в 9 пришли задачи»)\n"
    "• Журнал: помню все прошлые разговоры и ищу по ним\n"
    "• Самообучение: запоминаю факты и предпочтения, выучиваю навыки из решённых "
    "задач, а в тихие часы консолидирую выученное\n\n"
    "Пиши текстом или надиктовывай голосовые. Контекст общий с веб-версией.\n\n"
    "**Команды**\n"
    "/new — новая сессия (история сохраняется в журнале)\n"
    "/status — сессия, память, навыки, задания\n"
    "/help — это сообщение"
)

DRAFT_CAP = 3500       # stop updating the live draft past this size
DRAFT_THROTTLE = 1.0   # min seconds between sendMessageDraft calls

TG_LIMIT = 3500  # split markdown below Telegram's 4096-char cap (HTML adds length)


def md_to_tg_html(md: str) -> str:
    """Convert a markdown chunk to the safe HTML subset Telegram accepts."""
    md = re.sub(r"^#{1,6}[ \t]+(.+?)\s*#*$", r"**\1**", md, flags=re.M)   # headings → bold
    md = re.sub(r"^[ \t]*[-*][ \t]+", "• ", md, flags=re.M)               # bullets → •

    stash: list[str] = []

    def keep(s: str) -> str:
        stash.append(s)
        return f"\x00{len(stash) - 1}\x00"

    md = re.sub(r"```[^\n]*\n(.*?)```", lambda m: keep(f"<pre>{html_lib.escape(m.group(1))}</pre>"), md, flags=re.S)
    md = re.sub(r"```(.*?)```", lambda m: keep(f"<pre>{html_lib.escape(m.group(1))}</pre>"), md, flags=re.S)
    md = re.sub(r"`([^`\n]+)`", lambda m: keep(f"<code>{html_lib.escape(m.group(1))}</code>"), md)

    md = html_lib.escape(md)
    md = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", r'<a href="\2">\1</a>', md)
    md = re.sub(r"\*\*([^*\n]+)\*\*", r"<b>\1</b>", md)
    md = re.sub(r"__([^_\n]+)__", r"<b>\1</b>", md)

    return re.sub(r"\x00(\d+)\x00", lambda m: stash[int(m.group(1))], md)


def split_md(text: str, limit: int = TG_LIMIT) -> list[str]:
    """Split markdown into chunks under `limit`, preferring line boundaries."""
    if len(text) <= limit:
        return [text]
    chunks, buf = [], ""
    for line in text.split("\n"):
        while len(line) > limit:
            if buf:
                chunks.append(buf); buf = ""
            chunks.append(line[:limit]); line = line[limit:]
        if len(buf) + len(line) + 1 > limit:
            chunks.append(buf); buf = line
        else:
            buf = f"{buf}\n{line}" if buf else line
    if buf:
        chunks.append(buf)
    return chunks


async def tg_api(client: httpx.AsyncClient, method: str, **params) -> dict:
    try:
        r = await client.post(f"{config.TG_API}/{method}", json=params)
        data = r.json()
        if not data.get("ok"):
            logger.warning("tg %s failed: %s", method, data.get("description"))
        return data
    except Exception as e:
        logger.warning("tg %s error: %s", method, e)
        return {"ok": False}


async def tg_send(client: httpx.AsyncClient, chat_id: int, text: str):
    for chunk in split_md(text):
        res = await tg_api(
            client, "sendMessage",
            chat_id=chat_id, text=md_to_tg_html(chunk),
            parse_mode="HTML", disable_web_page_preview=True,
        )
        if not res.get("ok"):
            await tg_api(client, "sendMessage", chat_id=chat_id, text=chunk, disable_web_page_preview=True)


async def tg_typing(client: httpx.AsyncClient, chat_id: int, stop: asyncio.Event):
    while not stop.is_set():
        await tg_api(client, "sendChatAction", chat_id=chat_id, action="typing")
        try:
            await asyncio.wait_for(stop.wait(), timeout=4.5)
        except asyncio.TimeoutError:
            pass


async def tg_download(client: httpx.AsyncClient, file_id: str) -> tuple[bytes, str] | None:
    info = await tg_api(client, "getFile", file_id=file_id)
    if not info.get("ok"):
        return None
    file_path = info["result"].get("file_path")
    if not file_path:
        return None
    try:
        dl = await client.get(f"https://api.telegram.org/file/bot{config.TELEGRAM_BOT_TOKEN}/{file_path}")
        if dl.status_code != 200:
            return None
        return dl.content, file_path
    except Exception as e:
        logger.warning("tg file download error: %s", e)
        return None


async def tg_save_image(client: httpx.AsyncClient, file_id: str) -> str | None:
    res = await tg_download(client, file_id)
    if not res:
        return None
    content, remote = res
    ext = os.path.splitext(remote)[1].lstrip(".").lower() or "jpg"
    safe = re.sub(r"[^A-Za-z0-9_-]", "", file_id)[:48] or "img"
    os.makedirs(config.TG_MEDIA_DIR, exist_ok=True)
    dest = os.path.join(config.TG_MEDIA_DIR, f"{safe}.{ext}")
    with open(dest, "wb") as f:
        f.write(content)
    return dest


async def tg_save_document(client: httpx.AsyncClient, doc: dict) -> str | None:
    """Save an incoming non-image document into the storage inbox, keeping its name."""
    res = await tg_download(client, doc["file_id"])
    if not res:
        return None
    content, remote = res
    name = os.path.basename(doc.get("file_name") or remote) or "файл"
    inbox = os.path.join(config.FILES_DIR, config.FILES_INBOX)
    os.makedirs(inbox, exist_ok=True)
    dest = os.path.join(inbox, name)
    if os.path.exists(dest):
        stem, ext = os.path.splitext(name)
        dest = os.path.join(inbox, f"{stem}-{int(time.time())}{ext}")
    with open(dest, "wb") as f:
        f.write(content)
    return dest


async def tg_transcribe(client: httpx.AsyncClient, file_id: str, mime: str | None) -> str | None:
    if not config.ASR_UPSTREAM:
        return None
    res = await tg_download(client, file_id)
    if not res:
        return None
    audio = res[0]
    candidates = [("voice.ogg", "audio/ogg"), ("voice.webm", "audio/webm")]
    try:
        async with httpx.AsyncClient(timeout=180) as asr:
            for fname, ctype in candidates:
                resp = await asr.post(
                    config.ASR_UPSTREAM,
                    files={"audio": (fname, audio, ctype)},
                    data={"model_id": config.ASR_MODEL},
                )
                if resp.status_code == 200:
                    text = ((resp.json() or {}).get("text") or "").strip()
                    return text or None
                logger.warning("asr(tg) %s status %s: %s", fname, resp.status_code, resp.text[:200])
    except Exception as e:
        logger.warning("asr(tg) error: %s", e)
        return None
    return None


async def tg_handle(client: httpx.AsyncClient, update: dict):
    msg = update.get("message") or update.get("edited_message")
    if not msg:
        return
    chat_id = msg["chat"]["id"]
    user_id = (msg.get("from") or {}).get("id")

    if not config.TELEGRAM_ALLOWED_IDS:
        await tg_api(client, "sendMessage", chat_id=chat_id,
                     text=f"Бот ещё не настроен. Ваш Telegram ID: {user_id}\n"
                          f"Добавьте его в TELEGRAM_ALLOWED_IDS и перезапустите backend.")
        return
    if user_id not in config.TELEGRAM_ALLOWED_IDS:
        await tg_api(client, "sendMessage", chat_id=chat_id, text="Это приватный бот.")
        return

    from . import curator
    curator.mark_activity()

    text = (msg.get("text") or msg.get("caption") or "").strip()

    image_path = None
    photo = msg.get("photo")
    doc = msg.get("document")
    if photo:
        await tg_api(client, "sendChatAction", chat_id=chat_id, action="typing")
        image_path = await tg_save_image(client, photo[-1]["file_id"])
    elif doc and (doc.get("mime_type") or "").startswith("image/"):
        await tg_api(client, "sendChatAction", chat_id=chat_id, action="typing")
        image_path = await tg_save_image(client, doc["file_id"])
    if (photo or (doc and (doc.get("mime_type") or "").startswith("image/"))) and not image_path:
        await tg_api(client, "sendMessage", chat_id=chat_id, text="Не удалось загрузить изображение — попробуй ещё раз.")
        return
    if image_path:
        instr = f"[Пользователь прислал изображение. Посмотри его через Read: {image_path}]"
        text = f"{instr}\n\n{text}" if text else instr
    elif doc:
        await tg_api(client, "sendChatAction", chat_id=chat_id, action="typing")
        doc_path = await tg_save_document(client, doc)
        if not doc_path:
            await tg_api(client, "sendMessage", chat_id=chat_id,
                         text="Не удалось получить файл — попробуй ещё раз (лимит Telegram для ботов — 20 МБ).")
            return
        instr = (f"[Пользователь прислал файл «{os.path.basename(doc_path)}», он сохранён в {doc_path}. "
                 f"Если из сообщения ясно, куда его положить или как назвать, — перенеси и переименуй; "
                 f"иначе оставь во «{config.FILES_INBOX}» и скажи, что принял.]")
        text = f"{instr}\n\n{text}" if text else instr

    media = msg.get("voice") or msg.get("audio") or msg.get("video_note")
    if not text and media:
        await tg_api(client, "sendChatAction", chat_id=chat_id, action="typing")
        text = await tg_transcribe(client, media["file_id"], media.get("mime_type"))
        if not text:
            await tg_api(client, "sendMessage", chat_id=chat_id, text="Не удалось распознать голосовое — попробуй ещё раз.")
            return

    if not text:
        return

    if text in ("/start", "/help"):
        await tg_send(client, chat_id, TG_WELCOME)
        return
    if text in ("/new", "/clear"):
        clear_session()
        await tg_api(client, "sendMessage", chat_id=chat_id,
                     text="Начал новую сессию. Прошлый разговор сохранён в журнале — найду по запросу.")
        return
    if text == "/status":
        await tg_send(client, chat_id, build_status())
        return

    stop = asyncio.Event()
    typing = asyncio.create_task(tg_typing(client, chat_id, stop))
    # Native streaming (Bot API 9.5 sendMessageDraft): calls with the same
    # non-zero draft_id animate one live preview; the final tg_send persists
    # the real message. Drafts are plain text — mid-stream markdown is
    # incomplete. If the method is unavailable we silently fall back to the
    # typing indicator alone.
    draft = {"at": 0.0, "ok": None, "capped": False,
             "id": (time.time_ns() % 2_000_000_000) or 1}

    async def on_delta(acc: str) -> None:
        if draft["ok"] is False or draft["capped"] or not acc.strip():
            return
        now = time.monotonic()
        if now - draft["at"] < DRAFT_THROTTLE:
            return
        draft["at"] = now
        res = await tg_api(client, "sendMessageDraft", chat_id=chat_id,
                           draft_id=draft["id"], text=acc[:DRAFT_CAP])
        if draft["ok"] is None:
            draft["ok"] = bool(res.get("ok"))
        draft["capped"] = len(acc) > DRAFT_CAP

    try:
        async def on_tool(_name, _detail):
            await tg_api(client, "sendChatAction", chat_id=chat_id, action="typing")
        reply = await run_collect(text, on_tool, on_delta=on_delta)
    except Exception as e:
        logger.error("tg run error: %s", e)
        reply = "Что-то пошло не так при обработке запроса."
    finally:
        stop.set()
        await typing

    await tg_send(client, chat_id, reply)


def _plural(n: int, one: str, few: str, many: str) -> str:
    m10, m100 = n % 10, n % 100
    if m10 == 1 and m100 != 11:
        return f"{n} {one}"
    if 2 <= m10 <= 4 and not 12 <= m100 <= 14:
        return f"{n} {few}"
    return f"{n} {many}"


_WD = ("пн", "вт", "ср", "чт", "пт", "сб", "вс")


def _when(iso: str | None) -> str:
    """'2026-07-20T08:30' → 'пн 20.07 08:30'."""
    if not iso:
        return "—"
    try:
        d = datetime.fromisoformat(iso)
        return f"{_WD[d.weekday()]} {d.day:02d}.{d.month:02d} {d:%H:%M}"
    except ValueError:
        return iso.replace("T", " ")[:16]


def build_status() -> str:
    """Snapshot for /status: session, memory, skills, scheduled jobs. Markdown → tg_send."""
    from . import cron_store, memory_store, session_log, skill_store
    from .agent import load_session_state, session_age

    sid, _ = load_session_state()
    lines = []
    lines.append(f"**Сессия** {session_age() or '?'} · {sid[:8]}" if sid
                 else "**Сессия** новая, контекст пуст")
    s_n, m_n = session_log.stats()
    lines.append(f"**Журнал** {_plural(s_n, 'сессия', 'сессии', 'сессий')} · "
                 f"{_plural(m_n, 'сообщение', 'сообщения', 'сообщений')}")
    mem = memory_store.all_entries()
    by_cat = {c: sum(1 for e in mem if e["category"] == c) for c in memory_store.CATEGORIES}
    lines.append(f"**Память** {_plural(len(mem), 'запись', 'записи', 'записей')}: "
                 f"профиль {by_cat['profile']} · заметки {by_cat['note']} · предпочтения {by_cat['pref']}")
    lines.append(f"**Навыки** выучено {len(skill_store.list_skills())}")
    jobs = cron_store.list_jobs()
    if jobs:
        lines.append("\n**Задания**")
        for j in jobs:
            log = cron_store.run_log(j)
            last = log[-1] if log else None
            tail = ""
            if last:
                tail = f" · посл.: {_when(last['at'])}, " + ("отправлено" if last["sent"] else "молчание")
            lines.append(f"• #{j['id']} {j['name']}\n  следующий: {_when(j.get('next_run'))}{tail}")
    else:
        lines.append("\n**Задания** нет")
    return "\n".join(lines)


async def notify(text: str) -> None:
    """Push a message to all allowed Telegram users (used by the cron scheduler).
    In a private chat, chat_id == user_id, so the allowlist doubles as the target list."""
    if not config.TELEGRAM_BOT_TOKEN or not config.TELEGRAM_ALLOWED_IDS or not text.strip():
        return
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
        for chat_id in config.TELEGRAM_ALLOWED_IDS:
            await tg_send(client, chat_id, text)


BOT_COMMANDS = [
    {"command": "status", "description": "Сессия, память, навыки, задания"},
    {"command": "new", "description": "Новая сессия (история остаётся в журнале)"},
    {"command": "help", "description": "Что умеет бот"},
]


async def telegram_poller():
    """Long-poll Telegram for updates and dispatch them. One worker, sequential."""
    offset = None
    async with httpx.AsyncClient(timeout=httpx.Timeout(70.0)) as client:
        try:
            # The "/" menu button in clients — best-effort, once per start.
            await tg_api(client, "setMyCommands", commands=BOT_COMMANDS)
        except Exception as e:
            logger.warning("setMyCommands failed: %s", e)
        try:
            init = await tg_api(client, "getUpdates", offset=-1, timeout=0)
            if init.get("ok") and init.get("result"):
                offset = init["result"][-1]["update_id"] + 1
        except Exception:
            pass
        while True:
            try:
                resp = await tg_api(client, "getUpdates", offset=offset, timeout=50)
                for upd in resp.get("result", []):
                    offset = upd["update_id"] + 1
                    await tg_handle(client, upd)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.error("tg poll error: %s", e)
                await asyncio.sleep(3)
