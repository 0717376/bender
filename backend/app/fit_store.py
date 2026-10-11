"""Тренировки: дневник, программа и прогресс в sqlite рядом с остальным (data/fit.db).

Программа — круг дней (А, Б, кардио…), а не расписание по дням недели: пропустил —
следующая тренировка та же, план не ломается. Тренировка (session) — что сделано: у силовой
подходы (sets), у кардио и бассейна время с дистанцией.

Цель на подход считается здесь, без модели — двойная прогрессия: сначала растут повторы
до верхней границы, потом вес. Ассистент меняет саму программу, а не цифры на сегодня.
"""

import json
import os
import sqlite3
import threading
import time
from datetime import date, datetime, timedelta
from datetime import time as dtime

from . import config
from .fit_guides import GUIDES, KEYS as GUIDE_KEYS, slug
from .fit_seed import EXERCISES

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None
_version = 0           # растёт на каждой записи — по нему просыпается SSE

KINDS = ("strength", "cardio", "swim", "other")
EX_KINDS = ("strength", "time")        # time — держим на время: в reps лежат секунды
MUSCLES = ("chest", "back", "shoulders", "biceps", "triceps", "forearms", "core",
           "quads", "hamstrings", "glutes", "calves")
EQUIPMENT = ("barbell", "dumbbell", "machine", "cable", "kettlebell", "body", "other")
# День кончается не в полночь, как у карточек: тренировка в час ночи — ещё «сегодня».
DAY_START_HOUR = 4
# Вспомогательная мышца получает половину подхода: жим лёжа — это не полноценный трицепс.
ALSO_SHARE = 0.5
# Сколько сбросить после двух срывов подряд.
DELOAD = 0.9

DEFAULTS = {
    "notify": True,          # присылать ли утреннюю сводку в Telegram
    "notify_hour": 8,        # не раньше этого часа (по часам сервера)
    "weekly": True,          # воскресный разбор недели от ассистента
    "oura_min_minutes": 15,  # тренировки кольца короче этого не берём: дорога до метро — не кардио
    "profile": {},           # что ассистент знает о человеке: опыт, инвентарь, дни, ограничения
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS exercises (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT    NOT NULL,
  name_en   TEXT    NOT NULL DEFAULT '',
  muscle    TEXT    NOT NULL,
  also      TEXT    NOT NULL DEFAULT '[]',
  equipment TEXT    NOT NULL DEFAULT 'other',
  kind      TEXT    NOT NULL DEFAULT 'strength',
  step      REAL    NOT NULL DEFAULT 2.5,
  note      TEXT    NOT NULL DEFAULT '',
  archived  INTEGER NOT NULL DEFAULT 0,
  created   INTEGER NOT NULL DEFAULT 0,
  image     TEXT    NOT NULL DEFAULT '',
  guide     TEXT    NOT NULL DEFAULT '{}',
  guide_en  TEXT    NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS programs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT    NOT NULL,
  goal    TEXT    NOT NULL DEFAULT '',
  note    TEXT    NOT NULL DEFAULT '',
  active  INTEGER NOT NULL DEFAULT 1,
  created INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS program_days (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id INTEGER NOT NULL,
  pos        INTEGER NOT NULL,
  name       TEXT    NOT NULL,
  kind       TEXT    NOT NULL DEFAULT 'strength',
  minutes    INTEGER NOT NULL DEFAULT 0,
  note       TEXT    NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS program_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  day_id      INTEGER NOT NULL,
  pos         INTEGER NOT NULL,
  exercise_id INTEGER NOT NULL,
  sets        INTEGER NOT NULL DEFAULT 3,
  reps_min    INTEGER NOT NULL DEFAULT 8,
  reps_max    INTEGER NOT NULL DEFAULT 12,
  rir         INTEGER NOT NULL DEFAULT 2,
  rest        INTEGER NOT NULL DEFAULT 120,
  note        TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_items_day ON program_items(day_id);
CREATE TABLE IF NOT EXISTS sessions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  uid            TEXT,
  day            TEXT    NOT NULL,
  started        INTEGER NOT NULL,
  ended          INTEGER,
  kind           TEXT    NOT NULL DEFAULT 'strength',
  program_day_id INTEGER,
  title          TEXT    NOT NULL DEFAULT '',
  note           TEXT    NOT NULL DEFAULT '',
  feel           INTEGER,
  source         TEXT    NOT NULL DEFAULT 'manual',
  ext_id         TEXT,
  duration       INTEGER,
  distance       REAL,
  calories       REAL,
  avg_hr         INTEGER,
  max_hr         INTEGER,
  deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_day ON sessions(day);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_uid ON sessions(uid);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_ext ON sessions(source, ext_id);
CREATE TABLE IF NOT EXISTS sets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  uid         TEXT,
  session_id  INTEGER NOT NULL,
  exercise_id INTEGER NOT NULL,
  pos         INTEGER NOT NULL DEFAULT 0,
  weight      REAL    NOT NULL DEFAULT 0,
  reps        INTEGER NOT NULL DEFAULT 0,
  rir         INTEGER,
  warm        INTEGER NOT NULL DEFAULT 0,
  ts          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sets_session ON sets(session_id);
CREATE INDEX IF NOT EXISTS idx_sets_exercise ON sets(exercise_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sets_uid ON sets(uid);
CREATE TABLE IF NOT EXISTS body (
  day    TEXT PRIMARY KEY,
  weight REAL NOT NULL,
  note   TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS oura_daily (
  day           TEXT PRIMARY KEY,
  readiness     INTEGER,
  sleep_score   INTEGER,
  activity      INTEGER,
  hrv           REAL,
  rhr           REAL,
  temp_dev      REAL,
  sleep_sec     INTEGER,
  deep_sec      INTEGER,
  rem_sec       INTEGER,
  efficiency    INTEGER,
  bed_start     TEXT,
  bed_end       TEXT,
  steps         INTEGER,
  active_cal    INTEGER,
  stress_sec    INTEGER,
  recovery_sec  INTEGER,
  resilience    TEXT,
  spo2          REAL,
  vo2max        REAL,
  updated       INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""

OURA_FIELDS = ("readiness", "sleep_score", "activity", "hrv", "rhr", "temp_dev", "sleep_sec",
               "deep_sec", "rem_sec", "efficiency", "bed_start", "bed_end", "steps", "active_cal",
               "stress_sec", "recovery_sec", "resilience", "spo2", "vo2max")


def init() -> None:
    global _conn
    os.makedirs(config.DATA_DIR, exist_ok=True)
    _conn = sqlite3.connect(os.path.join(config.DATA_DIR, "fit.db"), check_same_thread=False)
    _conn.row_factory = sqlite3.Row
    _conn.execute("PRAGMA journal_mode=WAL")
    _conn.executescript(SCHEMA)
    have = {r["name"] for r in _conn.execute("PRAGMA table_info(exercises)")}
    for col, decl in (("image", "''"), ("guide", "'{}'"), ("guide_en", "'{}'")):
        if col not in have:
            _conn.execute(f"ALTER TABLE exercises ADD COLUMN {col} TEXT NOT NULL DEFAULT {decl}")
    if not _conn.execute("SELECT 1 FROM exercises LIMIT 1").fetchone():
        _conn.executemany(
            "INSERT INTO exercises(name, name_en, muscle, also, equipment, kind, step, created) "
            "VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
            [(n, en, m, json.dumps(also), eq, kind, step, now())
             for n, en, m, also, eq, kind, step in EXERCISES])
    # Техника из коробки — только туда, где пусто: своё описание (ассистент записал, как
    # тренажёр выглядит именно в этом зале) обновление не затирает.
    _conn.executemany(
        "UPDATE exercises SET image = ?, guide = ?, guide_en = ? "
        "WHERE name_en = ? AND image = '' AND guide = '{}'",
        [(slug(en), *(json.dumps(dict(zip(GUIDE_KEYS, g)), ensure_ascii=False) for g in pair), en)
         for en, pair in GUIDES.items()])
    _conn.commit()


def now() -> int:
    return int(time.time() * 1000)


def version() -> int:
    return _version


def _q(sql: str, params=()) -> list[sqlite3.Row]:
    with _lock:
        return _conn.execute(sql, params).fetchall()


def _w(sql: str, params=()) -> int:
    """Запись. Счётчик версии растёт здесь же: кто бы ни писал — ручка, агент или
    синхронизация, — открытое приложение узнаёт об этом само."""
    global _version
    with _lock:
        cur = _conn.execute(sql, params)
        _conn.commit()
        _version += 1
        return cur.lastrowid


# ── День и неделя ──

def day_of(ms: int) -> date:
    return (datetime.fromtimestamp(ms / 1000) - timedelta(hours=DAY_START_HOUR)).date()


def today(t: int | None = None) -> date:
    return day_of(t or now())


def week_start(d: date) -> date:
    return d - timedelta(days=d.weekday())


def _day(v, t: int | None = None) -> date:
    if not v:
        return today(t)
    try:
        return v if isinstance(v, date) else date.fromisoformat(str(v))
    except ValueError:
        raise ValueError(f"дата «{v}» — нужен вид ГГГГ-ММ-ДД")


# ── Настройки ──

def settings() -> dict:
    out = dict(DEFAULTS)
    for r in _q("SELECT key, value FROM settings"):
        if r["key"] in DEFAULTS:
            out[r["key"]] = json.loads(r["value"])
    return out


def save_settings(patch: dict) -> dict:
    for k, v in patch.items():
        if k not in DEFAULTS:
            continue
        if k in ("notify", "weekly"):
            v = bool(v)
        if k == "notify_hour":
            v = max(0, min(23, int(v)))
        if k == "oura_min_minutes":
            v = max(0, min(120, int(v)))
        if k == "profile":
            if not isinstance(v, dict):
                raise ValueError("profile — объект")
            # Правка по ключам: ассистент дописывает одно поле, не стирая остальные.
            v = {a: b for a, b in {**settings()["profile"], **v}.items() if b not in (None, "")}
        _w("INSERT INTO settings(key, value) VALUES(?, ?) "
           "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
           (k, json.dumps(v, ensure_ascii=False)))
    return settings()


def meta(key: str, default=None):
    """Служебные отметки (когда слали сводку) — там же, но мимо настроек."""
    r = _q("SELECT value FROM settings WHERE key = ?", ("_" + key,))
    return json.loads(r[0]["value"]) if r else default


def set_meta(key: str, value) -> None:
    _w("INSERT INTO settings(key, value) VALUES(?, ?) "
       "ON CONFLICT(key) DO UPDATE SET value = excluded.value", ("_" + key, json.dumps(value)))


# ── Упражнения ──

def _exercise(r) -> dict:
    return {**dict(r), "also": json.loads(r["also"]), "archived": bool(r["archived"]),
            "guide": json.loads(r["guide"]), "guide_en": json.loads(r["guide_en"])}


def exercises(q: str = "", muscle: str = "", archived: bool = False) -> list[dict]:
    # Сравнение в питоне: NOCASE у sqlite не знает кириллицы.
    q = q.strip().casefold()
    out = []
    for r in _q("SELECT * FROM exercises ORDER BY name"):
        e = _exercise(r)
        if e["archived"] and not archived:
            continue
        if muscle and muscle != e["muscle"] and muscle not in e["also"]:
            continue
        if q and q not in e["name"].casefold() and q not in e["name_en"].casefold():
            continue
        out.append(e)
    return out


def used_exercises() -> list[dict]:
    """Упражнения, по которым есть история, — последнее сделанное первым."""
    return [_exercise(r) for r in _q(
        "SELECT e.*, MAX(x.day) AS last_day FROM exercises e JOIN sets s ON s.exercise_id = e.id "
        "JOIN sessions x ON x.id = s.session_id WHERE s.warm = 0 AND x.deleted = 0 "
        "GROUP BY e.id ORDER BY last_day DESC, e.name")]


def exercise(ex_id: int) -> dict | None:
    r = _q("SELECT * FROM exercises WHERE id = ?", (ex_id,))
    return _exercise(r[0]) if r else None


def find_exercise(ref) -> dict | None:
    """По id или по названию — русскому или английскому, без учёта регистра."""
    if isinstance(ref, int) or (isinstance(ref, str) and ref.strip().isdigit()):
        return exercise(int(ref))
    name = str(ref or "").strip().casefold()
    if not name:
        return None
    for e in exercises(archived=True):
        if name in (e["name"].casefold(), e["name_en"].casefold()):
            return e
    return None


def _need_exercise(ref) -> dict:
    e = find_exercise(ref)
    if not e:
        raise ValueError(f"нет упражнения «{ref}»: выбери из списка или заведи новое")
    return e


def _guide(g) -> str:
    """Техника к хранению: только известные строки, без пустых."""
    if not isinstance(g, dict) or any(k not in GUIDE_KEYS for k in g):
        raise ValueError(f"guide — объект со строками: {', '.join(GUIDE_KEYS)}")
    return json.dumps({k: str(g[k]).strip()[:500] for k in GUIDE_KEYS if str(g.get(k) or "").strip()},
                      ensure_ascii=False)


def _check_exercise(f: dict) -> None:
    if f.get("muscle") is not None and f["muscle"] not in MUSCLES:
        raise ValueError(f"muscle — одно из: {', '.join(MUSCLES)}")
    if any(m not in MUSCLES for m in f.get("also") or []):
        raise ValueError(f"also — из списка: {', '.join(MUSCLES)}")
    if f.get("equipment") is not None and f["equipment"] not in EQUIPMENT:
        raise ValueError(f"equipment — одно из: {', '.join(EQUIPMENT)}")
    if f.get("kind") is not None and f["kind"] not in EX_KINDS:
        raise ValueError(f"kind — одно из: {', '.join(EX_KINDS)}")


def create_exercise(name: str, muscle: str, also=None, equipment: str = "other",
                    kind: str = "strength", step: float | None = None, name_en: str = "",
                    note: str = "", guide: dict | None = None) -> dict:
    name = (name or "").strip()
    if not name:
        raise ValueError("у упражнения нет названия")
    if find_exercise(name) or (name_en and find_exercise(name_en)):
        raise ValueError(f"упражнение «{name}» уже есть")
    _check_exercise({"muscle": muscle, "also": also, "equipment": equipment, "kind": kind})
    if step is None:
        step = 0 if kind == "time" else 2.5
    return exercise(_w(
        "INSERT INTO exercises(name, name_en, muscle, also, equipment, kind, step, note, guide, created) "
        "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (name, name_en.strip(), muscle, json.dumps(also or []), equipment, kind,
         max(0.0, float(step)), note, _guide(guide or {}), now())))


def update_exercise(ex_id: int, **patch) -> dict | None:
    if not exercise(ex_id):
        return None
    f = {k: v for k, v in patch.items() if v is not None and k in
         ("name", "name_en", "muscle", "also", "equipment", "kind", "step", "note", "archived",
          "guide", "guide_en")}
    _check_exercise(f)
    if "name" in f:
        f["name"] = f["name"].strip()
        other = find_exercise(f["name"])
        if not f["name"] or (other and other["id"] != ex_id):
            raise ValueError("такое название занято или пусто")
    if "also" in f:
        f["also"] = json.dumps(f["also"])
    if "archived" in f:
        f["archived"] = int(bool(f["archived"]))
    for k in ("guide", "guide_en"):
        if k in f:
            f[k] = _guide(f[k])
    if f:
        _w(f"UPDATE exercises SET {', '.join(k + ' = ?' for k in f)} WHERE id = ?",
           (*f.values(), ex_id))
    return exercise(ex_id)


# ── Программа ──

def program() -> dict | None:
    """Действующая программа с днями и упражнениями."""
    p = _q("SELECT * FROM programs WHERE active = 1 ORDER BY id DESC LIMIT 1")
    if not p:
        return None
    out = {**dict(p[0]), "active": True, "days": []}
    for d in _q("SELECT * FROM program_days WHERE program_id = ? ORDER BY pos", (out["id"],)):
        items = _q(
            "SELECT i.*, e.name, e.name_en, e.muscle, e.kind, e.step FROM program_items i "
            "JOIN exercises e ON e.id = i.exercise_id WHERE i.day_id = ? ORDER BY i.pos", (d["id"],))
        out["days"].append({**dict(d), "items": [dict(i) for i in items]})
    return out


def set_program(data: dict) -> dict:
    """Заменить программу целиком. Прежняя не стирается: на её дни ссылаются тренировки."""
    name = (data.get("name") or "").strip()
    days = data.get("days") or []
    if not name or not days:
        raise ValueError("у программы должны быть название и хотя бы один день")
    rows = []
    for d in days:
        kind = d.get("kind") or "strength"
        if kind not in KINDS:
            raise ValueError(f"вид дня — одно из: {', '.join(KINDS)}")
        if not (d.get("name") or "").strip():
            raise ValueError("у дня программы нет названия")
        items = []
        for i in d.get("items") or []:
            e = _need_exercise(i.get("exercise", i.get("exercise_id")))
            lo = max(1, int(i.get("reps_min") or 8))
            items.append((e["id"], max(1, min(10, int(i.get("sets") or 3))), lo,
                          max(lo, int(i.get("reps_max") or lo)),
                          max(0, min(5, int(i.get("rir", 2)))),
                          max(0, int(i.get("rest", 120))), i.get("note") or ""))
        if kind == "strength" and not items:
            raise ValueError(f"в силовом дне «{d['name']}» нет упражнений")
        rows.append((d["name"].strip(), kind, max(0, int(d.get("minutes") or 0)),
                     d.get("note") or "", items))
    global _version
    with _lock:
        _conn.execute("UPDATE programs SET active = 0")
        pid = _conn.execute("INSERT INTO programs(name, goal, note, created) VALUES(?, ?, ?, ?)",
                            (name, data.get("goal") or "", data.get("note") or "", now())).lastrowid
        for pos, (dname, kind, minutes, note, items) in enumerate(rows):
            did = _conn.execute(
                "INSERT INTO program_days(program_id, pos, name, kind, minutes, note) "
                "VALUES(?, ?, ?, ?, ?, ?)", (pid, pos, dname, kind, minutes, note)).lastrowid
            _conn.executemany(
                "INSERT INTO program_items(day_id, pos, exercise_id, sets, reps_min, reps_max, "
                "rir, rest, note) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [(did, n, *i) for n, i in enumerate(items)])
        _conn.commit()
        _version += 1
    return program()


def next_day() -> dict | None:
    """Какой день программы на очереди: следующий за последним выполненным, по кругу.
    Сверяем по названию дня: после правки программы очередь продолжается, а не начинается заново."""
    p = program()
    if not p:
        return None
    last = _q("SELECT d.name FROM sessions s JOIN program_days d ON d.id = s.program_day_id "
              "WHERE s.deleted = 0 AND s.ended IS NOT NULL "
              "ORDER BY s.day DESC, s.started DESC, s.id DESC LIMIT 1")
    names = [d["name"] for d in p["days"]]
    if last and last[0]["name"] in names:
        return p["days"][(names.index(last[0]["name"]) + 1) % len(names)]
    return p["days"][0]


def _fit(x: float, step: float) -> float:
    return round(round(x / step) * step, 2) if step > 0 else round(x, 2)


def next_target(n: int, lo: int, hi: int, step: float, hist: list[list[tuple]],
                inc: int = 1) -> tuple:
    """Цель на подход: (вес, повторы, что изменилось). hist — рабочие подходы прошлых
    тренировок, свежая первой, каждый подход — (вес, повторы).

    up — все подходы дошли до верхней границы, прибавляем вес и начинаем с нижней;
    hold — вес тот же, на повтор больше (inc — на сколько: у упражнений на время это секунды);
    down — два срыва подряд, сбрасываем десятую часть."""
    if not hist or not hist[0]:
        return None, lo, "new"
    w = max(s[0] for s in hist[0])
    top = [s[1] for s in hist[0] if s[0] == w]
    if len(top) >= n and min(top) >= hi:
        return (_fit(w + step, step), lo, "up") if step > 0 else (w, hi, "hold")
    failed = [h and max(s[0] for s in h) == w and any(s[1] < lo for s in h if s[0] == w)
              for h in hist[:2]]
    if len(failed) == 2 and all(failed) and w > 0:
        return _fit(w * DELOAD, step), lo, "down"
    return w, min(hi, max(lo, min(top) + inc)), "hold"


def _history(ex_id: int, sessions_n: int = 2, exclude: int | None = None) -> list[dict]:
    """Последние тренировки с этим упражнением: день и рабочие подходы."""
    out: list[dict] = []
    for r in _q("SELECT s.session_id, s.weight, s.reps, x.day FROM sets s "
                "JOIN sessions x ON x.id = s.session_id "
                "WHERE s.exercise_id = ? AND s.warm = 0 AND x.deleted = 0 AND x.id != ? "
                "ORDER BY x.day DESC, x.started DESC, x.id DESC, s.pos, s.id",
                (ex_id, exclude or 0)):
        if not out or out[-1]["session_id"] != r["session_id"]:
            if len(out) == sessions_n:
                break
            out.append({"session_id": r["session_id"], "day": r["day"], "sets": []})
        out[-1]["sets"].append((r["weight"], r["reps"]))
    return out


def plan_for(day_id: int, exclude: int | None = None, easy: bool = False) -> dict | None:
    """День программы с целями на сегодня. exclude — идущая тренировка: её подходы
    не должны считаться «прошлым разом». easy — облегчённый вариант для дня, когда
    восстановление так себе: на подход меньше и без прибавки веса."""
    d = _q("SELECT * FROM program_days WHERE id = ?", (day_id,))
    if not d:
        return None
    out = {**dict(d[0]), "easy": easy, "items": []}
    for i in _q("SELECT i.*, e.name, e.name_en, e.muscle, e.kind, e.step, e.equipment "
                "FROM program_items i JOIN exercises e ON e.id = i.exercise_id "
                "WHERE i.day_id = ? ORDER BY i.pos", (day_id,)):
        hist = _history(i["exercise_id"], exclude=exclude)
        weight, reps, hint = next_target(i["sets"], i["reps_min"], i["reps_max"], i["step"],
                                         [h["sets"] for h in hist],
                                         inc=5 if i["kind"] == "time" else 1)
        item = dict(i)
        if easy:
            item["sets"] = max(1, item["sets"] - 1)
            if hint == "up":
                weight, reps, hint = max(s[0] for s in hist[0]["sets"]), i["reps_max"], "hold"
        out["items"].append({
            **item, "weight": weight, "reps": reps, "hint": hint,
            "last": [{"weight": w, "reps": r} for w, r in hist[0]["sets"]] if hist else [],
            "last_day": hist[0]["day"] if hist else None})
    return out


# ── Тренировки ──

def e1rm(weight: float, reps: int) -> float:
    """Расчётный максимум на один раз по Эпли. Дальше двенадцати повторов формула врёт."""
    if weight <= 0 or reps <= 0:
        return 0.0
    return round(weight if reps == 1 else weight * (1 + min(reps, 12) / 30), 1)


def _sets(session_id: int) -> list[dict]:
    return [{**dict(r), "warm": bool(r["warm"])} for r in _q(
        "SELECT s.id, s.uid, s.exercise_id, s.pos, s.weight, s.reps, s.rir, s.warm, s.ts, "
        "e.name, e.name_en, e.muscle, e.kind FROM sets s JOIN exercises e ON e.id = s.exercise_id "
        "WHERE s.session_id = ? ORDER BY s.pos, s.id", (session_id,))]


def _session(r) -> dict:
    s = dict(r)
    s.pop("deleted"), s.pop("uid"), s.pop("ext_id")
    s["sets"] = _sets(s["id"])
    work = [x for x in s["sets"] if not x["warm"]]
    s["work_sets"] = len(work)
    s["volume"] = round(sum(x["weight"] * x["reps"] for x in work if x["kind"] == "strength"))
    sec = s["duration"] if s["duration"] is not None else (
        (s["ended"] - s["started"]) // 1000 if s["ended"] else None)
    s["minutes"] = round(sec / 60) if sec is not None else None
    return s


_SESSION = ("SELECT s.*, d.name AS day_name FROM sessions s "
            "LEFT JOIN program_days d ON d.id = s.program_day_id ")


def session(session_id: int) -> dict | None:
    r = _q(_SESSION + "WHERE s.id = ? AND s.deleted = 0", (session_id,))
    return _session(r[0]) if r else None


def sessions(limit: int = 30, offset: int = 0, since: str = "", until: str = "",
             kind: str = "") -> list[dict]:
    sql, params = _SESSION + "WHERE s.deleted = 0", []
    for cond, v in (("s.day >= ?", since), ("s.day <= ?", until), ("s.kind = ?", kind)):
        if v:
            sql += " AND " + cond
            params.append(v)
    sql += " ORDER BY s.day DESC, s.started DESC, s.id DESC LIMIT ? OFFSET ?"
    return [_session(r) for r in _q(sql, (*params, max(1, min(500, limit)), max(0, offset)))]


def active() -> dict | None:
    """Идущая тренировка: начата и не закончена."""
    r = _q(_SESSION + "WHERE s.deleted = 0 AND s.ended IS NULL ORDER BY s.started DESC LIMIT 1")
    return _session(r[0]) if r else None


def start_session(kind: str = "strength", program_day_id: int | None = None, title: str = "",
                  uid: str = "", t: int | None = None) -> dict:
    """Начать тренировку. uid — метка от приложения: повтор запроса после обрыва связи
    вернёт ту же тренировку, а не заведёт вторую."""
    if kind not in KINDS:
        raise ValueError(f"вид тренировки — одно из: {', '.join(KINDS)}")
    if uid:
        r = _q("SELECT id FROM sessions WHERE uid = ?", (uid,))
        if r:
            return session(r[0]["id"])
    if program_day_id is not None:
        d = _q("SELECT kind FROM program_days WHERE id = ?", (program_day_id,))
        if not d:
            raise ValueError("нет такого дня программы")
        kind = d[0]["kind"]
    t = t or now()
    return session(_w(
        "INSERT INTO sessions(uid, day, started, kind, program_day_id, title) VALUES(?, ?, ?, ?, ?, ?)",
        (uid or None, day_of(t).isoformat(), t, kind, program_day_id, title.strip())))


def _set_values(weight, reps, rir) -> tuple:
    weight, reps = float(weight or 0), int(reps or 0)
    if weight < 0 or weight > 1000 or reps <= 0 or reps > 10000:
        raise ValueError("подход: вес от 0 до 1000 кг, повторов больше нуля")
    return weight, reps, (None if rir is None else max(0, min(10, int(rir))))


def add_set(session_id: int, exercise, weight=0, reps=0, rir=None, warm: bool = False,
            uid: str = "", t: int | None = None) -> dict | None:
    if not _q("SELECT 1 FROM sessions WHERE id = ? AND deleted = 0", (session_id,)):
        return None
    if uid and _q("SELECT 1 FROM sets WHERE uid = ?", (uid,)):
        return session(session_id)
    e = _need_exercise(exercise)
    weight, reps, rir = _set_values(weight, reps, rir)
    pos = _q("SELECT COALESCE(MAX(pos), -1) + 1 AS p FROM sets WHERE session_id = ?",
             (session_id,))[0]["p"]
    _w("INSERT INTO sets(uid, session_id, exercise_id, pos, weight, reps, rir, warm, ts) "
       "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
       (uid or None, session_id, e["id"], pos, weight, reps, rir, int(bool(warm)), t or now()))
    return session(session_id)


def update_set(set_id: int, weight=None, reps=None, rir=None, warm=None) -> dict | None:
    r = _q("SELECT * FROM sets WHERE id = ?", (set_id,))
    if not r:
        return None
    w, n, i = _set_values(r[0]["weight"] if weight is None else weight,
                          r[0]["reps"] if reps is None else reps,
                          r[0]["rir"] if rir is None else rir)
    _w("UPDATE sets SET weight = ?, reps = ?, rir = ?, warm = ? WHERE id = ?",
       (w, n, i, r[0]["warm"] if warm is None else int(bool(warm)), set_id))
    return session(r[0]["session_id"])


def delete_set(set_id: int) -> dict | None:
    r = _q("SELECT session_id FROM sets WHERE id = ?", (set_id,))
    if not r:
        return None
    _w("DELETE FROM sets WHERE id = ?", (set_id,))
    return session(r[0]["session_id"])


def update_session(session_id: int, **patch) -> dict | None:
    """Правка тренировки: заметка, самочувствие (1…5), время, дистанция, день."""
    if not session(session_id):
        return None
    f = {k: v for k, v in patch.items() if v is not None and k in
         ("title", "note", "feel", "kind", "day", "duration", "distance", "calories",
          "avg_hr", "max_hr", "started", "ended", "program_day_id")}
    if "program_day_id" in f and not _q("SELECT 1 FROM program_days WHERE id = ?", (f["program_day_id"],)):
        raise ValueError("нет такого дня программы")
    if "feel" in f:
        f["feel"] = max(1, min(5, int(f["feel"])))
    if "kind" in f and f["kind"] not in KINDS:
        raise ValueError(f"вид тренировки — одно из: {', '.join(KINDS)}")
    if "day" in f:
        f["day"] = _day(f["day"]).isoformat()
    if f:
        _w(f"UPDATE sessions SET {', '.join(k + ' = ?' for k in f)} WHERE id = ?",
           (*f.values(), session_id))
    return session(session_id)


def finish_session(session_id: int, feel=None, note=None, t: int | None = None) -> dict | None:
    s = session(session_id)
    if not s:
        return None
    return update_session(session_id, feel=feel, note=note, ended=s["ended"] or t or now())


def delete_session(session_id: int) -> bool:
    if not session(session_id):
        return False
    _w("UPDATE sessions SET deleted = 1 WHERE id = ?", (session_id,))
    return True


def log_session(data: dict, t: int | None = None) -> dict:
    """Записать тренировку задним числом одним куском — для ассистента и записи текстом.
    Упражнения — по названию или id; всё проверяется до первой записи."""
    t = t or now()
    day = _day(data.get("day"), t)
    kind = data.get("kind") or ("strength" if data.get("sets") else "other")
    if kind not in KINDS:
        raise ValueError(f"вид тренировки — одно из: {', '.join(KINDS)}")
    day_id = None
    if data.get("program_day"):
        p = program()
        ref = str(data["program_day"]).strip().casefold()
        hit = [d for d in (p["days"] if p else [])
               if ref in (str(d["id"]), d["name"].casefold())]
        if not hit:
            raise ValueError(f"в программе нет дня «{data['program_day']}»")
        day_id = hit[0]["id"]
    rows = [(_need_exercise(s.get("exercise", s.get("exercise_id")))["id"],
             *_set_values(s.get("weight"), s.get("reps"), s.get("rir")), int(bool(s.get("warm"))))
            for s in data.get("sets") or []]
    sec = int(float(data["minutes"]) * 60) if data.get("minutes") else None
    # Сегодняшняя закончилась сейчас; прошлую ставим на полдень — точного часа никто не помнит.
    ended = t if day == today(t) else int(datetime.combine(day, dtime(12)).timestamp() * 1000)
    started = ended - (sec or 0) * 1000
    feel = data.get("feel")
    global _version
    with _lock:
        sid = _conn.execute(
            "INSERT INTO sessions(day, started, ended, kind, program_day_id, title, note, feel, "
            "duration, distance, calories) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (day.isoformat(), started, ended, kind, day_id, (data.get("title") or "").strip(),
             data.get("note") or "", None if feel is None else max(1, min(5, int(feel))), sec,
             float(data["distance_km"]) * 1000 if data.get("distance_km") else None,
             data.get("calories"))).lastrowid
        _conn.executemany(
            "INSERT INTO sets(session_id, exercise_id, pos, weight, reps, rir, warm, ts) "
            "VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
            [(sid, ex, pos, w, n, rir, warm, ended) for pos, (ex, w, n, rir, warm) in enumerate(rows)])
        _conn.commit()
        _version += 1
    return session(sid)


# ── Прогресс ──

def records(session_id: int) -> list[dict]:
    """Рекорды тренировки: упражнения, где расчётный максимум выше всего прежнего."""
    s = session(session_id)
    if not s:
        return []
    best: dict[int, dict] = {}
    for x in s["sets"]:
        v = e1rm(x["weight"], x["reps"]) if x["kind"] == "strength" and not x["warm"] else 0
        if v > best.get(x["exercise_id"], {"e1rm": 0})["e1rm"]:
            best[x["exercise_id"]] = {"exercise_id": x["exercise_id"], "name": x["name"],
                                      "name_en": x["name_en"], "e1rm": v,
                                      "weight": x["weight"], "reps": x["reps"]}
    out = []
    for ex_id, b in best.items():
        prev = max((e1rm(r["weight"], r["reps"]) for r in _q(
            "SELECT s.weight, s.reps FROM sets s JOIN sessions x ON x.id = s.session_id "
            "WHERE s.exercise_id = ? AND s.warm = 0 AND x.deleted = 0 AND x.id != ? "
            "AND (x.day < ? OR (x.day = ? AND x.started < ?))",
            (ex_id, session_id, s["day"], s["day"], s["started"]))), default=0)
        # Первая запись упражнения — точка отсчёта, а не рекорд.
        if prev and b["e1rm"] > prev:
            out.append({**b, "prev": prev})
    return out


def progress(exercise, limit: int = 60) -> dict:
    """Как менялось упражнение: по тренировкам — лучший подход, расчётный максимум, объём."""
    e = _need_exercise(exercise)
    points: dict[int, dict] = {}
    for r in _q("SELECT s.session_id, s.weight, s.reps, x.day FROM sets s "
                "JOIN sessions x ON x.id = s.session_id "
                "WHERE s.exercise_id = ? AND s.warm = 0 AND x.deleted = 0 "
                "ORDER BY x.day, x.started, x.id", (e["id"],)):
        p = points.setdefault(r["session_id"], {"day": r["day"], "e1rm": 0, "weight": 0,
                                                "reps": 0, "volume": 0, "sets": 0})
        v = e1rm(r["weight"], r["reps"])
        # У упражнений на время и со своим весом максимума нет — лучшим считаем длинный подход.
        if (v, r["reps"]) > (p["e1rm"], p["reps"]):
            p.update(e1rm=v, weight=r["weight"], reps=r["reps"])
        p["volume"] += round(r["weight"] * r["reps"])
        p["sets"] += 1
    pts = list(points.values())[-limit:]
    return {"exercise": e, "points": pts,
            "best": max(pts, key=lambda p: (p["e1rm"], p["reps"]), default=None)}


def week(t: int | None = None, back: int = 0) -> dict:
    """Неделя с понедельника: сколько тренировок и минут, тяжёлых подходов по мышцам."""
    start = week_start(today(t)) - timedelta(weeks=back)
    end = start + timedelta(days=6)
    rows = _q("SELECT * FROM sessions WHERE deleted = 0 AND ended IS NOT NULL "
              "AND day BETWEEN ? AND ? ORDER BY day, started", (start.isoformat(), end.isoformat()))
    out = {"from": start.isoformat(), "to": end.isoformat(), "sessions": len(rows),
           "minutes": 0, "by_kind": {}, "days": {}, "sets": {}, "work_sets": 0}
    for r in rows:
        sec = r["duration"] if r["duration"] is not None else (r["ended"] - r["started"]) // 1000
        out["minutes"] += round(sec / 60)
        out["by_kind"][r["kind"]] = out["by_kind"].get(r["kind"], 0) + 1
        out["days"].setdefault(r["day"], []).append(r["kind"])
    for r in _q("SELECT e.muscle, e.also FROM sets s JOIN sessions x ON x.id = s.session_id "
                "JOIN exercises e ON e.id = s.exercise_id WHERE s.warm = 0 AND x.deleted = 0 "
                "AND x.day BETWEEN ? AND ?", (start.isoformat(), end.isoformat())):
        out["work_sets"] += 1
        out["sets"][r["muscle"]] = out["sets"].get(r["muscle"], 0) + 1
        for m in json.loads(r["also"]):
            out["sets"][m] = out["sets"].get(m, 0) + ALSO_SHARE
    return out


def weeks(n: int = 12, t: int | None = None) -> list[dict]:
    return [week(t, back) for back in range(max(1, min(104, n)) - 1, -1, -1)]


# ── Вес тела ──

def log_body(weight: float, day=None, note: str = "", t: int | None = None) -> dict:
    weight = float(weight)
    if not 20 <= weight <= 400:
        raise ValueError("вес тела — в килограммах, от 20 до 400")
    d = _day(day, t).isoformat()
    _w("INSERT INTO body(day, weight, note) VALUES(?, ?, ?) "
       "ON CONFLICT(day) DO UPDATE SET weight = excluded.weight, note = excluded.note",
       (d, round(weight, 1), note))
    return {"day": d, "weight": round(weight, 1), "note": note}


def body(limit: int = 365) -> list[dict]:
    return [dict(r) for r in _q("SELECT * FROM body ORDER BY day DESC LIMIT ?", (limit,))][::-1]


def delete_body(day: str) -> bool:
    if not _q("SELECT 1 FROM body WHERE day = ?", (day,)):
        return False
    _w("DELETE FROM body WHERE day = ?", (day,))
    return True


# ── Кольцо ──
# Что приносит синхронизация с Oura (fit_oura): сутки одной строкой и тренировки кольца.

def oura_put(day: str, **vals) -> None:
    """Дописать сутки. Пустое не затирает записанное: сон и активность приходят порознь."""
    f = {k: v for k, v in vals.items() if k in OURA_FIELDS and v is not None}
    if not f:
        return
    cols = ", ".join(f)
    _w(f"INSERT INTO oura_daily(day, {cols}, updated) VALUES(?, {', '.join('?' * len(f))}, ?) "
       f"ON CONFLICT(day) DO UPDATE SET {', '.join(k + ' = excluded.' + k for k in f)}, "
       "updated = excluded.updated", (day, *f.values(), now()))


def oura_days(days: int = 30, t: int | None = None) -> list[dict]:
    since = (today(t) - timedelta(days=max(1, days) - 1)).isoformat()
    return [dict(r) for r in _q("SELECT * FROM oura_daily WHERE day >= ? ORDER BY day", (since,))]


def oura_workout(ext_id: str, day: str, started: int, ended: int, kind: str, title: str,
                 distance=None, calories=None) -> int | None:
    """Тренировка, которую записало кольцо. Если на это время уже есть своя запись —
    вторую не заводим, а дописываем в свою калории: человек записал подходы, кольцо — расход."""
    mine = _q("SELECT id, calories FROM sessions WHERE deleted = 0 AND source = 'manual' "
              "AND ended IS NOT NULL AND started < ? AND ended > ?", (ended, started))
    if mine:
        if mine[0]["calories"] is None and calories:
            _w("UPDATE sessions SET calories = ? WHERE id = ?", (calories, mine[0]["id"]))
        return None
    sec = (ended - started) // 1000
    r = _q("SELECT id FROM sessions WHERE source = 'oura' AND ext_id = ?", (ext_id,))
    if r:
        # Удалённую не воскрешаем, заметку и самочувствие не трогаем — меняется только измеренное.
        _w("UPDATE sessions SET day = ?, started = ?, ended = ?, duration = ?, distance = ?, "
           "calories = ? WHERE id = ?", (day, started, ended, sec, distance, calories, r[0]["id"]))
        return r[0]["id"]
    if sec < settings()["oura_min_minutes"] * 60:
        return None
    return _w("INSERT INTO sessions(day, started, ended, kind, title, source, ext_id, duration, "
              "distance, calories) VALUES(?, ?, ?, ?, ?, 'oura', ?, ?, ?, ?)",
              (day, started, ended, kind, title, ext_id, sec, distance, calories))


def without_pulse(since: str) -> list[dict]:
    """Законченные тренировки без пульса — синхронизация спросит его у кольца."""
    return [dict(r) for r in _q(
        "SELECT id, started, ended FROM sessions WHERE deleted = 0 AND avg_hr IS NULL "
        "AND ended IS NOT NULL AND ended > started AND day >= ? ORDER BY started", (since,))]


def set_pulse(session_id: int, avg: int, top: int) -> None:
    _w("UPDATE sessions SET avg_hr = ?, max_hr = ? WHERE id = ?", (avg, top, session_id))


# ── Восстановление ──
# Совет на день считается по правилам, без модели: сегодняшние цифры кольца против
# своей же нормы за две недели. Одного жёлтого сигнала мало — кольцо шумит.

BASE_DAYS = 14
BASE_MIN = 5          # меньше дней — нормы ещё нет, сравнивать не с чем


def _base(rows: list[dict], key: str) -> tuple | None:
    vals = [r[key] for r in rows if r[key] is not None]
    if len(vals) < BASE_MIN:
        return None
    mean = sum(vals) / len(vals)
    sd = (sum((v - mean) ** 2 for v in vals) / len(vals)) ** 0.5
    return mean, sd


def _grade(value, warn, bad, below: bool = True) -> str:
    if value is None:
        return ""
    if below:
        return "bad" if value < bad else "warn" if value < warn else "ok"
    return "bad" if value > bad else "warn" if value > warn else "ok"


def recovery(t: int | None = None) -> dict:
    """Как человек восстановился к сегодняшнему дню и что с этим делать:
    go — по плану, easy — облегчить, rest — перенести или погулять. level None — данных нет
    (кольцо не подключено или ещё не синхронизировалось с утра)."""
    d = today(t).isoformat()
    rows = oura_days(BASE_DAYS + 1, t)
    row = next((r for r in rows if r["day"] == d), None)
    out = {"day": d, "level": None, "signals": [], "data": row}
    if not row or (row["readiness"] is None and row["sleep_sec"] is None):
        return out
    past = [r for r in rows if r["day"] != d]
    sig = []

    def add(key, value, state, base=None):
        if state:
            sig.append({"key": key, "value": value, "state": state,
                        **({"base": round(base, 1)} if base is not None else {})})

    add("readiness", row["readiness"], _grade(row["readiness"], 70, 60))
    add("sleep", row["sleep_sec"], _grade(row["sleep_sec"], 6 * 3600, 5 * 3600))
    add("temp", row["temp_dev"], _grade(row["temp_dev"], 0.5, 1.0, below=False))
    hrv, rhr = _base(past, "hrv"), _base(past, "rhr")
    if hrv and row["hrv"] is not None:
        # Разброс не меньше двадцатой части нормы: у ровного человека сигма мала, и любой чих был бы тревогой.
        sd = max(hrv[1], hrv[0] * 0.05)
        add("hrv", row["hrv"], _grade(row["hrv"], hrv[0] - sd, hrv[0] - 2 * sd), hrv[0])
    if rhr and row["rhr"] is not None:
        sd = max(rhr[1], 2)
        add("rhr", row["rhr"], _grade(row["rhr"], rhr[0] + sd, rhr[0] + 2 * sd, below=False), rhr[0])
    state = {s["key"]: s["state"] for s in sig}
    score = sum({"warn": 1, "bad": 2}.get(s["state"], 0) for s in sig)
    if score >= 4 or state.get("temp") == "bad" or (row["readiness"] or 100) < 50:
        level = "rest"
    elif score >= 2:
        level = "easy"
    else:
        level = "go"
    return {**out, "level": level, "signals": sig}


# ── Сводка ──

def overview(t: int | None = None) -> dict:
    """Экран «Сегодня»: что на очереди, что идёт, что сделано и как идёт неделя."""
    t = t or now()
    d = today(t).isoformat()
    p = program()
    act = active()
    nxt = next_day()
    weights = body(1)
    rec = recovery(t)
    return {
        "day": d,
        "program": {"id": p["id"], "name": p["name"], "goal": p["goal"],
                    "days": [{"id": x["id"], "name": x["name"], "kind": x["kind"]}
                             for x in p["days"]]} if p else None,
        "active": act,
        "next": plan_for(nxt["id"], exclude=act["id"] if act else None,
                         easy=rec["level"] in ("easy", "rest")) if nxt else None,
        "recovery": rec,
        "today": [s for s in sessions(since=d, until=d) if s["ended"]],
        "week": week(t),
        "body": weights[0] if weights else None,
        "profile": settings()["profile"],
    }
