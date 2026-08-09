"""Правила повтора: нормализация и вычисление дат.

Отдельный модуль без БД — генерация дат чистая функция, её проверяют тестами
напрямую. Тот же алгоритм повторён во фронтенде (frontend-tasks/src/repeat.ts),
чтобы редактор показывал ближайшие даты без похода на сервер.

Правило (JSON в колонке tasks.repeat):
    unit      day | week | month | year
    interval  1..365 — «каждые N единиц»
    mode      schedule (от даты) | done (через N после выполнения)
    weekdays  [1..7] ISO-дни, только для week — «по вторникам и четвергам»
    monthday  1..31 | "last" — для month/year
    nth       [порядок, день] — «второй вторник», порядок -1 = последний
    month     1..12 — для year
    start     ISO — с какой даты отсчитываем
    end       {"after": N} | {"on": ISO} — когда прекратить
"""

import calendar
from datetime import date, timedelta

UNITS = ("day", "week", "month", "year")
MODES = ("schedule", "done")
ORDINALS = (1, 2, 3, 4, -1)


def _int(v, lo: int, hi: int, default=None):
    try:
        n = int(v)
    except (TypeError, ValueError):
        return default
    return n if lo <= n <= hi else default


def _iso(v) -> str | None:
    try:
        return date.fromisoformat(str(v)).isoformat()
    except (TypeError, ValueError):
        return None


def norm(rule) -> dict | None:
    """Привести правило к каноническому виду; пустое/битое → None (повтора нет)."""
    if not isinstance(rule, dict) or not rule:
        return None
    unit = rule.get("unit")
    if unit not in UNITS:
        return None
    out: dict = {
        "unit": unit,
        "interval": _int(rule.get("interval"), 1, 365, 1),
        "mode": rule.get("mode") if rule.get("mode") in MODES else "schedule",
    }
    if unit == "week":
        raw = rule.get("weekdays")
        if isinstance(raw, list):
            days = sorted({d for d in (_int(x, 1, 7) for x in raw) if d})
            if days:
                out["weekdays"] = days
    if unit in ("month", "year"):
        md, nth = rule.get("monthday"), rule.get("nth")
        day = _int(md, 1, 31)
        if md == "last":
            out["monthday"] = "last"
        elif day:
            out["monthday"] = day
        elif isinstance(nth, (list, tuple)) and len(nth) == 2:
            ordinal, weekday = _int(nth[0], -1, 4), _int(nth[1], 1, 7)
            if ordinal in ORDINALS and weekday:
                out["nth"] = [ordinal, weekday]
    if unit == "year":
        month = _int(rule.get("month"), 1, 12)
        if month:
            out["month"] = month
    start = _iso(rule.get("start"))
    if start:
        out["start"] = start
    end = rule.get("end")
    if isinstance(end, dict):
        after, on = _int(end.get("after"), 1, 999), _iso(end.get("on"))
        if after:
            out["end"] = {"after": after}
        elif on:
            out["end"] = {"on": on}
    return out


def advance(iso: str, unit: str, n: int) -> str:
    """iso + n единиц; месяц/год прижимают число к длине месяца (31 янв + 1 мес → 28 фев)."""
    d = date.fromisoformat(iso)
    if unit == "day":
        return (d + timedelta(days=n)).isoformat()
    if unit == "week":
        return (d + timedelta(weeks=n)).isoformat()
    months = n if unit == "month" else n * 12
    m = d.month - 1 + months
    y, m = d.year + m // 12, m % 12 + 1
    return date(y, m, min(d.day, calendar.monthrange(y, m)[1])).isoformat()


def _month_slot(y: int, m: int, rule: dict, start: date) -> date | None:
    """Дата внутри месяца: число, «последний день» или «второй вторник». None — такого дня нет."""
    last = calendar.monthrange(y, m)[1]
    nth = rule.get("nth")
    if nth:
        ordinal, weekday = nth
        shift = (weekday - date(y, m, 1).isoweekday()) % 7
        if ordinal == -1:
            day = 1 + shift + ((last - 1 - shift) // 7) * 7
        else:
            day = 1 + shift + (ordinal - 1) * 7
            if day > last:
                return None  # пятого вторника в этом месяце не бывает
        return date(y, m, day)
    md = rule.get("monthday", start.day)
    return date(y, m, last if md == "last" else min(int(md), last))


def occurrences(rule: dict, after: str | None, until: str, limit: int = 12) -> list[str]:
    """Даты повтора строго после `after` и не позже `until` — не больше `limit` штук.

    mode=done дат не имеет: следующая копия считается от факта выполнения, а не от календаря.
    """
    if not rule or limit <= 0 or rule.get("mode") == "done":
        return []
    start = date.fromisoformat(rule.get("start") or after or until)
    stop = date.fromisoformat(until)
    end_on = (rule.get("end") or {}).get("on")
    if end_on:
        stop = min(stop, date.fromisoformat(end_on))
    lo = date.fromisoformat(after) if after else start - timedelta(days=1)
    step, unit = rule["interval"], rule["unit"]
    out: list[str] = []

    if unit == "day":
        k = max(0, (lo - start).days // step + 1)
        d = start + timedelta(days=k * step)
        while d <= stop and len(out) < limit:
            out.append(d.isoformat())
            d += timedelta(days=step)
        return out

    if unit == "week":
        days = rule.get("weekdays") or [start.isoweekday()]
        anchor = start - timedelta(days=start.isoweekday() - 1)  # понедельник недели старта
        lo_monday = lo - timedelta(days=lo.isoweekday() - 1)
        k = max(0, ((lo_monday - anchor).days // 7) // step)
        week = anchor + timedelta(weeks=k * step)
        while week <= stop and len(out) < limit:
            for wd in days:
                d = week + timedelta(days=wd - 1)
                if start <= d <= stop and d > lo:
                    out.append(d.isoformat())
                    if len(out) >= limit:
                        break
            week += timedelta(weeks=step)
        return out

    # month/year — один и тот же шаг по месяцам, год просто длиннее и с фиксированным месяцем
    months = step if unit == "month" else step * 12
    base = date(start.year, rule.get("month") or start.month, 1)
    i = base.year * 12 + base.month - 1
    cur = lo.year * 12 + lo.month - 1
    i += max(0, (cur - i) // months) * months
    while len(out) < limit:
        y, m = i // 12, i % 12 + 1
        if y > 9000 or date(y, m, 1) > stop:
            break
        d = _month_slot(y, m, rule, start)
        if d and start <= d <= stop and d > lo:
            out.append(d.isoformat())
        i += months
    return out
