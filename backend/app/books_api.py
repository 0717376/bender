"""Библиотека книг: epub-файлы и их производные на диске под BOOKS_DIR.

Источник правды — файловая система, как в вики и хранилище. На книгу — папка:
    <id>/book.epub      сам файл, уже без скриптов (см. sanitize)
    <id>/meta.json      название, автор, размер, когда добавлена
    <id>/cover.<ext>    обложка из epub, как есть
    <id>/text/NNN.txt   текст глав: кэш, чтобы агент не разбирал zip на каждый вопрос

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

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import FileResponse

from . import config
from .auth import check_token, require_auth

logger = logging.getLogger("wiki")
router = APIRouter(prefix="/books", tags=["books"])

CONTAINER = "META-INF/container.xml"
NS_CONTAINER = "urn:oasis:names:tc:opendocument:xmlns:container"
NS_OPF = "http://www.idpf.org/2007/opf"
NS_DC = "http://purl.org/dc/elements/1.1/"
MARKUP = (".xhtml", ".html", ".htm", ".svg")


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
        href = urllib.parse.unquote(href.split("#")[0])
        return posixpath.normpath(posixpath.join(base, href)) if base else href

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

    chapters: list[str] = []
    for ref in opf.iter(f"{{{NS_OPF}}}itemref"):
        it = items.get(ref.get("idref", ""))
        if it and "html" in it["type"]:
            chapters.append(it["href"])
    if not chapters:
        raise HTTPException(400, "В epub нет ни одной главы")

    names = set(zf.namelist())
    return {
        "title": first("title"),
        "author": first("creator"),
        "cover": cover if cover in names else "",
        "chapters": [c for c in chapters if c in names],
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
    for name in os.listdir(config.BOOKS_DIR) if os.path.isdir(config.BOOKS_DIR) else []:
        if name.startswith(".") or not os.path.isdir(os.path.join(config.BOOKS_DIR, name)):
            continue
        try:
            out.append(meta_of(name))
        except HTTPException:
            continue
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
    os.makedirs(os.path.join(tmp, "text"), exist_ok=True)
    with open(os.path.join(tmp, "book.epub"), "wb") as f:
        f.write(clean)
    cover_name = ""
    if book["cover"]:
        cover_name = "cover" + (posixpath.splitext(book["cover"])[1] or ".jpg")
        with open(os.path.join(tmp, cover_name), "wb") as f:
            f.write(zf.read(book["cover"]))
    for n, href in enumerate(book["chapters"], 1):
        with open(os.path.join(tmp, "text", f"{n:03d}.txt"), "w", encoding="utf-8") as f:
            f.write(plain_text(zf.read(href)))

    meta = {
        "id": bid,
        "title": book["title"] or os.path.splitext(filename)[0] or "Книга",
        "author": book["author"],
        "added": int(time.time()),
        "size": len(clean),
        "chapters": len(book["chapters"]),
        "cover": cover_name,
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
    return {"ok": True, "trashed": os.path.basename(dest)}


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


@router.api_route("/{book_id}/file", methods=["GET", "HEAD"])
async def book_file(book_id: str, token: str = ""):
    meta = meta_of(book_id)
    return _send(book_id, "book.epub", token, f"{meta.get('title') or book_id}.epub")


@router.api_route("/{book_id}/cover", methods=["GET", "HEAD"])
async def book_cover(book_id: str, token: str = ""):
    cover = meta_of(book_id).get("cover")
    if not cover:
        raise HTTPException(404, "Обложки нет")
    return _send(book_id, cover, token)


@router.delete("/{book_id}")
async def delete_book(book_id: str, _: bool = Depends(require_auth)):
    return remove(book_id)
