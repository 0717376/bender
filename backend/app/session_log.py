"""Session journal: every conversation turn is logged to SQLite with an FTS5 index.

Nothing is lost on /clear — a session is marked ended, its transcript stays
searchable. The agent reaches past conversations through the session_search
tool (see session_tools.py): discovery (FTS), scroll, read, browse.
"""

import logging
import os
import sqlite3
import threading
from datetime import datetime

from . import config

logger = logging.getLogger("wiki.sessions")

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  last_used TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT,
  msg_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content='messages', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
"""


def init() -> None:
    global _conn
    os.makedirs(config.DATA_DIR, exist_ok=True)
    _conn = sqlite3.connect(os.path.join(config.DATA_DIR, "sessions.db"), check_same_thread=False)
    _conn.row_factory = sqlite3.Row
    _conn.execute("PRAGMA journal_mode=WAL")
    _conn.execute("PRAGMA foreign_keys=ON")
    _conn.executescript(SCHEMA)
    _conn.commit()


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _q(sql: str, params=()) -> list[sqlite3.Row]:
    with _lock:
        return _conn.execute(sql, params).fetchall()


def log_turn(session_id: str | None, source: str, user_text: str, reply_text: str) -> None:
    """Record one completed exchange. Best-effort: journal failures never break a turn."""
    if not session_id or not (user_text or "").strip():
        return
    try:
        now = _now()
        with _lock:
            _conn.execute(
                "INSERT INTO sessions(id,source,title,started_at,last_used) VALUES(?,?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET last_used=excluded.last_used",
                (session_id, source, user_text.strip()[:80], now, now),
            )
            _conn.execute("INSERT INTO messages(session_id,role,content,ts) VALUES(?,?,?,?)",
                          (session_id, "user", user_text.strip(), now))
            if (reply_text or "").strip():
                _conn.execute("INSERT INTO messages(session_id,role,content,ts) VALUES(?,?,?,?)",
                              (session_id, "assistant", reply_text.strip(), now))
            _conn.execute("UPDATE sessions SET msg_count=(SELECT COUNT(*) FROM messages WHERE session_id=?) WHERE id=?",
                          (session_id, session_id))
            _conn.commit()
    except Exception:  # noqa: BLE001
        logger.exception("session log failed")


def end(session_id: str | None, reason: str) -> None:
    """Mark a session ended; the first reason wins."""
    if not session_id:
        return
    try:
        with _lock:
            _conn.execute("UPDATE sessions SET ended_at=?, end_reason=? WHERE id=? AND ended_at IS NULL",
                          (_now(), reason, session_id))
            _conn.commit()
    except Exception:  # noqa: BLE001
        logger.exception("session end failed")


def stats() -> tuple[int, int]:
    """(sessions, messages) for /status."""
    try:
        r = _q("SELECT (SELECT COUNT(*) FROM sessions) AS s, (SELECT COUNT(*) FROM messages) AS m")[0]
        return r["s"], r["m"]
    except Exception:  # noqa: BLE001
        return 0, 0


# --- Retrieval (the session_search tool) ---

def _msg_dict(r: sqlite3.Row, anchor_id: int | None = None) -> dict:
    d = {"id": r["id"], "role": r["role"], "text": r["content"], "ts": r["ts"]}
    if anchor_id is not None and r["id"] == anchor_id:
        d["anchor"] = True
    return d


def _session_head(r: sqlite3.Row) -> dict:
    return {"session_id": r["id"], "source": r["source"], "title": r["title"],
            "started": r["started_at"], "last_used": r["last_used"],
            "ended": r["ended_at"], "messages": r["msg_count"]}


def _anchored_view(session_id: str, anchor_id: int, window: int = 4, bookend: int = 2) -> dict:
    """Hermes-style hit view: bookends (session start/end) + a window around the match."""
    first = _q("SELECT * FROM messages WHERE session_id=? ORDER BY id LIMIT ?", (session_id, bookend))
    last = _q("SELECT * FROM messages WHERE session_id=? ORDER BY id DESC LIMIT ?", (session_id, bookend))
    around = _q("SELECT * FROM messages WHERE session_id=? AND id BETWEEN ? AND ? ORDER BY id",
                (session_id, anchor_id - window, anchor_id + window))
    return {
        "start": [_msg_dict(r) for r in first],
        "around_match": [_msg_dict(r, anchor_id) for r in around],
        "end": [_msg_dict(r) for r in reversed(last)],
    }


def search(query: str, limit: int = 5) -> list[dict]:
    """Discovery: FTS5 → best hit per session → anchored views, newest sessions first on ties."""
    try:
        hits = _q(
            "SELECT m.id, m.session_id, snippet(messages_fts, 0, '>>>', '<<<', '…', 30) AS snip, "
            "bm25(messages_fts) AS rank "
            "FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid "
            "WHERE messages_fts MATCH ? ORDER BY rank LIMIT 60",
            (query,),
        )
    except sqlite3.OperationalError:
        # FTS syntax error (stray quotes/operators) — retry as a quoted phrase set
        safe = " ".join(f'"{w}"' for w in query.replace('"', " ").split())
        if not safe:
            return []
        hits = _q(
            "SELECT m.id, m.session_id, snippet(messages_fts, 0, '>>>', '<<<', '…', 30) AS snip, "
            "bm25(messages_fts) AS rank "
            "FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid "
            "WHERE messages_fts MATCH ? ORDER BY rank LIMIT 60",
            (safe,),
        )
    out, seen = [], set()
    for h in hits:
        if h["session_id"] in seen:
            continue
        seen.add(h["session_id"])
        srow = _q("SELECT * FROM sessions WHERE id=?", (h["session_id"],))
        if not srow:
            continue
        out.append({**_session_head(srow[0]), "snippet": h["snip"],
                    "match_message_id": h["id"],
                    **_anchored_view(h["session_id"], h["id"])})
        if len(out) >= limit:
            break
    return out


def around(session_id: str, message_id: int, window: int = 8) -> dict:
    rows = _q("SELECT * FROM messages WHERE session_id=? AND id BETWEEN ? AND ? ORDER BY id",
              (session_id, message_id - window, message_id + window))
    return {"session_id": session_id, "messages": [_msg_dict(r, message_id) for r in rows]}


def read(session_id: str, head: int = 20, tail: int = 10) -> dict:
    srow = _q("SELECT * FROM sessions WHERE id=?", (session_id,))
    if not srow:
        return {"error": "session not found"}
    total = srow[0]["msg_count"]
    if total <= head + tail:
        msgs = [_msg_dict(r) for r in _q("SELECT * FROM messages WHERE session_id=? ORDER BY id", (session_id,))]
        return {**_session_head(srow[0]), "messages": msgs}
    first = _q("SELECT * FROM messages WHERE session_id=? ORDER BY id LIMIT ?", (session_id, head))
    last = _q("SELECT * FROM messages WHERE session_id=? ORDER BY id DESC LIMIT ?", (session_id, tail))
    return {**_session_head(srow[0]),
            "messages_start": [_msg_dict(r) for r in first],
            "skipped": total - head - tail,
            "messages_end": [_msg_dict(r) for r in reversed(last)]}


def browse(limit: int = 10) -> list[dict]:
    return [_session_head(r) for r in _q("SELECT * FROM sessions ORDER BY last_used DESC LIMIT ?", (limit,))]
