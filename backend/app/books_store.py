"""Прогресс чтения и выписки: sqlite рядом с задачами (data/books.db).

Раньше состояние читалки лежало одним json в скрытой странице вики, а склеивали его
устройства между собой. Теперь порядок операций один — серверный, и склейка сводится к
«кто позже тронул, тот и прав» по полю updated. Удаление — надгробием (deleted=1),
иначе стёртая выписка воскресает со второго устройства, которое о ней ещё не знает.
"""

import json
import os
import sqlite3
import threading
import time

from . import config

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS positions (
  book_id  TEXT PRIMARY KEY,
  cfi      TEXT,
  pct      REAL    NOT NULL DEFAULT 0,
  chapter  TEXT    NOT NULL DEFAULT '',
  updated  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS highlights (
  id       TEXT PRIMARY KEY,
  book_id  TEXT NOT NULL,
  cfi      TEXT NOT NULL,
  text     TEXT NOT NULL DEFAULT '',
  color    TEXT NOT NULL DEFAULT '',
  chapter  TEXT NOT NULL DEFAULT '',
  thread   TEXT NOT NULL DEFAULT '[]',
  created  INTEGER NOT NULL DEFAULT 0,
  updated  INTEGER NOT NULL DEFAULT 0,
  deleted  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_hl_book ON highlights(book_id);
"""


def init() -> None:
    global _conn
    os.makedirs(config.DATA_DIR, exist_ok=True)
    _conn = sqlite3.connect(os.path.join(config.DATA_DIR, "books.db"), check_same_thread=False)
    _conn.row_factory = sqlite3.Row
    _conn.execute("PRAGMA journal_mode=WAL")
    _conn.executescript(SCHEMA)
    _conn.commit()


def now() -> int:
    return int(time.time() * 1000)


def _q(sql: str, params=()) -> list[sqlite3.Row]:
    with _lock:
        return _conn.execute(sql, params).fetchall()


def _w(sql: str, params=()) -> None:
    with _lock:
        _conn.execute(sql, params)
        _conn.commit()


# ── Позиция ──


def position(book_id: str) -> dict | None:
    rows = _q("SELECT cfi, pct, chapter, updated FROM positions WHERE book_id=?", (book_id,))
    return dict(rows[0]) if rows else None


def set_position(book_id: str, cfi: str, pct: float = 0, chapter: str = "",
                 updated: int | None = None) -> dict:
    """Позже тронутое побеждает: с двух устройств прилетает одно и то же поле."""
    stamp = updated or now()
    have = position(book_id)
    if have and have["updated"] > stamp:
        return have
    _w("INSERT INTO positions (book_id, cfi, pct, chapter, updated) VALUES (?,?,?,?,?) "
       "ON CONFLICT(book_id) DO UPDATE SET cfi=excluded.cfi, pct=excluded.pct, "
       "chapter=excluded.chapter, updated=excluded.updated",
       (book_id, cfi, float(pct or 0), chapter or "", stamp))
    return position(book_id)


# ── Выписки ──


def _row(r: sqlite3.Row) -> dict:
    d = dict(r)
    try:
        d["thread"] = json.loads(d.get("thread") or "[]")
    except json.JSONDecodeError:
        d["thread"] = []
    d["deleted"] = bool(d["deleted"])
    return d


def highlights(book_id: str, with_deleted: bool = False) -> list[dict]:
    sql = "SELECT * FROM highlights WHERE book_id=?"
    if not with_deleted:
        sql += " AND deleted=0"
    return [_row(r) for r in _q(sql + " ORDER BY created", (book_id,))]


def save_highlights(book_id: str, items: list[dict]) -> list[dict]:
    """Пачкой: и создание, и правка, и удаление. Клиент шлёт то, что у него изменилось,
    сервер оставляет более позднюю версию каждой выписки."""
    with _lock:
        for h in items:
            hid = str(h.get("id") or "").strip()
            if not hid:
                continue
            stamp = int(h.get("updated") or 0) or now()
            row = _conn.execute("SELECT updated FROM highlights WHERE id=?", (hid,)).fetchone()
            if row and row["updated"] > stamp:
                continue
            _conn.execute(
                "INSERT INTO highlights (id, book_id, cfi, text, color, chapter, thread, "
                "created, updated, deleted) VALUES (?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET cfi=excluded.cfi, text=excluded.text, "
                "color=excluded.color, chapter=excluded.chapter, thread=excluded.thread, "
                "updated=excluded.updated, deleted=excluded.deleted",
                (hid, book_id, h.get("cfi") or "", h.get("text") or "", h.get("color") or "",
                 h.get("chapter") or "", json.dumps(h.get("thread") or [], ensure_ascii=False),
                 int(h.get("created") or stamp), stamp, 1 if h.get("deleted") else 0))
        _conn.commit()
    return highlights(book_id, with_deleted=True)


def counts() -> dict[str, int]:
    return {r["book_id"]: r["n"] for r in
            _q("SELECT book_id, COUNT(*) AS n FROM highlights WHERE deleted=0 GROUP BY book_id")}


def positions() -> dict[str, dict]:
    return {r["book_id"]: dict(r) for r in
            _q("SELECT book_id, cfi, pct, chapter, updated FROM positions")}


def forget(book_id: str) -> None:
    """Книгу удалили — прогресс и выписки уходят с ней."""
    with _lock:
        _conn.execute("DELETE FROM positions WHERE book_id=?", (book_id,))
        _conn.execute("DELETE FROM highlights WHERE book_id=?", (book_id,))
        _conn.commit()
