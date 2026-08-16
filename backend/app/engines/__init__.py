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


def get(name: str = ""):
    """Модуль движка. Импорт ленивый: SDK второго движка на стенде может отсутствовать."""
    name = (name or config.ENGINE).lower()
    if name not in config.ENGINES:
        raise ValueError(f"неизвестный движок: {name}")
    return importlib.import_module(f".{name}", __package__)
