"""Кольцо Oura: вход, синхронизация, пульс тренировок.

Данные тянем опросом, а не вебхуками: пользователь один, а кольцо всё равно отдаёт ночь
только после того, как человек открыл его приложение. Каждый проход перечитывает последние
дни целиком — Oura правит записи задним числом.

Вход — OAuth: личные токены Oura отключила в декабре 2025-го. Токен обновления одноразовый:
новую пару сохраняем сразу, иначе следующее обновление не пройдёт и придётся входить заново.
"""

import asyncio
import logging
import secrets
import time
from datetime import date, datetime, timedelta
from urllib.parse import urlencode

import httpx

from . import config
from . import fit_store as store

logger = logging.getLogger("fit.oura")

AUTHORIZE = "https://cloud.ouraring.com/oauth/authorize"
TOKEN = "https://api.ouraring.com/oauth/token"
API = "https://api.ouraring.com/v2/usercollection/"
CALLBACK = "/fit/oura/callback"

STATE_TTL = 15 * 60          # сколько живёт начатый вход, секунды
BACKFILL_DAYS = 90           # сколько истории забрать при подключении
MORNING = (5, 12)            # в эти часы ждём ночь и спрашиваем чаще
EVERY_MORNING, EVERY_DAY = 30 * 60, 2 * 3600
RETRY = 5 * 60

transport: httpx.AsyncBaseTransport | None = None      # подмена сети в тестах
_lock = asyncio.Lock()       # один проход за раз: и синхронизация, и обновление токена


class NeedLogin(Exception):
    """Oura больше не принимает наш токен — человеку нужно подключить кольцо заново."""


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=30, transport=transport)


def configured() -> bool:
    return bool(config.OURA_CLIENT_ID and config.OURA_CLIENT_SECRET)


def status() -> dict:
    return {"configured": configured(), "connected": bool(store.meta("oura_token")),
            "synced": store.meta("oura_synced"), "error": store.meta("oura_error", "")}


# ── Вход ──

def connect_url(origin: str) -> str:
    """Ссылка на согласие в Oura. origin — адрес, с которого открыто приложение: на него же
    Oura вернёт человека, и он должен совпасть с записанным в её кабинете."""
    if not configured():
        raise ValueError("ключи Oura не заданы: OURA_CLIENT_ID и OURA_CLIENT_SECRET в .env")
    origin = origin.rstrip("/")
    if not origin.startswith(("https://", "http://")):
        raise ValueError("нужен адрес приложения")
    state = secrets.token_urlsafe(24)
    store.set_meta("oura_state", {"state": state, "origin": origin, "ts": int(time.time())})
    # scope не передаём: Oura выдаст всё, что отмечено у приложения в её кабинете.
    return AUTHORIZE + "?" + urlencode({"response_type": "code", "client_id": config.OURA_CLIENT_ID,
                                        "redirect_uri": origin + CALLBACK, "state": state})


def _save_token(tok: dict) -> None:
    store.set_meta("oura_token", {"access": tok["access_token"], "refresh": tok["refresh_token"],
                                  "expires": int(time.time()) + int(tok.get("expires_in", 86400))})
    store.set_meta("oura_error", "")


async def _grant(client: httpx.AsyncClient, **form) -> dict:
    r = await client.post(TOKEN, data={**form, "client_id": config.OURA_CLIENT_ID,
                                       "client_secret": config.OURA_CLIENT_SECRET})
    if r.status_code != 200:
        raise NeedLogin(f"Oura отказала в токене: {r.status_code} {r.text[:200]}")
    return r.json()


async def finish_connect(code: str, state: str) -> str:
    """Вторая половина входа: сверить state, обменять код на токены. Возвращает адрес
    приложения, куда вернуть человека. state одноразовый — второй раз тем же не войти."""
    saved = store.meta("oura_state") or {}
    store.set_meta("oura_state", None)
    if (not state or not secrets.compare_digest(str(saved.get("state", "")).encode(), state.encode())
            or time.time() - saved.get("ts", 0) > STATE_TTL):
        raise ValueError("вход в Oura устарел или начат не отсюда — начни заново из настроек")
    async with _client() as client:
        _save_token(await _grant(client, grant_type="authorization_code", code=code,
                                 redirect_uri=saved["origin"] + CALLBACK))
    return saved["origin"]


def disconnect() -> None:
    """Забыть токены. Накопленные данные остаются."""
    store.set_meta("oura_token", None)
    store.set_meta("oura_error", "")


async def _access(client: httpx.AsyncClient, force: bool = False) -> str:
    tok = store.meta("oura_token")
    if not tok:
        raise NeedLogin("кольцо не подключено")
    if force or tok["expires"] - time.time() < 300:
        try:
            _save_token(await _grant(client, grant_type="refresh_token", refresh_token=tok["refresh"]))
        except NeedLogin:
            store.set_meta("oura_token", None)
            store.set_meta("oura_error", "reauth")
            raise
        tok = store.meta("oura_token")
    return tok["access"]


# ── Чтение ──

async def _get(client: httpx.AsyncClient, path: str, **params) -> list[dict]:
    """Все страницы коллекции. Раздел, на который нет прав или подписки, — пустой список:
    из-за одного закрытого показателя остальные терять незачем."""
    out: list[dict] = []
    retried = False
    while True:
        r = await client.get(API + path, params={k: v for k, v in params.items() if v},
                             headers={"Authorization": "Bearer " + await _access(client)})
        if r.status_code == 401 and not retried:
            retried = True
            await _access(client, force=True)
            continue
        if r.status_code == 401:
            store.set_meta("oura_token", None)
            store.set_meta("oura_error", "reauth")
            raise NeedLogin("Oura не принимает токен")
        if r.status_code != 200:
            logger.warning("Oura %s: %s %s", path, r.status_code, r.text[:200])
            return out
        body = r.json()
        out += body.get("data") or []
        if not body.get("next_token"):
            return out
        params["next_token"] = body["next_token"]


def _ms(iso: str) -> int:
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)


def workout_kind(activity: str) -> str:
    a = (activity or "").lower()
    if "swim" in a:
        return "swim"
    if any(w in a for w in ("strength", "weight", "crossfit", "bodybuilding")):
        return "strength"
    if any(w in a for w in ("yoga", "pilates", "stretch", "mobility")):
        return "other"
    return "cardio"


def _night(periods: list[dict]) -> dict | None:
    """Главный сон суток: из нескольких отрезков берём самый длинный, дремоту не считаем."""
    main = [p for p in periods if p.get("type") in ("long_sleep", "sleep")]
    return max(main, key=lambda p: p.get("total_sleep_duration") or 0, default=None)


async def _pull(client: httpx.AsyncClient, since: date, until: date) -> None:
    # Конец диапазона — завтра: у части разделов Oura он не включается, и сегодняшний день терялся бы.
    span = {"start_date": since.isoformat(), "end_date": (until + timedelta(days=1)).isoformat()}
    for x in await _get(client, "daily_readiness", **span):
        store.oura_put(x["day"], readiness=x.get("score"), temp_dev=x.get("temperature_deviation"))
    for x in await _get(client, "daily_sleep", **span):
        store.oura_put(x["day"], sleep_score=x.get("score"))
    # Ночь относится к дню пробуждения.
    nights: dict[str, list[dict]] = {}
    for x in await _get(client, "sleep", **span):
        nights.setdefault(x["day"], []).append(x)
    for day, periods in nights.items():
        n = _night(periods)
        if n:
            store.oura_put(day, hrv=n.get("average_hrv"), rhr=n.get("lowest_heart_rate"),
                           sleep_sec=n.get("total_sleep_duration"),
                           deep_sec=n.get("deep_sleep_duration"), rem_sec=n.get("rem_sleep_duration"),
                           efficiency=n.get("efficiency"), bed_start=n.get("bedtime_start"),
                           bed_end=n.get("bedtime_end"))
    for x in await _get(client, "daily_activity", **span):
        store.oura_put(x["day"], activity=x.get("score"), steps=x.get("steps"),
                       active_cal=x.get("active_calories"))
    for x in await _get(client, "daily_stress", **span):
        store.oura_put(x["day"], stress_sec=x.get("stress_high"), recovery_sec=x.get("recovery_high"))
    for x in await _get(client, "daily_resilience", **span):
        store.oura_put(x["day"], resilience=x.get("level"))
    for x in await _get(client, "daily_spo2", **span):
        store.oura_put(x["day"], spo2=(x.get("spo2_percentage") or {}).get("average"))
    for x in await _get(client, "vO2_max", **span):
        store.oura_put(x["day"], vo2max=x.get("vo2_max"))
    for x in await _get(client, "workout", **span):
        if x.get("start_datetime") and x.get("end_datetime"):
            store.oura_workout(x["id"], x["day"], _ms(x["start_datetime"]), _ms(x["end_datetime"]),
                               workout_kind(x.get("activity", "")), x.get("activity") or "",
                               x.get("distance"), x.get("calories"))


async def _pulse(client: httpx.AsyncClient, since: date) -> None:
    """Средний и наибольший пульс за время тренировки — и своей, и записанной кольцом."""
    for s in store.without_pulse(since.isoformat()):
        iso = [datetime.fromtimestamp(v / 1000).astimezone().isoformat(timespec="seconds")
               for v in (s["started"], s["ended"])]
        bpm = [x["bpm"] for x in await _get(client, "heartrate", start_datetime=iso[0],
                                            end_datetime=iso[1]) if x.get("bpm")]
        if bpm:
            store.set_pulse(s["id"], round(sum(bpm) / len(bpm)), max(bpm))


async def sync(days: int = 3) -> dict:
    """Перечитать последние дни. Вызывается по расписанию, после входа и кнопкой."""
    async with _lock:
        if not store.meta("oura_token"):
            return status()
        until = datetime.now().date()
        since = until - timedelta(days=max(1, days))
        try:
            async with _client() as client:
                await _pull(client, since, until)
                # Пульс — только за свежие дни: за три месяца истории это сотни запросов.
                await _pulse(client, until - timedelta(days=min(days, 7)))
            store.set_meta("oura_synced", int(time.time()))
            store.set_meta("oura_error", "")
        except NeedLogin as e:
            logger.warning("Oura: %s", e)
        except httpx.HTTPError as e:
            # Сеть моргнула — не повод звать человека: попробуем на следующем проходе.
            logger.warning("Oura недоступна: %s", e)
            store.set_meta("oura_error", "network")
        return status()


async def maybe_sync(when: datetime | None = None) -> bool:
    """Из планировщика, раз в минуту: пора ли спросить кольцо. Утром чаще — ждём ночь."""
    if not configured() or not store.meta("oura_token"):
        return False
    when = when or datetime.now()
    # После неудачи (сеть, сбой у Oura) не долбим каждую минуту.
    if when.timestamp() - (store.meta("oura_tried") or 0) < RETRY:
        return False
    every = EVERY_MORNING if MORNING[0] <= when.hour < MORNING[1] else EVERY_DAY
    if when.timestamp() - (store.meta("oura_synced") or 0) < every:
        return False
    # Первый проход суток — за неделю: вчерашние правки Oura доезжают с опозданием.
    day = when.date().isoformat()
    wide = store.meta("oura_wide") != day
    store.set_meta("oura_tried", int(when.timestamp()))
    await sync(7 if wide else 3)
    if wide:
        store.set_meta("oura_wide", day)
    return True


if __name__ == "__main__":
    # Для ./bender doctor: одна строка о том, жива ли связь с кольцом.
    store.init()
    st = status()
    if not st["connected"]:
        print("нужен повторный вход" if st["error"] == "reauth" else "off")
    else:
        ago = (int(time.time()) - (st["synced"] or 0)) // 60
        print(f"ok данные {ago} мин назад" if st["synced"] else "ok ждём первую синхронизацию")
