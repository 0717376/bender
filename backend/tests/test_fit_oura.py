"""Кольцо Oura: вход, обновление токена, синхронизация, совет на день."""

import asyncio
import os
import sys
import time
from datetime import datetime, timedelta
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ORIGIN = "https://fit.example.com"


def at(day: int, hour: int = 12) -> int:
    return int(datetime(2026, 1, day, hour).timestamp() * 1000)


@pytest.fixture
def store(tmp_path, monkeypatch):
    from app import config, fit_store

    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(config, "OURA_CLIENT_ID", "cid")
    monkeypatch.setattr(config, "OURA_CLIENT_SECRET", "s3cret")
    fit_store.init()
    return fit_store


class Oura:
    """Oura понарошку: выдаёт токены по кругу и отдаёт то, что положили в data."""

    def __init__(self):
        self.data: dict[str, list] = {}
        self.calls: list[tuple] = []
        self.n = 0
        self.refresh_ok = True
        self.valid: set[str] = set()

    def grant(self) -> dict:
        self.n += 1
        self.valid = {f"a{self.n}"}
        return {"access_token": f"a{self.n}", "refresh_token": f"r{self.n}", "expires_in": 3600}

    def __call__(self, req: httpx.Request) -> httpx.Response:
        if req.url.path == "/oauth/token":
            form = {k: v[0] for k, v in parse_qs(req.content.decode()).items()}
            self.calls.append(("token", form))
            if form["grant_type"] == "refresh_token" and (
                    not self.refresh_ok or form["refresh_token"] != f"r{self.n}"):
                return httpx.Response(400, json={"error": "invalid_grant"})
            return httpx.Response(200, json=self.grant())
        name = req.url.path.rsplit("/", 1)[1]
        self.calls.append((name, dict(req.url.params)))
        if req.headers["Authorization"].removeprefix("Bearer ") not in self.valid:
            return httpx.Response(401, json={})
        if name not in self.data:
            return httpx.Response(403, json={"detail": "нет прав"})
        return httpx.Response(200, json={"data": self.data[name]})


@pytest.fixture
def oura(store, monkeypatch):
    from app import fit_oura

    fake = Oura()
    monkeypatch.setattr(fit_oura, "transport", httpx.MockTransport(fake))
    fake.mod = fit_oura
    return fake


def login(oura) -> None:
    state = parse_qs(urlparse(oura.mod.connect_url(ORIGIN)).query)["state"][0]
    assert asyncio.run(oura.mod.finish_connect("c0de", state)) == ORIGIN


# ── Вход ──

def test_connect_url_carries_state_and_redirect(oura):
    q = parse_qs(urlparse(oura.mod.connect_url(ORIGIN + "/")).query)
    assert q["redirect_uri"] == [ORIGIN + "/fit/oura/callback"] and q["client_id"] == ["cid"]
    assert len(q["state"][0]) > 20 and "scope" not in q


def test_connect_needs_keys(oura, monkeypatch):
    from app import config

    monkeypatch.setattr(config, "OURA_CLIENT_SECRET", "")
    with pytest.raises(ValueError, match="OURA_CLIENT_ID"):
        oura.mod.connect_url(ORIGIN)
    assert oura.mod.status()["configured"] is False


def test_login_exchanges_code(oura):
    login(oura)
    form = oura.calls[0][1]
    assert (form["grant_type"], form["code"], form["client_secret"]) == ("authorization_code", "c0de", "s3cret")
    assert form["redirect_uri"] == ORIGIN + "/fit/oura/callback"
    assert oura.mod.status()["connected"]


def test_state_is_checked_and_one_time(oura, store):
    state = parse_qs(urlparse(oura.mod.connect_url(ORIGIN)).query)["state"][0]
    with pytest.raises(ValueError):
        asyncio.run(oura.mod.finish_connect("c0de", "чужой"))
    # Неудачная попытка сжигает state: подобрать его вторым заходом нельзя.
    with pytest.raises(ValueError):
        asyncio.run(oura.mod.finish_connect("c0de", state))
    state = parse_qs(urlparse(oura.mod.connect_url(ORIGIN)).query)["state"][0]
    store.set_meta("oura_state", {**store.meta("oura_state"), "ts": int(time.time()) - 3600})
    with pytest.raises(ValueError, match="устарел"):
        asyncio.run(oura.mod.finish_connect("c0de", state))
    assert not oura.mod.status()["connected"] and oura.calls == []


def test_callback_route(oura, store, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app import config, fit_api

    monkeypatch.setattr(config, "WIKI_PASSWORD", "пароль")
    monkeypatch.setattr(config, "AUTH_TOKEN", "tok3n")
    app = FastAPI()
    app.include_router(fit_api.events_router)
    app.include_router(fit_api.router)
    c = TestClient(app, follow_redirects=False)
    assert c.post("/fit/oura/connect", json={"origin": ORIGIN}).status_code in (401, 403)
    auth = {"Authorization": "Bearer tok3n"}
    url = c.post("/fit/oura/connect", json={"origin": ORIGIN}, headers=auth).json()["url"]
    state = parse_qs(urlparse(url).query)["state"][0]
    assert c.get("/fit/oura/callback?code=x&state=нет").status_code == 400
    url = c.post("/fit/oura/connect", json={"origin": ORIGIN}, headers=auth).json()["url"]
    state = parse_qs(urlparse(url).query)["state"][0]
    r = c.get(f"/fit/oura/callback?code=x&state={state}")
    assert r.status_code == 307 and r.headers["location"] == ORIGIN + "/#/settings"
    assert c.get("/fit/oura", headers=auth).json()["connected"]
    assert c.delete("/fit/oura", headers=auth).json()["connected"] is False
    assert c.get("/fit/recovery", headers=auth).json()["level"] is None


# ── Токен ──

def test_token_is_refreshed_and_saved_at_once(oura, store):
    login(oura)
    store.set_meta("oura_token", {**store.meta("oura_token"), "expires": int(time.time()) + 10})
    oura.data["daily_readiness"] = []
    asyncio.run(oura.mod.sync())
    assert store.meta("oura_token")["refresh"] == "r2"
    # Второй раз обновляем уже новым токеном: старый одноразовый.
    store.set_meta("oura_token", {**store.meta("oura_token"), "expires": 0})
    asyncio.run(oura.mod.sync())
    assert store.meta("oura_token")["access"] == "a3" and oura.mod.status()["error"] == ""


def test_rejected_access_token_is_refreshed_once(oura, store):
    login(oura)
    oura.valid = set()
    oura.data["daily_readiness"] = [{"day": "2026-01-05", "score": 80}]
    asyncio.run(oura.mod.sync())
    assert store.meta("oura_token")["access"] == "a2"
    assert store.oura_days(400, at(6))[0]["readiness"] == 80


def test_dead_refresh_asks_to_reconnect(oura, store):
    login(oura)
    oura.refresh_ok = False
    store.set_meta("oura_token", {**store.meta("oura_token"), "expires": 0})
    st = asyncio.run(oura.mod.sync())
    assert (st["connected"], st["error"]) == (False, "reauth")
    assert asyncio.run(oura.mod.maybe_sync()) is False


def test_network_trouble_keeps_the_login(oura, store, monkeypatch):
    login(oura)

    def down(req):
        raise httpx.ConnectError("нет сети")

    monkeypatch.setattr(oura.mod, "transport", httpx.MockTransport(down))
    st = asyncio.run(oura.mod.sync())
    assert (st["connected"], st["error"], st["synced"]) == (True, "network", None)


# ── Синхронизация ──

NIGHT = {"day": "2026-01-06", "type": "long_sleep", "total_sleep_duration": 27000,
         "deep_sleep_duration": 5400, "rem_sleep_duration": 6000, "efficiency": 91,
         "average_hrv": 48, "lowest_heart_rate": 52,
         "bedtime_start": "2026-01-05T23:40:00+03:00", "bedtime_end": "2026-01-06T07:30:00+03:00"}


def test_sync_folds_a_day_into_one_row(oura, store):
    login(oura)
    oura.data = {
        "daily_readiness": [{"day": "2026-01-06", "score": 82, "temperature_deviation": -0.1}],
        "daily_sleep": [{"day": "2026-01-06", "score": 85}],
        "sleep": [{**NIGHT, "type": "late_nap", "total_sleep_duration": 99999, "average_hrv": 1},
                  {**NIGHT, "total_sleep_duration": 3600, "average_hrv": 2}, NIGHT],
        "daily_activity": [{"day": "2026-01-06", "score": 70, "steps": 8000, "active_calories": 420}],
        "daily_stress": [{"day": "2026-01-06", "stress_high": 3600, "recovery_high": 7200}],
        "daily_spo2": [{"day": "2026-01-06", "spo2_percentage": {"average": 97.2}}],
    }
    st = asyncio.run(oura.mod.sync())
    assert st["synced"] and st["error"] == ""
    [d] = store.oura_days(400, at(6))
    assert (d["readiness"], d["sleep_score"], d["hrv"], d["rhr"], d["sleep_sec"]) == (82, 85, 48, 52, 27000)
    assert (d["steps"], d["stress_sec"], d["spo2"], d["temp_dev"]) == (8000, 3600, 97.2, -0.1)
    # На устойчивость и МПК прав нет (403) — остальное от этого не страдает.
    assert d["resilience"] is None and d["vo2max"] is None


def test_later_sync_does_not_wipe_what_is_known(oura, store):
    login(oura)
    oura.data = {"daily_readiness": [{"day": "2026-01-06", "score": 82}], "sleep": [NIGHT]}
    asyncio.run(oura.mod.sync())
    oura.data = {"daily_readiness": [{"day": "2026-01-06", "score": 84}], "sleep": []}
    asyncio.run(oura.mod.sync())
    [d] = store.oura_days(400, at(6))
    assert (d["readiness"], d["hrv"]) == (84, 48)


# Тренировки — вчерашние: пульс синхронизация спрашивает только за свежие дни.
YDAY = (datetime.now() - timedelta(days=1)).date()


def yday(hour: int, minute: int = 0) -> datetime:
    return datetime(YDAY.year, YDAY.month, YDAY.day, hour, minute)


def workout(id_, start, minutes, activity="running", **kw):
    t0 = yday(*start).astimezone()
    return {"id": id_, "day": YDAY.isoformat(), "activity": activity,
            "start_datetime": t0.isoformat(), "end_datetime": (t0 + timedelta(minutes=minutes)).isoformat(),
            **kw}


def test_ring_workouts_become_sessions(oura, store):
    login(oura)
    oura.data = {"workout": [workout("w1", (8, 0), 35, distance=5200, calories=380),
                             workout("w2", (13, 0), 6, "walking"),
                             workout("w3", (19, 0), 40, "swimming")],
                 "heartrate": [{"bpm": 120}, {"bpm": 150}, {"bpm": 141}]}
    asyncio.run(oura.mod.sync())
    asyncio.run(oura.mod.sync())
    got = store.sessions()
    assert [(s["title"], s["kind"], s["minutes"], s["source"]) for s in got] == [
        ("swimming", "swim", 40, "oura"), ("running", "cardio", 35, "oura")]
    run = got[1]
    assert (run["distance"], run["calories"], run["avg_hr"], run["max_hr"]) == (5200, 380, 137, 150)
    hr = [c[1] for c in oura.calls if c[0] == "heartrate"]
    assert len(hr) == 2 and hr[0]["start_datetime"].startswith(f"{YDAY}T08:00:00")


def test_deleted_ring_workout_stays_deleted_and_notes_survive(oura, store):
    login(oura)
    oura.data = {"workout": [workout("w1", (8, 0), 35), workout("w2", (19, 0), 30, "cycling")]}
    asyncio.run(oura.mod.sync())
    ride, run = store.sessions()
    store.delete_session(run["id"])
    store.update_session(ride["id"], note="в горку", feel=4)
    oura.data["workout"][1]["calories"] = 300
    asyncio.run(oura.mod.sync())
    [s] = store.sessions()
    assert (s["id"], s["note"], s["feel"], s["calories"]) == (ride["id"], "в горку", 4, 300)


def test_ring_workout_over_own_session_only_adds_calories(oura, store):
    login(oura)
    s = store.start_session(t=int(yday(18).timestamp() * 1000))
    store.add_set(s["id"], "Жим лёжа", 80, 8)
    store.finish_session(s["id"], t=int(yday(19).timestamp() * 1000))
    oura.data = {"workout": [workout("w1", (18, 10), 40, "strength_training", calories=250)]}
    asyncio.run(oura.mod.sync())
    [only] = store.sessions()
    assert (only["id"], only["source"], only["calories"]) == (s["id"], "manual", 250)


def test_workout_kinds(oura):
    kind = oura.mod.workout_kind
    assert [kind(a) for a in ("swimming", "strength_training", "yoga", "running", "", "hiking")] == [
        "swim", "strength", "other", "cardio", "cardio", "cardio"]


def test_scheduler_pacing(oura, store):
    assert asyncio.run(oura.mod.maybe_sync()) is False            # кольцо не подключено
    login(oura)
    oura.data = {"daily_readiness": []}
    morning = datetime.now().replace(hour=8, minute=0)
    assert asyncio.run(oura.mod.maybe_sync(morning)) is True
    first = [c for c in oura.calls if c[0] == "daily_readiness"][-1][1]
    assert (datetime.fromisoformat(first["end_date"]) - datetime.fromisoformat(first["start_date"])).days == 8
    store.set_meta("oura_synced", int(morning.timestamp()))
    assert asyncio.run(oura.mod.maybe_sync(morning + timedelta(minutes=20))) is False
    assert asyncio.run(oura.mod.maybe_sync(morning + timedelta(minutes=31))) is True
    # Днём — раз в два часа.
    noon = morning.replace(hour=14)
    store.set_meta("oura_synced", int(noon.timestamp()))
    store.set_meta("oura_tried", 0)
    assert asyncio.run(oura.mod.maybe_sync(noon + timedelta(minutes=90))) is False
    assert asyncio.run(oura.mod.maybe_sync(noon + timedelta(minutes=121))) is True


def test_failed_sync_is_not_retried_every_minute(oura, store, monkeypatch):
    login(oura)
    monkeypatch.setattr(oura.mod, "transport", httpx.MockTransport(lambda r: (_ for _ in ()).throw(httpx.ConnectError("x"))))
    now = datetime.now()
    assert asyncio.run(oura.mod.maybe_sync(now)) is True
    assert asyncio.run(oura.mod.maybe_sync(now + timedelta(minutes=1))) is False
    assert asyncio.run(oura.mod.maybe_sync(now + timedelta(minutes=6))) is True


# ── Совет на день ──

def fill(store, today=None, days=14, **base):
    """Две ровные недели и сегодняшний день поверх."""
    base = {"readiness": 80, "hrv": 50, "rhr": 52, "sleep_sec": 27000, "temp_dev": 0.0, **base}
    for d in range(20 - days, 20):
        store.oura_put(f"2026-01-{d:02d}", **base)
    if today is not None:
        store.oura_put("2026-01-20", **{**base, **today})
    return store.recovery(at(20))


def test_no_data_no_advice(store):
    assert store.recovery(at(20))["level"] is None
    assert fill(store)["level"] is None                      # сегодня кольцо ещё не отчиталось


def test_normal_day_goes_by_plan(store):
    r = fill(store, {})
    assert r["level"] == "go" and {s["state"] for s in r["signals"]} == {"ok"}
    assert [s["base"] for s in r["signals"] if s["key"] == "hrv"] == [50]


def test_one_yellow_signal_is_noise(store):
    assert fill(store, {"sleep_sec": 5.5 * 3600})["level"] == "go"


def test_two_signals_ease_the_day(store):
    r = fill(store, {"hrv": 46, "rhr": 55})
    assert r["level"] == "easy"
    assert {s["key"]: s["state"] for s in r["signals"]}["hrv"] == "warn"


def test_one_red_signal_eases_too(store):
    assert fill(store, {"sleep_sec": 4 * 3600})["level"] == "easy"


def test_bad_day_rests(store):
    assert fill(store, {"readiness": 45})["level"] == "rest"
    assert fill(store, {"temp_dev": 1.2})["level"] == "rest"
    assert fill(store, {"readiness": 58, "hrv": 38})["level"] == "rest"


def test_no_baseline_no_hrv_verdict(store):
    r = fill(store, {"hrv": 20}, days=3)
    assert r["level"] == "go" and "hrv" not in [s["key"] for s in r["signals"]]


def test_easy_day_trims_the_plan(store):
    p = store.set_program({"name": "База", "days": [{"name": "А", "items": [
        {"exercise": "Жим лёжа", "sets": 3, "reps_min": 6, "reps_max": 10},
        {"exercise": "Планка", "sets": 1, "reps_min": 30, "reps_max": 60}]}]})
    store.log_session({"day": "2026-01-18", "kind": "strength",
                       "sets": [{"exercise": "Жим лёжа", "weight": 80, "reps": 10}] * 3}, t=at(18))
    day = p["days"][0]["id"]
    assert store.plan_for(day)["items"][0]["weight"] == 82.5
    bench, plank = store.plan_for(day, easy=True)["items"]
    assert (bench["sets"], bench["weight"], bench["reps"], bench["hint"]) == (2, 80, 10, "hold")
    assert plank["sets"] == 1
    fill(store, {"hrv": 46, "rhr": 55})
    o = store.overview(at(20))
    assert o["recovery"]["level"] == "easy" and o["next"]["easy"] and o["next"]["items"][0]["sets"] == 2


def test_agent_sees_recovery(store):
    from app import fit_tools as tools

    assert "error" in tools.recovery()
    store.oura_put((store.today() - timedelta(days=1)).isoformat(), readiness=80, sleep_sec=27000)
    store.oura_put(store.today().isoformat(), readiness=77, sleep_sec=25200)
    got = tools.recovery()
    assert got["today"]["today"] == {"day": store.today().isoformat(), "readiness": 77, "sleep_h": 7.0}
    assert got["days"][0]["sleep_h"] == 7.5 and "sleep_sec" not in got["days"][0]
    assert tools.today()["recovery"]["level"] == "go"
