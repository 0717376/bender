"""Команды Codex для установщика и ./bender: вход, проверка, живой ход.

Запускается внутри контейнера:
    docker compose exec backend uv run python -m app.codex_cli login|check|ping

Отдельной командой, а не ручкой HTTP: вход в чужой аккаунт не должен быть доступен
по сети, даже за паролем.
"""

import asyncio
import sys

from . import config
from .engines import codex

USAGE = "Использование: python -m app.codex_cli login|check|ping"


async def cmd_login() -> int:
    """Вход по коду устройства: браузер нужен любой, но не на этой машине."""
    who = await codex.account()
    if who:
        print("Уже авторизованы: " + ", ".join(f"{k}={v}" for k, v in who.items()))
        return 0

    async def show(url: str, code: str) -> None:
        print("\nОткройте на любом устройстве:\n  " + url)
        print(f"и введите код:\n  {code}\n")
        print("Жду подтверждения…", flush=True)

    try:
        await codex.login(show)
    except Exception as e:  # noqa: BLE001 — консольной команде нужен внятный текст
        print(f"Не получилось: {e}")
        return 1
    who = await codex.account()
    print("Готово. " + (", ".join(f"{k}={v}" for k, v in who.items()) if who else "Вход выполнен."))
    return 0


async def cmd_check() -> int:
    """Есть ли живой логин. Тихо: печатает только то, что нужно доктору."""
    who = await codex.account()
    if not who:
        return 1
    print(", ".join(f"{k}={v}" for k, v in who.items()))
    return 0


async def cmd_ping() -> int:
    """Настоящий ход через тот же движок, которым ходит агент: наличие токена
    ничего не доказывает — подписка могла кончиться, а лимит исчерпаться."""
    async def sink(_ev: dict) -> None:
        pass

    out = await codex.run("Ответь одним словом: ok", resume=None, surface="telegram",
                          instructions="Ты отвечаешь одним словом.", emit=sink,
                          interactive=False)
    if out.error:
        print(out.error)
        return 1
    print((out.reply or "").strip()[:40] or "(пустой ответ)")
    return 0


def main(argv: list[str]) -> int:
    if config.ENGINE != "codex":
        print(f"Движок сейчас {config.ENGINE}, команды Codex не нужны.")
        return 0
    cmd = (argv[1] if len(argv) > 1 else "").lower()
    runner = {"login": cmd_login, "check": cmd_check, "ping": cmd_ping}.get(cmd)
    if runner is None:
        print(USAGE)
        return 2
    return asyncio.run(runner())


if __name__ == "__main__":
    sys.exit(main(sys.argv))
