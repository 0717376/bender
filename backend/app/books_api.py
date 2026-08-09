"""Библиотека книг: epub и pdf с их производными на диске под BOOKS_DIR.

Источник правды — файловая система, как в вики и хранилище. На книгу — папка:
    <id>/book.epub      сам файл, уже без скриптов (см. sanitize); у pdf — book.pdf
    <id>/meta.json      название, автор, размер, когда добавлена; у pdf ещё kind и pages
    <id>/cover.<ext>    обложка из epub, как есть (у pdf обложки нет — только миниатюра)
    <id>/thumb.jpg      миниатюра: полке хватает, а качать в двадцать раз меньше
    <id>/text/NNN.txt   текст глав: кэш, чтобы агент не разбирал файл на каждый вопрос
    <id>/chapters.json  оглавление: номер главы, файл, название, длина

Главы у pdf — куски по закладкам оглавления (или ровные пачки страниц, когда закладок
нет): агенту и поиску всё равно, из чего склеен NNN.txt, и они работают как с epub.

id — первые 8 байт SHA-256 файла: одна и та же книга, залитая дважды, не двоится.
Удаление — в .trash/, а не rm.
"""

import asyncio
import datetime
import hashlib
import io
import json
import logging
import mimetypes
import os
import posixpath
import re
import shutil
import subprocess
import threading
import time
import urllib.parse
import zipfile
from html.parser import HTMLParser
from xml.etree import ElementTree

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from pypdf import PdfReader
from sse_starlette.sse import EventSourceResponse

from . import books_store, config
from .auth import check_token, require_auth

logger = logging.getLogger("wiki")
router = APIRouter(prefix="/books", tags=["books"])
# Поток событий — отдельным роутером без auth-зависимости: EventSource не умеет
# ставить заголовки, токен приходит в query (как у задач и вики).
events_router = APIRouter(prefix="/books", tags=["books"])

CONTAINER = "META-INF/container.xml"
NS_CONTAINER = "urn:oasis:names:tc:opendocument:xmlns:container"
NS_OPF = "http://www.idpf.org/2007/opf"
NS_DC = "http://purl.org/dc/elements/1.1/"
NS_NCX = "http://www.daisy.org/z3986/2005/ncx/"
MARKUP = (".xhtml", ".html", ".htm", ".svg")
THUMB = "thumb.jpg"
THUMB_MAX = 512 * 1024
TEXT = "text"
CHAPTERS = "chapters.json"
IMG = "img"             # <id>/img/ — рисунки, вынутые из книги по требованию агента
MARK = "\x00img{}\x00"  # место рисунка в сыром тексте главы, до нумерации
MIN_IMG = 2048          # меньше — украшательство вёрстки, а не рисунок
PAGE_DPI = 110          # на 110 точках график читается, а страница остаётся лёгкой
TEXT_V = 2              # версия разбора текста; 2 — с метками рисунков (см. retext)


def init() -> None:
    os.makedirs(config.BOOKS_DIR, exist_ok=True)
    # Книги, положенные рядом файлами (так работала первая версия читалки), разбираем
    # в обычные папки. id — из имени файла, чтобы прогресс и выписки не потерялись.
    for name in sorted(os.listdir(config.BOOKS_DIR)):
        path = os.path.join(config.BOOKS_DIR, name)
        if not os.path.isfile(path) or not name.lower().endswith(".epub"):
            continue
        try:
            with open(path, "rb") as f:
                meta = ingest(f.read(), name, book_id=re.sub(r"[^A-Za-z0-9_-]", "", name[:-5])[:64] or None)
            os.unlink(path)
            logger.info("Books: %s → %s", name, meta["id"])
        except Exception as e:  # noqa: BLE001 — одна битая книга не должна ронять запуск
            logger.warning("Books: %s не разобралась (%s)", name, e)
    filled = sum(backfill_chapters(m["id"]) for m in catalog())
    if filled:
        logger.info("Books: собрано оглавление, книг: %d", filled)
    moved = migrate_legacy_state()
    if moved:
        logger.info("Books: прогресс перенесён из вики, книг: %d", moved)
    # Перебор текстов — в сторонке: толстый pdf разбирается с минуту, а держать из-за
    # него запуск бэкенда незачем. Пока не перебралась, книга читается по-старому.
    threading.Thread(target=retext_all, name="books-retext", daemon=True).start()


LEGACY_STATE = os.path.join(".reader", "state.json")


def migrate_legacy_state() -> int:
    """Первая версия читалки держала прогресс одним json в скрытой странице вики.
    Переносим в базу и переименовываем файл, чтобы больше не возвращаться."""
    path = os.path.join(config.WIKI_DIR, LEGACY_STATE)
    if not os.path.isfile(path):
        return 0
    moved = 0
    try:
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
        for book_id, st in (doc.get("books") or {}).items():
            if not os.path.isdir(os.path.join(config.BOOKS_DIR, book_id)):
                continue
            if st.get("pos"):
                books_store.set_position(book_id, st["pos"], st.get("pct") or 0,
                                         st.get("chap") or "", st.get("at") or None)
            items = [{
                "id": h.get("id"), "cfi": h.get("cfi"), "text": h.get("text"),
                "color": h.get("color"), "chapter": h.get("chapter"),
                "thread": h.get("thread") or [], "created": h.get("ts"),
                "updated": h.get("upd") or h.get("ts"), "deleted": bool(h.get("del")),
            } for h in (st.get("hl") or []) if h.get("id")]
            if items:
                books_store.save_highlights(book_id, items)
            moved += 1
        os.rename(path, path.replace("state.json", "state.migrated.json"))
    except Exception as e:  # noqa: BLE001 — не переехало, так не переехало: файл на месте
        logger.warning("Books: старое состояние не перенеслось (%s)", e)
        return 0
    return moved


# ── Разбор epub ──


class _Text(HTMLParser):
    """Текст главы + рисунки. На месте каждого рисунка остаётся метка MARK: чем он
    окажется в тексте, решает уже вызывающий — ему видны размеры файлов в книге."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.imgs: list[dict] = []
        self.skip = 0
        self.fig = 0      # сколько картинок было до открытия <figure>
        self.cap = -1     # чей <figcaption> сейчас читаем

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "title"):   # заголовок из head — не текст главы
            self.skip += 1
        elif tag in ("img", "image"):
            a = dict(attrs)
            src = a.get("src") or a.get("xlink:href") or a.get("href") or ""
            if src and not src.startswith("data:"):
                self.parts.append(MARK.format(len(self.imgs)))
                self.imgs.append({"src": src, "alt": " ".join((a.get("alt") or "").split()),
                                  "caption": ""})
        elif tag == "figure":
            self.fig = len(self.imgs)
        elif tag == "figcaption":
            # Подпись — той картинке, что открыта этой же <figure>; подпись без картинки
            # (бывает у таблиц) ни к кому не приклеиваем.
            self.cap = len(self.imgs) - 1 if len(self.imgs) > self.fig else -1

    def handle_endtag(self, tag):
        if tag in ("script", "style", "title") and self.skip:
            self.skip -= 1
        elif tag == "figcaption":
            self.cap = -1
        elif tag in ("p", "div", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6"):
            self.parts.append("\n")

    def handle_data(self, data):
        if self.skip:
            return
        self.parts.append(data)
        if self.cap >= 0:
            self.imgs[self.cap]["caption"] += data


def parse_markup(markup: bytes) -> tuple[str, list[dict]]:
    """Текст главы с метками рисунков и сами рисунки по порядку встречи."""
    p = _Text()
    try:
        p.feed(markup.decode("utf-8", "replace"))
    except Exception:  # noqa: BLE001 — рваная вёрстка не повод терять главу
        pass
    for im in p.imgs:
        im["caption"] = " ".join(im["caption"].split())
    return "".join(p.parts), p.imgs


def tidy(text: str) -> str:
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    return re.sub(r"\n\s*\n\s*\n+", "\n\n", text).strip()


def mark_figures(text: str, imgs: list[dict]) -> str:
    """Метки → «[рисунок N]». Картинки без номера отсеяны, их метки просто исчезают.

    Подпись в метку не дублируем: <figcaption> и так остался текстом рядом. В метке —
    alt, которого в тексте нет нигде: без него агент не поймёт, что за рисунок пропущен."""
    for i, im in enumerate(imgs):
        n = im.get("n")
        alt = im.get("alt") or ""
        text = text.replace(MARK.format(i),
                            f"\n[рисунок {n}{': ' + alt if alt else ''}]\n" if n else "")
    return text


def plain_text(markup: bytes) -> str:
    """Текст главы, когда книги под рукой нет: нумеруем все рисунки подряд."""
    text, imgs = parse_markup(markup)
    for n, im in enumerate(imgs, 1):
        im["n"] = n
    return tidy(mark_figures(text, imgs))


def chapter_content(zf: zipfile.ZipFile, href: str, names: set[str] | None = None
                    ) -> tuple[str, list[dict]]:
    """Текст главы с метками рисунков и список самих рисунков (путь в архиве, alt, подпись).
    Нумерация здесь одна на оба выхода — по «рисунок 3» из текста агент достаёт третий."""
    raw, imgs = parse_markup(zf.read(href))
    names = names if names is not None else set(zf.namelist())
    base = posixpath.dirname(href)
    kept = []
    for im in imgs:
        im["path"] = _join(base, im["src"])
        size = zf.getinfo(im["path"]).file_size if im["path"] in names else 0
        # Буквицы, линейки и прозрачные распорки — не рисунки: метка о них только мешает,
        # а доставать их агенту тем более незачем.
        if size < MIN_IMG:
            continue
        im["n"], im["size"] = len(kept) + 1, size
        kept.append(im)
    return tidy(mark_figures(raw, imgs)), kept


class _Links(HTMLParser):
    """Ссылки оглавления epub3: (href, подпись)."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links: list[tuple[str, str]] = []
        self.href = ""
        self.label: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self.href = dict(attrs).get("href") or ""
            self.label = []

    def handle_data(self, data):
        if self.href:
            self.label.append(data)

    def handle_endtag(self, tag):
        if tag == "a" and self.href:
            self.links.append((self.href, " ".join("".join(self.label).split())))
            self.href = ""


def _join(base: str, href: str) -> str:
    href = urllib.parse.unquote(href.split("#")[0])
    return posixpath.normpath(posixpath.join(base, href)) if base else href


def toc_titles(zf: zipfile.ZipFile, items: dict[str, dict]) -> dict[str, str]:
    """Названия глав из оглавления — сначала nav (epub3), потом toc.ncx (epub2).
    Ключ — путь главы в архиве: по нему потом подписываются файлы корешка."""
    titles: dict[str, str] = {}
    nav = next((i["href"] for i in items.values() if "nav" in i["props"]), "")
    if nav:
        p = _Links()
        try:
            p.feed(zf.read(nav).decode("utf-8", "replace"))
        except Exception:  # noqa: BLE001 — кривое оглавление не повод терять книгу
            pass
        base = posixpath.dirname(nav)
        for href, label in p.links:
            if label:
                titles.setdefault(_join(base, href), label)

    ncx = next((i["href"] for i in items.values() if "ncx" in i["type"]), "")
    if ncx:
        base = posixpath.dirname(ncx)
        try:
            root = ElementTree.fromstring(zf.read(ncx))
        except (KeyError, ElementTree.ParseError):
            return titles
        for point in root.iter(f"{{{NS_NCX}}}navPoint"):
            src = point.find(f"{{{NS_NCX}}}content")
            text = point.find(f"{{{NS_NCX}}}navLabel/{{{NS_NCX}}}text")
            if src is None or text is None or not (text.text or "").strip():
                continue
            titles.setdefault(_join(base, src.get("src", "")), " ".join(text.text.split()))
    return titles


def parse_epub(data: bytes) -> dict:
    """Название, автор, обложка и главы по порядку корешка."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise HTTPException(400, "Это не epub и не PDF") from None
    try:
        root = ElementTree.fromstring(zf.read(CONTAINER))
    except KeyError:
        raise HTTPException(400, "В файле нет META-INF/container.xml") from None
    rootfile = root.find(f".//{{{NS_CONTAINER}}}rootfile")
    opf_path = rootfile.get("full-path") if rootfile is not None else None
    if not opf_path:
        raise HTTPException(400, "В epub не указан пакет OPF")
    opf = ElementTree.fromstring(zf.read(opf_path))
    base = posixpath.dirname(opf_path)

    def resolve(href: str) -> str:
        return _join(base, href)

    def first(tag: str) -> str:
        node = opf.find(f".//{{{NS_DC}}}{tag}")
        return (node.text or "").strip() if node is not None else ""

    items: dict[str, dict] = {}
    for it in opf.iter(f"{{{NS_OPF}}}item"):
        items[it.get("id", "")] = {
            "href": resolve(it.get("href", "")),
            "type": it.get("media-type", ""),
            "props": it.get("properties", ""),
        }

    cover = ""
    for it in items.values():
        if "cover-image" in it["props"]:
            cover = it["href"]
            break
    if not cover:
        for m in opf.iter(f"{{{NS_OPF}}}meta"):
            if m.get("name") == "cover" and m.get("content") in items:
                cover = items[m.get("content")]["href"]
                break

    names = set(zf.namelist())
    titles = toc_titles(zf, items)
    chapters: list[dict] = []
    for ref in opf.iter(f"{{{NS_OPF}}}itemref"):
        it = items.get(ref.get("idref", ""))
        if it and "html" in it["type"] and it["href"] in names:
            chapters.append({"href": it["href"], "title": titles.get(it["href"], "")})
    if not chapters:
        raise HTTPException(400, "В epub нет ни одной главы")

    return {
        "title": first("title"),
        "author": first("creator"),
        "cover": cover if cover in names else "",
        "chapters": chapters,
        "zip": zf,
    }


# ── Разбор pdf ──

PDF_MAGIC = b"%PDF-"
PDF_CHUNK = 25          # без закладок главы режем ровными пачками страниц


def _pdf_outline(reader: PdfReader) -> list[dict]:
    """Закладки двух верхних уровней: (название, страница с нуля). Один уровень —
    слишком крупно: у книг с частями «Part I» покрывает треть тома, и агент читал бы
    её одним куском. Глубже двух — уже параграфы, это дробить незачем."""
    out: list[dict] = []
    try:
        items = reader.outline or []
    except Exception:  # noqa: BLE001 — кривые закладки не повод терять книгу
        return out

    def walk(items: list, depth: int) -> None:
        for it in items:
            if isinstance(it, list):
                if depth < 1:
                    walk(it, depth + 1)
                continue
            try:
                title = " ".join((it.title or "").split())
                page = reader.get_destination_page_number(it)
            except Exception:  # noqa: BLE001 — битая закладка пропускается, остальные в деле
                continue
            if title and page is not None:
                out.append({"title": title, "page": int(page)})

    walk(items, 0)
    out.sort(key=lambda x: x["page"])
    return out


def pdf_sections(reader: PdfReader) -> list[dict]:
    """Диапазоны страниц будущих глав (страницы с нуля, включительно)."""
    n = len(reader.pages)
    marks = _pdf_outline(reader)
    secs: list[dict] = []
    if len(marks) >= 2:
        # Страницы до первой закладки (обложка, выходные данные) — тоже текст книги.
        if marks[0]["page"] > 0:
            secs.append({"title": "", "from": 0, "to": marks[0]["page"] - 1})
        for i, m in enumerate(marks):
            last = (marks[i + 1]["page"] - 1) if i + 1 < len(marks) else n - 1
            secs.append({"title": m["title"], "from": m["page"], "to": max(m["page"], last)})
    else:
        for start in range(0, n, PDF_CHUNK):
            end = min(start + PDF_CHUNK, n) - 1
            secs.append({"title": f"Страницы {start + 1}–{end + 1}", "from": start, "to": end})
    return secs


def parse_pdf(data: bytes) -> dict:
    try:
        reader = PdfReader(io.BytesIO(data))
        pages = len(reader.pages)
    except Exception:  # noqa: BLE001 — pypdf кидает разное, наружу это всё «не читается»
        raise HTTPException(400, "Не читается как PDF") from None
    if not pages:
        raise HTTPException(400, "В PDF нет ни одной страницы")
    info = reader.metadata or {}

    def field(name: str) -> str:
        v = info.get(name)
        return " ".join(str(v).split()) if v else ""

    return {"title": field("/Title"), "author": field("/Author"),
            "pages": pages, "reader": reader, "sections": pdf_sections(reader)}


def page_has_image(page) -> bool:
    """Есть ли на странице рисунок. Смотрим только опись ресурсов: доставать пиксели
    незачем, страницу всё равно рисуем целиком и только ту, о которой спросят."""
    try:
        xo = page["/Resources"]["/XObject"]
        return any(xo[k].get("/Subtype") == "/Image" for k in xo)
    except Exception:  # noqa: BLE001 — нет ресурсов, битая ссылка, что угодно: значит нет
        return False


def pdf_image_pages(reader: PdfReader, sec: dict) -> list[int]:
    """Страницы главы с рисунками, нумерация человеческая (с единицы)."""
    return [p + 1 for p in range(sec["from"], sec["to"] + 1) if page_has_image(reader.pages[p])]


def pdf_text(reader: PdfReader, sec: dict) -> str:
    parts = []
    for p in range(sec["from"], sec["to"] + 1):
        try:
            page = reader.pages[p]
            parts.append(page.extract_text() or "")
            # Метка страницы, а не рисунка: в PDF рисунок — это пиксели без имени,
            # достанем мы его рендером всей страницы (см. page_image).
            if page_has_image(page):
                parts.append(f"[рисунок, стр. {p + 1}]")
        except Exception:  # noqa: BLE001 — одна битая страница не повод терять главу
            parts.append("")
    return tidy("\n".join(parts))


# ── Чистка ──

_SCRIPT = re.compile(rb"<script\b[^>]*>.*?</\s*script\s*>", re.I | re.S)
_SCRIPT_ONE = re.compile(rb"<script\b[^>]*/\s*>", re.I)
_HANDLER = re.compile(rb"\son[a-z]{3,20}\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)", re.I)
_JS_URL = re.compile(rb"""(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2""", re.I)


def sanitize(data: bytes) -> tuple[bytes, int]:
    """Убрать из книги исполняемое: читалка рендерит epub с включёнными скриптами
    (иначе внутрь iframe не доходят события), поэтому чистим на входе, один раз.

    @returns (файл, сколько мест поправлено)
    """
    src = zipfile.ZipFile(io.BytesIO(data))
    out = io.BytesIO()
    hits = 0
    with zipfile.ZipFile(out, "w") as dst:
        for info in src.infolist():
            if info.filename.lower().endswith(".js"):
                hits += 1
                continue
            raw = src.read(info)
            if info.filename.lower().endswith(MARKUP):
                for rx in (_SCRIPT, _SCRIPT_ONE, _HANDLER, _JS_URL):
                    raw, n = rx.subn(b"", raw)
                    hits += n
            info.compress_size = len(raw)
            dst.writestr(info, raw)
    return out.getvalue(), hits


# ── Библиотека на диске ──


def safe_id(book_id: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", book_id or ""):
        raise HTTPException(400, "Недопустимый id книги")
    return book_id


def book_dir(book_id: str) -> str:
    return os.path.join(config.BOOKS_DIR, safe_id(book_id))


def meta_of(book_id: str) -> dict:
    try:
        with open(os.path.join(book_dir(book_id), "meta.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        raise HTTPException(404, "Книга не найдена") from None


def catalog() -> list[dict]:
    out = []
    pos, hl = books_store.positions(), books_store.counts()
    for name in os.listdir(config.BOOKS_DIR) if os.path.isdir(config.BOOKS_DIR) else []:
        if name.startswith(".") or not os.path.isdir(os.path.join(config.BOOKS_DIR, name)):
            continue
        try:
            meta = meta_of(name)
        except HTTPException:
            continue
        # Полке нужны и проценты, и число выписок — пусть приезжают вместе со списком.
        meta["position"] = pos.get(name)
        meta["highlights"] = hl.get(name, 0)
        out.append(meta)
    return sorted(out, key=lambda m: m.get("added", 0), reverse=True)


def ingest(data: bytes, filename: str = "", book_id: str | None = None) -> dict:
    """Положить книгу в библиотеку. Уже знакомую не перекладываем — отдаём как есть."""
    bid = safe_id(book_id or hashlib.sha256(data).hexdigest()[:16])
    if os.path.isdir(book_dir(bid)):
        meta = meta_of(bid)
        meta["known"] = True
        return meta
    if data[:len(PDF_MAGIC)] == PDF_MAGIC:
        return ingest_pdf(bid, data, filename)

    book = parse_epub(data)
    zf = book["zip"]
    clean, hits = sanitize(data)
    if hits:
        logger.info("Books: в %s вычищено исполняемого: %d", filename or bid, hits)

    tmp = book_dir(bid) + ".part"
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(os.path.join(tmp, TEXT), exist_ok=True)
    with open(os.path.join(tmp, "book.epub"), "wb") as f:
        f.write(clean)
    cover_name = ""
    if book["cover"]:
        cover_name = "cover" + (posixpath.splitext(book["cover"])[1] or ".jpg")
        with open(os.path.join(tmp, cover_name), "wb") as f:
            f.write(zf.read(book["cover"]))
    names = set(zf.namelist())
    toc = []
    for n, ch in enumerate(book["chapters"], 1):
        text, _ = chapter_content(zf, ch["href"], names)
        with open(os.path.join(tmp, TEXT, f"{n:03d}.txt"), "w", encoding="utf-8") as f:
            f.write(text)
        toc.append({"n": n, "href": ch["href"], "title": ch["title"] or headline(text),
                    "chars": len(text)})
    with open(os.path.join(tmp, CHAPTERS), "w", encoding="utf-8") as f:
        json.dump(toc, f, ensure_ascii=False, indent=1)

    meta = {
        "id": bid,
        "title": book["title"] or os.path.splitext(filename)[0] or "Книга",
        "author": book["author"],
        "added": int(time.time()),
        "size": len(clean),
        "chapters": len(book["chapters"]),
        "cover": cover_name,
        "thumb": "",          # появится, когда клиент пришлёт уменьшенную (см. put_thumb)
        "text_v": TEXT_V,
    }
    with open(os.path.join(tmp, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    os.rename(tmp, book_dir(bid))
    return meta


def ingest_pdf(bid: str, data: bytes, filename: str = "") -> dict:
    """PDF ложится той же папкой, что и epub: файл, meta, главы текстом. Чистить его не
    надо (pdf.js скрипты внутри файла не исполняет), обложки нет — миниатюру первой
    страницы пришлёт клиент, у него уже есть рендер."""
    book = parse_pdf(data)
    tmp = book_dir(bid) + ".part"
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(os.path.join(tmp, TEXT), exist_ok=True)
    with open(os.path.join(tmp, "book.pdf"), "wb") as f:
        f.write(data)
    toc = []
    for n, sec in enumerate(book["sections"], 1):
        text = pdf_text(book["reader"], sec)
        with open(os.path.join(tmp, TEXT, f"{n:03d}.txt"), "w", encoding="utf-8") as f:
            f.write(text)
        toc.append({"n": n, "title": sec["title"] or headline(text), "chars": len(text),
                    "pages": [sec["from"] + 1, sec["to"] + 1]})
    with open(os.path.join(tmp, CHAPTERS), "w", encoding="utf-8") as f:
        json.dump(toc, f, ensure_ascii=False, indent=1)

    meta = {
        "id": bid,
        "kind": "pdf",
        "file": "book.pdf",
        "title": book["title"] or os.path.splitext(filename)[0] or "Книга",
        "author": book["author"],
        "added": int(time.time()),
        "size": len(data),
        "chapters": len(toc),
        "pages": book["pages"],
        "cover": "",
        "thumb": "",          # появится, когда клиент пришлёт первую страницу (см. put_thumb)
        "text_v": TEXT_V,
    }
    with open(os.path.join(tmp, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    os.rename(tmp, book_dir(bid))
    return meta


def remove(book_id: str) -> dict:
    path = book_dir(book_id)
    if not os.path.isdir(path):
        raise HTTPException(404, "Книга не найдена")
    trash = os.path.join(config.BOOKS_DIR, config.BOOKS_TRASH)
    os.makedirs(trash, exist_ok=True)
    dest = os.path.join(trash, f"{int(time.time())}-{safe_id(book_id)}")
    shutil.rmtree(dest, ignore_errors=True)
    shutil.move(path, dest)
    books_store.forget(book_id)
    return {"ok": True, "trashed": os.path.basename(dest)}


# ── Текст книги (для агента) ──


def headline(text: str) -> str:
    """Чем подписать главу, о которой молчит оглавление: первой строкой текста."""
    for line in text.split("\n"):
        if line.strip():
            return line.strip()[:80]
    return ""


def chapters(book_id: str) -> list[dict]:
    """Оглавление: номер, название, длина. Книги, разобранные до появления
    chapters.json, подписываем на лету — перекладывать их ради этого незачем."""
    path = os.path.join(book_dir(book_id), CHAPTERS)
    try:
        with open(path, encoding="utf-8") as f:
            return [{"n": int(c["n"]), "title": c.get("title") or "", "chars": c.get("chars") or 0}
                    for c in json.load(f)]
    except (OSError, json.JSONDecodeError, KeyError, TypeError, ValueError):
        pass
    out = []
    text_dir = os.path.join(book_dir(book_id), TEXT)
    for name in sorted(os.listdir(text_dir)) if os.path.isdir(text_dir) else []:
        if not re.fullmatch(r"\d+\.txt", name):
            continue
        text = chapter_text(book_id, int(name[:-4]))
        out.append({"n": int(name[:-4]), "title": headline(text), "chars": len(text)})
    return out


def backfill_chapters(book_id: str) -> bool:
    """Книге, разобранной прошлой версией, оглавления не писали. Тексты глав на диске
    уже есть — достаём из самой книги только названия, разбирать заново её незачем."""
    path = os.path.join(book_dir(book_id), CHAPTERS)
    if os.path.isfile(path):
        return False
    text_dir = os.path.join(book_dir(book_id), TEXT)
    try:
        with open(os.path.join(book_dir(book_id), "book.epub"), "rb") as f:
            spine = parse_epub(f.read())["chapters"]
        saved = [n for n in os.listdir(text_dir) if re.fullmatch(r"\d+\.txt", n)]
    except (OSError, HTTPException):
        return False
    if len(saved) != len(spine):
        return False        # тексты и корешок разошлись — пусть подписываются первой строкой
    toc = []
    for n, ch in enumerate(spine, 1):
        text = chapter_text(book_id, n)
        toc.append({"n": n, "href": ch["href"], "title": ch["title"] or headline(text),
                    "chars": len(text)})
    with open(path, "w", encoding="utf-8") as f:
        json.dump(toc, f, ensure_ascii=False, indent=1)
    return True


def _write_text(book_id: str, n: int, text: str) -> None:
    path = os.path.join(book_dir(book_id), TEXT, f"{n:03d}.txt")
    with open(path + ".part", "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(path + ".part", path)   # эту главу может читать агент прямо сейчас


def retext(book_id: str) -> bool:
    """Перебрать тексты глав из самой книги: разбор поменялся (TEXT_V), а книга та же.
    Без этого метки рисунков появились бы только у книг, залитых после обновления."""
    meta = meta_of(book_id)
    if meta.get("text_v") == TEXT_V:
        return False
    d = book_dir(book_id)
    with open(os.path.join(d, meta.get("file") or "book.epub"), "rb") as f:
        data = f.read()
    toc = []
    if meta.get("kind") == "pdf":
        book = parse_pdf(data)
        for n, sec in enumerate(book["sections"], 1):
            text = pdf_text(book["reader"], sec)
            _write_text(book_id, n, text)
            toc.append({"n": n, "title": sec["title"] or headline(text), "chars": len(text),
                        "pages": [sec["from"] + 1, sec["to"] + 1]})
    else:
        book = parse_epub(data)
        names = set(book["zip"].namelist())
        for n, ch in enumerate(book["chapters"], 1):
            text, _ = chapter_content(book["zip"], ch["href"], names)
            _write_text(book_id, n, text)
            toc.append({"n": n, "href": ch["href"], "title": ch["title"] or headline(text),
                        "chars": len(text)})
    with open(os.path.join(d, CHAPTERS), "w", encoding="utf-8") as f:
        json.dump(toc, f, ensure_ascii=False, indent=1)
    meta["text_v"] = TEXT_V
    with open(os.path.join(d, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    shutil.rmtree(os.path.join(d, IMG), ignore_errors=True)   # нумерация рисунков могла съехать
    return True


def retext_all() -> None:
    for m in catalog():
        try:
            if retext(m["id"]):
                logger.info("Books: %s перебрана под разбор v%d", m["id"], TEXT_V)
        except Exception as e:  # noqa: BLE001 — одна книга не должна утащить остальные
            logger.warning("Books: %s не перебралась (%s)", m.get("id"), e)


# ── Рисунки (для агента) ──


def figures(book_id: str, chapter: int) -> list[dict]:
    """Рисунки главы. У epub это файлы: достаём их из книги и кладём рядом, чтобы второй
    раз не распаковывать. У pdf рисунок — пиксели без имени, поэтому отдаём номера
    страниц, которые стоит нарисовать (см. page_image)."""
    meta = meta_of(book_id)
    d = book_dir(book_id)
    n = int(chapter)
    with open(os.path.join(d, meta.get("file") or "book.epub"), "rb") as f:
        data = f.read()

    if meta.get("kind") == "pdf":
        book = parse_pdf(data)
        secs = book["sections"]
        if not 1 <= n <= len(secs):
            raise HTTPException(404, f"В книге нет главы {n}")
        return [{"page": p} for p in pdf_image_pages(book["reader"], secs[n - 1])]

    book = parse_epub(data)
    chs = book["chapters"]
    if not 1 <= n <= len(chs):
        raise HTTPException(404, f"В книге нет главы {n}")
    _, imgs = chapter_content(book["zip"], chs[n - 1]["href"])
    out = []
    for im in imgs:
        name = f"{n:03d}-{im['n']}{posixpath.splitext(im['path'])[1].lower() or '.img'}"
        dest = os.path.join(d, IMG, name)
        if not os.path.isfile(dest):
            os.makedirs(os.path.join(d, IMG), exist_ok=True)
            with open(dest, "wb") as f:
                f.write(book["zip"].read(im["path"]))
        out.append({"n": im["n"], "alt": im["alt"], "caption": im["caption"], "file": dest})
    return out


def page_image(book_id: str, page: int) -> dict:
    """Страница pdf картинкой: график чаще всего нарисован векторами, вынуть его файлом
    нельзя — можно только отрисовать страницу целиком. Рисуем pdftoppm, он уже в образе."""
    meta = meta_of(book_id)
    if meta.get("kind") != "pdf":
        raise HTTPException(400, "Страницы есть только у pdf; рисунки epub достаёт chapter_images")
    total = int(meta.get("pages") or 0)
    p = int(page)
    if not 1 <= p <= total:
        raise HTTPException(404, f"В книге {total} страниц, {p}-й нет")
    d = book_dir(book_id)
    root = os.path.join(d, IMG, f"p{p:04d}")
    if not os.path.isfile(root + ".jpg"):
        os.makedirs(os.path.join(d, IMG), exist_ok=True)
        cmd = ["pdftoppm", "-jpeg", "-r", str(PAGE_DPI), "-f", str(p), "-l", str(p),
               "-singlefile", os.path.join(d, meta.get("file") or "book.pdf"), root]
        try:
            subprocess.run(cmd, check=True, capture_output=True, timeout=120)
        except FileNotFoundError:
            raise HTTPException(500, "Нечем нарисовать страницу: нет pdftoppm") from None
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
            raise HTTPException(500, f"Страница не нарисовалась: {e}") from None
    return {"page": p, "file": root + ".jpg"}


def chapter_text(book_id: str, n: int) -> str:
    try:
        with open(os.path.join(book_dir(book_id), TEXT, f"{int(n):03d}.txt"), encoding="utf-8") as f:
            return f.read()
    except (OSError, ValueError):
        raise HTTPException(404, f"В книге нет главы {n}") from None


def search(book_id: str, query: str, regex: bool = False, limit: int = 20,
           around: int = 160) -> list[dict]:
    """Поиск по тексту книги: спрашивают обычно словами, а не точной цитатой."""
    if not (query or "").strip():
        raise HTTPException(400, "Пустой запрос")
    try:
        rx = re.compile(query if regex else re.escape(query), re.I)
    except re.error as e:
        raise HTTPException(400, f"Некорректное регулярное выражение: {e}") from None
    hits: list[dict] = []
    for c in chapters(book_id):
        text = chapter_text(book_id, c["n"])
        for m in rx.finditer(text):
            s, e = max(0, m.start() - around), min(len(text), m.end() + around)
            frag = " ".join(text[s:e].split())
            hits.append({"chapter": c["n"], "title": c["title"],
                         "text": ("…" if s else "") + frag + ("…" if e < len(text) else "")})
            if len(hits) >= limit:
                return hits
    return hits


# ── Статистика чтения ──

DAY = re.compile(r"\d{4}-\d{2}-\d{2}")


def _today(tz: int) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(time.time() + int(tz) * 60))


def _shift(day: str, back: int) -> str:
    return (datetime.date.fromisoformat(day) - datetime.timedelta(days=back)).isoformat()


def _streaks(days: set[str], today: str) -> tuple[int, int]:
    """Текущая серия и рекорд. Сегодняшний день ещё не кончился, поэтому серию,
    доходящую до вчера, не обнуляем — иначе она рвётся каждое утро."""
    if not days:
        return 0, 0
    cur = 0
    probe = today if today in days else _shift(today, 1)
    while probe in days:
        cur += 1
        probe = _shift(probe, 1)
    best = run = 0
    prev = None
    for d in sorted(days):
        run = run + 1 if prev == _shift(d, 1) else 1
        best = max(best, run)
        prev = d
    return cur, best


def reading_stats(tz: int = 0, today: str = "", window: int = 182) -> dict:
    """Календарь чтения: по дню — сколько минут и сколько выписок. Плюс разбивка по
    книгам и серии. День считается по часам читателя: их присылает устройство."""
    today = today if DAY.fullmatch(today or "") else _today(tz)
    window = max(7, min(int(window or 182), 730))
    start = _shift(today, window - 1)

    per_day: dict[str, dict] = {}
    per_book: dict[str, dict] = {}
    for r in books_store.reading_days(start):
        if r["day"] > today:
            continue
        d = per_day.setdefault(r["day"], {"day": r["day"], "secs": 0, "pct": 0.0, "highlights": 0})
        d["secs"] += r["secs"]
        d["pct"] += r["pct"]
        b = per_book.setdefault(r["book_id"], {"secs": 0, "pct": 0.0, "days": 0})
        b["secs"] += r["secs"]
        b["pct"] += r["pct"]
        b["days"] += 1
    # День, в который только выделяли, — тоже день чтения: клетка не должна быть пустой.
    for day, n in books_store.highlight_days(tz).items():
        if start <= day <= today:
            per_day.setdefault(day, {"day": day, "secs": 0, "pct": 0.0, "highlights": 0})["highlights"] = n

    days = [per_day[k] for k in sorted(per_day)]
    cur, best = _streaks(set(per_day), today)
    counts = books_store.counts()
    books = []
    for meta in catalog():
        b = per_book.get(meta["id"])
        if not b and not counts.get(meta["id"]):
            continue
        books.append({
            "id": meta["id"], "title": meta.get("title") or "", "author": meta.get("author") or "",
            "secs": (b or {}).get("secs", 0), "pct": round((b or {}).get("pct", 0.0), 4),
            "days": (b or {}).get("days", 0), "highlights": counts.get(meta["id"], 0),
            "at": round((meta.get("position") or {}).get("pct") or 0, 4),
        })
    books.sort(key=lambda x: (-x["secs"], x["title"]))
    return {
        "today": today,
        "from": start,
        "days": days,
        "books": books,
        "totals": {
            "secs": sum(d["secs"] for d in days),
            "days": len([d for d in days if d["secs"] or d["highlights"]]),
            "highlights": sum(d["highlights"] for d in days),
            "streak": cur,
            "best": best,
            "longest_day": max((d["secs"] for d in days), default=0),
        },
    }


# ── Ручки ──


@router.get("")
async def list_books(_: bool = Depends(require_auth)):
    return catalog()


@router.get("/stats")
async def get_stats(tz: int = 0, today: str = "", window: int = 182,
                    _: bool = Depends(require_auth)):
    return reading_stats(tz, today, window)


@router.post("")
async def upload(file: UploadFile, client: str = "", _: bool = Depends(require_auth)):
    data = await file.read()
    if not data:
        raise HTTPException(400, "Пустой файл")
    if len(data) > config.BOOKS_MAX_UPLOAD:
        raise HTTPException(413, "Книга слишком большая")
    meta = ingest(data, file.filename or "")
    books_store.touch("", client)          # полка изменилась у всех
    return meta


def _send(book_id: str, name: str, download: str = "") -> FileResponse:
    path = os.path.join(book_dir(book_id), name)
    if not os.path.isfile(path):
        raise HTTPException(404, "Не найдено")
    media = mimetypes.guess_type(path)[0] or ("application/epub+zip" if name.endswith(".epub")
                                              else "application/octet-stream")
    headers = {}
    if download:
        fname = urllib.parse.quote(download)
        headers["Content-Disposition"] = f"inline; filename*=UTF-8''{fname}"
    return FileResponse(path, media_type=media, headers=headers)


def _guard(request: Request, token: str) -> None:
    """Токен из query — так его шлют <img> и <a>, заголовок им не поставить; из
    Authorization — так его шлёт fetch. Годится любой: иначе книга открывается только
    из кэша, а на чистом устройстве fetch с заголовком получает 401.

    Проверяем до того, как заглянуть в библиотеку: иначе по коду ответа видно,
    какие книги на сервере есть, а какие нет."""
    if not token:
        head = request.headers.get("authorization") or ""
        token = head[7:].strip() if head[:7].lower() == "bearer " else ""
    if not check_token(token):
        raise HTTPException(401, "Unauthorized")


@router.api_route("/{book_id}/file", methods=["GET", "HEAD"])
async def book_file(book_id: str, request: Request, token: str = ""):
    _guard(request, token)
    meta = meta_of(book_id)
    name = meta.get("file") or "book.epub"
    ext = posixpath.splitext(name)[1] or ".epub"
    return _send(book_id, name, f"{meta.get('title') or book_id}{ext}")


@router.api_route("/{book_id}/cover", methods=["GET", "HEAD"])
async def book_cover(book_id: str, request: Request, token: str = ""):
    _guard(request, token)
    cover = meta_of(book_id).get("cover")
    if not cover:
        raise HTTPException(404, "Обложки нет")
    return _send(book_id, cover)


@router.api_route("/{book_id}/thumb", methods=["GET", "HEAD"])
async def book_thumb(book_id: str, request: Request, token: str = ""):
    _guard(request, token)
    if not meta_of(book_id).get("thumb"):
        raise HTTPException(404, "Миниатюры нет")
    return _send(book_id, THUMB)


# ── Прогресс и выписки ──


class PositionReq(BaseModel):
    cfi: str = ""
    pct: float = 0
    chapter: str = ""
    updated: int | None = None


class ReadReq(BaseModel):
    day: str = ""          # дата по часам читателя: сервер про его вечер не знает
    secs: int = 0
    pct: float = 0


@router.get("/{book_id}/state")
async def get_state(book_id: str, _: bool = Depends(require_auth)):
    meta_of(book_id)
    return {"position": books_store.position(book_id),
            "highlights": books_store.highlights(book_id, with_deleted=True)}


@router.put("/{book_id}/position")
async def put_position(book_id: str, req: PositionReq, client: str = "",
                       _: bool = Depends(require_auth)):
    meta_of(book_id)
    saved = books_store.set_position(book_id, req.cfi, req.pct, req.chapter, req.updated)
    books_store.touch(book_id, client)
    return saved


@router.put("/{book_id}/highlights")
async def put_highlights(book_id: str, items: list[dict], client: str = "",
                         _: bool = Depends(require_auth)):
    meta_of(book_id)
    saved = books_store.save_highlights(book_id, items)
    books_store.touch(book_id, client)
    return saved


@router.post("/{book_id}/read")
async def put_reading(book_id: str, req: ReadReq, _: bool = Depends(require_auth)):
    """Сколько читали с прошлой отметки. Тик живой синхронизации на это не шлём:
    читающее устройство отмечается каждые полминуты, будить этим остальные незачем."""
    meta_of(book_id)
    day = req.day if DAY.fullmatch(req.day or "") else _today(0)
    books_store.add_reading(book_id, day, req.secs, req.pct)
    return {"ok": True}


# ── Живая синхронизация ──


@events_router.get("/events")
async def books_events(request: Request, token: str = ""):
    """Тик на каждое изменение: вкладка сама решает, забирать ли состояние. Гонять по
    потоку сами выписки незачем — их всё равно склеивать с локальными."""
    if not check_token(token):
        raise HTTPException(401, "Unauthorized")

    async def gen():
        last = books_store.tick()["v"]      # прошлое не пересылаем: подписались — значит с этого места
        while True:
            if await request.is_disconnected():
                break
            t = books_store.tick()
            if t["v"] != last:
                last = t["v"]
                yield {"event": "books", "data": json.dumps(t, ensure_ascii=False)}
            await asyncio.sleep(1.5)

    return EventSourceResponse(gen())


@router.put("/{book_id}/thumb")
async def put_thumb(book_id: str, request: Request, _: bool = Depends(require_auth)):
    """Миниатюру уменьшает тот, кто книгу добавил: у него файл уже в руках, а серверу
    для этого понадобилась бы библиотека картинок. Остальные устройства качают маленькое."""
    data = await request.body()
    if not data.startswith(b"\xff\xd8\xff"):
        raise HTTPException(400, "Миниатюра должна быть jpeg")
    if len(data) > THUMB_MAX:
        raise HTTPException(413, "Миниатюра слишком большая")
    meta = meta_of(book_id)
    with open(os.path.join(book_dir(book_id), THUMB), "wb") as f:
        f.write(data)
    meta["thumb"] = THUMB
    with open(os.path.join(book_dir(book_id), "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    return meta


@router.delete("/{book_id}")
async def delete_book(book_id: str, client: str = "", _: bool = Depends(require_auth)):
    gone = remove(book_id)
    books_store.touch("", client)
    return gone
