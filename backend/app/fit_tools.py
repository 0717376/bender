"""Тренировки для агента: составить программу, записать сделанное, посмотреть прогресс.

Цифры на сегодня (какой вес, сколько повторов) считает хранилище по прошлым тренировкам —
агенту их придумывать не надо. Его дело — программа, разбор и запись со слов.
"""

import json
from datetime import timedelta

from claude_agent_sdk import create_sdk_mcp_server, tool

from . import fit_store as store


def _text(obj) -> dict:
    return {"content": [{"type": "text", "text": json.dumps(obj, ensure_ascii=False, default=str)}]}


def _try(fn, *a, **kw) -> dict:
    try:
        return fn(*a, **kw)
    except (ValueError, TypeError) as e:
        return {"error": str(e)}


def brief(s: dict) -> dict:
    """Тренировка для агента: подходы строкой «80×5, 80×5», без служебных полей."""
    out = {"id": s["id"], "day": s["day"], "kind": s["kind"]}
    for k in ("day_name", "title", "minutes", "feel", "note", "avg_hr", "max_hr", "calories"):
        if s.get(k):
            out[k] = s[k]
    if s.get("distance"):
        out["distance_km"] = round(s["distance"] / 1000, 2)
    if s["source"] != "manual":
        out["source"] = s["source"]
    if not s["ended"]:
        out["running"] = True
    by: dict[str, list[str]] = {}
    for x in s["sets"]:
        if x["kind"] == "time":
            one = f"{x['reps']} с" + (f" с {x['weight']:g} кг" if x["weight"] else "")
        else:
            one = f"{x['weight']:g}×{x['reps']}" if x["weight"] else str(x["reps"])
        by.setdefault(x["name"], []).append(one + (" (разминка)" if x["warm"] else ""))
    if by:
        out["exercises"] = {k: ", ".join(v) for k, v in by.items()}
    return out


def plan_brief(p: dict | None) -> dict | None:
    """День программы с целями: что делать и что было в прошлый раз."""
    if not p:
        return None
    out = {"id": p["id"], "name": p["name"], "kind": p["kind"]}
    if p["minutes"]:
        out["minutes"] = p["minutes"]
    if p["note"]:
        out["note"] = p["note"]
    if p["items"]:
        out["items"] = [{
            "exercise": i["name"], "sets": i["sets"], "reps": f"{i['reps_min']}–{i['reps_max']}",
            "rir": i["rir"], "target_weight": i["weight"], "target_reps": i["reps"],
            "change": i["hint"],
            **({"last": ", ".join(f"{x['weight']:g}×{x['reps']}" for x in i["last"]),
                "last_day": i["last_day"]} if i["last"] else {}),
        } for i in p["items"]]
    return out


def today() -> dict:
    o = store.overview()
    w = o["week"]
    return {"day": o["day"], "program": o["program"]["name"] if o["program"] else None,
            "next": plan_brief(o["next"]),
            "running": brief(o["active"]) if o["active"] else None,
            "done_today": [brief(s) for s in o["today"]],
            "week": {"sessions": w["sessions"], "minutes": w["minutes"], "by_kind": w["by_kind"],
                     "sets_by_muscle": w["sets"]},
            "recovery": recovery_brief(o["recovery"]),
            "body": o["body"], "profile": o["profile"]}


def _night(r: dict) -> dict:
    """Сутки кольца для агента: часы вместо секунд, без пустых полей."""
    out = {k: r[k] for k in ("day", "readiness", "sleep_score", "activity", "hrv", "rhr", "temp_dev",
                             "efficiency", "steps", "active_cal", "resilience", "spo2", "vo2max")
           if r.get(k) is not None}
    for k, name in (("sleep_sec", "sleep_h"), ("deep_sec", "deep_h"), ("rem_sec", "rem_h"),
                    ("stress_sec", "stress_h"), ("recovery_sec", "recovery_h")):
        if r.get(k) is not None:
            out[name] = round(r[k] / 3600, 1)
    return out


def recovery_brief(rec: dict) -> dict | None:
    """Совет на день по кольцу: go — по плану, easy — облегчить, rest — перенести."""
    if not rec["level"]:
        return None
    return {"level": rec["level"], "today": _night(rec["data"]),
            "signals": [s for s in rec["signals"] if s["state"] != "ok"]}


def recovery(days: int = 14) -> dict:
    rec = store.recovery()
    rows = store.oura_days(max(1, min(120, days)))
    if not rows:
        return {"error": "данных кольца нет: Oura не подключена или ещё не синхронизировалась"}
    return {"today": recovery_brief(rec), "days": [_night(r) for r in rows]}


def history(days: int = 30, kind: str = "", limit: int = 30) -> list[dict]:
    since = (store.today() - timedelta(days=max(1, days))).isoformat()
    return [brief(s) for s in store.sessions(limit=limit, since=since, kind=kind)]


def exercise_progress(exercise, limit: int = 20) -> dict:
    p = store.progress(exercise, limit)
    return {"exercise": p["exercise"]["name"], "best": p["best"], "points": p["points"]}


def log(data: dict) -> dict:
    s = store.log_session(data)
    return {**brief(s), "records": [{"exercise": r["name"], "e1rm": r["e1rm"], "was": r["prev"]}
                                    for r in store.records(s["id"])]}


@tool("today", "Тренировки сегодня: какой день программы на очереди и с какими целями "
      "(вес и повторы посчитаны по прошлому разу), что уже сделано, итог недели, вес тела "
      "и профиль человека (опыт, инвентарь, ограничения).", {})
async def today_tool(args):
    return _text(today())


@tool("get_program", "Действующая программа тренировок: дни по кругу и упражнения в них "
      "(подходы, диапазон повторов, запас повторов до отказа, отдых).", {})
async def get_program(args):
    p = store.program()
    if not p:
        return _text({"program": None})
    return _text({"id": p["id"], "name": p["name"], "goal": p["goal"], "note": p["note"], "days": [
        {"name": d["name"], "kind": d["kind"],
         **({"minutes": d["minutes"]} if d["minutes"] else {}),
         **({"note": d["note"]} if d["note"] else {}),
         "items": [{"exercise": i["name"], "sets": i["sets"], "reps_min": i["reps_min"],
                    "reps_max": i["reps_max"], "rir": i["rir"], "rest": i["rest"],
                    **({"note": i["note"]} if i["note"] else {})} for i in d["items"]]}
        for d in p["days"]]})


@tool(
    "set_program",
    "Задать программу целиком (заменяет действующую; история тренировок остаётся). days — "
    "круг дней в порядке выполнения, без привязки к дням недели. У дня: name («А», «Кардио»), "
    "kind (strength | cardio | swim | other); у силового — items, у остальных — minutes и note "
    "(«30 минут в спокойном темпе»). У строки: exercise (название из list_exercises), sets, "
    "reps_min, reps_max, rir (запас повторов до отказа, 0…5), rest (отдых, секунды). Чтобы "
    "поправить одну строку, возьми get_program, измени и пришли целиком.",
    {"type": "object",
     "properties": {
         "name": {"type": "string"}, "goal": {"type": "string"}, "note": {"type": "string"},
         "days": {"type": "array", "items": {
             "type": "object",
             "properties": {
                 "name": {"type": "string"},
                 "kind": {"type": "string", "enum": list(store.KINDS)},
                 "minutes": {"type": "integer"}, "note": {"type": "string"},
                 "items": {"type": "array", "items": {
                     "type": "object",
                     "properties": {"exercise": {"type": "string"}, "sets": {"type": "integer"},
                                    "reps_min": {"type": "integer"}, "reps_max": {"type": "integer"},
                                    "rir": {"type": "integer"}, "rest": {"type": "integer"},
                                    "note": {"type": "string"}},
                     "required": ["exercise", "sets", "reps_min", "reps_max"]}}},
             "required": ["name"]}}},
     "required": ["name", "days"]},
)
async def set_program(args):
    p = _try(store.set_program, args)
    return _text(p if "error" in p else {"ok": True, "id": p["id"], "name": p["name"],
                                         "days": [d["name"] for d in p["days"]]})


GUIDE_HELP = ("find — как выглядит снаряд и как его найти в зале, setup — исходное положение, "
              "focus — на что обратить внимание, avoid — частая ошибка; по одной-две фразы.")
GUIDE_SCHEMA = {"type": "object", "properties": {k: {"type": "string"} for k in store.GUIDE_KEYS}}


@tool(
    "list_exercises",
    "Справочник упражнений. q — часть названия, muscle — группа мышц: " + ", ".join(store.MUSCLES) + ".",
    {"type": "object", "properties": {"q": {"type": "string"}, "muscle": {"type": "string"}}},
)
async def list_exercises(args):
    return _text([{"id": e["id"], "name": e["name"], "muscle": e["muscle"], "also": e["also"],
                   "equipment": e["equipment"], "kind": e["kind"]}
                  for e in store.exercises(args.get("q", ""), args.get("muscle", ""))])


@tool(
    "add_exercise",
    "Завести упражнение, которого нет в справочнике. muscle — главная группа, also — "
    "вспомогательные; equipment: " + ", ".join(store.EQUIPMENT) + "; kind: strength (вес и "
    "повторы) или time (держим на время, в повторах секунды); step — шаг прибавки веса, кг. "
    "guide — карточка техники, её человек открывает в зале: " + GUIDE_HELP,
    {"type": "object",
     "properties": {"name": {"type": "string"}, "name_en": {"type": "string"},
                    "muscle": {"type": "string", "enum": list(store.MUSCLES)},
                    "also": {"type": "array", "items": {"type": "string"}},
                    "equipment": {"type": "string", "enum": list(store.EQUIPMENT)},
                    "kind": {"type": "string", "enum": list(store.EX_KINDS)},
                    "step": {"type": "number"}, "guide": GUIDE_SCHEMA},
     "required": ["name", "muscle"]},
)
async def add_exercise(args):
    return _text(_try(store.create_exercise, args["name"], args["muscle"], args.get("also"),
                      args.get("equipment", "other"), args.get("kind", "strength"),
                      args.get("step"), args.get("name_en", ""), guide=args.get("guide")))


def exercise_guide(exercise, guide: dict | None = None) -> dict:
    e = store._need_exercise(exercise)
    if guide:
        # Правят по строке: «мой тренажёр стоит у окна» не должно стирать остальное.
        # Перевод переписанной строки устарел — убираем: приложение покажет то, что записано.
        e = store.update_exercise(
            e["id"], guide={**e["guide"], **guide},
            guide_en={k: v for k, v in e["guide_en"].items() if k not in guide})
    return {"exercise": e["name"], "guide": e["guide"], "image": bool(e["image"])}


@tool(
    "exercise_guide",
    "Карточка техники упражнения — то, что человек видит в приложении по нажатию на название. "
    "Без guide — прочитать; с guide — записать указанные строки, остальные остаются: "
    + GUIDE_HELP + " Пустая строка стирает свою.",
    {"type": "object", "properties": {"exercise": {"type": "string"}, "guide": GUIDE_SCHEMA},
     "required": ["exercise"]},
)
async def exercise_guide_tool(args):
    return _text(_try(exercise_guide, args["exercise"], args.get("guide")))


@tool(
    "log_session",
    "Записать сделанную тренировку. kind: strength | cardio | swim | other. Для силовой — sets: "
    "по записи на каждый подход {exercise (название), weight (кг; 0 — свой вес), reps, rir?, "
    "warm? (разминочный)}; «жим 80 на 5, три подхода» — это три записи. Для кардио и бассейна — "
    "minutes и distance_km. day — ГГГГ-ММ-ДД (по умолчанию сегодня), program_day — название дня "
    "программы, если тренировка по ней (тогда очередь сдвинется), feel — самочувствие 1…5, "
    "title, note.",
    {"type": "object",
     "properties": {
         "kind": {"type": "string", "enum": list(store.KINDS)},
         "day": {"type": "string"}, "program_day": {"type": "string"},
         "title": {"type": "string"}, "note": {"type": "string"},
         "minutes": {"type": "number"}, "distance_km": {"type": "number"},
         "feel": {"type": "integer"},
         "sets": {"type": "array", "items": {
             "type": "object",
             "properties": {"exercise": {"type": "string"}, "weight": {"type": "number"},
                            "reps": {"type": "integer"}, "rir": {"type": "integer"},
                            "warm": {"type": "boolean"}},
             "required": ["exercise", "reps"]}}},
     "required": ["kind"]},
)
async def log_session(args):
    return _text(_try(log, args))


@tool(
    "history",
    "Прошлые тренировки, свежие первыми: что делал, с какими весами, сколько минут, "
    "самочувствие. days — за сколько дней (по умолчанию 30), kind — только такого вида.",
    {"type": "object", "properties": {"days": {"type": "integer"}, "kind": {"type": "string"},
                                      "limit": {"type": "integer"}}},
)
async def history_tool(args):
    return _text(history(args.get("days") or 30, args.get("kind", ""), args.get("limit") or 30))


@tool(
    "progress",
    "Как менялось упражнение от тренировки к тренировке: лучший подход, расчётный максимум "
    "на один раз (e1rm), объём. exercise — название. Без него — недельная картина: тренировок, "
    "минут и тяжёлых подходов по группам мышц за weeks недель (по умолчанию 8).",
    {"type": "object", "properties": {"exercise": {"type": "string"}, "weeks": {"type": "integer"}}},
)
async def progress(args):
    if args.get("exercise"):
        return _text(_try(exercise_progress, args["exercise"]))
    return _text([{"from": w["from"], "sessions": w["sessions"], "minutes": w["minutes"],
                   "by_kind": w["by_kind"], "sets_by_muscle": w["sets"]}
                  for w in store.weeks(args.get("weeks") or 8)])


@tool(
    "recovery",
    "Сон и восстановление с кольца Oura по дням: готовность, оценка сна, часы сна (всего, "
    "глубокий, REM), вариабельность пульса (hrv), пульс покоя (rhr), отклонение температуры, "
    "шаги, стресс. today — совет на сегодня по правилам приложения: go (по плану), easy "
    "(облегчить), rest (перенести) и сигналы, из-за которых так. days — сколько дней, "
    "по умолчанию 14.",
    {"type": "object", "properties": {"days": {"type": "integer"}}},
)
async def recovery_tool(args):
    return _text(recovery(args.get("days") or 14))


@tool(
    "delete_session",
    "Удалить тренировку по id — если записал с ошибкой и проще записать заново.",
    {"type": "object", "properties": {"id": {"type": "integer"}}, "required": ["id"]},
)
async def delete_session(args):
    return _text({"ok": True} if store.delete_session(args["id"]) else {"error": "тренировка не найдена"})


@tool(
    "log_body",
    "Записать вес тела, кг. day — ГГГГ-ММ-ДД, по умолчанию сегодня.",
    {"type": "object", "properties": {"weight": {"type": "number"}, "day": {"type": "string"}},
     "required": ["weight"]},
)
async def log_body(args):
    return _text(_try(store.log_body, args["weight"], args.get("day")))


@tool(
    "update_profile",
    "Запомнить, что важно для программы: profile — объект с любыми из полей goal (цель), "
    "experience (опыт), equipment (где и чем занимается), days_per_week, minutes (на одну "
    "тренировку), limits (травмы и ограничения), notes. Пишутся только присланные поля; "
    "пустая строка стирает поле.",
    {"type": "object", "properties": {"profile": {"type": "object"}}, "required": ["profile"]},
)
async def update_profile(args):
    s = _try(store.save_settings, {"profile": args.get("profile")})
    return _text(s if "error" in s else s["profile"])


TOOLS = [today_tool, get_program, set_program, list_exercises, add_exercise, exercise_guide_tool,
         log_session, history_tool, progress, recovery_tool, delete_session, log_body,
         update_profile]

TOOL_NAMES = [f"mcp__fit__{t.name}" for t in TOOLS]

server = create_sdk_mcp_server("fit", version="1.0.0", tools=TOOLS)
