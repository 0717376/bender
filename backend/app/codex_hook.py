#!/usr/bin/env python3
"""Хук Codex: запрещает удаление файлов мимо корзины.

Codex запускает нас отдельным процессом: на stdin — JSON события, на stdout — решение.
Контракт тот же, что у хуков Claude Code, поэтому правило одно на оба движка
(app/guards.py), а здесь только разбор события.

Запускается по абсолютному пути, вне пакета, — отсюда правка sys.path.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import guards  # noqa: E402 — путь настраивается выше


def decide(event: dict) -> dict:
    """Пустой словарь — не возражаем. Иначе — отказ с причиной."""
    if event.get("hook_event_name") != "PreToolUse":
        return {}
    payload = event.get("tool_input") or event.get("toolInput") or event
    command = payload.get("command", "") if isinstance(payload, dict) else ""
    if isinstance(command, list):     # shell у Codex приезжает и списком аргументов
        command = " ".join(str(c) for c in command)
    if guards.rm_allowed(command):
        return {}
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": guards.RM_DENIED,
        }
    }


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
