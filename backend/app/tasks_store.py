"""SQLite store for the Tasks domain (Things-like model).

Areas ⊃ Projects ⊃ Tasks ⊃ Checklist items. Shared by the REST API and the
agent's in-process tools, so the chat assistant and the Tasks UI see the same data.
"""

import json
import os
import sqlite3
import threading
from datetime import date, timedelta

from . import config, repeat as rep

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
        # 'task' | 'heading' | 'repeat' — headings divide a project list, 'repeat' is a
        # repeating-task template: it holds the rule and spawns dated occurrences.
        _conn.execute("ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'task'")
    migrate_repeats = "repeat_parent" not in cols
    if migrate_repeats:
        _conn.execute("ALTER TABLE tasks ADD COLUMN repeat_parent INTEGER")  # экземпляр → шаблон
    if "last_spawn" not in cols:
        _conn.execute("ALTER TABLE tasks ADD COLUMN last_spawn TEXT")        # шаблон: докуда посчитали
    if "spawn_count" not in cols:
        _conn.execute("ALTER TABLE tasks ADD COLUMN spawn_count INTEGER NOT NULL DEFAULT 0")
    _conn.execute("CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(repeat_parent)")
    if "triaged" not in cols:
        # 0 = never scheduled/filed anywhere → lives in Inbox; 1 = user decided "when",
        # so a dateless task shows in Anytime even without a project (Things-style).
        _conn.execute("ALTER TABLE tasks ADD COLUMN triaged INTEGER NOT NULL DEFAULT 0")
        _conn.execute("UPDATE tasks SET triaged=1 WHERE when_date IS NOT NULL OR someday=1 "
                      "OR project_id IS NOT NULL OR area_id IS NOT NULL")
    _conn.execute("DELETE FROM tasks WHERE deleted_at IS NOT NULL AND deleted_at < date('now','-30 days')")
    _conn.commit()
    if migrate_repeats:
        _migrate_repeats()


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


def delete_project(project_id: int) -> None:
    """Задачи переживают проект: FK ON DELETE SET NULL просто отвязывает их."""
    _exec("DELETE FROM projects WHERE id=?", (project_id,))


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


# --- Repeat: template (kind='repeat') + its dated occurrences ---
#
# Правило живёт на отдельной строке-шаблоне, а не на самой задаче. Иначе цепочка
# держится на выполнении: не отметил — следующего повторения не будет, удалил задачу —
# повтор исчез навсегда. Шаблон в списки не попадает (kind='repeat') и сам заранее
# раскладывает ближайшие копии, поэтому они видны в «Предстоящих», а пропуск одной
# ничего не ломает.

AHEAD = 3            # сколько будущих копий держим готовыми
HORIZON_DAYS = 400   # дальше не заглядываем: «каждый год» и так укладывается

_ensured_day: str | None = None


def _occurrences_of(tpl_id: int, only_open: bool = True) -> list[sqlite3.Row]:
    sql = "SELECT id,when_date,status FROM tasks WHERE repeat_parent=? AND deleted_at IS NULL"
    if only_open:
        sql += " AND status='open'"
    return _q(sql + " ORDER BY when_date", (tpl_id,))


def _spawn(tpl: dict, when: str) -> int:
    """Экземпляр повтора: копия шаблона с датой. Двигает курсор шаблона."""
    rule = tpl["repeat"] or {}
    deadline = None
    if tpl["deadline"] and rule.get("start"):
        # дедлайн шаблона задан относительно старта — сохраняем ту же фору
        offset = date.fromisoformat(tpl["deadline"]) - date.fromisoformat(rule["start"])
        deadline = (date.fromisoformat(when) + offset).isoformat()
    tid = _exec(
        "INSERT INTO tasks(title,notes,when_date,deadline,someday,project_id,area_id,tags,repeat,repeat_parent,sort,created_at,triaged) "
        "VALUES(?,?,?,?,0,?,?,?,?,?,?,?,1)",
        (tpl["title"], tpl["notes"], when, deadline, tpl["project_id"], tpl["area_id"],
         json.dumps(tpl["tags"], ensure_ascii=False), json.dumps(rule), tpl["id"], _next_sort(), _today()),
    )
    for c in tpl.get("checklist") or []:
        _exec("INSERT INTO checklist(task_id,title,sort) VALUES(?,?,?)", (tid, c["title"], c["sort"]))
    _exec("UPDATE tasks SET last_spawn=?, spawn_count=spawn_count+1 WHERE id=?", (when, tpl["id"]))
    return tid


def _exhausted(rule: dict, spawned: int) -> bool:
    end = rule.get("end") or {}
    if end.get("after"):
        return spawned >= end["after"]
    if end.get("on"):
        return end["on"] < _today()
    return False


def ensure_occurrences(tpl_id: int) -> list[int]:
    """Доложить недостающие копии шаблона. Возвращает id созданных."""
    rows = _q("SELECT * FROM tasks WHERE id=? AND kind='repeat' AND status='open' AND deleted_at IS NULL", (tpl_id,))
    if not rows:
        return []
    tpl = task_dict(rows[0])
    rule = tpl["repeat"]
    if not rule:
        return []
    today, made = _today(), []
    spawned = tpl["spawn_count"] or 0

    if rule["mode"] == "done":
        # «через N после выполнения»: следующей даты в календаре нет, поэтому держим
        # ровно одну открытую копию и считаем от факта выполнения предыдущей.
        if not _occurrences_of(tpl_id) and not _exhausted(rule, spawned):
            if tpl["last_spawn"] is None:
                when = rule.get("start") or today
            else:
                last = _q("SELECT MAX(completed_at) AS c FROM tasks WHERE repeat_parent=? AND status='completed'", (tpl_id,))
                when = rep.advance(last[0]["c"] or today, rule["unit"], rule["interval"])
            made.append(_spawn(tpl, when))
    else:
        need = AHEAD - len([r for r in _occurrences_of(tpl_id) if r["when_date"] and r["when_date"] > today])
        if (rule.get("end") or {}).get("after"):
            need = min(need, rule["end"]["after"] - spawned)
        if need > 0:
            # Прошлое не восстанавливаем: пропущенные сроки (сервер лежал, задачу
            # завели давно) не должны превращаться в стопку просроченных копий —
            # незакрытый экземпляр и так висит просроченным.
            yesterday = (date.fromisoformat(today) - timedelta(days=1)).isoformat()
            after = max(tpl["last_spawn"] or yesterday, yesterday)
            until = (date.fromisoformat(today) + timedelta(days=HORIZON_DAYS)).isoformat()
            for d in rep.occurrences(rule, after, until, need):
                made.append(_spawn(tpl, d))

    if not made and not _occurrences_of(tpl_id) and _exhausted(rule, spawned):
        # правило отработало своё — шаблон уходит из «Повторов», копии остаются в журнале
        _exec("UPDATE tasks SET status='completed',completed_at=? WHERE id=?", (today, tpl_id))
    return made


def _ensure_all() -> None:
    for r in _q("SELECT id FROM tasks WHERE kind='repeat' AND status='open' AND deleted_at IS NULL"):
        ensure_occurrences(r["id"])


def _maybe_ensure() -> None:
    """Раскладка ленивая, при чтении списка: крон не нужен, выключенный контейнер не страшен."""
    global _ensured_day
    if _ensured_day == _today():
        return
    _ensured_day = _today()  # до обхода, чтобы вложенные чтения не зациклились
    _ensure_all()


def _template_from(t: dict, rule: dict) -> int:
    """Сделать из задачи шаблон повтора; сама задача становится первым экземпляром."""
    rule = dict(rule)
    when = t["when_date"]
    if not when and not t["someday"]:
        # бездатной задаче даём дату первого повторения — иначе она навсегда зависнет
        # «в любое время», а копии поедут отдельно от неё
        rule.setdefault("start", _today())
        nxt = rep.occurrences(rule, (date.fromisoformat(_today()) - timedelta(days=1)).isoformat(),
                              (date.fromisoformat(_today()) + timedelta(days=HORIZON_DAYS)).isoformat(), 1)
        when = nxt[0] if nxt else _today()
        _exec("UPDATE tasks SET when_date=?, triaged=1 WHERE id=?", (when, t["id"]))
    rule.setdefault("start", when or _today())
    tpl = _exec(
        "INSERT INTO tasks(title,notes,when_date,deadline,someday,project_id,area_id,tags,repeat,kind,sort,created_at,triaged,last_spawn,spawn_count) "
        "VALUES(?,?,NULL,?,0,?,?,?,?,'repeat',?,?,1,?,1)",
        (t["title"], t["notes"], t["deadline"], t["project_id"], t["area_id"],
         json.dumps(t["tags"], ensure_ascii=False), json.dumps(rule), _next_sort(), _today(), when or _today()),
    )
    for c in t.get("checklist") or []:
        _exec("INSERT INTO checklist(task_id,title,sort) VALUES(?,?,?)", (tpl, c["title"], c["sort"]))
    _exec("UPDATE tasks SET repeat=?, repeat_parent=? WHERE id=?", (json.dumps(rule), tpl, t["id"]))
    return tpl


def _drop_template(tpl_id: int, keep: int | None = None) -> None:
    """Снять повтор: шаблон и запланированное вперёд убираем, начатое остаётся задачами.

    keep — задача, из которой повтор и снимали: даже если она в будущем, удалять её
    нельзя, пользователь просил убрать повторение, а не саму задачу.
    """
    today = _today()
    _exec("UPDATE tasks SET deleted_at=? WHERE (id=? OR (repeat_parent=? AND status='open' AND when_date>? AND id IS NOT ?)) "
          "AND deleted_at IS NULL", (today, tpl_id, tpl_id, today, keep))
    _exec("UPDATE tasks SET repeat=NULL, repeat_parent=NULL WHERE repeat_parent=? AND deleted_at IS NULL", (tpl_id,))


def _apply_repeat(task_id: int, rule: dict | None) -> None:
    """Правило всегда живёт на шаблоне, поэтому правку экземпляра переносим на него."""
    t = get_task(task_id)
    if not t or t["kind"] == "heading":
        return
    tpl_id = t["id"] if t["kind"] == "repeat" else t["repeat_parent"]
    if rule is None:
        if tpl_id:
            _drop_template(tpl_id, keep=None if t["kind"] == "repeat" else t["id"])
        return
    if not tpl_id:
        tpl_id = _template_from(t, rule)
    else:
        old = get_task(tpl_id)
        rule.setdefault("start", (old["repeat"] or {}).get("start") or _today())
        # правило поменялось — будущее пересобираем по новому, наступившее не трогаем
        _exec("UPDATE tasks SET repeat=?, last_spawn=? WHERE id=?", (json.dumps(rule), _today(), tpl_id))
        _exec("UPDATE tasks SET deleted_at=? WHERE repeat_parent=? AND status='open' AND when_date>? AND deleted_at IS NULL",
              (_today(), tpl_id, _today()))
        _exec("UPDATE tasks SET repeat=? WHERE repeat_parent=? AND status='open' AND deleted_at IS NULL",
              (json.dumps(rule), tpl_id))
    ensure_occurrences(tpl_id)


def _migrate_repeats() -> None:
    """Старые повторяющиеся задачи: правило переезжает на шаблон, задача — первый экземпляр."""
    rows = _q("SELECT id FROM tasks WHERE repeat IS NOT NULL AND kind='task' AND status='open' AND deleted_at IS NULL")
    for r in rows:
        t = get_task(r["id"])
        rule = rep.norm(t and t["repeat"])
        if rule:
            ensure_occurrences(_template_from(t, rule))


# --- Tasks ---

VIEWS = ("inbox", "today", "upcoming", "anytime", "someday", "logbook", "done_today", "repeats")

# Ближайшая открытая копия шаблона — строка «следующая 12 августа» в списке повторов.
NEXT_DATE = ("(SELECT MIN(o.when_date) FROM tasks o WHERE o.repeat_parent=t.id "
             "AND o.status='open' AND o.deleted_at IS NULL) AS next_date")


def list_tasks(view: str | None = None, project_id: int | None = None,
               area_id: int | None = None, q: str | None = None,
               tag: str | None = None) -> list[dict]:
    _maybe_ensure()
    today = _today()
    where = ["deleted_at IS NULL"]
    params: list = []

    if view in ("logbook", "done_today"):
        where.append("status='completed'")
    else:
        where.append("status='open'")

    if view == "repeats":
        where.append("kind='repeat'")
    elif view is not None or tag is not None:
        # заголовки живут только внутри проекта, шаблоны повторов — только в «Повторах»
        where.append("kind='task'")

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
    elif view == "repeats":
        order = "next_date,sort,id"  # что сработает раньше — то и выше
    else:
        order = "sort,id"  # manual planning order (drag-to-reorder)
    sql = (
        "SELECT t.*, "
        "(SELECT COUNT(*) FROM checklist c WHERE c.task_id=t.id) AS checklist_total, "
        "(SELECT COUNT(*) FROM checklist c WHERE c.task_id=t.id AND c.done=1) AS checklist_done, "
        "(SELECT COUNT(*) FROM task_moves m WHERE m.task_id=t.id) AS moves, "
        f"{NEXT_DATE} "
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
    rows = _q("SELECT t.*, (SELECT COUNT(*) FROM task_moves m WHERE m.task_id=t.id) AS moves, "
              f"{NEXT_DATE} FROM tasks t WHERE t.id=?", (task_id,))
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
        "INSERT INTO tasks(title,notes,when_date,deadline,someday,project_id,area_id,tags,kind,sort,created_at,triaged) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        (title, notes, when_date, deadline, someday, project_id, area_id,
         json.dumps(tags or [], ensure_ascii=False),
         kind if kind in ("task", "heading") else "task", _next_sort(), _today(), triaged),
    )
    rule = rep.norm(repeat)
    if rule and kind == "task":
        # задача сразу становится первым экземпляром своего повтора
        ensure_occurrences(_template_from(get_task(tid), rule))
    return get_task(tid)


def update_task(task_id: int, **fields) -> dict | None:
    # Повтор обрабатываем отдельно: он живёт на шаблоне, а не в колонках этой строки.
    rule_given = "repeat" in fields
    rule = rep.norm(fields.pop("repeat", None)) if rule_given else None
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
    allowed = {"title", "notes", "when_date", "deadline", "someday", "project_id", "area_id", "tags", "status", "sort", "triaged"}
    sets = {k: v for k, v in fields.items() if k in allowed}
    if not sets and not rule_given:
        return get_task(task_id)
    old = get_task(task_id) if "when_date" in sets else None
    if sets:
        cols = ",".join(f"{k}=?" for k in sets)
        _exec(f"UPDATE tasks SET {cols} WHERE id=?", (*sets.values(), task_id))
    if rule_given:
        _apply_repeat(task_id, rule)  # {} / битое правило → повтор снимается
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
        _exec("UPDATE tasks SET status='completed',completed_at=? WHERE id=?", (_today(), task_id))
        # Освободилось место в цепочке повтора: «через N после выполнения» ставит
        # следующую копию именно здесь, у расписания ближайшие обычно уже разложены.
        made = ensure_occurrences(t["repeat_parent"]) if t["status"] == "open" and t["repeat_parent"] else []
        if made:
            _exec("UPDATE tasks SET spawned_id=? WHERE id=?", (made[0], task_id))
    else:
        # Undo: remove the occurrence this completion spawned, if it's still untouched-open.
        if t.get("spawned_id"):
            _exec("DELETE FROM tasks WHERE id=? AND status='open'", (t["spawned_id"],))
        _exec("UPDATE tasks SET status='open',completed_at=NULL,spawned_id=NULL WHERE id=?", (task_id,))
    return get_task(task_id)


def delete_task(task_id: int) -> None:
    """Soft delete — restorable via restore_task; purged after 30 days."""
    t = get_task(task_id)
    _exec("UPDATE tasks SET deleted_at=? WHERE id=?", (_today(), task_id))
    if not t:
        return
    if t["kind"] == "repeat":
        _exec("UPDATE tasks SET deleted_at=? WHERE repeat_parent=? AND status='open' AND deleted_at IS NULL",
              (_today(), task_id))
    elif t["repeat_parent"]:
        ensure_occurrences(t["repeat_parent"])  # удалить копию = пропустить повторение


def restore_task(task_id: int) -> dict | None:
    day = (get_task(task_id) or {}).get("deleted_at")
    _exec("UPDATE tasks SET deleted_at=NULL WHERE id=?", (task_id,))
    t = get_task(task_id)
    if t and t["kind"] == "repeat" and day:
        # шаблон уносил копии с собой — возвращаем ровно ту же пачку
        _exec("UPDATE tasks SET deleted_at=NULL WHERE repeat_parent=? AND deleted_at=?", (task_id, day))
    return t


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
