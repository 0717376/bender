"""Движки: чем именно делается один ход разговора.

Всё, что вокруг хода — нити и сессии, персона, память, журнал, крон-исходящие,
ревьюер — живёт в agent.py и от движка не зависит. Движок получает готовый текст
и готовые инструкции, а отдаёт нормализованный поток событий:

    {"t": "delta", "id": …, "text": кусок}   текст по мере генерации
    {"t": "flush", "id": …}                  блок закончился, можно показывать
    {"t": "text",  "id": …, "text": блок}    готовый кусок ответа
    {"t": "tool",  "name": …, "detail": …}   агент полез в инструмент
    {"t": "error", "text": …}                ход не удался

Так веб-чат и Telegram не знают, на чём сегодня работает ассистент.
"""

import importlib
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from .. import config

Emit = Callable[[dict], Awaitable[None]]


@dataclass
class Outcome:
    """Итог хода: id сессии для resume, собранный текст ответа и текст ошибки."""
    session_id: str | None = None
    reply: str = ""
    error: str = ""


class StaleSession(Exception):
    """resume сослался на сессию, которой у движка уже нет (переезд хоста, чистка
    кэша). Лечится сбросом указателя и повтором с чистого листа."""


class Overloaded(Exception):
    """Провайдер модели ответил «перегружен» — ход не начался, ответа нет.
    Сессию сбрасывать не надо: лечится паузой и повтором того же хода. Текст
    исключения — то, что показываем человеку, если и повтор не помог."""


# 529 (и 502/503 у прокси) — временная перегрузка на той стороне. 429 сюда не берём:
# это исчерпанный лимит подписки, повтором через минуту он не лечится.
_OVERLOAD = re.compile(r"overload|\b(502|503|529)\b|temporarily unavailable", re.I)


def looks_overloaded(text: str) -> bool:
    return bool(_OVERLOAD.search(text or ""))


def get(name: str = ""):
    """Модуль движка. Импорт ленивый: SDK второго движка на стенде может отсутствовать."""
    name = (name or config.ENGINE).lower()
    if name not in config.ENGINES:
        raise ValueError(f"неизвестный движок: {name}")
    return importlib.import_module(f".{name}", __package__)
