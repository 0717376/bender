"""Библиотека книг: epub-файлы и их производные на диске под BOOKS_DIR.

Источник правды — файловая система, как в вики и хранилище. На книгу — папка:
    <id>/book.epub      сам файл, уже без скриптов (см. sanitize)
    <id>/meta.json      название, автор, размер, когда добавлена
    <id>/cover.<ext>    обложка из epub, как есть
    <id>/thumb.jpg      её же миниатюра: полке хватает, а качать в двадцать раз меньше
    <id>/text/NNN.txt   текст глав: кэш, чтобы агент не разбирал zip на каждый вопрос
    <id>/chapters.json  оглавление: номер главы, файл, название, длина

id — первые 8 байт SHA-256 файла: одна и та же книга, залитая дважды, не двоится.
Удаление — в .trash/, а не rm.
"""

import hashlib
import io
import json
import logging
import mimetypes
import os
import posixpath
import re
import shutil
import time
import urllib.parse
import zipfile
from html.parser import HTMLParser
from xml.etree import ElementTree

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import books_store, config
from .auth import check_token, require_auth

logger = logging.getLogger("wiki")
router = APIRouter(prefix="/books", tags=["books"])

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
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "title"):   # заголовок из head — не текст главы
            self.skip += 1

    def handle_endtag(self, tag):
        if tag in ("script", "style", "title") and self.skip:
            self.skip -= 1
        elif tag in ("p", "div", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6"):
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def plain_text(markup: bytes) -> str:
    p = _Text()
    try:
        p.feed(markup.decode("utf-8", "replace"))
    except Exception:  # noqa: BLE001 — рваная вёрстка не повод терять главу
        pass
    text = "".join(p.parts)
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    return re.sub(r"\n\s*\n\s*\n+", "\n\n", text).strip()


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
        raise HTTPException(400, "Это не epub") from None
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
    toc = []
    for n, ch in enumerate(book["chapters"], 1):
        text = plain_text(zf.read(ch["href"]))
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


# ── Ручки ──


@router.get("")
async def list_books(_: bool = Depends(require_auth)):
    return catalog()


@router.post("")
async def upload(file: UploadFile, _: bool = Depends(require_auth)):
    data = await file.read()
    if not data:
        raise HTTPException(400, "Пустой файл")
    if len(data) > config.BOOKS_MAX_UPLOAD:
        raise HTTPException(413, "Книга слишком большая")
    return ingest(data, file.filename or "")


def _send(book_id: str, name: str, token: str, download: str = "") -> FileResponse:
    # Токен в query: <img> и <a> не умеют ставить заголовок.
    if not check_token(token):
        raise HTTPException(401, "Unauthorized")
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


def _guard(token: str) -> None:
    # Проверяем до того, как заглянуть в библиотеку: иначе по коду ответа видно,
    # какие книги на сервере есть, а какие нет.
    if not check_token(token):
        raise HTTPException(401, "Unauthorized")


@router.api_route("/{book_id}/file", methods=["GET", "HEAD"])
async def book_file(book_id: str, token: str = ""):
    _guard(token)
    meta = meta_of(book_id)
    return _send(book_id, "book.epub", token, f"{meta.get('title') or book_id}.epub")


@router.api_route("/{book_id}/cover", methods=["GET", "HEAD"])
async def book_cover(book_id: str, token: str = ""):
    _guard(token)
    cover = meta_of(book_id).get("cover")
    if not cover:
        raise HTTPException(404, "Обложки нет")
    return _send(book_id, cover, token)


@router.api_route("/{book_id}/thumb", methods=["GET", "HEAD"])
async def book_thumb(book_id: str, token: str = ""):
    _guard(token)
    if not meta_of(book_id).get("thumb"):
        raise HTTPException(404, "Миниатюры нет")
    return _send(book_id, THUMB, token)


# ── Прогресс и выписки ──


class PositionReq(BaseModel):
    cfi: str = ""
    pct: float = 0
    chapter: str = ""
    updated: int | None = None


@router.get("/{book_id}/state")
async def get_state(book_id: str, _: bool = Depends(require_auth)):
    meta_of(book_id)
    return {"position": books_store.position(book_id),
            "highlights": books_store.highlights(book_id, with_deleted=True)}


@router.put("/{book_id}/position")
async def put_position(book_id: str, req: PositionReq, _: bool = Depends(require_auth)):
    meta_of(book_id)
    return books_store.set_position(book_id, req.cfi, req.pct, req.chapter, req.updated)


@router.put("/{book_id}/highlights")
async def put_highlights(book_id: str, items: list[dict], _: bool = Depends(require_auth)):
    meta_of(book_id)
    return books_store.save_highlights(book_id, items)


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
async def delete_book(book_id: str, _: bool = Depends(require_auth)):
    return remove(book_id)
