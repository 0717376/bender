"""Тренировки: прогрессия, очередь программы, дневник, показатели, ручки, инструменты."""

import asyncio
import json
import os
import sys
from datetime import datetime

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def at(day: int, hour: int = 12, minute: int = 0) -> int:
    """Момент в миллисекундах: день января 2026-го по часам сервера."""
    return int(datetime(2026, 1, day, hour, minute).timestamp() * 1000)


@pytest.fixture
def store(tmp_path, monkeypatch):
    from app import config, fit_store

    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path))
    fit_store.init()
    return fit_store


@pytest.fixture
def api(store, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app import config, fit_api

    monkeypatch.setattr(config, "WIKI_PASSWORD", "пароль")
    monkeypatch.setattr(config, "AUTH_TOKEN", "tok3n")
    app = FastAPI()
    app.include_router(fit_api.events_router)
    app.include_router(fit_api.router)
    client = TestClient(app)
    client.headers["Authorization"] = "Bearer tok3n"
    return client


PROGRAM = {"name": "База", "goal": "сила", "days": [
    {"name": "А", "items": [
        {"exercise": "Жим лёжа", "sets": 3, "reps_min": 6, "reps_max": 10},
        {"exercise": "Тяга верхнего блока", "sets": 2, "reps_min": 8, "reps_max": 12}]},
    {"name": "Кардио", "kind": "cardio", "minutes": 30, "note": "спокойный темп"},
    {"name": "Б", "items": [
        {"exercise": "Приседания со штангой", "sets": 3, "reps_min": 5, "reps_max": 8}]},
]}


def done(store, day, sets, program_day=None, kind="strength", **kw):
    return store.log_session({"day": f"2026-01-{day:02d}", "kind": kind, "program_day": program_day,
                              "sets": [{"exercise": e, "weight": w, "reps": r} for e, w, r in sets],
                              **kw}, t=at(day))


# ── Прогрессия ──

def test_first_time_has_no_weight(store):
    assert store.next_target(3, 6, 10, 2.5, []) == (None, 6, "new")


def test_weight_goes_up_when_every_set_hits_the_top(store):
    assert store.next_target(3, 6, 10, 2.5, [[(80, 10), (80, 10), (80, 10)]]) == (82.5, 6, "up")


def test_reps_go_up_until_then(store):
    assert store.next_target(3, 6, 10, 2.5, [[(80, 9), (80, 8), (80, 7)]]) == (80, 8, "hold")
    # Верхняя граница — потолок цели, даже если один подход уже там.
    assert store.next_target(3, 6, 10, 2.5, [[(80, 10), (80, 10), (80, 9)]]) == (80, 10, "hold")


def test_fewer_sets_than_planned_is_not_a_reason_to_add(store):
    assert store.next_target(3, 6, 10, 2.5, [[(80, 10), (80, 10)]])[2] == "hold"


def test_two_failures_in_a_row_drop_the_weight(store):
    bad = [(100, 5), (100, 4)]
    assert store.next_target(2, 6, 10, 2.5, [bad]) == (100, 6, "hold")
    assert store.next_target(2, 6, 10, 2.5, [bad, bad]) == (90, 6, "down")
    # Срыв на другом весе — не второй подряд.
    assert store.next_target(2, 6, 10, 2.5, [bad, [(95, 5), (95, 5)]])[2] == "hold"


def test_time_holds_grow_by_seconds_and_never_add_weight(store):
    assert store.next_target(2, 30, 60, 0, [[(0, 40), (0, 35)]], inc=5) == (0, 40, "hold")
    assert store.next_target(2, 30, 60, 0, [[(0, 60), (0, 60)]], inc=5) == (0, 60, "hold")


def test_plan_takes_targets_from_last_session(store):
    p = store.set_program(PROGRAM)
    day_a = p["days"][0]["id"]
    assert [i["hint"] for i in store.plan_for(day_a)["items"]] == ["new", "new"]
    done(store, 5, [("Жим лёжа", 60, 5), ("Жим лёжа", 80, 10), ("Жим лёжа", 80, 10), ("Жим лёжа", 80, 10),
                    ("Тяга верхнего блока", 50, 9), ("Тяга верхнего блока", 50, 8)], "А")
    bench, pull = store.plan_for(day_a)["items"]
    assert (bench["weight"], bench["reps"], bench["hint"]) == (82.5, 6, "up")
    assert (pull["weight"], pull["reps"], pull["hint"]) == (50, 9, "hold")
    assert bench["last_day"] == "2026-01-05" and len(bench["last"]) == 4


def test_warmups_do_not_count(store):
    p = store.set_program(PROGRAM)
    s = store.start_session(program_day_id=p["days"][0]["id"], t=at(5))
    store.add_set(s["id"], "Жим лёжа", 100, 3, warm=True)
    for _ in range(3):
        store.add_set(s["id"], "Жим лёжа", 80, 8)
    store.finish_session(s["id"], t=at(5, 13))
    assert store.plan_for(p["days"][0]["id"])["items"][0]["weight"] == 80


def test_running_session_is_not_last_time(store):
    p = store.set_program(PROGRAM)
    day_a = p["days"][0]["id"]
    done(store, 5, [("Жим лёжа", 80, 8)] * 3, "А")
    s = store.start_session(program_day_id=day_a, t=at(8))
    store.add_set(s["id"], "Жим лёжа", 80, 9, t=at(8))
    assert store.plan_for(day_a, exclude=s["id"])["items"][0]["reps"] == 9
    # Очередь двигает законченная тренировка: пока идёт вторая «А», на очереди всё ещё «Кардио».
    o = store.overview(at(8))
    assert o["active"]["id"] == s["id"] and o["next"]["name"] == "Кардио"


# ── Программа и очередь ──

def test_queue_goes_round(store):
    store.set_program(PROGRAM)
    assert store.next_day()["name"] == "А"
    done(store, 5, [("Жим лёжа", 80, 8)], "А")
    assert store.next_day()["name"] == "Кардио"
    done(store, 6, [], "Кардио", kind="cardio", minutes=30)
    done(store, 7, [("Приседания со штангой", 100, 5)], "Б")
    assert store.next_day()["name"] == "А"


def test_session_outside_the_program_keeps_the_queue(store):
    store.set_program(PROGRAM)
    done(store, 5, [("Жим лёжа", 80, 8)], "А")
    done(store, 6, [], kind="cardio", minutes=20)
    assert store.next_day()["name"] == "Кардио"


def test_new_program_continues_the_queue_by_day_name(store):
    store.set_program(PROGRAM)
    done(store, 5, [("Жим лёжа", 80, 8)], "А")
    store.set_program({**PROGRAM, "name": "База 2"})
    assert store.program()["name"] == "База 2"
    assert store.next_day()["name"] == "Кардио"


def test_program_is_checked_before_anything_is_written(store):
    store.set_program(PROGRAM)
    bad = {"name": "Плохая", "days": [{"name": "А", "items": [{"exercise": "Жим мизинцем"}]}]}
    with pytest.raises(ValueError, match="Жим мизинцем"):
        store.set_program(bad)
    with pytest.raises(ValueError):
        store.set_program({"name": "Пустая", "days": [{"name": "А"}]})
    assert store.program()["name"] == "База"


def test_start_takes_kind_from_program_day(store):
    p = store.set_program(PROGRAM)
    assert store.start_session(program_day_id=p["days"][1]["id"])["kind"] == "cardio"
    with pytest.raises(ValueError):
        store.start_session(program_day_id=999)


# ── Дневник ──

def test_live_session(store):
    s = store.start_session(t=at(5, 18))
    assert store.active()["id"] == s["id"] and s["day"] == "2026-01-05"
    store.add_set(s["id"], "Жим лёжа", 80, 8, rir=2, t=at(5, 18, 5))
    s = store.add_set(s["id"], "bench press", 80, 7, t=at(5, 18, 9))
    assert [x["reps"] for x in s["sets"]] == [8, 7] and s["volume"] == 1200
    s = store.update_set(s["sets"][1]["id"], reps=8)
    assert s["sets"][1]["reps"] == 8 and s["sets"][1]["weight"] == 80
    s = store.finish_session(s["id"], feel=4, note="легко", t=at(5, 18, 45))
    assert (s["minutes"], s["feel"], s["note"]) == (45, 4, "легко")
    assert store.active() is None
    s = store.delete_set(s["sets"][0]["id"])
    assert s["work_sets"] == 1


def test_repeated_requests_do_not_duplicate(store):
    a = store.start_session(uid="s-1", t=at(5))
    assert store.start_session(uid="s-1", t=at(5, 13))["id"] == a["id"]
    store.add_set(a["id"], "Жим лёжа", 80, 8, uid="x-1")
    assert len(store.add_set(a["id"], "Жим лёжа", 80, 8, uid="x-1")["sets"]) == 1


def test_night_session_belongs_to_the_day_before(store):
    assert store.start_session(t=at(6, 1))["day"] == "2026-01-05"


def test_bad_sets_are_refused(store):
    s = store.start_session(t=at(5))
    for weight, reps in ((80, 0), (-5, 8), (5000, 8)):
        with pytest.raises(ValueError):
            store.add_set(s["id"], "Жим лёжа", weight, reps)
    with pytest.raises(ValueError, match="нет упражнения"):
        store.add_set(s["id"], "Жим мизинцем", 10, 10)
    assert store.add_set(999, "Жим лёжа", 80, 8) is None


def test_log_is_all_or_nothing(store):
    with pytest.raises(ValueError):
        store.log_session({"kind": "strength", "sets": [
            {"exercise": "Жим лёжа", "weight": 80, "reps": 8},
            {"exercise": "Жим мизинцем", "weight": 1, "reps": 1}]}, t=at(5))
    assert store.sessions() == []


def test_cardio_log(store):
    s = store.log_session({"kind": "swim", "minutes": 40, "distance_km": 1.2, "feel": 5}, t=at(5))
    assert (s["kind"], s["minutes"], s["distance"], s["feel"]) == ("swim", 40, 1200, 5)
    past = store.log_session({"kind": "cardio", "day": "2026-01-02", "minutes": 30}, t=at(5))
    assert past["day"] == "2026-01-02"
    assert [x["id"] for x in store.sessions()] == [s["id"], past["id"]]
    assert store.sessions(kind="cardio")[0]["id"] == past["id"]
    with pytest.raises(ValueError, match="ГГГГ"):
        store.log_session({"kind": "cardio", "day": "вчера"}, t=at(5))


def test_ring_cardio_can_be_counted_as_program_day(store):
    store.set_program(PROGRAM)
    done(store, 5, [("Жим лёжа", 80, 8)], "А")
    run = done(store, 6, [], kind="cardio", minutes=30)
    cardio = store.program()["days"][1]["id"]
    assert store.update_session(run["id"], program_day_id=cardio)["day_name"] == "Кардио"
    assert store.next_day()["name"] == "Б"
    with pytest.raises(ValueError):
        store.update_session(run["id"], program_day_id=999)


def test_used_exercises_latest_first(store):
    done(store, 5, [("Жим лёжа", 80, 8)])
    done(store, 7, [("Планка", 0, 60)])
    assert [e["name"] for e in store.used_exercises()] == ["Планка", "Жим лёжа"]


def test_deleted_session_leaves_history(store):
    store.set_program(PROGRAM)
    s = done(store, 5, [("Жим лёжа", 80, 8)], "А")
    assert store.delete_session(s["id"]) and not store.delete_session(s["id"])
    assert store.next_day()["name"] == "А"
    assert store.progress("Жим лёжа")["points"] == []


# ── Показатели ──

def test_e1rm(store):
    assert store.e1rm(100, 1) == 100
    assert store.e1rm(100, 6) == 120
    assert store.e1rm(100, 30) == store.e1rm(100, 12)
    assert store.e1rm(0, 10) == 0


def test_records_need_something_to_beat(store):
    first = done(store, 5, [("Жим лёжа", 80, 8)])
    assert store.records(first["id"]) == []
    same = done(store, 7, [("Жим лёжа", 80, 8)])
    assert store.records(same["id"]) == []
    better = done(store, 9, [("Жим лёжа", 80, 8), ("Жим лёжа", 85, 8)])
    [r] = store.records(better["id"])
    assert (r["name"], r["weight"], r["prev"]) == ("Жим лёжа", 85, store.e1rm(80, 8))


def test_progress_points(store):
    done(store, 5, [("Жим лёжа", 80, 8), ("Жим лёжа", 80, 6)])
    done(store, 9, [("Жим лёжа", 85, 8)])
    p = store.progress("Жим лёжа")
    assert [(x["day"], x["weight"], x["reps"], x["sets"]) for x in p["points"]] == [
        ("2026-01-05", 80, 8, 2), ("2026-01-09", 85, 8, 1)]
    assert p["points"][0]["volume"] == 1120 and p["best"]["weight"] == 85


def test_week_counts_sets_by_muscle(store):
    # 5 января 2026-го — понедельник.
    done(store, 5, [("Жим лёжа", 80, 8)] * 3 + [("Тяга верхнего блока", 50, 10)] * 2, minutes=45)
    done(store, 7, [], kind="cardio", minutes=30)
    done(store, 12, [("Жим лёжа", 80, 8)])
    w = store.week(at(8))
    assert (w["from"], w["to"]) == ("2026-01-05", "2026-01-11")
    assert (w["sessions"], w["minutes"], w["work_sets"]) == (2, 75, 5)
    assert w["by_kind"] == {"strength": 1, "cardio": 1}
    assert w["sets"] == {"chest": 3, "triceps": 1.5, "shoulders": 1.5, "back": 2, "biceps": 1}
    assert w["days"] == {"2026-01-05": ["strength"], "2026-01-07": ["cardio"]}
    assert [x["sessions"] for x in store.weeks(3, at(14))] == [0, 2, 1]


def test_body_weight(store):
    store.log_body(82.34, "2026-01-05")
    store.log_body(81.9, "2026-01-07")
    assert store.log_body(82.0, "2026-01-05")["weight"] == 82.0
    assert [b["weight"] for b in store.body()] == [82.0, 81.9]
    with pytest.raises(ValueError):
        store.log_body(5)
    assert store.delete_body("2026-01-05") and not store.delete_body("2026-01-05")


# ── Упражнения и настройки ──

def test_exercises_are_seeded_once(store):
    n = len(store.exercises())
    assert n > 50
    store.init()
    assert len(store.exercises()) == n
    assert store.exercises(q="жим ЛЁЖА")[0]["name"] == "Жим лёжа"
    assert all("biceps" in (e["muscle"], *e["also"]) for e in store.exercises(muscle="biceps"))


def test_custom_exercise(store):
    e = store.create_exercise("Тяга Т-грифа", "back", also=["biceps"], equipment="barbell")
    assert e["step"] == 2.5 and store.find_exercise("тяга т-грифа")["id"] == e["id"]
    with pytest.raises(ValueError, match="уже есть"):
        store.create_exercise("ТЯГА Т-ГРИФА", "back")
    with pytest.raises(ValueError):
        store.create_exercise("Что-то", "уши")
    assert store.update_exercise(e["id"], archived=True)["archived"]
    assert e["id"] not in [x["id"] for x in store.exercises()]
    with pytest.raises(ValueError):
        store.update_exercise(e["id"], name="Жим лёжа")


def test_profile_is_patched_by_key(store):
    store.save_settings({"profile": {"goal": "сила", "limits": "колено"}})
    s = store.save_settings({"profile": {"limits": "", "days_per_week": 3}, "notify_hour": 99})
    assert s["profile"] == {"goal": "сила", "days_per_week": 3} and s["notify_hour"] == 23


# ── Ручки ──

def test_api_needs_token(api):
    api.headers.pop("Authorization")
    assert api.get("/fit/overview").status_code in (401, 403)
    assert api.get("/fit/events?token=нет").status_code == 401


def test_api_session_round(api):
    assert api.put("/fit/program", json=PROGRAM).status_code == 200
    o = api.get("/fit/overview").json()
    assert o["next"]["name"] == "А" and o["active"] is None
    s = api.post("/fit/sessions", json={"program_day_id": o["next"]["id"], "uid": "u1"}).json()
    ex = o["next"]["items"][0]["exercise_id"]
    r = api.post(f"/fit/sessions/{s['id']}/sets", json={"exercise_id": ex, "weight": 80, "reps": 8})
    set_id = r.json()["sets"][0]["id"]
    assert api.patch(f"/fit/sets/{set_id}", json={"reps": 9}).json()["sets"][0]["reps"] == 9
    assert api.get("/fit/overview").json()["active"]["id"] == s["id"]
    done_ = api.post(f"/fit/sessions/{s['id']}/finish", json={"feel": 4}).json()
    assert done_["feel"] == 4 and done_["records"] == []
    o = api.get("/fit/overview").json()
    assert o["next"]["name"] == "Кардио" and len(o["today"]) == 1 and o["week"]["sessions"] == 1
    assert api.get(f"/fit/exercises/{ex}/progress").json()["points"][0]["reps"] == 9
    assert api.get(f"/fit/program/days/{o['program']['days'][0]['id']}").json()["items"][0]["reps"] == 10
    assert api.delete(f"/fit/sessions/{s['id']}").json() == {"ok": True}
    assert api.get(f"/fit/sessions/{s['id']}").status_code == 404


def test_api_errors(api):
    assert api.post("/fit/sessions", json={"kind": "танцы"}).status_code == 400
    assert api.post("/fit/sessions/1/sets", json={"exercise_id": 1, "weight": 1, "reps": 1}).status_code == 404
    assert api.put("/fit/program", json={"name": ""}).status_code == 400
    assert api.post("/fit/sessions/log", json={"kind": "cardio", "minutes": "много"}).status_code == 400
    assert api.post("/fit/body", json={"weight": 1}).status_code == 400
    assert api.get("/fit/exercises/9999/progress").status_code == 404
    assert api.post("/fit/sessions/log", json={"kind": "cardio", "minutes": 20}).json()["minutes"] == 20


# ── Инструменты ──

def call(tool, **args):
    return json.loads(asyncio.run(tool.handler(args))["content"][0]["text"])


def test_tools_program_and_log(store):
    from app import fit_tools as tools

    assert call(tools.get_program) == {"program": None}
    assert call(tools.set_program, **PROGRAM)["days"] == ["А", "Кардио", "Б"]
    assert "Жим мизинцем" in call(tools.set_program, name="X", days=[
        {"name": "А", "items": [{"exercise": "Жим мизинцем", "sets": 1, "reps_min": 1, "reps_max": 1}]}])["error"]
    got = call(tools.get_program)
    assert got["days"][0]["items"][0] == {"exercise": "Жим лёжа", "sets": 3, "reps_min": 6,
                                          "reps_max": 10, "rir": 2, "rest": 120}
    # Что отдал get_program, то set_program принимает обратно.
    assert call(tools.set_program, **got)["ok"]

    logged = call(tools.log_session, kind="strength", program_day="А", sets=[
        {"exercise": "Жим лёжа", "weight": 80, "reps": 5}] * 3)
    assert logged["exercises"] == {"Жим лёжа": "80×5, 80×5, 80×5"} and logged["records"] == []
    t = call(tools.today_tool)
    assert t["next"]["name"] == "Кардио" and t["next"]["minutes"] == 30
    assert t["done_today"][0]["day_name"] == "А" and t["week"]["sets_by_muscle"]["chest"] == 3
    assert call(tools.history_tool)[0]["id"] == logged["id"]
    assert call(tools.progress, exercise="жим лёжа")["best"]["weight"] == 80
    assert call(tools.progress)[-1]["sessions"] == 1
    assert "error" in call(tools.progress, exercise="Жим мизинцем")
    assert call(tools.delete_session, id=logged["id"]) == {"ok": True}


def test_tools_profile_body_exercises(store):
    from app import fit_tools as tools

    assert call(tools.update_profile, profile={"goal": "сила"}) == {"goal": "сила"}
    assert "error" in call(tools.update_profile, profile="сила")
    assert call(tools.log_body, weight=82)["weight"] == 82
    assert "error" in call(tools.log_body, weight=2)
    assert call(tools.add_exercise, name="Тяга Т-грифа", muscle="back")["name"] == "Тяга Т-грифа"
    assert [e["name"] for e in call(tools.list_exercises, q="т-грифа")] == ["Тяга Т-грифа"]
    plank = call(tools.log_session, kind="strength", sets=[{"exercise": "Планка", "reps": 60}])
    assert plank["exercises"] == {"Планка": "60 с"}
