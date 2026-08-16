"""Команды Codex для установщика и ./bender: вход, проверка, живой ход.

Запускается внутри контейнера:
    docker compose exec backend uv run python -m app.codex_cli login|check|ping

Отдельной командой, а не ручкой HTTP: вход в чужой аккаунт не должен быть доступен
по сети, даже за паролем.
"""

import asyncio
import os
import sys

from . import config
from .engines import codex

USAGE = "Использование: python -m app.codex_cli login|check|ping|guard"


def _who(account: dict) -> str:
    """Строка про аккаунт для доктора: почта и тариф, если движок их отдал."""
    return " · ".join(v for k, v in account.items() if k != "аккаунт") or "вход есть"


async def cmd_login() -> int:
    """Вход по коду устройства: браузер нужен любой, но не на этой машине."""
    who = await codex.account()
    if who:
        print("Уже авторизованы: " + _who(who))
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
    print("Готово. " + (_who(who) if who else "Вход выполнен."))
    return 0


async def cmd_check() -> int:
    """Есть ли живой логин. Тихо: печатает только то, что нужно доктору."""
    who = await codex.account()
    if not who:
        return 1
    print(_who(who))
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


async def cmd_guard() -> int:
    """Целы ли запреты. На этом движке они держатся на одном файле и одном скрипте:
    не будет их — агент сотрёт страницу вики мимо корзины, и заметить это будет
    некому. Проверяем не наличие файла, а само решение хука."""
    from . import codex_hook

    problems = []
    if not os.path.exists(codex.MANAGED_CONFIG):
        problems.append(f"нет {codex.MANAGED_CONFIG}")
    checks = (
        ("Bash", "rm /app/content/x.md", True),
        ("Bash", "ls /app/content", False),
        ("apply_patch", "*** Begin Patch\n*** Update File: " + config.BOOKS_DIR + "/a/meta.json\n", True),
    )
    for tool, command, must_deny in checks:
        out = codex_hook.decide({"hook_event_name": "PreToolUse", "tool_name": tool,
                                 "tool_input": {"command": command}})
        denied = bool(out)
        if denied != must_deny:
            problems.append(f"{tool}: {command[:30]!r} — " + ("пропущено" if must_deny else "запрещено зря"))
    if problems:
        print("; ".join(problems))
        return 1
    print("запреты на месте")
    return 0


def main(argv: list[str]) -> int:
    if config.ENGINE != "codex":
        print(f"Движок сейчас {config.ENGINE}, команды Codex не нужны.")
        return 0
    cmd = (argv[1] if len(argv) > 1 else "").lower()
    runner = {"login": cmd_login, "check": cmd_check, "ping": cmd_ping,
              "guard": cmd_guard}.get(cmd)
    if runner is None:
        print(USAGE)
        return 2
    return asyncio.run(runner())


if __name__ == "__main__":
    sys.exit(main(sys.argv))
