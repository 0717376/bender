"""Привязка Telegram-чата кодом.

Раньше путь был двухфазным: подними бота, напиши ему, прочитай свой id из ответа,
впиши в TELEGRAM_ALLOWED_IDS, перезапусти бэкенд. Теперь бот заводит шестизначный
код (его печатает установщик и показывает `./bender pair`), человек отправляет код
в чат — и чат привязан навсегда, без правки конфига и перезапуска.

TELEGRAM_ALLOWED_IDS из .env продолжает работать и старше кода: заданный список
отключает привязку совсем — на сервере с готовым конфигом лишняя дверь не нужна.
"""

import json
import logging
import os
import secrets

from . import config

logger = logging.getLogger("wiki.pairing")

STATE = os.path.join(config.DATA_DIR, "telegram.json")


def _read() -> dict:
    try:
        with open(STATE, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _write(data: dict) -> None:
    os.makedirs(config.DATA_DIR, exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, STATE)


def paired_ids() -> set[int]:
    return {int(x) for x in _read().get("chats", []) if str(x).lstrip("-").isdigit()}


def allowed_ids() -> set[int]:
    """Кому можно писать боту: список из .env, а если его нет — привязанные чаты."""
    return set(config.TELEGRAM_ALLOWED_IDS) or paired_ids()


def code() -> str:
    """Код привязки: заводится при первом спросе и живёт, пока чат не привязан.

    Пустая строка — привязка не нужна: список чатов задан в .env или кто-то уже привязан.
    """
    if config.TELEGRAM_ALLOWED_IDS or paired_ids():
        return ""
    data = _read()
    if not (data.get("code") or "").isdigit():
        data["code"] = f"{secrets.randbelow(1_000_000):06d}"
        _write(data)
        logger.info("Telegram: код привязки %s — отправьте его боту", data["code"])
    return data["code"]


def try_pair(chat_id: int, text: str) -> bool:
    """Привязать чат, если человек прислал верный код."""
    expected = code()
    if not expected or (text or "").strip() != expected:
        return False
    data = _read()
    data["chats"] = sorted(set(data.get("chats", [])) | {int(chat_id)})
    data.pop("code", None)  # код одноразовый: привязались — дверь закрыта
    _write(data)
    logger.info("Telegram: чат %s привязан", chat_id)
    return True


def unpair() -> None:
    """Отвязать все чаты — следующий спрос кода заведёт новый."""
    _write({})
