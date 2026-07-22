"""Personal file storage API: plain folders on disk under FILES_DIR.

The filesystem is the source of truth — no database. Deletes go to .trash/
instead of unlinking. Uploads land via temp file + rename (atomic).
"""

import mimetypes
import os
import re
import shutil
import time
import unicodedata
import urllib.parse

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import config
from .auth import check_token, require_auth

router = APIRouter(prefix="/storage", tags=["storage"])


def init() -> None:
    os.makedirs(os.path.join(config.FILES_DIR, config.FILES_INBOX), exist_ok=True)


# Telegram and browsers ship names with zero-width/bidi marks and exotic spaces
# that later break shell handling and links.
_INVISIBLE = re.compile("[\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f\\ufeff\\u00ad]")
_ODD_SPACE = re.compile("[\\u00a0\\u2000-\\u200a\\u202f\\u205f\\u3000]")


def clean_name(name: str) -> str:
    name = unicodedata.normalize("NFC", name)
    name = _INVISIBLE.sub("", name)
    name = _ODD_SPACE.sub(" ", name)
    name = "".join(c for c in name if c.isprintable())
    return re.sub(r"\s+", " ", name).strip() or "файл"


def safe_path(rel: str) -> str:
    rel = (rel or "").strip().lstrip("/")
    abs_path = os.path.realpath(os.path.join(config.FILES_DIR, rel))
    root = os.path.realpath(config.FILES_DIR)
    if abs_path != root and not abs_path.startswith(root + os.sep):
        raise HTTPException(400, "Недопустимый путь")
    return abs_path


def build_tree(abs_dir: str, rel_prefix: str) -> list[dict]:
    nodes: list[dict] = []
    try:
        entries = sorted(os.scandir(abs_dir), key=lambda e: (e.is_file(), e.name.lower()))
    except FileNotFoundError:
        return nodes
    for entry in entries:
        if entry.name.startswith("."):
            continue
        rel = f"{rel_prefix}{entry.name}"
        if entry.is_dir():
            nodes.append({
                "name": entry.name, "path": rel, "type": "dir",
                "children": build_tree(entry.path, rel + "/"),
            })
        else:
            st = entry.stat()
            nodes.append({
                "name": entry.name, "path": rel, "type": "file",
                "size": st.st_size, "mtime": int(st.st_mtime),
            })
    return nodes


class PathReq(BaseModel):
    path: str


class MoveReq(BaseModel):
    src: str
    dst: str


@router.get("/tree")
async def tree(_: bool = Depends(require_auth)):
    init()
    return {"tree": build_tree(config.FILES_DIR, "")}


@router.api_route("/file", methods=["GET", "HEAD"])
async def download(path: str, token: str = ""):
    # Token via query: <img>/<iframe>/<a> can't set the Bearer header.
    if not check_token(token):
        raise HTTPException(401, "Unauthorized")
    abs_path = safe_path(path)
    if not os.path.isfile(abs_path):
        raise HTTPException(404, "Файл не найден")
    media_type = mimetypes.guess_type(abs_path)[0] or "application/octet-stream"
    fname = urllib.parse.quote(os.path.basename(abs_path))
    return FileResponse(abs_path, media_type=media_type, headers={
        "Content-Disposition": f"inline; filename*=UTF-8''{fname}",
    })


@router.post("/upload")
async def upload(file: UploadFile, dir: str = "", _: bool = Depends(require_auth)):
    abs_dir = safe_path(dir)
    os.makedirs(abs_dir, exist_ok=True)
    name = clean_name(os.path.basename(file.filename or "файл"))
    dest = os.path.join(abs_dir, name)
    if os.path.exists(dest):
        stem, ext = os.path.splitext(name)
        dest = os.path.join(abs_dir, f"{stem}-{int(time.time())}{ext}")
    tmp = dest + ".part"
    size = 0
    try:
        with open(tmp, "wb") as out:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > config.FILES_MAX_UPLOAD:
                    raise HTTPException(413, "Файл слишком большой")
                out.write(chunk)
        os.replace(tmp, dest)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    rel = os.path.relpath(dest, config.FILES_DIR)
    return {"ok": True, "path": rel, "size": size}


@router.post("/mkdir")
async def mkdir(req: PathReq, _: bool = Depends(require_auth)):
    abs_path = safe_path(req.path)
    if os.path.exists(abs_path):
        raise HTTPException(409, "Уже существует")
    os.makedirs(abs_path)
    return {"ok": True}


@router.post("/move")
async def move(req: MoveReq, _: bool = Depends(require_auth)):
    src, dst = safe_path(req.src), safe_path(req.dst)
    if not os.path.exists(src):
        raise HTTPException(404, "Не найдено")
    if os.path.exists(dst):
        raise HTTPException(409, "Цель уже существует")
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    os.rename(src, dst)
    return {"ok": True}


@router.delete("")
async def delete(path: str, _: bool = Depends(require_auth)):
    abs_path = safe_path(path)
    root = os.path.realpath(config.FILES_DIR)
    if os.path.realpath(abs_path) == root:
        raise HTTPException(400, "Нельзя удалить корень")
    if not os.path.exists(abs_path):
        raise HTTPException(404, "Не найдено")
    trash = os.path.join(root, config.FILES_TRASH)
    os.makedirs(trash, exist_ok=True)
    dest = os.path.join(trash, f"{int(time.time())}-{os.path.basename(abs_path)}")
    shutil.move(abs_path, dest)
    return {"ok": True, "trashed": os.path.relpath(dest, root)}
