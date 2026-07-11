import os
import shutil

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from . import config
from .auth import require_auth

router = APIRouter(prefix="/files", tags=["files"])


def safe_path(rel: str) -> str:
    """Resolve a wiki-relative path and ensure it stays inside WIKI_DIR."""
    rel = (rel or "").lstrip("/")
    abs_path = os.path.realpath(os.path.join(config.WIKI_DIR, rel))
    root = os.path.realpath(config.WIKI_DIR)
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
        elif entry.name.endswith(".md"):
            nodes.append({"name": entry.name, "path": rel, "type": "file"})
    return nodes


class WriteReq(BaseModel):
    path: str
    text: str


class CreateReq(BaseModel):
    path: str
    type: str  # "file" | "dir"


class RenameReq(BaseModel):
    src: str
    dst: str


@router.get("/tree")
async def files_tree(_: bool = Depends(require_auth)):
    os.makedirs(config.WIKI_DIR, exist_ok=True)
    return {"tree": build_tree(config.WIKI_DIR, "")}


@router.get("/content")
async def files_content(path: str, _: bool = Depends(require_auth)):
    abs_path = safe_path(path)
    if not os.path.isfile(abs_path):
        raise HTTPException(404, "Файл не найден")
    with open(abs_path, encoding="utf-8") as f:
        return {"path": path, "text": f.read()}


@router.put("/content")
async def files_save(req: WriteReq, _: bool = Depends(require_auth)):
    abs_path = safe_path(req.path)
    os.makedirs(os.path.dirname(abs_path), exist_ok=True)
    with open(abs_path, "w", encoding="utf-8") as f:
        f.write(req.text)
    return {"ok": True}


@router.post("/create")
async def files_create(req: CreateReq, _: bool = Depends(require_auth)):
    abs_path = safe_path(req.path)
    if os.path.exists(abs_path):
        raise HTTPException(409, "Уже существует")
    if req.type == "dir":
        os.makedirs(abs_path, exist_ok=True)
    else:
        os.makedirs(os.path.dirname(abs_path), exist_ok=True)
        with open(abs_path, "w", encoding="utf-8") as f:
            f.write("")
    return {"ok": True}


@router.post("/rename")
async def files_rename(req: RenameReq, _: bool = Depends(require_auth)):
    src = safe_path(req.src)
    dst = safe_path(req.dst)
    if not os.path.exists(src):
        raise HTTPException(404, "Не найдено")
    if os.path.exists(dst):
        raise HTTPException(409, "Цель уже существует")
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    os.rename(src, dst)
    return {"ok": True}


@router.delete("")
async def files_delete(path: str, _: bool = Depends(require_auth)):
    abs_path = safe_path(path)
    if os.path.realpath(abs_path) == os.path.realpath(config.WIKI_DIR):
        raise HTTPException(400, "Нельзя удалить корень")
    if os.path.isdir(abs_path):
        shutil.rmtree(abs_path)
    elif os.path.isfile(abs_path):
        os.remove(abs_path)
    else:
        raise HTTPException(404, "Не найдено")
    return {"ok": True}
