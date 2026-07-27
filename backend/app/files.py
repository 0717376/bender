import os
import re
import shutil
import time
import unicodedata
from urllib.parse import quote, unquote

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from . import config
from .auth import require_auth

router = APIRouter(prefix="/files", tags=["files"])

TRASH = config.WIKI_TRASH
TRASH_KEEP_DAYS = 30


def safe_path(rel: str) -> str:
    """Resolve a wiki-relative path and ensure it stays inside WIKI_DIR."""
    rel = (rel or "").lstrip("/")
    abs_path = os.path.realpath(os.path.join(config.WIKI_DIR, rel))
    root = os.path.realpath(config.WIKI_DIR)
    if abs_path != root and not abs_path.startswith(root + os.sep):
        raise HTTPException(400, "Недопустимый путь")
    return abs_path


def rel_path(abs_path: str) -> str:
    """Путь относительно корня вики. Обе стороны через realpath: сам корень бывает
    симлинком (на macOS /tmp → /private/tmp), и тогда relpath уезжает в «../..»."""
    return os.path.relpath(os.path.realpath(abs_path), os.path.realpath(config.WIKI_DIR))


# ── Имена файлов ──

CYR = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "ж": "zh",
    "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o",
    "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "h", "ц": "c",
    "ч": "ch", "ш": "sh", "щ": "sch", "ъ": "", "ы": "y", "ь": "", "э": "e",
    "ю": "yu", "я": "ya",
}


def slugify(raw: str) -> str:
    """Человеческое имя → имя файла: латиница, нижний регистр, дефисы.

    Имя файла — идентификатор страницы: оно попадает в URL, в ссылки, в git diff
    и в ssh-команды, поэтому держим его ascii-безопасным. Заголовок живёт внутри
    страницы и правится свободно; слаг за ним не следует (иначе каждое
    переименование рвало бы ссылки).
    """
    out: list[str] = []
    for ch in (raw or "").strip().lower():
        if ch in CYR:
            out.append(CYR[ch])
        elif ch.isascii() and (ch.isalnum() or ch in "-_"):
            out.append(ch)
        elif ch.isalpha():
            # ü → u, é → e; всё, что не разложилось в латиницу, — в дефис
            plain = "".join(c for c in unicodedata.normalize("NFKD", ch) if c.isascii())
            out.append(plain.lower() if plain.isalnum() else "-")
        else:
            out.append("-")
    slug = re.sub(r"-{2,}", "-", "".join(out)).strip("-_")
    return slug or "page"


# Имена по договорённости, а не человеческие: слаг сделал бы из CLAUDE.md
# claude.md, и Claude Code перестал бы её читать (в контейнере ФС регистрозависима).
RESERVED_NAMES = {"CLAUDE.md", "AGENTS.md", "index.md"}


def slug_path(rel: str) -> str:
    """Слагифицировать каждый сегмент пути, сохранив расширение .md.

    Путь, который уже есть на диске, не трогаем: иначе запись в существующую
    страницу с кириллическим именем создала бы рядом её латинского двойника.
    """
    rel = (rel or "").strip().lstrip("/")
    if not rel or os.path.exists(os.path.join(config.WIKI_DIR, rel)):
        return rel
    parts = [p for p in rel.split("/") if p not in ("", ".", "..")]
    if not parts:
        return rel
    if parts[-1] in RESERVED_NAMES:
        return "/".join([slugify(p) for p in parts[:-1]] + [parts[-1]])
    tail = parts[-1]
    stem, dot, ext = tail.rpartition(".")
    if dot and ext.lower() == "md":
        parts[-1] = slugify(stem) + ".md"
    else:
        parts[-1] = slugify(tail)
    return "/".join([slugify(p) for p in parts[:-1]] + [parts[-1]])


def free_path(abs_path: str) -> str:
    """`имя.md` занято → `имя-2.md`."""
    if not os.path.exists(abs_path):
        return abs_path
    stem, ext = os.path.splitext(abs_path)
    n = 2
    while os.path.exists(f"{stem}-{n}{ext}"):
        n += 1
    return f"{stem}-{n}{ext}"


def page_title(abs_path: str) -> str | None:
    """Первый заголовок `# ...` из начала файла — человеческое имя страницы."""
    try:
        with open(abs_path, encoding="utf-8", errors="ignore") as f:
            for line in f.read(4096).splitlines():
                s = line.strip()
                if s.startswith("# "):
                    return s[2:].strip() or None
                if s and not s.startswith(("#", "---", "<!--")):
                    break
    except OSError:
        pass
    return None


def page_label(rel: str) -> str:
    """Как звать страницу, у которой нет заголовка `# ...`: родительскую — по её
    папке (слово «index» пользователь видеть не должен), обычную — по имени файла."""
    base = os.path.basename(rel)
    if base.endswith(".md"):
        base = base[:-3]
    if base == "index" and "/" in rel:
        return os.path.basename(os.path.dirname(rel))
    return base


def build_tree(abs_dir: str, rel_prefix: str) -> list[dict]:
    """Дерево страниц. Папка с `index.md` — это одна страница с детьми (как в
    Confluence), поэтому сам index.md отдельной строкой не показываем."""
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
            node = {
                "name": entry.name, "path": rel, "type": "dir",
                "children": build_tree(entry.path, rel + "/"),
            }
            index = os.path.join(entry.path, "index.md")
            if os.path.isfile(index):
                node["page"] = f"{rel}/index.md"
                node["title"] = page_title(index) or entry.name
                node["mtime"] = int(os.stat(index).st_mtime)
            nodes.append(node)
        elif entry.name.endswith(".md"):
            if entry.name == "index.md" and rel_prefix:
                continue  # уже показан как сама папка
            nodes.append({
                "name": entry.name, "path": rel, "type": "file",
                "title": page_title(entry.path), "mtime": int(entry.stat().st_mtime),
            })
    return nodes


def walk_pages(root: str | None = None):
    """Все страницы вики как пути относительно корня (корзина не в счёт)."""
    base = root or config.WIKI_DIR
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for name in sorted(filenames):
            if name.endswith(".md") and not name.startswith("."):
                yield os.path.relpath(os.path.join(dirpath, name), config.WIKI_DIR)


# ── Ссылки между страницами ──

# `](путь)` и `](путь "подпись")` — сюда же попадают картинки `![alt](путь)`.
LINK_RX = re.compile(r"\]\(\s*<?([^)<>\s]+)>?((?:\s+\"[^\"]*\")?)\s*\)")
EXTERNAL_RX = re.compile(r"^[a-z][a-z0-9+.-]*:", re.I)


def _link_target(from_rel: str, href: str) -> str | None:
    """Куда указывает ссылка href со страницы from_rel. None — не ссылка на вики."""
    if not href or href.startswith(("#", "//")) or EXTERNAL_RX.match(href):
        return None
    path = unquote(href.split("#", 1)[0])
    if not path:
        return None
    if path.startswith("/"):
        return os.path.normpath(path.lstrip("/"))
    return os.path.normpath(os.path.join(os.path.dirname(from_rel), path))


def _href(from_rel: str, target_rel: str) -> str:
    """Ссылка на target_rel со страницы from_rel — относительная, как её пишут люди."""
    rel = os.path.relpath(target_rel, os.path.dirname(from_rel) or ".")
    return quote(rel, safe="/._-~()")


def rewrite_links(moves: dict[str, str]) -> int:
    """Починить ссылки после переноса страниц. moves: старый путь → новый.

    Зовётся уже после перемещения файлов: ссылки внутри самих переехавших страниц
    тоже становятся неверными (сменилась их папка), поэтому их разрешаем от
    старого места, а записываем от нового.
    """
    if not moves:
        return 0
    back = {new: old for old, new in moves.items()}
    touched = 0
    for cur_rel in list(walk_pages()):
        src_rel = back.get(cur_rel, cur_rel)
        abs_path = os.path.join(config.WIKI_DIR, cur_rel)
        try:
            with open(abs_path, encoding="utf-8") as f:
                text = f.read()
        except (OSError, UnicodeDecodeError):
            continue

        def repl(m: re.Match) -> str:
            href, title = m.group(1), m.group(2)
            target = _link_target(src_rel, href)
            if target is None:
                return m.group(0)
            dest = moves.get(target, target)
            if dest == target and cur_rel == src_rel:
                return m.group(0)
            frag = href.split("#", 1)
            anchor = "#" + frag[1] if len(frag) > 1 else ""
            return f"]({_href(cur_rel, dest)}{anchor}{title})"

        new_text = LINK_RX.sub(repl, text)
        if new_text != text:
            with open(abs_path, "w", encoding="utf-8") as f:
                f.write(new_text)
            touched += 1
    return touched


def moves_for(src_rel: str, dst_rel: str) -> dict[str, str]:
    """Карта переездов страниц: для файла — одна пара, для папки — все страницы внутри."""
    abs_dst = os.path.join(config.WIKI_DIR, dst_rel)
    if os.path.isdir(abs_dst):
        return {
            f"{src_rel}/{os.path.relpath(p, dst_rel)}": p
            for p in walk_pages(abs_dst)
        }
    return {src_rel: dst_rel} if dst_rel.endswith(".md") else {}


# ── Родительские страницы ──
#
# Главное правило: папок как отдельной сущности не существует. У всякой папки есть
# своя страница — её index.md, — и пользователь видит только страницы. Всё, что ниже,
# охраняет этот инвариант, чтобы «папка» не всплыла в интерфейсе.

def promote(rel: str) -> str:
    """`x.md` → `x/index.md`: страница становится родителем и получает детей.

    Ссылки на неё переписываются здесь же — иначе первое добавление дочерней
    страницы тихо ломало бы все ссылки на родителя.
    """
    abs_src = os.path.join(config.WIKI_DIR, rel)
    folder = abs_src[:-3]
    index = os.path.join(folder, "index.md")
    if os.path.exists(index):
        raise ValueError("Страница с таким именем уже есть")
    dst = f"{rel[:-3]}/index.md"
    os.makedirs(folder, exist_ok=True)
    os.rename(abs_src, index)
    rewrite_links({rel: dst})
    return dst


def ensure_page(rel_dir: str) -> str:
    """Дать папке её страницу. Если рядом лежит `x.md` — это она и есть.

    Страница заводится пустой. Человеческого имени у папки нет — есть только слаг,
    и написать `# notes` заголовком значило бы выдать идентификатор за название:
    пользователю пришлось бы сначала стереть выдумку, а потом писать своё. Дерево
    и поиск в отсутствие заголовка и так зовут страницу по папке (page_label).
    """
    abs_dir = os.path.join(config.WIKI_DIR, rel_dir)
    index = os.path.join(abs_dir, "index.md")
    if os.path.isfile(index):
        return f"{rel_dir}/index.md"
    if os.path.isfile(abs_dir + ".md"):
        return promote(f"{rel_dir}.md")
    os.makedirs(abs_dir, exist_ok=True)
    with open(index, "w", encoding="utf-8") as f:
        f.write("")
    return f"{rel_dir}/index.md"


def page_folder(parent: str) -> str:
    """Папка, в которой живут дети этой страницы; обычную страницу продвигает.

    Принимает и путь страницы (`x.md`, `x/index.md`), и путь папки, и пустую строку
    для корня — вызывающему не нужно знать, кем родитель был до этого.
    """
    parent = (parent or "").strip().lstrip("/")
    if not parent:
        return ""
    if parent.endswith("/index.md"):
        return parent[: -len("/index.md")]
    if parent.endswith(".md"):
        promote(parent)
        return parent[:-3]
    ensure_page(parent)
    return parent


def ensure_parent(abs_path: str) -> None:
    """Создать папки под abs_path — каждую сразу со своей страницей."""
    parts = rel_path(os.path.dirname(abs_path)).split(os.sep)
    cur = ""
    for part in parts:
        if part in ("", "."):
            continue
        cur = f"{cur}/{part}" if cur else part
        ensure_page(cur)


def normalize_pages() -> list[tuple[str, str]]:
    """Разовая починка при старте: папкам без страницы её выдать.

    Папки заводит не только интерфейс — их создаёт агент через Bash, они приезжают
    из бэкапов. Без этого в дереве всплыла бы «папка», которой в модели нет.

    Возвращает [(путь страницы, 'promoted' | 'created')] — чтобы вмешательство в
    чужой контент не было молчаливым: страницы, заведённые без спроса, должны быть
    названы в логе поимённо.
    """
    made: list[tuple[str, str]] = []
    for dirpath, dirnames, _ in os.walk(config.WIKI_DIR):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for name in dirnames:
            abs_dir = os.path.join(dirpath, name)
            if os.path.isfile(os.path.join(abs_dir, "index.md")):
                continue
            rel = rel_path(abs_dir)
            how = "promoted" if os.path.isfile(abs_dir + ".md") else "created"
            made.append((ensure_page(rel), how))
    return made


def move(src_rel: str, dst_rel: str) -> None:
    """Перенести страницу или ветку, починив ссылки во всей вики."""
    src = os.path.join(config.WIKI_DIR, src_rel)
    dst = os.path.join(config.WIKI_DIR, dst_rel)
    if not os.path.exists(src):
        raise ValueError(f"Не найдено: {src_rel}")
    if os.path.exists(dst):
        raise ValueError(f"Цель уже существует: {dst_rel}")
    ensure_parent(dst)
    os.rename(src, dst)
    rewrite_links(moves_for(src_rel, dst_rel))


def to_trash(rel: str) -> str:
    """Удаление — это перенос в `.trash/`: у страницы-родителя внутри дети,
    и безвозвратный rmtree унёс бы ветку целиком."""
    abs_path = os.path.join(config.WIKI_DIR, rel)
    root = os.path.realpath(config.WIKI_DIR)
    if os.path.realpath(abs_path) == root:
        raise ValueError("Нельзя удалить корень")
    if not os.path.exists(abs_path):
        raise ValueError(f"Не найдено: {rel}")
    trash = os.path.join(root, TRASH)
    os.makedirs(trash, exist_ok=True)
    purge_trash(trash)
    dest = os.path.join(trash, f"{int(time.time())}-{os.path.basename(abs_path)}")
    shutil.move(abs_path, dest)
    return rel_path(dest)


def purge_trash(root: str) -> None:
    """Старьё из корзины чистим при следующем удалении — иначе она растёт вечно."""
    cutoff = time.time() - TRASH_KEEP_DAYS * 86400
    try:
        entries = list(os.scandir(root))
    except OSError:
        return
    for e in entries:
        try:
            if e.stat().st_mtime < cutoff:
                shutil.rmtree(e.path) if e.is_dir() else os.remove(e.path)
        except OSError:
            continue


def snippet(text: str, needle: str, width: int = 110) -> str:
    """Строка с совпадением, обрезанная вокруг него."""
    at = text.lower().find(needle)
    if at == -1:
        return ""
    start = text.rfind("\n", 0, at) + 1
    end = text.find("\n", at)
    line = text[start:end if end != -1 else len(text)].strip()
    pos = line.lower().find(needle)
    if len(line) <= width:
        return line
    left = max(0, pos - width // 3)
    out = line[left:left + width].strip()
    return ("…" if left else "") + out + "…"


class WriteReq(BaseModel):
    path: str
    text: str


class CreateReq(BaseModel):
    path: str


class RenameReq(BaseModel):
    src: str
    dst: str


class ChildReq(BaseModel):
    parent: str  # путь родительской страницы; "" — корень вики
    title: str


class ReparentReq(BaseModel):
    src: str
    parent: str  # новая родительская страница; "" — корень вики


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


@router.get("/search")
async def files_search(q: str, limit: int = 30, _: bool = Depends(require_auth)):
    """Поиск по вики: сначала совпадения в названии страницы, потом в тексте."""
    needle = q.strip().lower()
    if not needle:
        return {"results": []}
    by_title: list[dict] = []
    by_text: list[dict] = []
    for rel in walk_pages():
        abs_path = os.path.join(config.WIKI_DIR, rel)
        try:
            with open(abs_path, encoding="utf-8", errors="ignore") as f:
                text = f.read()
        except OSError:
            continue
        title = page_title(abs_path) or page_label(rel)
        hit = {"path": rel, "title": title, "snippet": snippet(text, needle)}
        if needle in title.lower() or needle in rel.lower():
            by_title.append(hit)
        elif needle in text.lower():
            by_text.append(hit)
    return {"results": (by_title + by_text)[:limit]}


@router.put("/content")
async def files_save(req: WriteReq, _: bool = Depends(require_auth)):
    abs_path = safe_path(req.path)
    ensure_parent(abs_path)
    with open(abs_path, "w", encoding="utf-8") as f:
        f.write(req.text)
    return {"ok": True}


@router.post("/create")
async def files_create(req: CreateReq, _: bool = Depends(require_auth)):
    path = slug_path(req.path)
    abs_path = safe_path(path)
    if os.path.exists(abs_path):
        raise HTTPException(409, "Уже существует")
    ensure_parent(abs_path)
    with open(abs_path, "w", encoding="utf-8") as f:
        f.write("")
    return {"ok": True, "path": path}


@router.post("/child")
async def files_child(req: ChildReq, _: bool = Depends(require_auth)):
    """Дочерняя страница. Родитель при необходимости сам становится родительским —
    слова «index» и «папка» пользователь не видит никогда."""
    title = req.title.strip()
    if not title:
        raise HTTPException(400, "Пустой заголовок")
    safe_path(req.parent)
    try:
        folder = page_folder(req.parent)
    except ValueError as e:
        raise HTTPException(409, str(e)) from None
    abs_path = free_path(os.path.join(safe_path(folder), slugify(title) + ".md"))
    with open(abs_path, "w", encoding="utf-8") as f:
        f.write(f"# {title}\n")
    return {"ok": True, "path": rel_path(abs_path)}


@router.post("/reparent")
async def files_reparent(req: ReparentReq, _: bool = Depends(require_auth)):
    """Перенести страницу под другую страницу (перетаскивание в дереве)."""
    src_rel = rel_path(safe_path(req.src))
    safe_path(req.parent)
    try:
        folder = page_folder(req.parent)
        dst_rel = f"{folder}/{os.path.basename(src_rel)}" if folder else os.path.basename(src_rel)
        move(src_rel, dst_rel)
    except ValueError as e:
        raise HTTPException(409, str(e)) from None
    return {"ok": True, "path": dst_rel}


@router.post("/rename")
async def files_rename(req: RenameReq, _: bool = Depends(require_auth)):
    src_rel = rel_path(safe_path(req.src))
    dst_rel = rel_path(safe_path(req.dst))
    try:
        move(src_rel, dst_rel)
    except ValueError as e:
        raise HTTPException(409, str(e)) from None
    return {"ok": True}


@router.delete("")
async def files_delete(path: str, _: bool = Depends(require_auth)):
    rel = rel_path(safe_path(path))
    try:
        return {"ok": True, "trashed": to_trash(rel)}
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
