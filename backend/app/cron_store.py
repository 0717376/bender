"""SQLite store for scheduled (cron) jobs.

Each job: a natural-language prompt + a schedule. A background scheduler runs due
jobs as isolated agent turns and delivers the result (usually to Telegram).

Schedule formats (ported from Hermes — one field, parser picks the kind):
  '5m', '2h', '1d'        → one-shot, fires once N from now, then self-deletes
  '2026-06-28T07:50'      → one-shot at an absolute time (ISO)
  'every 30m', 'every 2h' → recurring interval
  '0 9 * * *'             → recurring cron expression

`repeat` caps how many times a job runs (None = forever; one-shots default to 1).
When the cap is reached the scheduler removes the job — the agent never manages
schedules itself (anti-recursion: no cron tools inside a scheduled run).
"""

import json
import os
import re
import sqlite3
import threading
from datetime import datetime, timedelta

from croniter import croniter

from . import config

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS cron_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'cron',
  surface TEXT NOT NULL DEFAULT 'telegram',
  deliver TEXT NOT NULL DEFAULT 'telegram',
  enabled INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'scheduled',
  repeat_times INTEGER,
  repeat_done INTEGER NOT NULL DEFAULT 0,
  next_run TEXT,
  last_run TEXT,
  last_output TEXT,
  run_log TEXT,
  created_at TEXT NOT NULL
);
"""

# Columns added after the first release — backfilled on init for existing DBs.
_MIGRATIONS = {
    "kind": "TEXT NOT NULL DEFAULT 'cron'",
    "state": "TEXT NOT NULL DEFAULT 'scheduled'",
    "repeat_times": "INTEGER",
    "repeat_done": "INTEGER NOT NULL DEFAULT 0",
    "run_log": "TEXT",
}


def init() -> None:
    global _conn
    os.makedirs(config.DATA_DIR, exist_ok=True)
    _conn = sqlite3.connect(os.path.join(config.DATA_DIR, "cron.db"), check_same_thread=False)
    _conn.row_factory = sqlite3.Row
    _conn.execute("PRAGMA journal_mode=WAL")
    _conn.executescript(SCHEMA)
    existing = {r["name"] for r in _conn.execute("PRAGMA table_info(cron_jobs)")}
    for col, decl in _MIGRATIONS.items():
        if col not in existing:
            _conn.execute(f"ALTER TABLE cron_jobs ADD COLUMN {col} {decl}")
    _conn.commit()


def _now() -> datetime:
    return datetime.now()


def _q(sql: str, params=()) -> list[sqlite3.Row]:
    with _lock:
        return _conn.execute(sql, params).fetchall()


def _exec(sql: str, params=()) -> int:
    with _lock:
        cur = _conn.execute(sql, params)
        _conn.commit()
        return cur.lastrowid


# --- Schedule parsing ---

_DUR_RE = re.compile(r"^\s*(\d+)\s*([mhd])\s*$", re.IGNORECASE)
_UNIT_MIN = {"m": 1, "h": 60, "d": 1440}

_SCHEDULE_HELP = (
    "Используй: '5m'/'2h'/'1d' (разово через N), '2026-06-28T07:50' (разово в момент), "
    "'every 30m'/'every 2h' (повтор-интервал) или cron '0 9 * * *'."
)


def parse_duration(s: str) -> int:
    """'30m' | '2h' | '1d' → minutes. Raises ValueError otherwise."""
    m = _DUR_RE.match(s or "")
    if not m:
        raise ValueError(f"Некорректная длительность: {s!r}. {_SCHEDULE_HELP}")
    return int(m.group(1)) * _UNIT_MIN[m.group(2).lower()]


def parse_schedule(schedule: str) -> dict:
    """Parse a schedule string into {kind, ...}. Raises ValueError if invalid.

    kind='once'     → {'run_at': iso}
    kind='interval' → {'minutes': int}
    kind='cron'     → {'expr': str}
    """
    s = (schedule or "").strip()
    if not s:
        raise ValueError(f"Пустое расписание. {_SCHEDULE_HELP}")

    if s.lower().startswith("every "):
        return {"kind": "interval", "minutes": parse_duration(s[6:])}

    parts = s.split()
    if len(parts) >= 5 and all(re.fullmatch(r"[\d*\-,/]+", p) for p in parts[:5]):
        if not croniter.is_valid(s):
            raise ValueError(f"Некорректное cron-расписание: {s!r}")
        return {"kind": "cron", "expr": s}

    if "T" in s or re.match(r"^\d{4}-\d{2}-\d{2}", s):
        try:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError as e:
            raise ValueError(f"Некорректное время: {s!r}: {e}")
        if dt.tzinfo is not None:  # store naive local (the scheduler compares against naive now())
            dt = dt.astimezone().replace(tzinfo=None)
        return {"kind": "once", "run_at": dt.isoformat(timespec="seconds")}

    # bare duration → one-shot from now
    run_at = _now() + timedelta(minutes=parse_duration(s))
    return {"kind": "once", "run_at": run_at.isoformat(timespec="seconds")}


def valid_schedule(schedule: str) -> bool:
    try:
        parse_schedule(schedule)
        return True
    except ValueError:
        return False


def _next_run(parsed: dict, base: datetime | None = None) -> str | None:
    """Next fire time for a parsed schedule, or None if it has no future run."""
    base = base or _now()
    kind = parsed["kind"]
    if kind == "once":
        return parsed["run_at"]
    if kind == "interval":
        return (base + timedelta(minutes=parsed["minutes"])).isoformat(timespec="seconds")
    return croniter(parsed["expr"], base).get_next(datetime).isoformat(timespec="seconds")


# --- CRUD ---

def create(name: str, prompt: str, schedule: str, surface: str = "telegram",
           deliver: str = "telegram", repeat: int | None = None) -> dict:
    parsed = parse_schedule(schedule)  # raises ValueError on bad input
    kind = parsed["kind"]
    if repeat is not None and repeat <= 0:
        repeat = None
    if kind == "once" and repeat is None:
        repeat = 1  # one-shots run exactly once unless overridden
    next_run = _next_run(parsed)
    jid = _exec(
        "INSERT INTO cron_jobs(name,prompt,schedule,kind,surface,deliver,repeat_times,next_run,created_at) "
        "VALUES(?,?,?,?,?,?,?,?,?)",
        (name, prompt, schedule, kind, surface, deliver, repeat, next_run,
         _now().isoformat(timespec="seconds")),
    )
    return get(jid)


def _row(r: sqlite3.Row) -> dict:
    d = dict(r)
    d["enabled"] = bool(d["enabled"])
    return d


def get(jid: int) -> dict | None:
    rows = _q("SELECT * FROM cron_jobs WHERE id=?", (jid,))
    return _row(rows[0]) if rows else None


def list_jobs() -> list[dict]:
    return [_row(r) for r in _q("SELECT * FROM cron_jobs ORDER BY id")]


def update(jid: int, **fields) -> dict | None:
    if "repeat" in fields:
        rep = fields.pop("repeat")
        fields["repeat_times"] = None if (rep is not None and rep <= 0) else rep
    if "schedule" in fields:
        parsed = parse_schedule(fields["schedule"])  # raises ValueError
        fields["kind"] = parsed["kind"]
        fields["next_run"] = _next_run(parsed)
        fields["state"] = "scheduled"
        if parsed["kind"] == "once":
            fields["repeat_done"] = 0  # re-arm a one-shot when rescheduled
    if "enabled" in fields:
        fields["enabled"] = 1 if fields["enabled"] else 0
    allowed = {"name", "prompt", "schedule", "kind", "surface", "deliver",
               "enabled", "state", "repeat_times", "repeat_done", "next_run"}
    sets = {k: v for k, v in fields.items() if k in allowed}
    if not sets:
        return get(jid)
    cols = ",".join(f"{k}=?" for k in sets)
    _exec(f"UPDATE cron_jobs SET {cols} WHERE id=?", (*sets.values(), jid))
    return get(jid)


def delete(jid: int) -> None:
    _exec("DELETE FROM cron_jobs WHERE id=?", (jid,))


# --- Scheduler helpers ---

def due(now: datetime | None = None) -> list[dict]:
    now_iso = (now or _now()).isoformat(timespec="seconds")
    rows = _q(
        "SELECT * FROM cron_jobs WHERE enabled=1 AND next_run IS NOT NULL AND next_run<=?",
        (now_iso,),
    )
    return [_row(r) for r in rows]


RUN_LOG_KEEP = 5  # last N runs fed back into the next run's prompt


def run_log(job: dict) -> list[dict]:
    """Parsed run history of a job row: [{at, text, sent}], oldest first."""
    try:
        data = json.loads(job.get("run_log") or "[]")
        return data if isinstance(data, list) else []
    except json.JSONDecodeError:
        return []


def mark_ran(jid: int, output: str, when: datetime | None = None, sent: bool = True) -> None:
    """Record a run, advance the schedule, and self-delete when the repeat cap is hit.

    The scheduler owns job lifecycle — a scheduled agent never deletes its own job.
    A recurring job whose next run can't be computed is marked state='error' and kept
    (never silently disabled), so a transient failure doesn't kill the schedule.
    `sent=False` marks a suppressed ([SILENT]/empty) run in the history.
    """
    when = when or _now()
    job = get(jid)
    if not job:
        return
    entry = {"at": when.strftime("%d.%m %H:%M"), "text": (output or "").strip()[:600] if sent else "", "sent": bool(sent)}
    log_json = json.dumps((run_log(job) + [entry])[-RUN_LOG_KEEP:], ensure_ascii=False)
    done = (job["repeat_done"] or 0) + 1
    limit = job["repeat_times"]
    # A one-shot is ALWAYS terminal after it fires — never re-arm it. This holds
    # even if repeat_times is missing/None: a 'once' job's next_run is a fixed
    # instant, so re-arming would leave it perpetually past-due and re-fire every
    # tick. The repeat cap only governs recurring jobs.
    if job["kind"] == "once" or (limit is not None and done >= limit):
        delete(jid)  # one-shot fired, or finite-repeat exhausted → remove
        return

    try:
        parsed = parse_schedule(job["schedule"])
        nxt = _next_run(parsed, when)
    except ValueError:
        nxt = None

    if nxt is None:
        # No further run: terminal for once, but recurring must not be silently disabled.
        if job["kind"] in ("cron", "interval"):
            _exec(
                "UPDATE cron_jobs SET last_run=?,last_output=?,run_log=?,repeat_done=?,state='error' WHERE id=?",
                (when.isoformat(timespec="seconds"), (output or "")[:4000], log_json, done, jid),
            )
        else:
            delete(jid)
        return

    _exec(
        "UPDATE cron_jobs SET last_run=?,last_output=?,run_log=?,repeat_done=?,next_run=?,state='scheduled' WHERE id=?",
        (when.isoformat(timespec="seconds"), (output or "")[:4000], log_json, done, nxt, jid),
    )
