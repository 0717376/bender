#!/usr/bin/env python3
"""Хук Codex: запреты, которые нельзя доверить промпту.

Codex запускает нас отдельным процессом: на stdin — JSON события, на stdout — решение.
Контракт тот же, что у хуков Claude Code (включая имена инструментов: шелл приезжает
как `Bash`, правка файлов — как `apply_patch`), поэтому правило про rm живёт в общем
app/guards.py, а здесь — разбор события и то, что у Claude делают хуки движка.

На движке Codex это единственная защита: своя песочница Codex внутри докера не
работает, границей служит контейнер. Запускается по абсолютному пути, вне пакета, —
отсюда правка sys.path.
"""

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import config, guards  # путь настраивается выше

# Пути, которые правит патч: `*** Add File: x`, `*** Update File: x`, `*** Delete File: x`,
# `*** Move to: x`.
PATCH_PATH = re.compile(r"^\*\*\* (Add File|Update File|Delete File|Move to):\s*(.+)$", re.MULTILINE)

BOOKS_DENIED = ("В библиотеку книг писать нельзя: она открыта только на чтение "
                "(рисунки и страницы — инструментами chapter_images и page_image).")


def _deny(reason: str) -> dict:
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }


def _command(event: dict) -> str:
    payload = event.get("tool_input") or event.get("toolInput") or event
    command = payload.get("command", "") if isinstance(payload, dict) else ""
    if isinstance(command, list):     # шелл приезжает и списком аргументов
        command = " ".join(str(c) for c in command)
    return command or ""


def _patch_paths(text: str) -> list[str]:
    return [os.path.abspath(m.group(2).strip()) for m in PATCH_PATH.finditer(text)]


def decide(event: dict) -> dict:
    """Пустой словарь — не возражаем. Иначе — отказ с причиной."""
    if event.get("hook_event_name") != "PreToolUse":
        return {}
    command = _command(event)
    tool = event.get("tool_name") or ""

    if tool == "apply_patch" or command.lstrip().startswith("*** Begin Patch"):
        paths = _patch_paths(command)
        # Библиотеку книг правит человек в читалке, а не агент.
        if any(p.startswith(config.BOOKS_DIR + os.sep) for p in paths):
            return _deny(BOOKS_DENIED)
        # Патчем можно и удалить файл — это то же самое стирание мимо корзины.
        if "*** Delete File:" in command:
            return _deny(guards.RM_DENIED)
        return {}

    if guards.rm_allowed(command):
        return {}
    return _deny(guards.RM_DENIED)


def main() -> int:
    try:
        event = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        return 0                      # непонятное событие — не наше дело мешать ходу
    out = decide(event if isinstance(event, dict) else {})
    if out:
        print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
