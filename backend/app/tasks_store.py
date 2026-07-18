"""SQLite store for the Tasks domain (Things-like model).

Areas ⊃ Projects ⊃ Tasks ⊃ Checklist items. Shared by the REST API and the
agent's in-process tools, so the chat assistant and the Tasks UI see the same data.
"""

import calendar
import json
import os
import sqlite3
import threading
from datetime import date, timedelta

from . import config

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None

# Monotonic data version, bumped on every write. The SSE /tasks/events endpoint polls
# this so open boards live-refresh when the agent (chat/Telegram/cron) mutates tasks.
_version = 0


def version() -> int:
    return _version

SCHEMA = """
CREATE TABLE IF NOT EXISTS areas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  sort REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  area_id INTEGER REFERENCES areas(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open',
  when_date TEXT,
  deadline TEXT,
  someday INTEGER NOT NULL DEFAULT 0,
  sort REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  area_id INTEGER REFERENCES areas(id) ON DELETE SET NULL,
  when_date TEXT,
  deadline TEXT,
  someday INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]',
  sort REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS task_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  old_date TEXT NOT NULL,
  new_date TEXT NOT NULL,
  moved_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  sort REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_moves_task ON task_moves(task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_when ON tasks(when_date);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
"""


def init() -> None:
    global _conn
    os.makedirs(config.DATA_DIR, exist_ok=True)
    _conn = sqlite3.connect(os.path.join(config.DATA_DIR, "tasks.db"), check_same_thread=False)
    _conn.row_factory = sqlite3.Row
    _conn.execute("PRAGMA journal_mode=WAL")
    _conn.execute("PRAGMA foreign_keys=ON")
    _conn.executescript(SCHEMA)
    # Backfill a stable manual order for pre-existing rows (sort defaulted to 0 → ties on id).
    _conn.execute("UPDATE tasks SET sort=id WHERE sort=0")
    # Additive migrations for pre-existing DBs.
    cols = {r["name"] for r in _conn.execute("PRAGMA table_info(tasks)")}
    if "repeat" not in cols:
        # JSON rule: {"unit": day|week|month|year, "interval": n, "mode": schedule|done}
        _conn.execute("ALTER TABLE tasks ADD COLUMN repeat TEXT")
    if "spawned_id" not in cols:
        # Occurrence created when this (repeating) task was completed — lets undo remove it.
        _conn.execute("ALTER TABLE tasks ADD COLUMN spawned_id INTEGER")
    if "deleted_at" not in cols:
        # Soft delete: rows linger for undo, purged after 30 days.
        _conn.execute("ALTER TABLE tasks ADD COLUMN deleted_at TEXT")
    if "kind" not in cols:
        # 'task' | 'heading' — headings are section dividers inside a project list.
        _conn.execute("ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'task'")
    if "triaged" not in cols:
        # 0 = never scheduled/filed anywhere → lives in Inbox; 1 = user decided "when",
        # so a dateless task shows in Anytime even without a project (Things-style).
        _conn.execute("ALTER TABLE tasks ADD COLUMN triaged INTEGER NOT NULL DEFAULT 0")
        _conn.execute("UPDATE tasks SET triaged=1 WHERE when_date IS NOT NULL OR someday=1 "
                      "OR project_id IS NOT NULL OR area_id IS NOT NULL")
    _conn.execute("DELETE FROM tasks WHERE deleted_at IS NOT NULL AND deleted_at < date('now','-30 days')")
    _conn.commit()


def _today() -> str:
    return date.today().isoformat()


def _q(sql: str, params=()) -> list[sqlite3.Row]:
    with _lock:
        return _conn.execute(sql, params).fetchall()


def _exec(sql: str, params=()) -> int:
    global _version
    with _lock:
        cur = _conn.execute(sql, params)
        _conn.commit()
        _version += 1
        return cur.lastrowid


def _next_sort() -> float:
    """Append position — new tasks go to the bottom of every list."""
    rows = _q("SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM tasks")
    return float(rows[0]["n"])


# --- Serializers ---

def _checklist(task_id: int) -> list[dict]:
    rows = _q("SELECT id,title,done,sort FROM checklist WHERE task_id=? ORDER BY sort,id", (task_id,))
    return [{"id": r["id"], "title": r["title"], "done": bool(r["done"]), "sort": r["sort"]} for r in rows]


def task_dict(r: sqlite3.Row, with_checklist: bool = True) -> dict:
    d = dict(r)
    d["someday"] = bool(d["someday"])
    d["triaged"] = bool(d.get("triaged"))
    try:
        d["tags"] = json.loads(d["tags"] or "[]")
    except json.JSONDecodeError:
        d["tags"] = []
    try:
        d["repeat"] = json.loads(d["repeat"]) if d.get("repeat") else None
    except json.JSONDecodeError:
        d["repeat"] = None
    if with_checklist:
        d["checklist"] = _checklist(r["id"])
    return d


# --- Areas ---

def list_areas() -> list[dict]:
    return [dict(r) for r in _q("SELECT * FROM areas ORDER BY sort,id")]


def create_area(title: str) -> int:
    return _exec("INSERT INTO areas(title,created_at) VALUES(?,?)", (title, _today()))


def update_area(area_id: int, title: str) -> dict | None:
    _exec("UPDATE areas SET title=? WHERE id=?", (title, area_id))
    rows = _q("SELECT * FROM areas WHERE id=?", (area_id,))
    return dict(rows[0]) if rows else None


def delete_area(area_id: int) -> None:
    """Projects and tasks survive: FK ON DELETE SET NULL detaches them."""
    _exec("DELETE FROM areas WHERE id=?", (area_id,))


# --- Projects ---

def list_projects(include_done: bool = False) -> list[dict]:
    sql = "SELECT * FROM projects"
    if not include_done:
        sql += " WHERE status='open'"
    sql += " ORDER BY sort,id"
    return [dict(r) for r in _q(sql)]


def create_project(title: str, area_id: int | None = None, notes: str = "") -> int:
    return _exec(
        "INSERT INTO projects(title,notes,area_id,created_at) VALUES(?,?,?,?)",
        (title, notes, area_id, _today()),
    )


def update_project(project_id: int, **fields) -> dict | None:
    allowed = {"title", "notes", "area_id", "status", "sort"}
    sets = {k: v for k, v in fields.items() if k in allowed}
    if sets:
        cols = ",".join(f"{k}=?" for k in sets)
        _exec(f"UPDATE projects SET {cols} WHERE id=?", (*sets.values(), project_id))
    rows = _q("SELECT * FROM projects WHERE id=?", (project_id,))
    return dict(rows[0]) if rows else None


def resolve_project(name_or_id: str | int | None) -> int | None:
    """Accept a project id or name; create the project if a new name is given."""
    if name_or_id in (None, "", "null"):
        return None
    if isinstance(name_or_id, int) or (isinstance(name_or_id, str) and name_or_id.isdigit()):
        pid = int(name_or_id)
        row = _q("SELECT id FROM projects WHERE id=?", (pid,))
        return pid if row else None
    row = _q("SELECT id FROM projects WHERE lower(title)=lower(?) AND status='open'", (name_or_id,))
    if row:
        return row[0]["id"]
    return create_project(str(name_or_id))


# --- Repeat rules ---

REPEAT_UNITS = ("day", "week", "month", "year")


def _norm_repeat(rule) -> str | None:
    """Validate/normalize a repeat rule; empty/invalid → None (no repeat)."""
    if not isinstance(rule, dict) or not rule:
        return None
    unit = rule.get("unit")
    if unit not in REPEAT_UNITS:
        return None
    try:
        interval = max(1, min(365, int(rule.get("interval", 1))))
    except (TypeError, ValueError):
        interval = 1
    mode = rule.get("mode") if rule.get("mode") in ("schedule", "done") else "schedule"
    return json.dumps({"unit": unit, "interval": interval, "mode": mode})


def _advance(iso: str, unit: str, n: int) -> str:
    """iso date + n units; month/year clamp the day (Jan 31 + 1 mo → Feb 28)."""
    d = date.fromisoformat(iso)
    if unit == "day":
        return (d + timedelta(days=n)).isoformat()
    if unit == "week":
        return (d + timedelta(weeks=n)).isoformat()
    months = n if unit == "month" else n * 12
    m = d.month - 1 + months
    y, m = d.year + m // 12, m % 12 + 1
    return date(y, m, min(d.day, calendar.monthrange(y, m)[1])).isoformat()


def _spawn_next(t: dict) -> int:
    """Create the next occurrence of a completed repeating task. Returns its id."""
    rule = t["repeat"]
    unit, interval, mode = rule["unit"], rule["interval"], rule["mode"]
    today = _today()

    def nxt(base: str) -> str:
        if mode == "done":
            return _advance(today, unit, interval)
        n = _advance(base, unit, interval)
        while n <= today:  # overdue schedule catches up to the nearest future slot
            n = _advance(n, unit, interval)
        return n

    when = deadline = None
    if t["when_date"]:
        when = nxt(t["when_date"])
        if t["deadline"]:  # keep the deadline's offset from the start date
            offset = date.fromisoformat(t["deadline"]) - date.fromisoformat(t["when_date"])
            deadline = (date.fromisoformat(when) + offset).isoformat()
    elif t["deadline"]:
        deadline = nxt(t["deadline"])
    else:
        when = nxt(today)

    tid = _exec(
        "INSERT INTO tasks(title,notes,when_date,deadline,someday,project_id,area_id,tags,repeat,sort,created_at,triaged) "
        "VALUES(?,?,?,?,0,?,?,?,?,?,?,1)",
        (t["title"], t["notes"], when, deadline, t["project_id"], t["area_id"],
         json.dumps(t["tags"], ensure_ascii=False), json.dumps(rule), _next_sort(), _today()),
    )
    for c in t.get("checklist") or []:
        _exec("INSERT INTO checklist(task_id,title,sort) VALUES(?,?,?)", (tid, c["title"], c["sort"]))
    return tid


# --- Tasks ---

VIEWS = ("inbox", "today", "upcoming", "anytime", "someday", "logbook", "done_today")


def list_tasks(view: str | None = None, project_id: int | None = None,
               area_id: int | None = None, q: str | None = None,
               tag: str | None = None) -> list[dict]:
    today = _today()
    where = ["deleted_at IS NULL"]
    params: list = []

    if view in ("logbook", "done_today"):
        where.append("status='completed'")
    else:
        where.append("status='open'")

    if view is not None or tag is not None:
        where.append("kind='task'")  # headings only show inside their project's list

    if view == "inbox":
        where.append("project_id IS NULL AND area_id IS NULL AND when_date IS NULL AND someday=0 AND triaged=0")
    elif view == "today":
        where.append("someday=0 AND ((when_date IS NOT NULL AND when_date<=?) OR (deadline IS NOT NULL AND deadline<=?))")
        params += [today, today]
    elif view == "done_today":
        where.append("completed_at=?")
        params.append(today)
    elif view == "upcoming":
        where.append("someday=0 AND when_date IS NOT NULL AND when_date>?")
        params.append(today)
    elif view == "anytime":
        where.append("someday=0 AND when_date IS NULL AND (triaged=1 OR project_id IS NOT NULL OR area_id IS NOT NULL)")
    elif view == "someday":
        where.append("someday=1")

    if project_id is not None:
        where.append("project_id=?"); params.append(project_id)
    if area_id is not None:
        where.append("area_id=?"); params.append(area_id)
    if tag:
        where.append("tags LIKE ?"); params.append(f'%"{tag}"%')
    if q:
        where.append("(title LIKE ? OR notes LIKE ?)"); params += [f"%{q}%", f"%{q}%"]

    if view in ("logbook", "done_today"):
        order = "completed_at DESC,id DESC"
    elif view == "upcoming":
        order = "when_date,sort,id"  # calendar order, manual within a day
    else:
        order = "sort,id"  # manual planning order (drag-to-reorder)
    sql = (
        "SELECT t.*, "
        "(SELECT COUNT(*) FROM checklist c WHERE c.task_id=t.id) AS checklist_total, "
        "(SELECT COUNT(*) FROM checklist c WHERE c.task_id=t.id AND c.done=1) AS checklist_done, "
        "(SELECT COUNT(*) FROM task_moves m WHERE m.task_id=t.id) AS moves "
        f"FROM tasks t WHERE {' AND '.join(where)} ORDER BY {order}"
    )
    return [task_dict(r, with_checklist=False) for r in _q(sql, params)]


def search_tasks(q: str, limit: int = 30) -> list[dict]:
    """Global quick-find across every task (any status), for the command palette."""
    like = f"%{q}%"
    sql = ("SELECT * FROM tasks WHERE deleted_at IS NULL AND kind='task' AND (title LIKE ? OR notes LIKE ?) "
           "ORDER BY (status='completed'), sort, id LIMIT ?")
    return [task_dict(r, with_checklist=False) for r in _q(sql, (like, like, limit))]


def reorder_tasks(ids: list[int]) -> None:
    """Persist a drag-reordered list by reassigning dense integer sort keys."""
    if not ids:
        return
    global _version
    with _lock:
        _conn.executemany(
            "UPDATE tasks SET sort=? WHERE id=?",
            [(float(i), tid) for i, tid in enumerate(ids)],
        )
        _conn.commit()
        _version += 1


def get_task(task_id: int) -> dict | None:
    rows = _q("SELECT t.*, (SELECT COUNT(*) FROM task_moves m WHERE m.task_id=t.id) AS moves "
              "FROM tasks t WHERE t.id=?", (task_id,))
    return task_dict(rows[0]) if rows else None


def create_task(title: str, notes: str = "", when: str | None = None, deadline: str | None = None,
                project: str | int | None = None, area_id: int | None = None,
                tags: list[str] | None = None, repeat: dict | None = None,
                kind: str = "task") -> dict:
    someday = 0
    when_date = None
    if when == "today":
        when_date = _today()
    elif when == "someday":
        someday = 1
    elif when and when != "anytime":
        when_date = when
    project_id = resolve_project(project)
    triaged = 1 if (when or project_id is not None or area_id is not None) else 0
    tid = _exec(
        "INSERT INTO tasks(title,notes,when_date,deadline,someday,project_id,area_id,tags,repeat,kind,sort,created_at,triaged) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (title, notes, when_date, deadline, someday, project_id, area_id,
         json.dumps(tags or [], ensure_ascii=False), _norm_repeat(repeat),
         kind if kind in ("task", "heading") else "task", _next_sort(), _today(), triaged),
    )
    return get_task(tid)


def update_task(task_id: int, **fields) -> dict | None:
    if "when" in fields:
        w = fields.pop("when")
        if w == "today":
            fields["when_date"], fields["someday"] = _today(), 0
        elif w == "someday":
            fields["when_date"], fields["someday"] = None, 1
        elif w == "inbox":
            # Explicit "back to Inbox": the only way a task becomes untriaged again.
            fields["when_date"], fields["someday"], fields["triaged"] = None, 0, 0
        else:
            # date, "anytime" or empty (clear date) — all count as a triage decision
            fields["when_date"], fields["someday"] = (None if w in (None, "", "anytime") else w), 0
        fields.setdefault("triaged", 1)
    if "project" in fields:
        fields["project_id"] = resolve_project(fields.pop("project"))
    if fields.get("project_id") is not None or fields.get("area_id") is not None:
        fields["triaged"] = 1
    if "tags" in fields and isinstance(fields["tags"], list):
        fields["tags"] = json.dumps(fields["tags"], ensure_ascii=False)
    if "repeat" in fields:
        fields["repeat"] = _norm_repeat(fields["repeat"])  # {} / invalid → NULL (repeat off)
    allowed = {"title", "notes", "when_date", "deadline", "someday", "project_id", "area_id", "tags", "status", "sort", "repeat", "triaged"}
    sets = {k: v for k, v in fields.items() if k in allowed}
    if not sets:
        return get_task(task_id)
    old = get_task(task_id) if "when_date" in sets else None
    cols = ",".join(f"{k}=?" for k in sets)
    _exec(f"UPDATE tasks SET {cols} WHERE id=?", (*sets.values(), task_id))
    # Slip journal: a due/overdue task pushed to a later date. Planning moves of
    # future tasks and triage to anytime/someday are decisions, not slips.
    if old and old["status"] == "open" and old.get("kind") == "task":
        ow, nw = old["when_date"], sets["when_date"]
        if ow and nw and ow <= _today() and nw > ow:
            _exec("INSERT INTO task_moves(task_id,old_date,new_date,moved_at) VALUES(?,?,?,?)",
                  (task_id, ow, nw, _today()))
    return get_task(task_id)


def complete_task(task_id: int, done: bool = True) -> dict | None:
    t = get_task(task_id)
    if not t:
        return None
    if done:
        # Completing a repeating task spawns its next occurrence (Things-style).
        spawned = _spawn_next(t) if t["status"] == "open" and t.get("repeat") else None
        _exec("UPDATE tasks SET status='completed',completed_at=?,spawned_id=? WHERE id=?",
              (_today(), spawned, task_id))
    else:
        # Undo: remove the occurrence this completion spawned, if it's still untouched-open.
        if t.get("spawned_id"):
            _exec("DELETE FROM tasks WHERE id=? AND status='open'", (t["spawned_id"],))
        _exec("UPDATE tasks SET status='open',completed_at=NULL,spawned_id=NULL WHERE id=?", (task_id,))
    return get_task(task_id)


def delete_task(task_id: int) -> None:
    """Soft delete — restorable via restore_task; purged after 30 days."""
    _exec("UPDATE tasks SET deleted_at=? WHERE id=?", (_today(), task_id))


def restore_task(task_id: int) -> dict | None:
    _exec("UPDATE tasks SET deleted_at=NULL WHERE id=?", (task_id,))
    return get_task(task_id)


# --- Checklist ---

def add_checklist(task_id: int, title: str) -> int:
    return _exec("INSERT INTO checklist(task_id,title) VALUES(?,?)", (task_id, title))


def toggle_checklist(item_id: int, done: bool) -> None:
    _exec("UPDATE checklist SET done=? WHERE id=?", (1 if done else 0, item_id))


def delete_checklist(item_id: int) -> None:
    _exec("DELETE FROM checklist WHERE id=?", (item_id,))


# --- Sidebar counts ---

def counts() -> dict:
    return {v: len(list_tasks(view=v)) for v in ("inbox", "today", "upcoming", "anytime", "someday", "done_today")}


def project_progress() -> dict[int, dict]:
    """Per-project {open, total} so the sidebar can draw Things-style progress rings."""
    rows = _q(
        "SELECT project_id, "
        "SUM(status='open') AS open, COUNT(*) AS total "
        "FROM tasks WHERE project_id IS NOT NULL AND deleted_at IS NULL AND kind='task' GROUP BY project_id"
    )
    return {r["project_id"]: {"open": r["open"], "total": r["total"]} for r in rows}
