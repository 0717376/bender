"""Live timestamp injected into every agent turn (interactive and cron).

The SDK session's system prompt carries the date of the FIRST turn only; a
long-lived session drifts (the agent once insisted "today is July 7" on July 10).
Prepending a [Сейчас: …] line to each user message keeps the clock honest without
touching the cached system prompt.
"""

from datetime import datetime

_DAYS = ("понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье")
_MONTHS = ("января", "февраля", "марта", "апреля", "мая", "июня", "июля",
           "августа", "сентября", "октября", "ноября", "декабря")


def now_line(now: datetime | None = None) -> str:
    now = now or datetime.now()
    return f"{_DAYS[now.weekday()]}, {now.day} {_MONTHS[now.month - 1]} {now.year}, {now:%H:%M}"


def stamp(now: datetime | None = None) -> str:
    return f"[Сейчас: {now_line(now)}]"
