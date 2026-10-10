"""Карточки для интервальных повторений: sqlite рядом с задачами и книгами (data/cards.db).

Три слоя. Заметка (note) — то, что человек хочет помнить: слово, вопрос с ответом, фраза
с пропусками. Карточка (card) — один вопрос по заметке: у слова их две (узнать и вспомнить),
у фразы — по одной на пропуск. Журнал (revlog) — каждый ответ: по нему считается статистика,
и по нему же потом подгоняются параметры планировщика под свою память.

Когда показывать карточку, решает cards_fsrs; здесь — хранение, очередь дня и счёт.
"""

import json
import os
import re
import sqlite3
import threading
import time
from datetime import date, datetime, timedelta
from datetime import time as dtime

from . import cards_fsrs as fsrs
from . import config

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None
_version = 0           # растёт на каждой записи — по нему просыпается SSE

NEW, LEARNING, REVIEW, RELEARNING = 0, 1, 2, 3
KINDS = ("word", "basic", "cloze")
# День карточек кончается не в полночь: повторять в час ночи — это ещё «сегодня».
DAY_START_HOUR = 4
# Доучиваемую карточку показываем чуть раньше срока, если больше показывать нечего:
# иначе сессия кончается словами «приходи через восемь минут».
LEARN_AHEAD_MS = 20 * 60 * 1000
# Столько провалов — и карточка не учится, а мучает: её надо переписать, а не зубрить.
LEECH_LAPSES = 6

DEFAULTS = {
    "notify": True,          # присылать ли утреннее напоминание в Telegram
    "notify_hour": 9,        # в котором часу (по часам сервера)
    "new_per_day": 15,       # новых карточек в день — для новых колод
    "retention": 0.9,        # какую долю хотим помнить к моменту повтора
    "params": None,          # свои параметры FSRS; None — стандартные
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS decks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  descr       TEXT    NOT NULL DEFAULT '',
  new_per_day INTEGER NOT NULL DEFAULT 15,
  retention   REAL    NOT NULL DEFAULT 0.9,
  created     INTEGER NOT NULL DEFAULT 0,
  updated     INTEGER NOT NULL DEFAULT 0,
  deleted     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS notes (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  deck_id  INTEGER NOT NULL,
  kind     TEXT    NOT NULL,
  fields   TEXT    NOT NULL DEFAULT '{}',
  source   TEXT    NOT NULL DEFAULT '{}',
  tags     TEXT    NOT NULL DEFAULT '[]',
  status   TEXT    NOT NULL DEFAULT 'ready',
  error    TEXT    NOT NULL DEFAULT '',
  created  INTEGER NOT NULL DEFAULT 0,
  updated  INTEGER NOT NULL DEFAULT 0,
  deleted  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_notes_deck ON notes(deck_id);
CREATE TABLE IF NOT EXISTS cards (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id      INTEGER NOT NULL,
  tpl          TEXT    NOT NULL,
  state        INTEGER NOT NULL DEFAULT 0,
  step         INTEGER,
  stability    REAL,
  difficulty   REAL,
  due          INTEGER,
  last_review  INTEGER,
  first_review INTEGER,
  reps         INTEGER NOT NULL DEFAULT 0,
  lapses       INTEGER NOT NULL DEFAULT 0,
  suspended    INTEGER NOT NULL DEFAULT 0,
  leech        INTEGER NOT NULL DEFAULT 0,
  buried_until INTEGER NOT NULL DEFAULT 0,
  created      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cards_note ON cards(note_id);
CREATE INDEX IF NOT EXISTS idx_cards_due ON cards(state, due);
CREATE TABLE IF NOT EXISTS revlog (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id   INTEGER NOT NULL,
  ts        INTEGER NOT NULL,
  rating    INTEGER NOT NULL,
  state     INTEGER NOT NULL,
  elapsed   REAL    NOT NULL DEFAULT 0,
  scheduled REAL    NOT NULL DEFAULT 0,
  duration  INTEGER NOT NULL DEFAULT 0,
  src       TEXT    NOT NULL DEFAULT 'web',
  prev      TEXT    NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_revlog_ts ON revlog(ts);
CREATE INDEX IF NOT EXISTS idx_revlog_card ON revlog(card_id);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""


def init() -> None:
    global _conn
    os.makedirs(config.DATA_DIR, exist_ok=True)
    _conn = sqlite3.connect(os.path.join(config.DATA_DIR, "cards.db"), check_same_thread=False)
    _conn.row_factory = sqlite3.Row
    _conn.execute("PRAGMA journal_mode=WAL")
    _conn.executescript(SCHEMA)
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
    бот, — открытое приложение узнаёт об этом само."""
    global _version
    with _lock:
        cur = _conn.execute(sql, params)
        _conn.commit()
        _version += 1
        return cur.lastrowid


# ── День ──
# Время сервера, а не UTC: «сегодня» у карточек то же, что у задач и у расписания.

def day_of(ms: int) -> date:
    return (datetime.fromtimestamp(ms / 1000) - timedelta(hours=DAY_START_HOUR)).date()


def day_start(d: date) -> int:
    return int(datetime.combine(d, dtime(DAY_START_HOUR)).timestamp() * 1000)


def day_end(ms: int) -> int:
    """Конец дня, в который попадает момент: до него карточка считается сегодняшней."""
    return day_start(day_of(ms) + timedelta(days=1))


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
        if k == "notify_hour":
            v = max(0, min(23, int(v)))
        if k == "new_per_day":
            v = max(0, min(500, int(v)))
        if k == "retention":
            v = max(0.7, min(0.97, float(v)))
        _w("INSERT INTO settings(key, value) VALUES(?, ?) "
           "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (k, json.dumps(v)))
    return settings()


def meta(key: str, default=None):
    """Служебные отметки (когда слали напоминание) — там же, но мимо настроек."""
    r = _q("SELECT value FROM settings WHERE key = ?", ("_" + key,))
    return json.loads(r[0]["value"]) if r else default


def set_meta(key: str, value) -> None:
    _w("INSERT INTO settings(key, value) VALUES(?, ?) "
       "ON CONFLICT(key) DO UPDATE SET value = excluded.value", ("_" + key, json.dumps(value)))


# ── Колоды ──

def _deck(r: sqlite3.Row) -> dict:
    return {"id": r["id"], "name": r["name"], "descr": r["descr"],
            "new_per_day": r["new_per_day"], "retention": r["retention"]}


def decks() -> list[dict]:
    return [_deck(r) for r in _q("SELECT * FROM decks WHERE deleted = 0 ORDER BY id")]


def deck(deck_id: int) -> dict | None:
    r = _q("SELECT * FROM decks WHERE id = ? AND deleted = 0", (deck_id,))
    return _deck(r[0]) if r else None


def create_deck(name: str, descr: str = "", new_per_day: int | None = None,
                retention: float | None = None) -> dict:
    name = (name or "").strip()
    if not name:
        raise ValueError("у колоды должно быть название")
    # Сравниваем в питоне: NOCASE в sqlite знает только латиницу, а «Физика» и «физика» —
    # одна колода.
    for d in decks():
        if d["name"].casefold() == name.casefold():
            return d
    s = settings()
    t = now()
    did = _w("INSERT INTO decks(name, descr, new_per_day, retention, created, updated) "
             "VALUES(?, ?, ?, ?, ?, ?)",
             (name, descr or "", s["new_per_day"] if new_per_day is None else int(new_per_day),
              s["retention"] if retention is None else float(retention), t, t))
    return deck(did)


def update_deck(deck_id: int, **fields) -> dict | None:
    if not deck(deck_id):
        return None
    allowed = {"name": str, "descr": str, "new_per_day": int, "retention": float}
    for k, v in fields.items():
        if k in allowed and v is not None:
            v = allowed[k](v)
            if k == "name" and not v.strip():
                continue
            if k == "retention":
                v = max(0.7, min(0.97, v))
            _w(f"UPDATE decks SET {k} = ?, updated = ? WHERE id = ?", (v, now(), deck_id))
    return deck(deck_id)


def delete_deck(deck_id: int) -> bool:
    if not deck(deck_id):
        return False
    t = now()
    _w("UPDATE notes SET deleted = 1, updated = ? WHERE deck_id = ?", (t, deck_id))
    _w("UPDATE decks SET deleted = 1, updated = ? WHERE id = ?", (t, deck_id))
    return True


def resolve_deck(ref, kind: str = "basic") -> dict:
    """Колода по id или названию; новое название колоду заводит. Без указания — слова
    идут в «Слова», остальное в «Разное»: карточка без колоды нигде не видна."""
    if isinstance(ref, int) or (isinstance(ref, str) and ref.strip().isdigit()):
        d = deck(int(ref))
        if d:
            return d
    if isinstance(ref, str) and ref.strip() and not ref.strip().isdigit():
        return create_deck(ref)
    return create_deck("Слова" if kind == "word" else "Разное")


# ── Заметки ──

CLOZE = re.compile(r"\{\{c(\d+)::(.*?)(?:::(.*?))?\}\}", re.S)

WORD_FIELDS = ("word", "lemma", "ipa", "pos", "meaning", "other", "example", "example_tr", "lang")
BASIC_FIELDS = ("front", "back", "extra", "reverse")
CLOZE_FIELDS = ("text", "extra")


def clean_fields(kind: str, fields: dict, draft: bool = False) -> dict:
    """Оставить известные поля и проверить, что карточке есть что спросить и что ответить.
    Черновик проверку не проходит по определению — его ещё заполнят."""
    if kind not in KINDS:
        raise ValueError(f"вид карточки — один из {', '.join(KINDS)}")
    keep = {"word": WORD_FIELDS, "basic": BASIC_FIELDS, "cloze": CLOZE_FIELDS}[kind]
    out = {}
    for k in keep:
        v = (fields or {}).get(k)
        if k == "reverse":
            if v:
                out[k] = True
        elif v is not None and str(v).strip():
            out[k] = str(v).strip()
    if draft:
        return out
    if kind == "word" and not (out.get("word") and out.get("meaning")):
        raise ValueError("слову нужны поля word и meaning")
    if kind == "basic" and not (out.get("front") and out.get("back")):
        raise ValueError("карточке нужны поля front и back")
    if kind == "cloze" and not CLOZE.search(out.get("text", "")):
        raise ValueError("во фразе нет пропусков: отметь их как {{c1::скрытое}}")
    return out


def templates(kind: str, fields: dict) -> list[str]:
    """Какие карточки положены заметке. Порядок важен: следующая вводится после предыдущей."""
    if kind == "word":
        return ["fwd", "rev"]
    if kind == "basic":
        return ["fwd", "rev"] if fields.get("reverse") else ["fwd"]
    nums = sorted({int(m.group(1)) for m in CLOZE.finditer(fields.get("text", ""))})
    return [f"c{n}" for n in nums]


def faces(kind: str, fields: dict, tpl: str) -> dict:
    """Лицо и оборот карточки простым текстом с лёгкой разметкой — для бота, агента и
    всех, кому не нужна вёрстка. Приложение рисует по полям само."""
    f = fields or {}
    if kind == "word":
        word, meaning = f.get("word", ""), f.get("meaning", "")
        details = " · ".join(x for x in (f.get("ipa"), f.get("pos")) if x)
        lemma = f.get("lemma") if f.get("lemma") and f.get("lemma") != word else ""
        example = f.get("example", "")
        if tpl == "rev":
            hidden = re.sub(re.escape(word), "____", example, flags=re.I) if word and example else ""
            front = meaning + (f"\n\n_{hidden}_" if hidden and hidden != example else "")
            back = "\n".join(x for x in (f"**{word}**", details, f"_{example}_" if example else "") if x)
            return {"front": front, "back": back}
        front = f"**{word}**" + (f"\n\n_{example}_" if example else "")
        back = "\n".join(x for x in (
            f"**{meaning}**", details, f"начальная форма: {lemma}" if lemma else "",
            f.get("other", ""), f.get("example_tr", "")) if x)
        return {"front": front, "back": back}
    if kind == "basic":
        a, b = f.get("front", ""), f.get("back", "")
        if tpl == "rev":
            a, b = b, a
        return {"front": a, "back": b + (f"\n\n{f['extra']}" if f.get("extra") else "")}
    n = int(tpl[1:]) if tpl[1:].isdigit() else 1
    text = f.get("text", "")
    front = CLOZE.sub(lambda m: (f"[{m.group(3) or '…'}]" if int(m.group(1)) == n else m.group(2)), text)
    back = CLOZE.sub(lambda m: (f"**{m.group(2)}**" if int(m.group(1)) == n else m.group(2)), text)
    return {"front": front, "back": back + (f"\n\n{f['extra']}" if f.get("extra") else "")}


def _note(r: sqlite3.Row) -> dict:
    return {"id": r["id"], "deck_id": r["deck_id"], "kind": r["kind"],
            "fields": json.loads(r["fields"]), "source": json.loads(r["source"]),
            "tags": json.loads(r["tags"]), "status": r["status"], "error": r["error"],
            "created": r["created"], "updated": r["updated"]}


def note(note_id: int) -> dict | None:
    r = _q("SELECT * FROM notes WHERE id = ? AND deleted = 0", (note_id,))
    return _note(r[0]) if r else None


def _sync_cards(note_id: int, kind: str, fields: dict) -> None:
    """Привести карточки заметки к её полям: недостающие завести, лишние убрать.
    Существующие не трогаем — правка опечатки не должна стирать выученное."""
    want = templates(kind, fields)
    have = {r["tpl"]: r["id"] for r in _q("SELECT id, tpl FROM cards WHERE note_id = ?", (note_id,))}
    for tpl, cid in have.items():
        if tpl not in want:
            _w("DELETE FROM cards WHERE id = ?", (cid,))
    t = now()
    for tpl in want:
        if tpl not in have:
            _w("INSERT INTO cards(note_id, tpl, created) VALUES(?, ?, ?)", (note_id, tpl, t))


def create_note(kind: str, fields: dict, deck=None, source: dict | None = None,
                tags: list[str] | None = None, draft: bool = False) -> dict:
    """Завести заметку и её карточки. Черновик (draft) карточек не получает: его поля
    ещё заполняет агент, и спрашивать по нему нечего."""
    fields = clean_fields(kind, fields, draft=draft)
    d = resolve_deck(deck, kind)
    t = now()
    nid = _w("INSERT INTO notes(deck_id, kind, fields, source, tags, status, created, updated) "
             "VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
             (d["id"], kind, json.dumps(fields, ensure_ascii=False),
              json.dumps(source or {}, ensure_ascii=False),
              json.dumps(tags or [], ensure_ascii=False), "draft" if draft else "ready", t, t))
    if not draft:
        _sync_cards(nid, kind, fields)
    return note(nid)


def update_note(note_id: int, fields: dict | None = None, kind: str | None = None, deck=None,
                tags: list[str] | None = None) -> dict | None:
    """Править заметку. Поля приходят целиком или частью — сливаем с прежними.
    Удачная правка черновика или сбойной заметки делает её готовой."""
    cur = note(note_id)
    if not cur:
        return None
    kind = kind or cur["kind"]
    merged = dict(cur["fields"]) if kind == cur["kind"] else {}
    for k, v in (fields or {}).items():
        if v is None or v == "":
            merged.pop(k, None)
        else:
            merged[k] = v
    merged = clean_fields(kind, merged)
    deck_id = resolve_deck(deck, kind)["id"] if deck is not None else cur["deck_id"]
    _w("UPDATE notes SET kind = ?, fields = ?, deck_id = ?, tags = ?, status = 'ready', "
       "error = '', updated = ? WHERE id = ?",
       (kind, json.dumps(merged, ensure_ascii=False), deck_id,
        json.dumps(cur["tags"] if tags is None else tags, ensure_ascii=False), now(), note_id))
    _sync_cards(note_id, kind, merged)
    return note(note_id)


def fail_note(note_id: int, error: str) -> None:
    _w("UPDATE notes SET status = 'failed', error = ?, updated = ? WHERE id = ? AND status = 'draft'",
       (error[:500], now(), note_id))


def redraft_note(note_id: int) -> dict | None:
    """Сбойную заметку — снова в черновики: заполнение попробует ещё раз."""
    _w("UPDATE notes SET status = 'draft', error = '', updated = ? WHERE id = ? AND status = 'failed'",
       (now(), note_id))
    return note(note_id)


def drafts() -> list[dict]:
    return [_note(r) for r in _q("SELECT * FROM notes WHERE deleted = 0 AND status = 'draft' ORDER BY id")]


def delete_note(note_id: int) -> bool:
    if not note(note_id):
        return False
    _w("UPDATE notes SET deleted = 1, updated = ? WHERE id = ?", (now(), note_id))
    return True


def _card(r: sqlite3.Row) -> dict:
    return {"id": r["id"], "note_id": r["note_id"], "tpl": r["tpl"], "state": r["state"],
            "due": r["due"], "stability": r["stability"], "difficulty": r["difficulty"],
            "reps": r["reps"], "lapses": r["lapses"], "suspended": bool(r["suspended"]),
            "leech": bool(r["leech"]), "last_review": r["last_review"]}


def note_cards(note_id: int) -> list[dict]:
    return [_card(r) for r in _q("SELECT * FROM cards WHERE note_id = ? ORDER BY id", (note_id,))]


def list_notes(q: str = "", deck_id: int | None = None, status: str = "", leech: bool = False,
               limit: int = 100, offset: int = 0) -> list[dict]:
    """Заметки с карточками — для списка и поиска. status: ready | draft | failed |
    inbox (черновики и сбои вместе)."""
    where, params = ["n.deleted = 0"], []
    if deck_id:
        where.append("n.deck_id = ?"); params.append(deck_id)
    if status == "inbox":
        where.append("n.status IN ('draft', 'failed')")
    elif status:
        where.append("n.status = ?"); params.append(status)
    if leech:
        where.append("EXISTS (SELECT 1 FROM cards c WHERE c.note_id = n.id AND c.leech = 1)")
    rows = _q(f"SELECT n.* FROM notes n WHERE {' AND '.join(where)} ORDER BY n.id DESC", params)
    # Поиск — в питоне: LIKE в sqlite не различает регистр только на латинице, а в полях
    # кириллица. Заметок не миллионы.
    needle = (q or "").strip().casefold()
    out = []
    for r in rows:
        if needle and needle not in (r["fields"] + r["tags"] + r["source"]).casefold():
            continue
        out.append(r)
    out = out[offset:offset + max(1, min(500, limit))]
    result = []
    for r in out:
        n = _note(r)
        n["cards"] = note_cards(n["id"])
        result.append(n)
    return result


def set_suspended(card_id: int, suspended: bool) -> bool:
    if not _q("SELECT 1 FROM cards WHERE id = ?", (card_id,)):
        return False
    if suspended:
        _w("UPDATE cards SET suspended = 1 WHERE id = ?", (card_id,))
    else:
        # Вернуть в работу — значит и снять метку пиявки: человек карточку посмотрел,
        # и счёт провалов начинается заново.
        _w("UPDATE cards SET suspended = 0, leech = 0, lapses = 0 WHERE id = ?", (card_id,))
    return True


# ── Очередь ──

_LIVE = ("FROM cards c JOIN notes n ON n.id = c.note_id JOIN decks d ON d.id = n.deck_id "
         "WHERE n.deleted = 0 AND d.deleted = 0 AND n.status = 'ready' AND c.suspended = 0")


def _introduced_today(t: int) -> dict[int, int]:
    """Сколько новых карточек уже начато сегодня — по колодам."""
    rows = _q("SELECT n.deck_id AS deck, COUNT(*) AS k FROM cards c JOIN notes n ON n.id = c.note_id "
              "WHERE c.first_review >= ? GROUP BY n.deck_id", (day_start(day_of(t)),))
    return {r["deck"]: r["k"] for r in rows}


def _new_cards(t: int, deck_id: int | None) -> list[sqlite3.Row]:
    """Новые карточки в пределах дневной нормы каждой колоды. Вторая карточка заметки
    (вспомнить слово) ждёт, пока первая (узнать его) не выучена: иначе они подсказывают
    друг другу."""
    rows = _q(f"SELECT c.*, n.deck_id AS deck, d.new_per_day AS quota {_LIVE} "
              "AND c.state = 0 AND c.buried_until <= ? "
              "AND NOT EXISTS (SELECT 1 FROM cards s WHERE s.note_id = c.note_id AND s.id < c.id "
              "                AND s.state != 2 AND s.suspended = 0) "
              + ("AND n.deck_id = ? " if deck_id else "") + "ORDER BY c.id",
              (t, deck_id) if deck_id else (t,))
    used = _introduced_today(t)
    out, seen = [], set()
    for r in rows:
        if r["note_id"] in seen:          # две новые карточки одной заметки в один день не даём
            continue
        if used.get(r["deck"], 0) >= r["quota"]:
            continue
        used[r["deck"]] = used.get(r["deck"], 0) + 1
        seen.add(r["note_id"])
        out.append(r)
    return out


def _due_rows(t: int, deck_id: int | None) -> tuple[list, list, list]:
    """(доучиваемые, повторы, новые) — всё, что положено показать сегодня."""
    deck_sql = "AND n.deck_id = ? " if deck_id else ""
    args = (deck_id,) if deck_id else ()
    learning = _q(f"SELECT c.*, n.deck_id AS deck {_LIVE} AND c.state IN (1, 3) AND c.due < ? "
                  f"{deck_sql}ORDER BY c.due", (day_end(t), *args))
    review = _q(f"SELECT c.*, n.deck_id AS deck, d.retention AS retention {_LIVE} AND c.state = 2 "
                f"AND c.due < ? AND c.buried_until <= ? {deck_sql}", (day_end(t), t, *args))
    # Сначала то, что вот-вот забудется: если на все повторы времени не хватит,
    # пропадёт то, что и так держится лучше.
    review = sorted(review, key=lambda r: fsrs.retrievability(r, t))
    return learning, review, _new_cards(t, deck_id)


def counts(deck_id: int | None = None, t: int | None = None) -> dict:
    t = t or now()
    learning, review, new = _due_rows(t, deck_id)
    return {"learning": len(learning), "review": len(review), "new": len(new),
            "total": len(learning) + len(review) + len(new)}


def _full(r: sqlite3.Row, t: int) -> dict:
    """Карточка со всем, что нужно показать и оценить: заметка, лица, интервалы."""
    n = note(r["note_id"])
    d = deck(n["deck_id"])
    c = _card(r)
    c.update(kind=n["kind"], fields=n["fields"], source=n["source"], tags=n["tags"],
             deck_id=d["id"], deck=d["name"], **faces(n["kind"], n["fields"], r["tpl"]))
    c["intervals"] = fsrs.preview(r, t, d["retention"], settings()["params"])
    return c


def next_card(deck_id: int | None = None, t: int | None = None) -> dict | None:
    """Следующая карточка сессии или None, если на сейчас всё. Порядок: доучиваемые,
    у которых подошёл срок, потом повторы, потом новые; под конец — доучиваемые чуть
    раньше срока, чтобы не обрывать сессию ожиданием."""
    t = t or now()
    learning, review, new = _due_rows(t, deck_id)
    ripe = [r for r in learning if r["due"] <= t]
    pick = (ripe or review or new or [r for r in learning if r["due"] <= t + LEARN_AHEAD_MS] or [None])[0]
    return _full(pick, t) if pick else None


def waiting(deck_id: int | None = None, t: int | None = None) -> int | None:
    """Когда подойдёт ближайшая доучиваемая карточка (мс), если сейчас показывать нечего."""
    t = t or now()
    learning, _, _ = _due_rows(t, deck_id)
    later = [r["due"] for r in learning if r["due"] > t]
    return min(later) if later else None


def card(card_id: int, t: int | None = None) -> dict | None:
    r = _q(f"SELECT c.* {_LIVE.replace('AND c.suspended = 0', '')} AND c.id = ?", (card_id,))
    return _full(r[0], t or now()) if r else None


# ── Ответ ──

def answer(card_id: int, rating: int, duration: int = 0, src: str = "web",
           t: int | None = None) -> dict | None:
    """Записать оценку (1 снова · 2 трудно · 3 хорошо · 4 легко) и переставить карточку."""
    if rating not in (1, 2, 3, 4):
        raise ValueError("оценка — от 1 до 4")
    t = t or now()
    rows = _q("SELECT c.*, d.retention AS retention FROM cards c JOIN notes n ON n.id = c.note_id "
              "JOIN decks d ON d.id = n.deck_id WHERE c.id = ?", (card_id,))
    if not rows:
        return None
    r = rows[0]
    nxt = fsrs.review(r, rating, t, r["retention"], settings()["params"])
    lapse = r["state"] == REVIEW and rating == 1
    lapses = r["lapses"] + (1 if lapse else 0)
    leech = 1 if lapses >= LEECH_LAPSES else r["leech"]
    # Соседние карточки той же заметки сегодня больше не показываем: только что виденный
    # ответ превращает вопрос в формальность. Доучиваемые не трогаем — у них свой счёт минут.
    end = day_end(t)
    siblings = [s["id"] for s in _q(
        "SELECT id FROM cards WHERE note_id = ? AND id != ? AND state IN (0, 2) AND buried_until < ?",
        (r["note_id"], card_id, end))]
    prev = {k: r[k] for k in ("state", "step", "stability", "difficulty", "due", "last_review",
                              "first_review", "reps", "lapses", "suspended", "leech")}
    prev["buried"] = siblings
    with _lock:
        _w("UPDATE cards SET state = ?, step = ?, stability = ?, difficulty = ?, due = ?, "
           "last_review = ?, first_review = COALESCE(first_review, ?), reps = reps + 1, "
           "lapses = ?, leech = ?, suspended = CASE WHEN ? THEN 1 ELSE suspended END WHERE id = ?",
           (nxt["state"], nxt["step"], nxt["stability"], nxt["difficulty"], nxt["due"], t, t,
            lapses, leech, 1 if leech and not r["leech"] else 0, card_id))
        for sid in siblings:
            _w("UPDATE cards SET buried_until = ? WHERE id = ?", (end, sid))
        elapsed = (t - r["last_review"]) / 86400000 if r["last_review"] else 0
        _w("INSERT INTO revlog(card_id, ts, rating, state, elapsed, scheduled, duration, src, prev) "
           "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
           (card_id, t, rating, r["state"], elapsed, (nxt["due"] - t) / 86400000,
            max(0, min(int(duration or 0), 10 * 60 * 1000)), src, json.dumps(prev)))
    return {"card_id": card_id, "state": nxt["state"], "due": nxt["due"],
            "leech": bool(leech and not r["leech"])}


def undo() -> dict | None:
    """Отменить последний ответ: палец промахнулся мимо кнопки. Только сегодняшний —
    вчерашнюю оценку «отменять» уже поздно, по ней прошло время."""
    rows = _q("SELECT * FROM revlog ORDER BY id DESC LIMIT 1")
    if not rows or day_of(rows[0]["ts"]) != day_of(now()):
        return None
    log = rows[0]
    prev = json.loads(log["prev"])
    if not prev:
        return None
    with _lock:
        _w("UPDATE cards SET state = ?, step = ?, stability = ?, difficulty = ?, due = ?, "
           "last_review = ?, first_review = ?, reps = ?, lapses = ?, suspended = ?, leech = ? "
           "WHERE id = ?",
           (prev["state"], prev["step"], prev["stability"], prev["difficulty"], prev["due"],
            prev["last_review"], prev["first_review"], prev["reps"], prev["lapses"],
            prev["suspended"], prev["leech"], log["card_id"]))
        for sid in prev.get("buried", []):
            _w("UPDATE cards SET buried_until = 0 WHERE id = ?", (sid,))
        _w("DELETE FROM revlog WHERE id = ?", (log["id"],))
    return {"card_id": log["card_id"]}


# ── Сводка и статистика ──

def _streaks(days: set[date], today: date) -> tuple[int, int]:
    """(текущая серия, лучшая). Сегодняшний день без повторов серию ещё не рвёт."""
    cur, d = 0, today if today in days else today - timedelta(days=1)
    while d in days:
        cur += 1
        d -= timedelta(days=1)
    best, run, last = 0, 0, None
    for d in sorted(days):
        run = run + 1 if last and d - last == timedelta(days=1) else 1
        best, last = max(best, run), d
    return cur, best


def _review_days() -> dict[date, dict]:
    out: dict[date, dict] = {}
    for r in _q("SELECT ts, rating, state, duration FROM revlog"):
        d = out.setdefault(day_of(r["ts"]), {"n": 0, "again": 0, "ms": 0, "mature": 0, "mature_ok": 0})
        d["n"] += 1
        d["ms"] += r["duration"]
        d["again"] += r["rating"] == 1
        if r["state"] == REVIEW:
            d["mature"] += 1
            d["mature_ok"] += r["rating"] != 1
    return out


def forecast(days: int = 7, t: int | None = None) -> list[dict]:
    """Сколько повторов придётся на каждый из ближайших дней. Просроченное — на сегодня."""
    t = t or now()
    today = day_of(t)
    out = [{"day": (today + timedelta(days=i)).isoformat(), "n": 0} for i in range(days)]
    for r in _q(f"SELECT c.due {_LIVE} AND c.state != 0 AND c.due IS NOT NULL"):
        i = max(0, (day_of(r["due"]) - today).days)
        if i < days:
            out[i]["n"] += 1
    return out


def overview(t: int | None = None) -> dict:
    """Всё для главного экрана одним запросом: что сегодня, колоды, серия, прогноз."""
    t = t or now()
    days = _review_days()
    today = day_of(t)
    cur, best = _streaks(set(days), today)
    totals = {r["deck"]: r["k"] for r in _q(
        f"SELECT n.deck_id AS deck, COUNT(*) AS k {_LIVE.replace('AND c.suspended = 0', '')} "
        "GROUP BY n.deck_id")}
    return {
        "due": counts(None, t),
        "waiting": waiting(None, t),
        "decks": [{**d, "counts": counts(d["id"], t), "cards": totals.get(d["id"], 0)} for d in decks()],
        "streak": {"current": cur, "best": best},
        "today": days.get(today, {"n": 0, "again": 0, "ms": 0}),
        "forecast": forecast(7, t),
        "inbox": _q("SELECT COUNT(*) AS k FROM notes WHERE deleted = 0 AND status IN ('draft', 'failed')")[0]["k"],
        "leeches": _q(f"SELECT COUNT(*) AS k {_LIVE.replace('AND c.suspended = 0', '')} AND c.leech = 1")[0]["k"],
    }


def stats(window: int = 182, t: int | None = None) -> dict:
    t = t or now()
    today = day_of(t)
    days = _review_days()
    cur, best = _streaks(set(days), today)
    since = today - timedelta(days=window - 1)
    month = today - timedelta(days=29)
    seen = sum(v["mature"] for d, v in days.items() if d >= month)
    kept = sum(v["mature_ok"] for d, v in days.items() if d >= month)
    maturity = {"new": 0, "learning": 0, "young": 0, "mature": 0, "suspended": 0}
    for r in _q(f"SELECT c.state, c.stability, c.suspended {_LIVE.replace('AND c.suspended = 0', '')}"):
        if r["suspended"]:
            maturity["suspended"] += 1
        elif r["state"] == NEW:
            maturity["new"] += 1
        elif r["state"] in (LEARNING, RELEARNING):
            maturity["learning"] += 1
        else:
            # Граница та же, что в Anki: интервал от трёх недель — карточка «зрелая».
            maturity["mature" if (r["stability"] or 0) >= 21 else "young"] += 1
    return {
        "today": today.isoformat(), "from": since.isoformat(),
        "days": [{"day": d.isoformat(), "n": v["n"], "again": v["again"], "ms": v["ms"]}
                 for d, v in sorted(days.items()) if d >= since],
        "streak": {"current": cur, "best": best},
        "totals": {"reviews": sum(v["n"] for v in days.values()),
                   "ms": sum(v["ms"] for v in days.values()), "days": len(days)},
        # Удержание — доля повторов выученных карточек, на которых ответ вспомнился.
        "retention": {"seen": seen, "kept": kept, "rate": round(kept / seen, 3) if seen else None},
        "maturity": maturity,
        "forecast": forecast(30, t),
    }
